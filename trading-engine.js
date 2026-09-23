const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, finite(value, min)));

export const DEFAULT_TRADING_CONFIG = Object.freeze({
  version: 1,
  enabled: false,
  executionMode: 'paper',
  orderUsd: 1_000,
  maxPositions: 3,
  minScore: 82,
  minLiquidityUsd: 150_000,
  minHolders: 1_000,
  maxChange24hPct: 35,
  maxPoolImpactPct: 0.5,
  stopLossPct: 12,
  takePrincipalMultiple: 2,
  maxDailyLossUsd: 2_000,
  maxDailyEntries: 3,
  cooldownMinutes: 120,
  requireHighQuality: true,
  requireOnchainConfirmation: false,
  exitOnHardRisk: true
});

export function normalizeTradingConfig(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    version: 1,
    enabled: Boolean(source.enabled),
    // AlphaPulse never stores wallet credentials or executes unattended live orders.
    executionMode: 'paper',
    orderUsd: clamp(source.orderUsd ?? DEFAULT_TRADING_CONFIG.orderUsd, 10, 100_000),
    maxPositions: Math.round(clamp(source.maxPositions ?? DEFAULT_TRADING_CONFIG.maxPositions, 1, 20)),
    minScore: Math.round(clamp(source.minScore ?? DEFAULT_TRADING_CONFIG.minScore, 0, 100)),
    minLiquidityUsd: clamp(source.minLiquidityUsd ?? DEFAULT_TRADING_CONFIG.minLiquidityUsd, 0, 1_000_000_000),
    minHolders: Math.round(clamp(source.minHolders ?? DEFAULT_TRADING_CONFIG.minHolders, 0, 100_000_000)),
    maxChange24hPct: clamp(source.maxChange24hPct ?? DEFAULT_TRADING_CONFIG.maxChange24hPct, 0, 10_000),
    maxPoolImpactPct: clamp(source.maxPoolImpactPct ?? DEFAULT_TRADING_CONFIG.maxPoolImpactPct, 0.01, 20),
    stopLossPct: clamp(source.stopLossPct ?? DEFAULT_TRADING_CONFIG.stopLossPct, 1, 95),
    takePrincipalMultiple: clamp(source.takePrincipalMultiple ?? DEFAULT_TRADING_CONFIG.takePrincipalMultiple, 1.1, 20),
    maxDailyLossUsd: clamp(source.maxDailyLossUsd ?? DEFAULT_TRADING_CONFIG.maxDailyLossUsd, 0, 1_000_000),
    maxDailyEntries: Math.round(clamp(source.maxDailyEntries ?? DEFAULT_TRADING_CONFIG.maxDailyEntries, 1, 100)),
    cooldownMinutes: Math.round(clamp(source.cooldownMinutes ?? DEFAULT_TRADING_CONFIG.cooldownMinutes, 0, 10_080)),
    requireHighQuality: source.requireHighQuality === undefined ? DEFAULT_TRADING_CONFIG.requireHighQuality : Boolean(source.requireHighQuality),
    requireOnchainConfirmation: source.requireOnchainConfirmation === undefined ? DEFAULT_TRADING_CONFIG.requireOnchainConfirmation : Boolean(source.requireOnchainConfirmation),
    exitOnHardRisk: source.exitOnHardRisk === undefined ? DEFAULT_TRADING_CONFIG.exitOnHardRisk : Boolean(source.exitOnHardRisk)
  };
}

export function tradingDayKey(timestamp = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(timestamp));
}

export function emptyTradingState(timestamp = Date.now()) {
  return {
    version: 1,
    updatedAt: timestamp,
    lastEvaluationAt: 0,
    lastEntryAt: 0,
    pausedReason: null,
    daily: { key: tradingDayKey(timestamp), entries: 0, realizedPnl: 0 },
    managedPositions: {},
    events: []
  };
}

export function normalizeTradingState(value = {}, timestamp = Date.now()) {
  const source = value && typeof value === 'object' ? value : {};
  const managedPositions = {};
  for (const [address, position] of Object.entries(source.managedPositions || {})) {
    const entryPrice = finite(position?.entryPrice);
    const initialCostUsd = finite(position?.initialCostUsd);
    if (!address || entryPrice <= 0 || initialCostUsd <= 0) continue;
    managedPositions[address.toLowerCase()] = {
      address: address.toLowerCase(),
      symbol: String(position.symbol || ''),
      entryPrice,
      initialCostUsd,
      openedAt: finite(position.openedAt, timestamp),
      principalRecovered: Boolean(position.principalRecovered),
      principalRecoveredUsd: Math.max(0, finite(position.principalRecoveredUsd)),
      highWaterPrice: Math.max(entryPrice, finite(position.highWaterPrice, entryPrice)),
      lastActionAt: finite(position.lastActionAt, position.openedAt || timestamp)
    };
  }
  const day = source.daily && typeof source.daily === 'object' ? source.daily : {};
  const today = tradingDayKey(timestamp);
  return {
    version: 1,
    updatedAt: finite(source.updatedAt, timestamp),
    lastEvaluationAt: finite(source.lastEvaluationAt),
    lastEntryAt: finite(source.lastEntryAt),
    pausedReason: source.pausedReason ? String(source.pausedReason) : null,
    daily: day.key === today
      ? { key: today, entries: Math.max(0, Math.round(finite(day.entries))), realizedPnl: finite(day.realizedPnl) }
      : { key: today, entries: 0, realizedPnl: 0 },
    managedPositions,
    events: Array.isArray(source.events) ? source.events.slice(0, 200) : []
  };
}

export function entryEvaluation(token, configValue = DEFAULT_TRADING_CONFIG) {
  const config = normalizeTradingConfig(configValue);
  const blockers = [];
  const riskFlags = token?.metrics?.riskFlags || {};
  const chain = token?.chainIntel || {};
  const poolImpactPct = finite(token?.liquidity) > 0 ? (config.orderUsd / finite(token.liquidity)) * 100 : Infinity;

  if (!token || token.offline || token.chainId !== '56') blockers.push('非可用 BSC 资产');
  if (token?.action !== '试仓') blockers.push('尚未达到试仓级别');
  if (finite(token?.score) < config.minScore) blockers.push(`评分低于 ${config.minScore}`);
  if (config.requireHighQuality && token?.quality !== '高质量') blockers.push('信号质量不足');
  if (['过热', '衰竭'].includes(token?.stage)) blockers.push(`处于${token.stage}阶段`);
  if (finite(token?.liquidity) < config.minLiquidityUsd) blockers.push('流动性不足');
  if (finite(token?.holders) < config.minHolders) blockers.push('持币地址不足');
  if (finite(token?.change24h) > config.maxChange24hPct) blockers.push('24H 涨幅过高');
  if (poolImpactPct > config.maxPoolImpactPct) blockers.push('试仓金额占池子比例过高');
  if (riskFlags.thinLiquidity || riskFlags.botLike || riskFlags.highDilution || riskFlags.concentrated || riskFlags.liquidityDrain) blockers.push('存在结构性风险');
  if (token?.metrics?.exhaustion) blockers.push('短周期动量衰竭');
  if (config.requireOnchainConfirmation && !(chain.available && chain.smartNetUsd > 0 && chain.largeSwapNetUsd >= 0)) blockers.push('缺少链上净买入确认');

  return {
    eligible: blockers.length === 0,
    blockers: [...new Set(blockers)],
    poolImpactPct,
    score: finite(token?.score),
    symbol: String(token?.symbol || ''),
    address: String(token?.address || '').toLowerCase()
  };
}

export function rankEntryCandidates(tokens, config, portfolioPositions = {}, managedPositions = {}) {
  return (Array.isArray(tokens) ? tokens : [])
    .map((token) => ({ token, evaluation: entryEvaluation(token, config) }))
    .filter(({ token, evaluation }) => evaluation.eligible && !portfolioPositions[token.address] && !managedPositions[token.address])
    .sort((a, b) => b.token.score - a.token.score || b.token.liquidity - a.token.liquidity);
}

export function principalRecoveryOrder(position, managed, currentPrice, multiple = 2) {
  const price = finite(currentPrice);
  if (!position || !managed || managed.principalRecovered || price <= 0) return null;
  const triggerPrice = managed.entryPrice * clamp(multiple, 1.1, 20);
  if (price < triggerPrice) return null;
  const targetProceeds = Math.max(0, managed.initialCostUsd - finite(managed.principalRecoveredUsd));
  const qty = Math.min(finite(position.qty), targetProceeds / price);
  if (qty <= 0) return null;
  return { reason: 'principal-recovery', qty, expectedProceeds: qty * price, triggerPrice };
}

export function managedExitDecision(token, position, managed, configValue = DEFAULT_TRADING_CONFIG) {
  if (!token || !position || !managed) return null;
  const config = normalizeTradingConfig(configValue);
  const price = finite(token.price);
  if (price <= 0) return null;
  const riskFlags = token.metrics?.riskFlags || {};
  if (config.exitOnHardRisk && (token.action === '回避' || riskFlags.liquidityDrain || riskFlags.concentrated)) {
    return { reason: 'hard-risk', qty: finite(position.qty), triggerPrice: price };
  }
  const stopPrice = managed.entryPrice * (1 - config.stopLossPct / 100);
  if (price <= stopPrice) return { reason: 'stop-loss', qty: finite(position.qty), triggerPrice: stopPrice };
  return principalRecoveryOrder(position, managed, price, config.takePrincipalMultiple);
}
