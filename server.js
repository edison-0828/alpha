import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { OkxChainIntelStream } from './okx-chain-intel.js';
import {
  DEFAULT_TRADING_CONFIG, emptyTradingState, managedExitDecision,
  normalizeTradingConfig, normalizeTradingState, rankEntryCandidates,
  reconcileManagedAddition, tradingDayKey
} from './trading-engine.js';
import { ALERT_COOLDOWN_MS, alertRules, calculateSignal, canEmitAlert } from './signal-engine.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const dataDir = join(root, 'data');
const legacyStateFile = join(dataDir, 'monitor-state.json');
const stateFile = join(dataDir, 'monitor-state.json.gz');
const paperPortfolioFile = join(dataDir, 'paper-portfolio.json');
const autoTradingFile = join(dataDir, 'auto-trading.json');
const databaseFile = join(dataDir, 'alphapulse.db');
const envFile = join(root, '.env');
const port = Number(process.env.PORT || 4173);
const BINANCE_ALPHA_URL = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';
const BINANCE_ALPHA_WS = 'wss://nbstream.binance.com/w3w/wsa/stream';
const CACHE_MS = 5_000;
const LIVE_PRICE_MAX_AGE_MS = 4_000;
const LIVE_BROADCAST_MS = 80;
const MAX_HISTORY = 240;
const MAX_ALERTS = 300;
const STATE_PERSIST_MS = 5 * 60_000;
const PERFORMANCE_HORIZONS = { '5m':5 * 60_000, '15m':15 * 60_000, '1h':60 * 60_000, '4h':4 * 60 * 60_000 };
const SNAPSHOT_RETENTION_MS = 2 * 24 * 60 * 60_000;
const SIGNAL_RETENTION_MS = 90 * 24 * 60 * 60_000;
const PRIORITY_SNAPSHOT_SCORE = 50;
const MARKET_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const SIGNAL_EVALUATION_INTERVAL_MS = 15_000;
const CHAIN_INTEL_WINDOW_MS = 15 * 60_000;
const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

let cache = { fetchedAt: 0, tokens: [], source: 'loading', error: null };
const histories = new Map();
let monitorBusy = false;
let persistTimer = null;
let shuttingDown = false;
let alphaSocket = null;
let alphaSocketStatus = 'connecting';
let alphaSocketLastEvent = 0;
let alphaSocketReconnect = null;
const livePrices = new Map();
const tokenByAlphaId = new Map();
const sseClients = new Set();
const pendingLiveUpdates = new Map();
let liveBroadcastTimer = null;
const alerts = [];
const alertStates = new Map();
const firstSignalAt = new Map();
const iconCache = new Map();
let alertEnginePrimed = false;
let alertSequence = 0;
let performanceDb = null;
let lastDatabasePruneAt = 0;
let lastPrioritySnapshotBucketAt = 0;
let lastMarketSnapshotAt = 0;
let lastSignalEvaluationAt = 0;
const chainEventLog = new Map();
const chainLiquidityHistory = new Map();
const chainHolderState = new Map();
let okxStream = null;
let okxIntelStatus = { configured:false, status:'not_configured', lastEvent:0, ageMs:null, subscriptions:0, trackedTokens:0, error:null };
const PAPER_CAPITAL = 100_000;
let paperPortfolio = emptyPaperPortfolio();
let paperPortfolioPersisted = false;
let tradingConfig = normalizeTradingConfig(DEFAULT_TRADING_CONFIG);
let tradingState = emptyTradingState();
let tradingPersisted = false;
let tradingBusy = false;

function emptyPaperPortfolio() {
  return { version:1, updatedAt:Date.now(), cash:PAPER_CAPITAL, positions:{}, realized:0, trades:[] };
}

function normalizePaperPortfolio(value) {
  const source = value && typeof value === 'object' ? value : {};
  const positions = {};
  for (const [address, position] of Object.entries(source.positions || {})) {
    const qty = Number(position?.qty);
    const avgCost = Number(position?.avgCost);
    if (!address || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(avgCost) || avgCost < 0) continue;
    positions[address] = {
      symbol:String(position.symbol || ''), name:String(position.name || ''), qty,
      avgCost, lastPrice:Number.isFinite(Number(position.lastPrice)) ? Number(position.lastPrice) : avgCost
    };
  }
  return {
    version:1,
    updatedAt:Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : Date.now(),
    cash:Number.isFinite(Number(source.cash)) && Number(source.cash) >= 0 ? Number(source.cash) : PAPER_CAPITAL,
    positions,
    realized:Number.isFinite(Number(source.realized)) ? Number(source.realized) : 0,
    trades:Array.isArray(source.trades) ? source.trades.slice(0,100) : []
  };
}

async function loadPaperPortfolio() {
  try {
    paperPortfolio = normalizePaperPortfolio(JSON.parse(await readFile(paperPortfolioFile, 'utf8')));
    paperPortfolioPersisted = true;
    console.log(`Restored paper portfolio with ${Object.keys(paperPortfolio.positions).length} positions`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Paper portfolio restore failed: ${error.message}`);
    paperPortfolio = emptyPaperPortfolio();
    paperPortfolioPersisted = false;
  }
}

async function persistPaperPortfolio() {
  await mkdir(dataDir, { recursive:true });
  const tempFile = `${paperPortfolioFile}.tmp`;
  await writeFile(tempFile, JSON.stringify(paperPortfolio), 'utf8');
  await rename(tempFile, paperPortfolioFile);
  paperPortfolioPersisted = true;
}

async function loadAutoTrading() {
  try {
    const saved = JSON.parse(await readFile(autoTradingFile, 'utf8'));
    tradingConfig = normalizeTradingConfig(saved.config);
    tradingState = normalizeTradingState(saved.state);
    tradingPersisted = true;
    console.log(`Restored auto trading (${tradingConfig.enabled ? 'enabled' : 'paused'}) with ${Object.keys(tradingState.managedPositions).length} managed positions`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Auto trading restore failed: ${error.message}`);
    tradingConfig = normalizeTradingConfig(DEFAULT_TRADING_CONFIG);
    tradingState = emptyTradingState();
    tradingPersisted = false;
  }
}

async function persistAutoTrading() {
  await mkdir(dataDir, { recursive:true });
  const tempFile = `${autoTradingFile}.tmp`;
  tradingState.updatedAt = Date.now();
  await writeFile(tempFile, JSON.stringify({ version:1, config:tradingConfig, state:tradingState }), 'utf8');
  await rename(tempFile, autoTradingFile);
  tradingPersisted = true;
}

function resetTradingDay(now = Date.now()) {
  const key = tradingDayKey(now);
  if (tradingState.daily?.key === key) return;
  tradingState.daily = { key, entries:0, realizedPnl:0 };
  tradingState.pausedReason = null;
}

function recordTradingEvent(event) {
  const item = { id:`trade-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, createdAt:Date.now(), ...event };
  tradingState.events.unshift(item);
  tradingState.events = tradingState.events.slice(0,200);
  broadcastEvent('auto-trade', item);
  return item;
}

function reconcileManagedPortfolioAdditions(previousPortfolio, nextPortfolio, now = Date.now()) {
  const additions = [];
  for (const [address, managed] of Object.entries(tradingState.managedPositions)) {
    const result = reconcileManagedAddition(
      previousPortfolio.positions?.[address], nextPortfolio.positions?.[address], managed, now
    );
    if (!result) continue;
    tradingState.managedPositions[address] = result.updated;
    additions.push({
      type:'buy', reason:'manual-add', symbol:managed.symbol, address,
      price:nextPortfolio.positions[address].avgCost, quantity:result.quantityAdded,
      amountUsd:result.addedCostUsd,
      message:`检测到手动加仓，均价已更新为 ${nextPortfolio.positions[address].avgCost}`
    });
  }
  return additions;
}

function applyPaperSale(token, position, quantity, reason) {
  const qty = Math.min(Number(position.qty) || 0, Number(quantity) || 0);
  if (!(qty > 0) || !(token.price > 0)) return null;
  const proceeds = qty * token.price;
  const realizedPnl = (token.price - position.avgCost) * qty;
  paperPortfolio.cash += proceeds;
  paperPortfolio.realized += realizedPnl;
  position.qty -= qty;
  position.lastPrice = token.price;
  if (position.qty < 1e-10) delete paperPortfolio.positions[token.address];
  paperPortfolio.trades.unshift({
    side:'sell', symbol:token.symbol, address:token.address, amount:proceeds, quantity:qty,
    price:token.price, time:Date.now(), execution:'auto-paper', reason
  });
  paperPortfolio.trades = paperPortfolio.trades.slice(0,100);
  paperPortfolio.updatedAt = Date.now();
  tradingState.daily.realizedPnl += realizedPnl;
  return { qty, proceeds, realizedPnl };
}

function tradingPauseReason() {
  if (!tradingConfig.enabled) return '策略已暂停';
  if (tradingConfig.executionMode !== 'paper') return '真实执行必须逐笔确认';
  if (tradingState.daily.realizedPnl <= -tradingConfig.maxDailyLossUsd) return '已达到单日最大亏损';
  if (tradingState.daily.entries >= tradingConfig.maxDailyEntries) return '已达到单日开仓上限';
  return null;
}

function tradingCandidates(tokens) {
  return rankEntryCandidates(tokens, tradingConfig, paperPortfolio.positions, tradingState.managedPositions)
    .slice(0,10)
    .map(({ token, evaluation }) => ({
      symbol:token.symbol, name:token.name, address:token.address, alphaId:token.alphaId,
      score:token.score, quality:token.quality, stage:token.stage, price:token.price,
      change24h:token.change24h, liquidity:token.liquidity, holders:token.holders,
      poolImpactPct:evaluation.poolImpactPct, priceSource:token.priceSource
    }));
}

function tradingOverview() {
  const tokenMap = new Map(cache.tokens.map((token) => [token.address, token]));
  const managedPositions = Object.entries(tradingState.managedPositions).map(([address, managed]) => {
    const token = tokenMap.get(address);
    const position = paperPortfolio.positions[address];
    const price = Number(token?.price || position?.lastPrice || managed.entryPrice) || managed.entryPrice;
    const value = (Number(position?.qty) || 0) * price;
    const pnl = position ? (price - position.avgCost) * position.qty : 0;
    return {
      ...managed, quantity:Number(position?.qty) || 0, currentPrice:price, value, pnl,
      pnlPct:position?.avgCost > 0 ? ((price / position.avgCost) - 1) * 100 : 0,
      principalTargetPrice:managed.entryPrice * tradingConfig.takePrincipalMultiple
    };
  }).sort((a,b) => b.openedAt - a.openedAt);
  return {
    persisted:tradingPersisted,
    safety:{ liveExecution:false, confirmationRequired:true, walletCredentialsStored:false },
    config:tradingConfig,
    state:{
      ...tradingState,
      managedPositions,
      managedPositionCount:managedPositions.length,
      candidates:tradingCandidates(cache.tokens)
    },
    now:Date.now()
  };
}

async function evaluateAutoTrading(tokens, now = Date.now()) {
  if (tradingBusy) return;
  tradingBusy = true;
  try {
    resetTradingDay(now);
    tradingState.lastEvaluationAt = now;
    let changed = false;

    for (const [address, managed] of Object.entries(tradingState.managedPositions)) {
      const position = paperPortfolio.positions[address];
      const token = tokens.find((item) => item.address === address);
      if (!position) {
        recordTradingEvent({ type:'position-closed', symbol:managed.symbol, address, message:'持仓已在其他位置关闭，自动管理结束' });
        delete tradingState.managedPositions[address];
        changed = true;
        continue;
      }
      if (!token?.price) continue;
      managed.highWaterPrice = Math.max(Number(managed.highWaterPrice) || 0, token.price);
      const decision = managedExitDecision(token, position, managed, tradingConfig);
      if (!tradingConfig.enabled || !decision) continue;
      const result = applyPaperSale(token, position, decision.qty, decision.reason);
      if (!result) continue;
      managed.lastActionAt = now;
      if (decision.reason === 'principal-recovery') {
        managed.principalRecovered = true;
        managed.principalRecoveredUsd += result.proceeds;
      }
      if (!paperPortfolio.positions[address]) delete tradingState.managedPositions[address];
      recordTradingEvent({
        type:'sell', reason:decision.reason, symbol:token.symbol, address, price:token.price,
        quantity:result.qty, amountUsd:result.proceeds, realizedPnl:result.realizedPnl,
        message:decision.reason === 'principal-recovery' ? '价格达到目标，已自动卖出并收回本金' : decision.reason === 'stop-loss' ? '触发硬止损，已自动退出模拟仓' : '触发结构性风险，已自动退出模拟仓'
      });
      changed = true;
    }

    const pauseReason = tradingPauseReason();
    tradingState.pausedReason = pauseReason;
    const cooldownReady = now - tradingState.lastEntryAt >= tradingConfig.cooldownMinutes * 60_000;
    const slots = tradingConfig.maxPositions - Object.keys(tradingState.managedPositions).length;
    if (!pauseReason && cooldownReady && slots > 0 && paperPortfolio.cash >= tradingConfig.orderUsd) {
      const candidate = rankEntryCandidates(tokens, tradingConfig, paperPortfolio.positions, tradingState.managedPositions)[0];
      if (candidate?.token?.price > 0) {
        const token = candidate.token;
        const amount = Math.min(tradingConfig.orderUsd, paperPortfolio.cash);
        const qty = amount / token.price;
        paperPortfolio.positions[token.address] = { symbol:token.symbol, name:token.name, qty, avgCost:token.price, lastPrice:token.price };
        paperPortfolio.cash -= amount;
        paperPortfolio.updatedAt = now;
        paperPortfolio.trades.unshift({
          side:'buy', symbol:token.symbol, address:token.address, amount, quantity:qty,
          price:token.price, time:now, execution:'auto-paper', reason:'signal-entry'
        });
        paperPortfolio.trades = paperPortfolio.trades.slice(0,100);
        tradingState.managedPositions[token.address] = {
          address:token.address, symbol:token.symbol, entryPrice:token.price, initialCostUsd:amount,
          openedAt:now, principalRecovered:false, principalRecoveredUsd:0,
          highWaterPrice:token.price, lastActionAt:now
        };
        tradingState.daily.entries += 1;
        tradingState.lastEntryAt = now;
        recordTradingEvent({
          type:'buy', reason:'signal-entry', symbol:token.symbol, address:token.address,
          price:token.price, quantity:qty, amountUsd:amount, score:token.score,
          message:`满足保守试仓规则，已自动模拟买入 ${amount.toFixed(2)} USDT`
        });
        changed = true;
      }
    }

    if (changed) {
      await persistPaperPortfolio();
      await persistAutoTrading();
    }
  } catch (error) {
    tradingState.pausedReason = `自动交易异常：${error.message}`;
    console.error(tradingState.pausedReason);
  } finally {
    tradingBusy = false;
  }
}

async function readJsonBody(req, maxBytes=1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function loadEnvironmentFile() {
  try {
    const content = await readFile(envFile,'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || match[1].startsWith('#') || process.env[match[1]]) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1,-1);
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Environment file failed: ${error.message}`);
  }
}

async function loadPersistentState() {
  try {
    let saved;
    try {
      saved = JSON.parse((await gunzip(await readFile(stateFile))).toString('utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Compressed state restore failed: ${error.message}; trying legacy state`);
      saved = JSON.parse(await readFile(legacyStateFile, 'utf8'));
    }
    for (const [key, rows] of saved.histories || []) {
      const normalized = Array.isArray(rows) ? rows.slice(-MAX_HISTORY).map((row) => Array.isArray(row)
        ? { t:Number(row[0]) || 0, price:Number(row[1]) || 0, volume:Number(row[2]) || 0, score:Number(row[3]) || 0 }
        : row
      ).filter((row) => row?.t && row?.price) : [];
      histories.set(key, normalized);
    }
    for (const item of saved.alerts || []) alerts.push(item);
    if (alerts.length > MAX_ALERTS) alerts.splice(0, alerts.length - MAX_ALERTS);
    for (const [key, value] of saved.alertStates || []) alertStates.set(key, value);
    for (const [key, value] of saved.firstSignalAt || []) firstSignalAt.set(key, value);
    for (const alert of alerts) {
      const previous = firstSignalAt.get(alert.address);
      if (!previous || alert.createdAt < previous) firstSignalAt.set(alert.address, alert.createdAt);
    }
    alertEnginePrimed = alertStates.size > 0;
    console.log(`Restored ${histories.size} token histories and ${alerts.length} alerts`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`State restore failed: ${error.message}`);
  }
}

function withDatabaseTransaction(work) {
  if (!performanceDb) return;
  performanceDb.exec('BEGIN IMMEDIATE');
  try {
    work();
    performanceDb.exec('COMMIT');
  } catch (error) {
    try { performanceDb.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function insertSignalRecord(alert) {
  if (!performanceDb || !alert?.id || !alert?.price) return;
  performanceDb.prepare(`
    INSERT OR IGNORE INTO signals (
      id, created_at, address, symbol, type, label, level, entry_price,
      score, stage, action, max_return, min_return, last_price, last_evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    alert.id, alert.createdAt, alert.address, alert.symbol, alert.type, alert.label,
    alert.level, alert.price, alert.score, alert.stage, alert.action, alert.price, alert.createdAt
  );
}

function backfillHistoricalSnapshots() {
  if (!performanceDb || !histories.size) return;
  const minuteRows = new Map();
  for (const [address, rows] of histories) {
    for (const row of rows) {
      if (!row?.t || !row?.price) continue;
      const bucketAt = Math.floor(row.t / 60_000) * 60_000;
      minuteRows.set(`${address}:${bucketAt}`, { address, bucketAt, ...row });
    }
  }
  const statement = performanceDb.prepare(`
    INSERT INTO price_snapshots (address, bucket_at, price, volume, score, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(address, bucket_at) DO UPDATE SET
      price=excluded.price, volume=excluded.volume, score=excluded.score, recorded_at=excluded.recorded_at
  `);
  withDatabaseTransaction(() => {
    for (const row of minuteRows.values()) statement.run(row.address, row.bucketAt, row.price, row.volume || 0, row.score || 0, row.t);
  });
}

async function initializePerformanceDatabase() {
  await mkdir(dataDir, { recursive:true });
  performanceDb = new DatabaseSync(databaseFile);
  performanceDb.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS price_snapshots (
      address TEXT NOT NULL,
      bucket_at INTEGER NOT NULL,
      price REAL NOT NULL,
      volume REAL NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (address, bucket_at)
    );
    CREATE INDEX IF NOT EXISTS idx_price_snapshots_time ON price_snapshots(bucket_at);
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      address TEXT NOT NULL,
      symbol TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      level TEXT NOT NULL,
      entry_price REAL NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      stage TEXT,
      action TEXT,
      max_return REAL NOT NULL DEFAULT 0,
      min_return REAL NOT NULL DEFAULT 0,
      last_price REAL,
      last_evaluated_at INTEGER,
      return_5m REAL,
      sampled_5m_at INTEGER,
      return_15m REAL,
      sampled_15m_at INTEGER,
      return_1h REAL,
      sampled_1h_at INTEGER,
      return_4h REAL,
      sampled_4h_at INTEGER,
      tracking_complete INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);
    CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(type);
    CREATE INDEX IF NOT EXISTS idx_signals_tracking ON signals(tracking_complete, created_at);
    CREATE TABLE IF NOT EXISTS chain_events (
      id TEXT PRIMARY KEY,
      event_at INTEGER NOT NULL,
      address TEXT NOT NULL,
      kind TEXT NOT NULL,
      direction TEXT,
      amount_usd REAL NOT NULL DEFAULT 0,
      wallet TEXT,
      wallet_count INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chain_events_address_time ON chain_events(address, event_at);
    CREATE INDEX IF NOT EXISTS idx_chain_events_time ON chain_events(event_at);
    CREATE TABLE IF NOT EXISTS chain_metrics (
      address TEXT NOT NULL,
      bucket_at INTEGER NOT NULL,
      liquidity REAL NOT NULL DEFAULT 0,
      holders REAL NOT NULL DEFAULT 0,
      top10_percent REAL,
      source TEXT,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (address, bucket_at)
    );
    CREATE INDEX IF NOT EXISTS idx_chain_metrics_time ON chain_metrics(bucket_at);
  `);
  withDatabaseTransaction(() => {
    for (const alert of alerts) insertSignalRecord(alert);
  });
  const snapshotCount = performanceDb.prepare('SELECT COUNT(*) AS count FROM price_snapshots').get().count;
  if (!snapshotCount) backfillHistoricalSnapshots();
  restoreChainIntelFromDatabase();
  console.log(`Performance database ready at ${databaseFile}`);
}

function storeMinuteSnapshots(tokens, now) {
  if (!performanceDb) return;
  const bucketAt = Math.floor(now / 60_000) * 60_000;
  const priorityDue = bucketAt !== lastPrioritySnapshotBucketAt;
  const marketDue = !lastMarketSnapshotAt || bucketAt - lastMarketSnapshotAt >= MARKET_SNAPSHOT_INTERVAL_MS;
  if (!priorityDue && !marketDue) return;
  if (priorityDue) lastPrioritySnapshotBucketAt = bucketAt;
  if (marketDue) lastMarketSnapshotAt = bucketAt;
  const recentAddresses = new Set(alerts
    .filter((item) => item.createdAt > now - PERFORMANCE_HORIZONS['4h'])
    .map((item) => item.address));
  const statement = performanceDb.prepare(`
    INSERT INTO price_snapshots (address, bucket_at, price, volume, score, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(address, bucket_at) DO UPDATE SET
      price=excluded.price, volume=excluded.volume, score=excluded.score, recorded_at=excluded.recorded_at
  `);
  withDatabaseTransaction(() => {
    for (const token of tokens) {
      if (token.chainId !== '56' || !token.address || token.price <= 0) continue;
      const priority = token.score >= PRIORITY_SNAPSHOT_SCORE
        || Boolean(paperPortfolio.positions[token.address])
        || recentAddresses.has(token.address);
      if ((priority && priorityDue) || (!priority && marketDue)) {
        statement.run(token.address, bucketAt, token.price, token.volume24h, token.score, now);
      }
    }
  });
}

function updateSignalPerformance(tokens, now) {
  if (!performanceDb) return;
  const tokenByAddress = new Map(tokens.map((token)=>[token.address,token]));
  const openSignals = performanceDb.prepare(`SELECT * FROM signals WHERE tracking_complete=0 ORDER BY created_at`).all();
  const nearestSnapshot = performanceDb.prepare(`
    SELECT price, bucket_at FROM price_snapshots
    WHERE address=? AND bucket_at BETWEEN ? AND ?
    ORDER BY ABS(bucket_at - ?) LIMIT 1
  `);
  const update = performanceDb.prepare(`
    UPDATE signals SET
      max_return=?, min_return=?, last_price=?, last_evaluated_at=?,
      return_5m=COALESCE(return_5m, ?), sampled_5m_at=COALESCE(sampled_5m_at, ?),
      return_15m=COALESCE(return_15m, ?), sampled_15m_at=COALESCE(sampled_15m_at, ?),
      return_1h=COALESCE(return_1h, ?), sampled_1h_at=COALESCE(sampled_1h_at, ?),
      return_4h=COALESCE(return_4h, ?), sampled_4h_at=COALESCE(sampled_4h_at, ?),
      tracking_complete=?
    WHERE id=?
  `);
  const sampleAt = (row, duration) => {
    const target = row.created_at + duration;
    if (now < target) return null;
    const sample = nearestSnapshot.get(row.address, target - 120_000, target + 120_000, target);
    if (!sample?.price) return null;
    return { value:((sample.price / row.entry_price) - 1) * 100, at:sample.bucket_at };
  };
  withDatabaseTransaction(() => {
    for (const row of openSignals) {
      const token = tokenByAddress.get(row.address);
      const currentReturn = token?.price > 0 ? ((token.price / row.entry_price) - 1) * 100 : null;
      const result5m = row.return_5m === null ? sampleAt(row, PERFORMANCE_HORIZONS['5m']) : null;
      const result15m = row.return_15m === null ? sampleAt(row, PERFORMANCE_HORIZONS['15m']) : null;
      const result1h = row.return_1h === null ? sampleAt(row, PERFORMANCE_HORIZONS['1h']) : null;
      const result4h = row.return_4h === null ? sampleAt(row, PERFORMANCE_HORIZONS['4h']) : null;
      const complete = now >= row.created_at + PERFORMANCE_HORIZONS['4h'] + 2 * 60_000 ? 1 : 0;
      update.run(
        currentReturn === null ? row.max_return : Math.max(row.max_return, currentReturn),
        currentReturn === null ? row.min_return : Math.min(row.min_return, currentReturn),
        token?.price || row.last_price, now,
        result5m?.value ?? null, result5m?.at ?? null,
        result15m?.value ?? null, result15m?.at ?? null,
        result1h?.value ?? null, result1h?.at ?? null,
        result4h?.value ?? null, result4h?.at ?? null,
        complete, row.id
      );
    }
  });
}

function prunePerformanceDatabase(now) {
  if (!performanceDb || now - lastDatabasePruneAt < 60 * 60_000) return;
  lastDatabasePruneAt = now;
  performanceDb.prepare('DELETE FROM price_snapshots WHERE bucket_at < ?').run(now - SNAPSHOT_RETENTION_MS);
  performanceDb.prepare('DELETE FROM signals WHERE created_at < ?').run(now - SIGNAL_RETENTION_MS);
  performanceDb.prepare('DELETE FROM chain_events WHERE event_at < ?').run(now - SNAPSHOT_RETENTION_MS);
  performanceDb.prepare('DELETE FROM chain_metrics WHERE bucket_at < ?').run(now - SNAPSHOT_RETENTION_MS);
  try { performanceDb.exec('PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);'); } catch {}
}

function recordPerformanceData(tokens, now) {
  if (!performanceDb) return;
  try {
    storeMinuteSnapshots(tokens, now);
    if (now - lastSignalEvaluationAt >= SIGNAL_EVALUATION_INTERVAL_MS) {
      lastSignalEvaluationAt = now;
      updateSignalPerformance(tokens, now);
    }
    prunePerformanceDatabase(now);
  } catch (error) {
    console.error(`Performance tracking failed: ${error.message}`);
  }
}

function performanceSummary(horizon = '15m') {
  if (!performanceDb) return { ready:false, horizon, totalSignals:0, completed:0, tracking:0, overall:null, rules:[], recent:[] };
  const safeHorizon = Object.hasOwn(PERFORMANCE_HORIZONS, horizon) ? horizon : '15m';
  const field = { '5m':'return_5m', '15m':'return_15m', '1h':'return_1h', '4h':'return_4h' }[safeHorizon];
  const allSignals = performanceDb.prepare(`SELECT id, created_at, symbol, type, label, level, entry_price, score, stage, action, max_return, min_return, ${field} AS result FROM signals ORDER BY created_at DESC`).all();
  const completedRows = allSignals.filter((row)=>row.result !== null);
  const directionalResult = (row) => row.level === 'risk' ? -row.result : row.result;
  const summarize = (rows) => {
    const samples = rows.filter((row)=>row.result !== null);
    if (!samples.length) return { samples:0, wins:0, winRate:null, average:null, median:null, averageFavorable:null, averageDrawdown:null };
    const outcomes = samples.map(directionalResult).sort((a,b)=>a-b);
    const wins = outcomes.filter((value)=>value > 0).length;
    const average = outcomes.reduce((sum,value)=>sum+value,0) / outcomes.length;
    const middle = Math.floor(outcomes.length / 2);
    const median = outcomes.length % 2 ? outcomes[middle] : (outcomes[middle-1] + outcomes[middle]) / 2;
    const favorable = samples.map((row)=>row.level === 'risk' ? Math.max(0,-row.min_return) : Math.max(0,row.max_return));
    const drawdowns = samples.map((row)=>row.level === 'risk' ? Math.max(0,row.max_return) : Math.max(0,-row.min_return));
    return {
      samples:samples.length, wins, winRate:(wins / samples.length) * 100, average, median,
      averageFavorable:favorable.reduce((sum,value)=>sum+value,0) / favorable.length,
      averageDrawdown:drawdowns.reduce((sum,value)=>sum+value,0) / drawdowns.length
    };
  };
  const grouped = new Map();
  for (const row of allSignals) {
    if (!grouped.has(row.type)) grouped.set(row.type,{ type:row.type, label:row.label, level:row.level, rows:[] });
    grouped.get(row.type).rows.push(row);
  }
  const rules = [...grouped.values()].map((group)=>({
    type:group.type, label:group.label, level:group.level, total:group.rows.length, ...summarize(group.rows)
  })).sort((a,b)=>(b.samples>0)-(a.samples>0) || (b.winRate ?? -1)-(a.winRate ?? -1) || b.total-a.total);
  const tracking = performanceDb.prepare('SELECT COUNT(*) AS count FROM signals WHERE tracking_complete=0').get().count;
  const snapshots = performanceDb.prepare('SELECT COUNT(*) AS count FROM price_snapshots').get().count;
  return {
    ready:true, horizon:safeHorizon, totalSignals:allSignals.length, completed:completedRows.length, tracking, snapshots,
    overall:summarize(completedRows), rules,
    recent:completedRows.slice(0,10).map((row)=>({
      id:row.id, createdAt:row.created_at, symbol:row.symbol, label:row.label, level:row.level,
      result:row.result, effect:directionalResult(row), score:row.score, stage:row.stage, action:row.action
    }))
  };
}

function chainEventId(event) {
  return String(event.id || event.txHash || `${event.kind}:${event.address}:${event.timestamp}:${event.wallet || ''}:${event.amountUsd || event.quoteAmount || 0}`);
}

function persistChainEvent(event) {
  if (!performanceDb) return;
  const detail = JSON.stringify({
    symbol:event.symbol || '', walletType:event.walletType || '', walletTypes:event.walletTypes || [], wallets:event.wallets || [],
    soldRatio:event.soldRatio ?? null, top10Percent:event.top10Percent ?? null, holders:event.holders ?? null,
    quoteSymbol:event.quoteSymbol || '', dexName:event.dexName || '', price:event.price || 0, marketCap:event.marketCap || 0,
    large:event.large || false
  });
  performanceDb.prepare(`
    INSERT OR IGNORE INTO chain_events (id, event_at, address, kind, direction, amount_usd, wallet, wallet_count, source, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chainEventId(event), event.timestamp, event.address, event.kind, event.direction || null,
    event.amountUsd || 0, event.wallet || null, event.walletCount || 0, event.source || 'OKX', detail
  );
}

function persistChainMetric(address, point, top10Percent = null, source = 'OKX Price Info') {
  if (!performanceDb) return;
  const bucketAt = Math.floor(point.t / 60_000) * 60_000;
  performanceDb.prepare(`
    INSERT INTO chain_metrics (address, bucket_at, liquidity, holders, top10_percent, source, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address, bucket_at) DO UPDATE SET
      liquidity=excluded.liquidity, holders=excluded.holders,
      top10_percent=COALESCE(excluded.top10_percent,chain_metrics.top10_percent),
      source=excluded.source, recorded_at=excluded.recorded_at
  `).run(address,bucketAt,point.liquidity || 0,point.holders || 0,top10Percent,source,point.t);
}

function pruneChainMemory(address, now = Date.now()) {
  const events = chainEventLog.get(address);
  if (events) {
    const filtered = events.filter((item)=>item.timestamp >= now - CHAIN_INTEL_WINDOW_MS).slice(-600);
    if (filtered.length) chainEventLog.set(address,filtered); else chainEventLog.delete(address);
  }
  const history = chainLiquidityHistory.get(address);
  if (history) {
    const filtered = history.filter((item)=>item.t >= now - CHAIN_INTEL_WINDOW_MS).slice(-240);
    if (filtered.length) chainLiquidityHistory.set(address,filtered); else chainLiquidityHistory.delete(address);
  }
}

function ingestOkxEvent(event, persist = true) {
  if (!event?.address || String(event.chainIndex) !== '56') return;
  const address = String(event.address).toLowerCase();
  const now = event.timestamp || Date.now();
  if (event.kind === 'token-metrics') {
    const history = chainLiquidityHistory.get(address) || [];
    history.push({ t:now, liquidity:event.liquidity || 0, holders:event.holders || 0 });
    chainLiquidityHistory.set(address,history);
    const previous = chainHolderState.get(address) || {};
    chainHolderState.set(address,{ ...previous, holders:event.holders || previous.holders || 0, lastUpdated:now, source:event.source });
    if (persist) persistChainMetric(address,history.at(-1),previous.top10Percent ?? null,event.source);
    pruneChainMemory(address,now);
    return;
  }
  let amountUsd = event.amountUsd || 0;
  if (event.kind === 'smart-trade' && !['USDT','USDC','BUSD','FDUSD','DAI'].includes(event.quoteSymbol)) amountUsd = 0;
  const normalized = { ...event, address, timestamp:now, amountUsd, id:chainEventId({ ...event,address,timestamp:now,amountUsd }) };
  const events = chainEventLog.get(address) || [];
  if (!events.some((item)=>item.id === normalized.id)) events.push(normalized);
  chainEventLog.set(address,events);
  if (event.top10Percent || event.holders) {
    const previous = chainHolderState.get(address) || {};
    chainHolderState.set(address,{
      ...previous, top10Percent:event.top10Percent || previous.top10Percent || null,
      holders:event.holders || previous.holders || 0, lastUpdated:now, source:event.source
    });
    if (persist) persistChainMetric(address,{ t:now, liquidity:chainLiquidityHistory.get(address)?.at(-1)?.liquidity || 0, holders:event.holders || previous.holders || 0 },event.top10Percent || previous.top10Percent || null,event.source);
  }
  if (persist) persistChainEvent(normalized);
  pruneChainMemory(address,now);
}

function restoreChainIntelFromDatabase() {
  if (!performanceDb) return;
  const cutoff = Date.now() - CHAIN_INTEL_WINDOW_MS;
  for (const row of performanceDb.prepare('SELECT * FROM chain_events WHERE event_at >= ? ORDER BY event_at').all(cutoff)) {
    let detail = {};
    try { detail = JSON.parse(row.detail || '{}'); } catch {}
    ingestOkxEvent({
      ...detail, id:row.id, timestamp:row.event_at, address:row.address, chainIndex:'56', kind:row.kind,
      direction:row.direction, amountUsd:row.amount_usd, wallet:row.wallet, walletCount:row.wallet_count, source:row.source
    },false);
  }
  for (const row of performanceDb.prepare('SELECT * FROM chain_metrics WHERE bucket_at >= ? ORDER BY bucket_at').all(cutoff)) {
    const history = chainLiquidityHistory.get(row.address) || [];
    history.push({ t:row.recorded_at || row.bucket_at, liquidity:row.liquidity, holders:row.holders });
    chainLiquidityHistory.set(row.address,history);
    const previous = chainHolderState.get(row.address) || {};
    chainHolderState.set(row.address,{
      ...previous, holders:row.holders || previous.holders || 0,
      top10Percent:row.top10_percent ?? previous.top10Percent ?? null,
      lastUpdated:row.recorded_at || row.bucket_at, source:row.source
    });
  }
}

function summarizeChainIntel(address, fallbackLiquidity = 0, now = Date.now()) {
  pruneChainMemory(address,now);
  const events = chainEventLog.get(address) || [];
  const liquidityHistory = chainLiquidityHistory.get(address) || [];
  const holder = chainHolderState.get(address) || {};
  let smartBuyUsd = 0, smartSellUsd = 0, smartSignals = 0;
  const wallets = new Set();
  for (const event of events) {
    if (event.kind !== 'smart-signal' && event.kind !== 'smart-trade') continue;
    if (event.kind === 'smart-signal') smartSignals += 1;
    for (const wallet of event.wallets || []) wallets.add(String(wallet).toLowerCase());
    if (event.wallet) wallets.add(event.wallet);
    if (event.direction === 'sell') smartSellUsd += event.amountUsd || 0;
    else smartBuyUsd += event.amountUsd || 0;
  }
  const latestLiquidity = liquidityHistory.at(-1)?.liquidity || fallbackLiquidity || 0;
  const largeSwapThreshold = Math.max(10_000,Math.min(50_000,latestLiquidity * 0.005 || 10_000));
  const largeSwaps = events.filter((event)=>event.kind === 'swap' && event.amountUsd >= largeSwapThreshold);
  const largeBuyUsd = largeSwaps.filter((event)=>event.direction !== 'sell').reduce((sum,event)=>sum+event.amountUsd,0);
  const largeSellUsd = largeSwaps.filter((event)=>event.direction === 'sell').reduce((sum,event)=>sum+event.amountUsd,0);
  const target = now - 5 * 60_000;
  const baseline = [...liquidityHistory].reverse().find((point)=>point.t <= target) || (liquidityHistory.length > 1 ? liquidityHistory[0] : null);
  const liquidityChange5m = baseline?.liquidity > 0 && latestLiquidity > 0 && now - baseline.t >= 2 * 60_000
    ? ((latestLiquidity / baseline.liquidity) - 1) * 100 : null;
  const lastEventAt = Math.max(holder.lastUpdated || 0,...events.map((item)=>item.timestamp),...liquidityHistory.map((item)=>item.t));
  return {
    configured:Boolean(okxIntelStatus.configured), status:okxIntelStatus.status,
    available:Boolean(events.length || liquidityHistory.length || holder.top10Percent), fresh:lastEventAt > now - 5 * 60_000,
    lastEventAt:lastEventAt || null, smartBuyUsd, smartSellUsd, smartNetUsd:smartBuyUsd-smartSellUsd,
    smartWallets:wallets.size, smartSignals, largeSwapThreshold, largeSwapCount:largeSwaps.length,
    largeBuyUsd, largeSellUsd, largeSwapNetUsd:largeBuyUsd-largeSellUsd,
    liquidity:latestLiquidity, liquidityChange5m, holders:holder.holders || 0,
    top10Percent:holder.top10Percent ?? null, source:holder.source || (events.length ? events.at(-1).source : null)
  };
}

function syncOkxPriorityTokens(tokens) {
  if (!okxStream) return;
  const recentAddresses = new Set(alerts.filter((item)=>item.createdAt > Date.now()-2*60*60_000).map((item)=>item.address));
  const prioritized = tokens
    .filter((token)=>token.chainId === '56' && token.address)
    .sort((a,b)=>(Number(recentAddresses.has(b.address))-Number(recentAddresses.has(a.address))) || b.score-a.score || b.volume24h-a.volume24h)
    .slice(0,24);
  okxStream.setPriorityTokens(prioritized);
}

function startOkxChainIntel() {
  if (process.env.OKX_CHAIN_INTEL_ENABLED !== 'true') {
    okxIntelStatus = { configured:false, status:'disabled', lastEvent:0, ageMs:null, subscriptions:0, trackedTokens:0, error:null };
    return;
  }
  okxStream = new OkxChainIntelStream({
    apiKey:process.env.OKX_DEX_API_KEY,
    secretKey:process.env.OKX_DEX_SECRET_KEY,
    passphrase:process.env.OKX_DEX_PASSPHRASE,
    onEvent:(event)=>ingestOkxEvent(event,true),
    onStatus:(status)=>{ okxIntelStatus = status; broadcastEvent('chain-status',status); }
  });
  okxStream.start();
}

async function persistState() {
  try {
    await mkdir(dataDir, { recursive: true });
    const tempFile = `${stateFile}.tmp`;
    const compactHistories = [...histories.entries()].map(([key, rows]) => [
      key,
      rows.slice(-MAX_HISTORY).map((row) => [row.t, row.price, row.volume || 0, row.score || 0])
    ]);
    const payload = JSON.stringify({
      version:2, savedAt:Date.now(), histories:compactHistories, alerts,
      alertStates:[...alertStates.entries()], firstSignalAt:[...firstSignalAt.entries()]
    });
    const compressed = await gzip(payload, { level:6 });
    await writeFile(tempFile, compressed);
    await rename(tempFile, stateFile);
  } catch (error) {
    console.error(`State persist failed: ${error.message}`);
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    await persistState();
  }, STATE_PERSIST_MS);
}

function flushLiveUpdates() {
  liveBroadcastTimer = null;
  if (!pendingLiveUpdates.size || !sseClients.size) { pendingLiveUpdates.clear(); return; }
  const payload = `data: ${JSON.stringify([...pendingLiveUpdates.values()])}\n\n`;
  pendingLiveUpdates.clear();
  for (const client of [...sseClients]) {
    try { client.write(payload); }
    catch { sseClients.delete(client); }
  }
}

function queueLiveUpdate(update) {
  pendingLiveUpdates.set(update.alphaId, update);
  if (!liveBroadcastTimer) liveBroadcastTimer = setTimeout(flushLiveUpdates, LIVE_BROADCAST_MS);
}

function broadcastEvent(name, value) {
  const payload = `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of [...sseClients]) {
    try { client.write(payload); }
    catch { sseClients.delete(client); }
  }
}

function processAlerts(tokens, now) {
  const candidates = [];
  for (const token of tokens) {
    if (token.offline || token.chainId !== '56') continue;
    const transitioned = [];
    for (const rule of alertRules(token)) {
      const key = `${token.address}:${rule.type}`;
      const previous = alertStates.get(key) || { active:false, lastAlertAt:0 };
      if (canEmitAlert(rule, previous, now, ALERT_COOLDOWN_MS)) transitioned.push({ token, rule, key });
      alertStates.set(key, { active:rule.active, lastAlertAt:previous.lastAlertAt });
    }
    if (transitioned.length) candidates.push(transitioned.sort((a,b)=>b.rule.priority-a.rule.priority)[0]);
  }

  candidates.sort((a,b)=>b.rule.priority-a.rule.priority || b.token.score-a.token.score);
  const selected = candidates.slice(0, alertEnginePrimed ? 30 : 12);
  for (const { token, rule, key } of selected) {
    if (!firstSignalAt.has(token.address)) firstSignalAt.set(token.address, now);
    const alert = {
      id:`${now}-${++alertSequence}`, type:rule.type, level:rule.level,
      label:rule.label, message:rule.message, createdAt:now,
      firstSignalAt:firstSignalAt.get(token.address) || now,
      symbol:token.symbol, name:token.name, address:token.address, alphaId:token.alphaId, chainId:token.chainId,
      icon:token.icon, score:token.score, stage:token.stage, action:token.action,
      price:token.price, change24h:token.change24h,
      change5m:token.metrics.change5m, flow5mRatio:token.metrics.flow5mRatio
    };
    alerts.push(alert);
    insertSignalRecord(alert);
    const state = alertStates.get(key);
    alertStates.set(key, { ...state, lastAlertAt:now });
    broadcastEvent('alert', alert);
  }
  if (alerts.length > MAX_ALERTS) alerts.splice(0, alerts.length - MAX_ALERTS);
  alertEnginePrimed = true;
  for (const token of tokens) token.firstSignalAt = firstSignalAt.get(token.address) || null;
  if (selected.length) schedulePersist();
}

function applyLiveTicker(row) {
  const match = String(row.s || '').toUpperCase().match(/^(ALPHA_\d+)(USDT|USDC)$/);
  if (!match) return;
  const [, alphaId, quote] = match;
  const price = num(row.c);
  const receivedAt = Date.now();
  const eventTime = num(row.E) || receivedAt;
  if (!price) return;
  const existing = livePrices.get(alphaId);
  const existingFresh = existing && receivedAt - (existing.receivedAt || existing.eventTime) <= LIVE_PRICE_MAX_AGE_MS;
  if (existingFresh && existing.quote === 'USDT' && quote !== 'USDT') return;
  const open = num(row.o);
  const update = {
    alphaId, price, eventTime, receivedAt, quote, source:'Binance Alpha WS',
    change24h: open > 0 ? ((price / open) - 1) * 100 : null,
    high24h: num(row.h), low24h: num(row.l), volume24h: num(row.q)
  };
  livePrices.set(alphaId, update);
  const token = tokenByAlphaId.get(alphaId);
  if (token) {
    token.price = update.price;
    if (update.change24h !== null) token.change24h = update.change24h;
    if (update.high24h) token.high24h = update.high24h;
    if (update.low24h) token.low24h = update.low24h;
    if (update.volume24h) token.volume24h = update.volume24h;
    token.livePriceAt = eventTime;
    token.priceSource = 'Binance Alpha WS';
  }
  queueLiveUpdate(update);
}

function scheduleSocketReconnect() {
  if (shuttingDown || alphaSocketReconnect) return;
  alphaSocketReconnect = setTimeout(() => {
    alphaSocketReconnect = null;
    startAlphaSocket();
  }, 3_000);
}

function startAlphaSocket() {
  if (alphaSocket && (alphaSocket.readyState === WebSocket.OPEN || alphaSocket.readyState === WebSocket.CONNECTING)) return;
  alphaSocketStatus = 'connecting';
  try {
    alphaSocket = new WebSocket(BINANCE_ALPHA_WS);
    alphaSocket.addEventListener('open', () => {
      alphaSocketStatus = 'live';
      alphaSocket.send(JSON.stringify({ method:'SUBSCRIBE', params:['!miniTicker@arr'], id:1 }));
      console.log('Binance Alpha realtime stream connected');
    });
    alphaSocket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (!Array.isArray(message.data)) return;
        alphaSocketLastEvent = Date.now();
        for (const row of message.data) applyLiveTicker(row);
      } catch (error) { console.error(`Realtime message failed: ${error.message}`); }
    });
    alphaSocket.addEventListener('close', () => {
      alphaSocketStatus = shuttingDown ? 'stopped' : 'reconnecting'; alphaSocket = null; scheduleSocketReconnect();
    });
    alphaSocket.addEventListener('error', () => {
      alphaSocketStatus = 'error';
      try { alphaSocket.close(); } catch {}
    });
  } catch (error) {
    alphaSocketStatus = 'error';
    console.error(`Realtime connection failed: ${error.message}`);
    scheduleSocketReconnect();
  }
}

function serveLiveStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive'
  });
  res.write(`event: status\ndata: ${JSON.stringify({ status:alphaSocketStatus, lastEvent:alphaSocketLastEvent })}\n\n`);
  res.write(`event: chain-status\ndata: ${JSON.stringify(okxIntelStatus)}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

setInterval(() => {
  for (const client of [...sseClients]) {
    try { client.write(`: keepalive ${Date.now()}\n\n`); }
    catch { sseClients.delete(client); }
  }
}, 15_000);

const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function sparkline(history, now, windowMs = 5 * 60_000, maxPoints = 24) {
  const points = history.filter((item) => item.t >= now - windowMs && item.price > 0);
  if (points.length <= maxPoints) return points.map((item) => item.price);
  const sampled = [];
  for (let index = 0; index < maxPoints; index += 1) sampled.push(points[Math.round(index * (points.length - 1) / (maxPoints - 1))].price);
  return sampled;
}

function normalizeToken(raw, history, chainIntel) {
  const signal = calculateSignal(raw, history, chainIntel);
  return {
    id: raw.tokenId,
    alphaId: raw.alphaId,
    chainId: raw.chainId,
    chainName: raw.chainName,
    address: String(raw.contractAddress || '').toLowerCase(),
    name: raw.name,
    symbol: raw.symbol,
    icon: raw.iconUrl,
    price: num(raw.price),
    change24h: num(raw.percentChange24h),
    volume24h: num(raw.volume24h),
    marketCap: num(raw.marketCap),
    fdv: num(raw.fdv),
    liquidity: num(raw.liquidity),
    holders: num(raw.holders),
    trades24h: num(raw.count24h),
    high24h: num(raw.priceHigh24h),
    low24h: num(raw.priceLow24h),
    listingTime: num(raw.listingTime),
    listingCex: Boolean(raw.listingCex),
    hot: Boolean(raw.hotTag),
    offline: Boolean(raw.offline),
    ...signal
  };
}

async function refreshTokens(force = false) {
  if (!force && Date.now() - cache.fetchedAt < CACHE_MS && cache.tokens.length) return cache;
  try {
    const response = await fetch(BINANCE_ALPHA_URL, {
      headers: { 'accept': 'application/json', 'user-agent': 'AlphaPulse/0.2' },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`Binance Alpha HTTP ${response.status}`);
    const body = await response.json();
    const rawTokens = Array.isArray(body.data) ? body.data : [];
    const now = Date.now();
    const tokens = rawTokens.map((raw) => {
      const key = String(raw.contractAddress || raw.tokenId).toLowerCase();
      const history = histories.get(key) || [];
      const chainIntel = summarizeChainIntel(key,num(raw.liquidity),now);
      const token = normalizeToken(raw, history,chainIntel);
      history.push({ t: now, price: token.price, volume: token.volume24h, score: token.score });
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
      histories.set(key, history);
      token.sparkline5m = sparkline(history, now);
      token.sparkline15m = sparkline(history, now, 15 * 60_000, 48);
      return token;
    });
    tokenByAlphaId.clear();
    for (const token of tokens) {
      const alphaId = String(token.alphaId || '').toUpperCase();
      tokenByAlphaId.set(alphaId, token);
      const live = livePrices.get(alphaId);
      const liveFresh = live && now - (live.receivedAt || live.eventTime) <= LIVE_PRICE_MAX_AGE_MS;
      if (!liveFresh) {
        token.priceSource = 'Binance Alpha REST';
        if (paperPortfolio.positions[token.address]) {
          queueLiveUpdate({
            alphaId, price:token.price, eventTime:now, receivedAt:now, source:'Binance Alpha REST',
            change24h:token.change24h, high24h:token.high24h, low24h:token.low24h, volume24h:token.volume24h
          });
        }
        continue;
      }
      token.price = live.price;
      if (live.change24h !== null) token.change24h = live.change24h;
      if (live.high24h) token.high24h = live.high24h;
      if (live.low24h) token.low24h = live.low24h;
      if (live.volume24h) token.volume24h = live.volume24h;
      token.livePriceAt = live.eventTime;
      token.priceSource = 'Binance Alpha WS';
    }
    processAlerts(tokens, now);
    syncOkxPriorityTokens(tokens);
    recordPerformanceData(tokens, now);
    cache = { fetchedAt: now, tokens, source: 'Binance Alpha', error: null };
    await evaluateAutoTrading(tokens, now);
    schedulePersist();
  } catch (error) {
    cache = { ...cache, error: error.message, source: cache.tokens.length ? 'cached' : 'unavailable' };
  }
  return cache;
}

async function monitorTick() {
  if (monitorBusy) return;
  monitorBusy = true;
  try { await refreshTokens(true); }
  finally { monitorBusy = false; }
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function serveIcon(res, alphaId) {
  const id = String(alphaId || '').toUpperCase();
  let token = cache.tokens.find((item) => String(item.alphaId || '').toUpperCase() === id);
  if (!token) {
    await refreshTokens();
    token = cache.tokens.find((item) => String(item.alphaId || '').toUpperCase() === id);
  }
  if (!token?.icon) { res.writeHead(404); return res.end('Icon not found'); }
  const source = new URL(token.icon);
  if (source.protocol !== 'https:' || source.hostname !== 'bin.bnbstatic.com') { res.writeHead(403); return res.end('Icon source not allowed'); }
  let cached = iconCache.get(id);
  if (!cached) {
    const response = await fetch(source, { signal:AbortSignal.timeout(10_000), headers:{ 'user-agent':'AlphaPulse/0.4' } });
    if (!response.ok) { res.writeHead(response.status); return res.end('Icon unavailable'); }
    const contentType = response.headers.get('content-type')?.startsWith('image/') ? response.headers.get('content-type') : 'image/jpeg';
    cached = { body:Buffer.from(await response.arrayBuffer()), contentType };
    iconCache.set(id, cached);
    if (iconCache.size > 500) iconCache.delete(iconCache.keys().next().value);
  }
  res.writeHead(200, { 'content-type':cached.contentType, 'cache-control':'public, max-age=86400, immutable' });
  res.end(cached.body);
}

async function api(req, res, url) {
  if (url.pathname === '/api/stream') return serveLiveStream(req, res);
  if (url.pathname.startsWith('/api/icon/')) return serveIcon(res, decodeURIComponent(url.pathname.slice('/api/icon/'.length)));
  if (url.pathname === '/api/paper-portfolio') {
    if (req.method === 'GET') return json(res, { persisted:paperPortfolioPersisted, portfolio:paperPortfolio });
    if (req.method !== 'PUT') {
      res.setHeader('allow', 'GET, PUT');
      return json(res, { error:'Method not allowed' }, 405);
    }
    const payload = await readJsonBody(req);
    const now = Date.now();
    const nextPortfolio = normalizePaperPortfolio({ ...payload, updatedAt:now });
    const additions = reconcileManagedPortfolioAdditions(paperPortfolio, nextPortfolio, now);
    paperPortfolio = nextPortfolio;
    await persistPaperPortfolio();
    if (additions.length) {
      for (const event of additions) recordTradingEvent(event);
      await persistAutoTrading();
    }
    return json(res, { persisted:true, portfolio:paperPortfolio });
  }
  if (url.pathname === '/api/trading') {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      return json(res, { error:'Method not allowed' }, 405);
    }
    return json(res, tradingOverview());
  }
  if (url.pathname === '/api/trading/config') {
    if (req.method !== 'PUT') {
      res.setHeader('allow', 'PUT');
      return json(res, { error:'Method not allowed' }, 405);
    }
    const payload = await readJsonBody(req, 100_000);
    tradingConfig = normalizeTradingConfig({ ...tradingConfig, ...payload });
    tradingState.pausedReason = tradingConfig.enabled ? null : '策略已暂停';
    await persistAutoTrading();
    if (tradingConfig.enabled) await evaluateAutoTrading(cache.tokens, Date.now());
    return json(res, tradingOverview());
  }
  if (url.pathname === '/api/health') {
    return json(res, {
      ok: true, version: '0.8.0', mode: 'unattended', pollingMs: CACHE_MS,
      now: Date.now(), lastRefresh: cache.fetchedAt, cachedTokens: cache.tokens.length,
      histories: histories.size, alerts:alerts.length, performanceDatabase:Boolean(performanceDb), source: cache.source, error: cache.error,
      chainIntel: { ...okxIntelStatus, eventTokens:chainEventLog.size, liquidityTokens:chainLiquidityHistory.size, holderTokens:chainHolderState.size },
      trading: {
        enabled:tradingConfig.enabled, executionMode:tradingConfig.executionMode,
        managedPositions:Object.keys(tradingState.managedPositions).length,
        dailyEntries:tradingState.daily.entries, pausedReason:tradingState.pausedReason,
        liveExecution:false, confirmationRequired:true
      },
      realtime: {
        status: alphaSocketStatus,
        lastEvent: alphaSocketLastEvent,
        ageMs: alphaSocketLastEvent ? Date.now() - alphaSocketLastEvent : null,
        tracked: livePrices.size,
        freshTracked: [...livePrices.values()].filter((item) => Date.now() - (item.receivedAt || item.eventTime) <= LIVE_PRICE_MAX_AGE_MS).length,
        maxPriceAgeMs: LIVE_PRICE_MAX_AGE_MS,
        clients: sseClients.size
      },
      storage: {
        statePersistMs:STATE_PERSIST_MS,
        snapshotRetentionMs:SNAPSHOT_RETENTION_MS,
        prioritySnapshotScore:PRIORITY_SNAPSHOT_SCORE,
        marketSnapshotMs:MARKET_SNAPSHOT_INTERVAL_MS,
        signalEvaluationMs:SIGNAL_EVALUATION_INTERVAL_MS,
        lastPrioritySnapshotAt:lastPrioritySnapshotBucketAt || null,
        lastMarketSnapshotAt:lastMarketSnapshotAt || null
      }
    });
  }
  if (url.pathname === '/api/alerts') {
    const limit = clamp(num(url.searchParams.get('limit')) || 80, 1, 300);
    const chain = url.searchParams.get('chain') || '56';
    const items = alerts.filter((item) => chain === 'all' || item.chainId === chain).slice(-limit).reverse();
    return json(res, { total:alerts.length, alerts:items, now:Date.now() });
  }
  if (url.pathname === '/api/performance') {
    return json(res, { ...performanceSummary(url.searchParams.get('horizon') || '15m'), now:Date.now() });
  }
  if (url.pathname === '/api/tokens') {
    const data = await refreshTokens(url.searchParams.get('refresh') === '1');
    const chain = url.searchParams.get('chain') || '56';
    const tokens = data.tokens.filter((t) => !t.offline && (chain === 'all' || t.chainId === chain));
    return json(res, { fetchedAt: data.fetchedAt, source: data.source, error: data.error, total: tokens.length, tokens });
  }
  if (url.pathname.startsWith('/api/token/')) {
    const address = decodeURIComponent(url.pathname.slice('/api/token/'.length)).toLowerCase();
    const data = await refreshTokens();
    const token = data.tokens.find((t) => t.address === address || t.alphaId?.toLowerCase() === address);
    if (!token) return json(res, { error: 'Token not found' }, 404);
    return json(res, { token, history: histories.get(token.address) || [], fetchedAt: data.fetchedAt });
  }
  return json(res, { error: 'Not found' }, 404);
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function serveStatic(req, res, url) {
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = normalize(join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    const file = await readFile(filePath);
    res.writeHead(200, { 'content-type': mime[extname(filePath)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(req, res, url);
  } catch (error) {
    json(res, { error: error.message }, 500);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`AlphaPulse running at http://127.0.0.1:${port}`);
  startAlphaSocket();
  loadEnvironmentFile()
    .then(() => loadPersistentState())
    .then(() => loadPaperPortfolio())
    .then(() => loadAutoTrading())
    .then(() => initializePerformanceDatabase())
    .then(() => startOkxChainIntel())
    .then(() => monitorTick())
    .then(() => console.log(`Loaded ${cache.tokens.length} Binance Alpha tokens; unattended monitor active`));
  setInterval(monitorTick, CACHE_MS);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; saving state before shutdown`);
  if (persistTimer) clearTimeout(persistTimer);
  if (alphaSocketReconnect) clearTimeout(alphaSocketReconnect);
  try { okxStream?.stop(); } catch {}
  try { alphaSocket?.close(); } catch {}
  for (const client of [...sseClients]) {
    try { client.end(); } catch {}
  }
  await persistState();
  try { await persistPaperPortfolio(); } catch {}
  try { await persistAutoTrading(); } catch {}
  try { performanceDb?.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
  try { performanceDb?.close(); } catch {}
  server.close(() => process.exit(0));
  const forceExit = setTimeout(() => process.exit(0), 5_000);
  forceExit.unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
