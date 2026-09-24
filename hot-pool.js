const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export const MAX_HISTORY_UPPER = 240;
export const HOT_POOL_HARD_MAX = 64;
export const DEFAULT_HOT_POOL_MAX = 48;
export const DEFAULT_HOT_DEBOUNCE_MS = 300;
export const DEFAULT_HISTORY_SAMPLE_MS = 5_000;
export const DEFAULT_RSS_SOFT_MB = 512;
export const DEFAULT_RECENT_ALERT_MS = 2 * 60 * 60_000;
export const DEFAULT_HIGH_SCORE = 62;
export const DEFAULT_EARLY_SCORE = 42;
export const EARLY_STAGES = new Set(['潜伏', '启动']);

const REASON_RANK = { position: 50, managed: 40, alert: 30, score: 20, early: 10 };

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function intEnv(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return clamp(fallback, min, max);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return clamp(fallback, min, max);
  return clamp(Math.floor(parsed), min, max);
}

export function readHotPoolConfig(env = {}) {
  const historyCap = intEnv(env.ALPHAPULSE_MAX_HISTORY, MAX_HISTORY_UPPER, 30, MAX_HISTORY_UPPER);
  const hotPoolMax = intEnv(env.ALPHAPULSE_HOT_POOL_MAX, DEFAULT_HOT_POOL_MAX, 8, HOT_POOL_HARD_MAX);
  const debounceMs = intEnv(env.ALPHAPULSE_HOT_DEBOUNCE_MS, DEFAULT_HOT_DEBOUNCE_MS, 200, 500);
  const historySampleMs = intEnv(env.ALPHAPULSE_HOT_HISTORY_SAMPLE_MS, DEFAULT_HISTORY_SAMPLE_MS, 1_000, 60_000);
  const rssSoftMb = intEnv(env.ALPHAPULSE_RSS_SOFT_MB, DEFAULT_RSS_SOFT_MB, 0, 16_384);
  const pressureHistoryCap = intEnv(env.ALPHAPULSE_PRESSURE_HISTORY_CAP, Math.min(120, historyCap), 30, historyCap);
  const pressureHotPoolMax = intEnv(env.ALPHAPULSE_PRESSURE_HOT_POOL_MAX, Math.min(16, hotPoolMax), 4, hotPoolMax);
  const maxTrackedHistories = intEnv(env.ALPHAPULSE_MAX_TRACKED_HISTORIES, 900, 16, 5_000);
  const pressureMaxHistories = intEnv(env.ALPHAPULSE_PRESSURE_MAX_HISTORIES, Math.min(180, maxTrackedHistories), 16, maxTrackedHistories);
  const maxChainTokens = intEnv(env.ALPHAPULSE_MAX_CHAIN_TOKENS, 400, 0, 2_000);
  const pressureMaxChainTokens = intEnv(
    env.ALPHAPULSE_PRESSURE_MAX_CHAIN_TOKENS,
    Math.min(24, maxChainTokens),
    0,
    maxChainTokens
  );
  const recentAlertMs = intEnv(env.ALPHAPULSE_HOT_ALERT_WINDOW_MS, DEFAULT_RECENT_ALERT_MS, 60_000, 24 * 60 * 60_000);
  const highScore = intEnv(env.ALPHAPULSE_HOT_SCORE, DEFAULT_HIGH_SCORE, 40, 100);
  const earlyScore = intEnv(env.ALPHAPULSE_HOT_EARLY_SCORE, DEFAULT_EARLY_SCORE, 30, 100);
  return {
    historyCap, hotPoolMax, debounceMs, historySampleMs, rssSoftMb,
    pressureHistoryCap, pressureHotPoolMax, maxTrackedHistories, pressureMaxHistories,
    maxChainTokens, pressureMaxChainTokens, recentAlertMs, highScore, earlyScore
  };
}

export function readProcessMemory(usage = process.memoryUsage()) {
  const rss = num(usage?.rss);
  const heapUsed = num(usage?.heapUsed);
  const heapTotal = num(usage?.heapTotal);
  const external = num(usage?.external);
  const toMb = (bytes) => Math.round((bytes / 1_048_576) * 10) / 10;
  return {
    rss, heapUsed, heapTotal, external,
    arrayBuffers: num(usage?.arrayBuffers),
    rssMb: toMb(rss),
    heapUsedMb: toMb(heapUsed),
    heapTotalMb: toMb(heapTotal)
  };
}

export function planMemoryGuard(config, memory = {}) {
  const rssBytes = Number.isFinite(Number(memory.rss)) ? Number(memory.rss) : num(memory.rssMb) * 1_048_576;
  const rssMb = rssBytes / 1_048_576;
  const pressure = config.rssSoftMb > 0 && rssMb >= config.rssSoftMb;
  return {
    pressure,
    rssMb: Math.round(rssMb * 10) / 10,
    historyCap: pressure ? config.pressureHistoryCap : config.historyCap,
    hotPoolMax: pressure ? config.pressureHotPoolMax : config.hotPoolMax,
    maxTrackedHistories: pressure ? config.pressureMaxHistories : config.maxTrackedHistories,
    maxChainTokens: pressure ? config.pressureMaxChainTokens : config.maxChainTokens,
    skipNonCriticalInstant: pressure
  };
}

function bestRank(member) {
  let rank = 0;
  for (const reason of member.reasons) rank = Math.max(rank, REASON_RANK[reason] || 0);
  return rank;
}

function rankMembers(members) {
  return [...members.values()].sort((a, b) => {
    const byReason = bestRank(b) - bestRank(a);
    if (byReason) return byReason;
    const byAlert = (b.alertAt || 0) - (a.alertAt || 0);
    if (byAlert) return byAlert;
    const byScore = (b.score || 0) - (a.score || 0);
    if (byScore) return byScore;
    return a.address.localeCompare(b.address);
  });
}

export function selectHotPool(tokens, options = {}) {
  const maxSize = Math.max(0, Math.floor(num(options.maxSize)));
  const members = new Map();
  if (!maxSize) return [];

  const tokenByAddress = new Map();
  for (const token of tokens || []) {
    if (!token?.address || token.offline || token.chainId !== '56') continue;
    tokenByAddress.set(String(token.address).toLowerCase(), token);
  }

  const ensure = (address) => {
    const key = String(address || '').toLowerCase();
    const token = tokenByAddress.get(key);
    if (!token) return null;
    let member = members.get(key);
    if (!member) {
      member = {
        address: key,
        alphaId: String(token.alphaId || '').toUpperCase(),
        symbol: token.symbol || '',
        score: num(token.score),
        stage: token.stage || '',
        reasons: [],
        critical: false,
        alertAt: 0
      };
      members.set(key, member);
    }
    return member;
  };

  const addReason = (address, reason, critical, alertAt = 0) => {
    const member = ensure(address);
    if (!member) return;
    if (!member.reasons.includes(reason)) member.reasons.push(reason);
    if (critical) member.critical = true;
    if (alertAt > member.alertAt) member.alertAt = alertAt;
  };

  for (const address of options.positionAddresses || []) addReason(address, 'position', true);
  for (const address of options.managedAddresses || []) addReason(address, 'managed', true);

  const now = num(options.now) || Date.now();
  const cutoff = now - (num(options.recentAlertMs) || DEFAULT_RECENT_ALERT_MS);
  const seenAlerts = new Set();
  const alertRows = [];
  for (const alert of options.recentAlerts || []) {
    if (!alert?.address || !(alert.createdAt > cutoff)) continue;
    if (alert.chainId && alert.chainId !== '56') continue;
    const address = String(alert.address).toLowerCase();
    if (seenAlerts.has(address)) continue;
    seenAlerts.add(address);
    alertRows.push({ address, createdAt: alert.createdAt });
  }
  alertRows.sort((a, b) => b.createdAt - a.createdAt);
  for (const alert of alertRows) addReason(alert.address, 'alert', true, alert.createdAt);

  const fill = (reason, rows) => {
    for (const token of rows) {
      const address = String(token.address).toLowerCase();
      if (!members.has(address) && members.size >= maxSize) continue;
      addReason(address, reason, false);
    }
  };

  if (members.size < maxSize) {
    const highScore = num(options.highScore) || DEFAULT_HIGH_SCORE;
    const scored = [];
    for (const token of tokenByAddress.values()) if (num(token.score) >= highScore) scored.push(token);
    scored.sort((a, b) => num(b.score) - num(a.score) || String(a.address).localeCompare(String(b.address)));
    fill('score', scored);
  }

  if (members.size < maxSize) {
    const earlyScore = num(options.earlyScore) || DEFAULT_EARLY_SCORE;
    const stages = options.earlyStages || EARLY_STAGES;
    const early = [];
    for (const token of tokenByAddress.values()) {
      if (stages.has(token.stage) && num(token.score) >= earlyScore) early.push(token);
    }
    early.sort((a, b) => num(b.score) - num(a.score) || String(a.address).localeCompare(String(b.address)));
    fill('early', early);
  }

  return rankMembers(members).slice(0, maxSize);
}

export function planInstantTick({
  inHotPool = false,
  critical = false,
  lastRecomputeAt = 0,
  now = Date.now(),
  debounceMs = DEFAULT_HOT_DEBOUNCE_MS,
  skipNonCritical = false
} = {}) {
  if (!inHotPool) return { recompute: false, reason: 'cold' };
  if (skipNonCritical && !critical) return { recompute: false, reason: 'degraded' };
  if (lastRecomputeAt && now - lastRecomputeAt < debounceMs) return { recompute: false, reason: 'debounced' };
  return { recompute: true, reason: 'hot' };
}

export function buildSignalInput(token, update = {}) {
  const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
  const change24h = update.change24h === null || update.change24h === undefined || !Number.isFinite(Number(update.change24h))
    ? num(token.change24h ?? token.percentChange24h)
    : Number(update.change24h);
  const volume24h = positive(token.bookVolume24h)
    ? Number(token.bookVolume24h)
    : positive(update.volume24h) ? Number(update.volume24h) : num(token.volume24h);
  return {
    price: positive(update.price) ? Number(update.price) : num(token.price),
    percentChange24h: change24h,
    volume24h,
    marketCap: num(token.marketCap),
    fdv: num(token.fdv),
    liquidity: num(token.liquidity),
    holders: num(token.holders),
    count24h: num(token.trades24h ?? token.count24h),
    priceHigh24h: positive(update.high24h) ? Number(update.high24h) : num(token.high24h ?? token.priceHigh24h),
    priceLow24h: positive(update.low24h) ? Number(update.low24h) : num(token.low24h ?? token.priceLow24h),
    listingTime: num(token.listingTime)
  };
}

export function applySignalSnapshot(token, input, signal) {
  token.price = input.price;
  token.change24h = input.percentChange24h;
  if (input.priceHigh24h) token.high24h = input.priceHigh24h;
  if (input.priceLow24h) token.low24h = input.priceLow24h;
  token.score = signal.score;
  token.action = signal.action;
  token.tone = signal.tone;
  token.positives = signal.positives;
  token.risks = signal.risks;
  token.quality = signal.quality;
  token.stage = signal.stage;
  token.confidence = signal.confidence;
  token.metrics = signal.metrics;
}

export function maybeSampleHistory(history, point, now, minIntervalMs, maxLength) {
  if (!Array.isArray(history) || !point?.t || !(point.price > 0) || !(maxLength > 0)) return false;
  const last = history.length ? history[history.length - 1] : null;
  if (last && now - last.t < minIntervalMs) return false;
  history.push({ t: point.t, price: point.price, volume: point.volume || 0, score: point.score || 0 });
  if (history.length > maxLength) history.splice(0, history.length - maxLength);
  return true;
}

export function runInstantTicks({
  updates,
  tokenByAddress,
  hotByAddress,
  lastRecomputeAt,
  histories,
  now,
  debounceMs,
  historySampleMs,
  historyCap,
  skipNonCritical = false,
  sampleHistory = true,
  calculateSignal
}) {
  const updated = [];
  const skipped = { cold: 0, debounced: 0, degraded: 0, failed: 0 };
  let sampled = 0;

  for (const update of updates || []) {
    const address = String(update?.address || '').toLowerCase();
    const member = address ? hotByAddress?.get(address) : null;
    const token = address ? tokenByAddress?.get(address) : null;
    if (!member || !token) {
      skipped.cold += 1;
      continue;
    }
    const plan = planInstantTick({
      inHotPool: true,
      critical: Boolean(member.critical),
      lastRecomputeAt: lastRecomputeAt?.get(address) || 0,
      now,
      debounceMs,
      skipNonCritical
    });
    if (!plan.recompute) {
      skipped[plan.reason] += 1;
      continue;
    }
    try {
      const existing = histories?.get(address);
      const history = existing || [];
      const input = buildSignalInput(token, update);
      const signal = calculateSignal(input, history, token.chainIntel || {});
      applySignalSnapshot(token, input, signal);
      if (lastRecomputeAt) lastRecomputeAt.set(address, now);
      if (sampleHistory && histories && maybeSampleHistory(history, {
        t: now, price: token.price, volume: input.volume24h, score: token.score
      }, now, historySampleMs, historyCap)) {
        if (!existing) histories.set(address, history);
        sampled += 1;
      }
      updated.push({ address, token, signal });
    } catch {
      skipped.failed += 1;
    }
  }

  return { updated, rescored: updated.map((item) => item.address), skipped, sampled };
}

function lastChainActivity(address, chainEventLog, chainLiquidityHistory, chainHolderState) {
  let last = 0;
  const events = chainEventLog?.get(address);
  if (Array.isArray(events) && events.length) last = Math.max(last, num(events[events.length - 1]?.timestamp));
  const history = chainLiquidityHistory?.get(address);
  if (Array.isArray(history) && history.length) last = Math.max(last, num(history[history.length - 1]?.t));
  const holder = chainHolderState?.get(address);
  if (holder) last = Math.max(last, num(holder.lastUpdated));
  return last;
}

function countChainTokens(chainEventLog, chainLiquidityHistory, chainHolderState) {
  const addresses = new Set();
  if (chainEventLog) for (const key of chainEventLog.keys()) addresses.add(key);
  if (chainLiquidityHistory) for (const key of chainLiquidityHistory.keys()) addresses.add(key);
  if (chainHolderState) for (const key of chainHolderState.keys()) addresses.add(key);
  return addresses.size;
}

export function pruneMemoryState({
  histories,
  chainEventLog,
  chainLiquidityHistory,
  chainHolderState,
  keepAddresses,
  historyCap,
  maxTrackedHistories,
  maxChainTokens
} = {}) {
  const keep = keepAddresses || new Set();
  let truncated = 0;
  let droppedHistories = 0;
  let droppedChain = 0;

  if (histories && historyCap > 0) {
    for (const [address, rows] of histories) {
      if (!Array.isArray(rows)) {
        histories.delete(address);
        droppedHistories += 1;
        continue;
      }
      if (rows.length > historyCap) {
        rows.splice(0, rows.length - historyCap);
        truncated += 1;
      }
    }
    if (Number.isFinite(maxTrackedHistories) && histories.size > maxTrackedHistories) {
      const ranked = [];
      for (const [address, rows] of histories) {
        const last = rows.length ? num(rows[rows.length - 1]?.t) : 0;
        ranked.push({ address, keep: keep.has(address), last });
      }
      ranked.sort((a, b) => Number(b.keep) - Number(a.keep) || b.last - a.last || a.address.localeCompare(b.address));
      let removed = 0;
      const overflow = histories.size - maxTrackedHistories;
      for (let index = ranked.length - 1; index >= 0 && removed < overflow; index -= 1) {
        if (ranked[index].keep) continue;
        histories.delete(ranked[index].address);
        removed += 1;
        droppedHistories += 1;
      }
    }
  }

  const chainTokens = countChainTokens(chainEventLog, chainLiquidityHistory, chainHolderState);
  if (Number.isFinite(maxChainTokens) && chainTokens > maxChainTokens) {
    const addresses = new Set();
    if (chainEventLog) for (const key of chainEventLog.keys()) addresses.add(key);
    if (chainLiquidityHistory) for (const key of chainLiquidityHistory.keys()) addresses.add(key);
    if (chainHolderState) for (const key of chainHolderState.keys()) addresses.add(key);
    const ranked = [...addresses].map((address) => ({
      address,
      keep: keep.has(address),
      last: lastChainActivity(address, chainEventLog, chainLiquidityHistory, chainHolderState)
    }));
    ranked.sort((a, b) => Number(b.keep) - Number(a.keep) || b.last - a.last || a.address.localeCompare(b.address));
    let removed = 0;
    const overflow = addresses.size - maxChainTokens;
    for (let index = ranked.length - 1; index >= 0 && removed < overflow; index -= 1) {
      if (ranked[index].keep) continue;
      const address = ranked[index].address;
      chainEventLog?.delete(address);
      chainLiquidityHistory?.delete(address);
      chainHolderState?.delete(address);
      removed += 1;
      droppedChain += 1;
    }
  }

  return {
    truncated,
    droppedHistories,
    droppedChain,
    trackedHistories: histories?.size || 0,
    chainTokens: countChainTokens(chainEventLog, chainLiquidityHistory, chainHolderState)
  };
}
