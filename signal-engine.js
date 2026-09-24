const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const optionalNumber = (value) => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const ALERT_COOLDOWN_MS = 30 * 60_000;
export const EARLY_MOMENTUM_CAP = 12;
export const FIRST_ALERT_EXEMPT_TYPES = new Set(['early-launch', 'launch', 'flow-surge', 'smart-money']);

const LAUNCH_SCORE = 50;
const FLOW_SURGE_SCORE = 50;
const FLOW_SURGE_RATIO = 0.0012;
const EARLY_LAUNCH_SCORE = 42;

function snapshotBefore(history, milliseconds, now = Date.now()) {
  const target = now - milliseconds;
  for (let i = history.length - 1; i >= 0; i -= 1) if (history[i].t <= target) return history[i];
  return null;
}

function earlyChainConfirmation(chainIntel = {}) {
  if (!chainIntel.available) return { smart: false, swap: false };
  return {
    smart: chainIntel.smartNetUsd >= 8_000 && chainIntel.smartWallets >= 1,
    swap: chainIntel.largeSwapNetUsd >= 20_000 && chainIntel.largeSwapCount >= 1
  };
}

export function calculateSignal(token, history = [], chainIntel = {}) {
  const previous = history.at(-1);
  const price = num(token.price);
  const change24h = num(token.percentChange24h);
  const volume = num(token.volume24h);
  const marketCap = num(token.marketCap);
  const fdv = num(token.fdv);
  const liquidity = num(token.liquidity);
  const holders = num(token.holders);
  const trades = num(token.count24h);
  const volumeRatio = marketCap > 0 ? volume / marketCap : 0;
  const liquidityRatio = marketCap > 0 ? liquidity / marketCap : 0;
  const unlockRatio = marketCap > 0 ? fdv / marketCap : 0;
  const volumeLiquidityRatio = liquidity > 0 ? volume / liquidity : 0;
  const averageTradeUsd = trades > 0 ? volume / trades : 0;
  const tradesPerHolder = holders > 0 ? trades / holders : 0;
  const high24h = num(token.priceHigh24h);
  const low24h = num(token.priceLow24h);
  const rangePct = low24h > 0 ? ((high24h - low24h) / low24h) * 100 : 0;
  const intradayPosition = high24h > low24h ? clamp((price - low24h) / (high24h - low24h), 0, 1) : 0.5;
  const ageHours = token.listingTime ? (Date.now() - num(token.listingTime)) / 3_600_000 : 99999;
  const shortChange = previous?.price > 0 ? ((price / previous.price) - 1) * 100 : 0;
  const volumeDelta = previous ? Math.max(0, volume - previous.volume) : 0;
  const now = Date.now();
  const snap1m = snapshotBefore(history, 60_000, now);
  const snap5m = snapshotBefore(history, 5 * 60_000, now);
  const snap15m = snapshotBefore(history, 15 * 60_000, now);
  const changeFor = (snapshot) => snapshot?.price > 0 ? ((price / snapshot.price) - 1) * 100 : null;
  const flowFor = (snapshot) => snapshot ? Math.max(0, volume - snapshot.volume) : null;
  const change1m = changeFor(snap1m);
  const change5m = changeFor(snap5m);
  const change15m = changeFor(snap15m);
  const flow1m = flowFor(snap1m);
  const flow5m = flowFor(snap5m);
  const flow15m = flowFor(snap15m);
  const flow5mRatio = flow5m !== null && marketCap > 0 ? flow5m / marketCap : null;
  const volumeAccelerating = flow1m !== null && flow5m !== null && flow1m > Math.max((flow5m / 5) * 1.8, marketCap * 0.0005);
  const multiWindowConfluence = change1m !== null && change5m !== null && change15m !== null && change1m > 0.25 && change5m > 1.2 && change15m > 2.5;
  const exhaustion = (change15m !== null && change15m > 3 && change1m !== null && change1m < -1) || (change24h > 15 && intradayPosition < 0.38);
  const sampleMinutes = history.length > 1 ? (now - history[0].t) / 60_000 : 0;
  const earlyChain = earlyChainConfirmation(chainIntel);

  let score = 20;
  const positives = [];
  const risks = [];
  let earlyPoints = 0;
  const grantEarly = (points, label) => {
    if (earlyPoints >= EARLY_MOMENTUM_CAP || points <= 0) return;
    const applied = Math.min(points, EARLY_MOMENTUM_CAP - earlyPoints);
    earlyPoints += applied;
    score += applied;
    if (label) positives.push(label);
  };

  if (change1m !== null) {
    if (change1m >= 0.4 && change1m < 1.6) grantEarly(5, '1分钟开始拉升');
    else if (change1m >= 1.6 && change1m < 4) grantEarly(7, '1分钟动量加速');
    else if (change1m >= 4) { grantEarly(3, '1分钟急拉'); risks.push('短线过热'); }
  }
  if (change5m !== null) {
    if (change5m >= 0.8 && change5m < 3) grantEarly(5, '5分钟转强');
    else if (change5m >= 3 && change5m < 8) grantEarly(7, '5分钟加速');
    else if (change5m >= 8) { grantEarly(3, '5分钟已大幅上涨'); risks.push('短线过热'); }
  }
  if (volumeAccelerating) grantEarly(8, '成交增量加速');
  if (flow5mRatio !== null && flow5mRatio >= 0.01) grantEarly(5, '5分钟资金强度突出');
  else if (flow5mRatio !== null && flow5mRatio >= 0.0015) grantEarly(3, '5分钟资金开始升温');
  if (shortChange >= 3) grantEarly(3, `短时上涨 ${shortChange.toFixed(1)}%`);

  if (change24h >= 3 && change24h < 12) { score += 6; positives.push('趋势转强'); }
  else if (change24h >= 12 && change24h < 30) { score += 7; positives.push('价格突破'); }
  else if (change24h >= 30 && change24h < 60) { score += 5; positives.push('涨幅已扩展'); risks.push('追涨风险'); }
  else if (change24h >= 60) { score += 2; positives.push('极端动量'); risks.push('追涨风险'); }
  else if (change24h <= -30) { score -= 12; risks.push('快速回撤'); }
  else if (change24h <= -12) { score -= 6; risks.push('弱势下跌'); }

  if (volumeRatio >= 0.75) { score += 25; positives.push('超高换手'); }
  else if (volumeRatio >= 0.35) { score += 22; positives.push('资金活跃'); }
  else if (volumeRatio >= 0.15) { score += 16; positives.push('成交放量'); }
  else if (volumeRatio >= 0.05) { score += 8; positives.push('换手升温'); }

  if (liquidityRatio >= 0.15) score += 15;
  else if (liquidityRatio >= 0.08) score += 13;
  else if (liquidityRatio >= 0.03) score += 9;
  else if (liquidityRatio >= 0.01) score += 5;
  else if (liquidityRatio < 0.005) { score -= 20; risks.push('流动性极薄'); }
  else { score -= 12; risks.push('流动性偏薄'); }

  if (trades >= 20_000) score += 10;
  else if (trades >= 5_000) score += 8;
  else if (trades >= 1_000) score += 5;

  if (holders >= 20_000) score += 8;
  else if (holders >= 5_000) score += 6;
  else if (holders >= 1_000) score += 3;
  else if (holders < 500) { score -= 10; risks.push('持币地址偏少'); }

  if (ageHours <= 6) { score += 7; positives.push('上线6小时内'); risks.push('上线不足24小时'); }
  else if (ageHours <= 24) { score += 5; positives.push('新币早期窗口'); risks.push('上线不足24小时'); }
  else if (ageHours <= 72) { score += 4; positives.push('上线3日内'); }
  else if (ageHours <= 24 * 7) score += 3;
  else if (ageHours <= 24 * 30) score += 2;

  if (unlockRatio >= 4) { score -= 10; risks.push('低流通高FDV'); }
  if (volumeRatio >= 1.5) { score -= 15; risks.push('换手异常，需排查对敲'); }
  if (change24h >= 10 && intradayPosition >= 0.72 && volumeRatio >= 0.08) { score += 4; positives.push('量价突破确认'); }
  if (change24h > 8 && intradayPosition < 0.35) { score -= 8; risks.push('冲高回落'); }
  if (volumeLiquidityRatio > 25) { score -= 12; risks.push('成交/流动性异常'); }
  else if (volumeLiquidityRatio >= 2 && volumeLiquidityRatio <= 12) { score += 4; positives.push('资金效率良好'); }
  if (trades >= 10_000 && averageTradeUsd < 12) { score -= 10; risks.push('小额高频，疑似机器人'); }
  if (tradesPerHolder > 12) { score -= 8; risks.push('交易密度异常'); }
  if (rangePct > 120) { score -= 8; risks.push('日内波动过大'); }
  if (multiWindowConfluence) { score += 12; positives.push('1/5/15分钟共振'); }
  if (exhaustion) { score -= 14; risks.push('短周期动量衰竭'); }
  if (shortChange <= -3) { score -= 8; risks.push(`短时下跌 ${Math.abs(shortChange).toFixed(1)}%`); }

  if (chainIntel.available) {
    if (chainIntel.smartNetUsd >= 100_000 && chainIntel.smartWallets >= 3) { score += 15; positives.push('Smart Money 集中净买入'); }
    else if (chainIntel.smartNetUsd >= 25_000 && chainIntel.smartWallets >= 2) { score += 10; positives.push('Smart Money 净买入'); }
    else if (earlyChain.smart) { score += 5; positives.push('早期 Smart Money 买入'); }
    if (chainIntel.smartNetUsd <= -50_000) { score -= 14; risks.push('Smart Money 净卖出'); }
    if (chainIntel.largeSwapNetUsd >= 75_000 && chainIntel.largeSwapCount >= 2) { score += 10; positives.push('大额 Swap 净流入'); }
    else if (earlyChain.swap) { score += 4; positives.push('早期大额 Swap'); }
    if (chainIntel.largeSwapNetUsd <= -75_000 && chainIntel.largeSwapCount >= 2) { score -= 12; risks.push('大额 Swap 净流出'); }
    if (chainIntel.liquidityChange5m !== null && chainIntel.liquidityChange5m >= 5) { score += 8; positives.push('池子流动性增加'); }
    if (chainIntel.liquidityChange5m !== null && chainIntel.liquidityChange5m <= -8) { score -= 16; risks.push('池子流动性快速下降'); }
    if (chainIntel.top10Percent !== null && chainIntel.top10Percent >= 80) { score -= 16; risks.push('Top10 持仓高度集中'); }
    else if (chainIntel.top10Percent !== null && chainIntel.top10Percent >= 60) { score -= 8; risks.push('Top10 持仓偏集中'); }
  }

  score = Math.round(clamp(score, 0, 100));
  const hardRisk = liquidity < 100_000 || liquidityRatio < 0.003 || holders < 100
    || (chainIntel.liquidityChange5m !== null && chainIntel.liquidityChange5m <= -20)
    || (chainIntel.top10Percent !== null && chainIntel.top10Percent >= 90);
  const structuralRiskCount = risks.filter((r) => /流动性|FDV|对敲|机器人|交易密度|冲高回落|动量衰竭|持仓|净卖出|净流出/.test(r)).length;
  const quality = hardRisk || structuralRiskCount >= 3 ? '噪声偏高' : score >= 75 && structuralRiskCount === 0 ? '高质量' : '待确认';
  const chainConfirmed = chainIntel.smartNetUsd >= 25_000 && chainIntel.smartWallets >= 2 && chainIntel.largeSwapNetUsd >= 0;
  const stage = exhaustion ? '衰竭'
    : change24h >= 60 || (change5m !== null && change5m >= 8) ? '过热'
      : multiWindowConfluence || chainConfirmed ? '确认'
        : volumeAccelerating || num(chainIntel.largeSwapNetUsd) >= 50_000 || (earlyChain.smart && (change1m === null || change1m > 0)) || (earlyChain.swap && (change5m === null || change5m > 0)) ? '启动'
          : (change5m !== null && change5m > 0.5) || (change1m !== null && change1m >= 0.35) ? '潜伏'
            : '观察';
  let action = '观察';
  let tone = 'watch';
  if (hardRisk || score < 40) { action = '回避'; tone = 'avoid'; }
  else if (change24h <= -20 && volumeRatio > 0.05) { action = '减仓'; tone = 'sell'; }
  else if (score >= 78 && change24h < 50 && risks.length <= 1 && stage !== '潜伏') { action = '试仓'; tone = 'buy'; }
  else if (score >= 62) { action = '重点观察'; tone = 'watch'; }

  const confidence = sampleMinutes >= 15 && liquidity >= 500_000 && holders >= 1000 ? '高' : sampleMinutes >= 5 ? '中' : '建立中';
  const riskFlags = {
    thinLiquidity: liquidityRatio < 0.005 || liquidity < 100_000,
    botLike: (trades >= 10_000 && averageTradeUsd < 12) || tradesPerHolder > 12 || volumeRatio >= 1.5 || volumeLiquidityRatio > 25,
    highDilution: unlockRatio >= 4,
    concentrated: chainIntel.top10Percent !== null && chainIntel.top10Percent >= 80,
    liquidityDrain: chainIntel.liquidityChange5m !== null && chainIntel.liquidityChange5m <= -8
  };

  return {
    score, action, tone, positives: [...new Set(positives)].slice(0, 4), risks: [...new Set(risks)].slice(0, 4),
    quality, stage, confidence, chainIntel,
    metrics: {
      volumeRatio, liquidityRatio, unlockRatio, volumeLiquidityRatio, averageTradeUsd, tradesPerHolder, rangePct, intradayPosition,
      shortChange, volumeDelta, ageHours, change1m, change5m, change15m, flow1m, flow5m, flow15m, flow5mRatio,
      volumeAccelerating, multiWindowConfluence, exhaustion, sampleMinutes, earlyMomentumPoints: earlyPoints, riskFlags
    }
  };
}

function earlyLaunchActive(token) {
  const metrics = token.metrics || {};
  const chain = token.chainIntel || {};
  const earlyChain = earlyChainConfirmation(chain);
  const change24h = num(token.change24h);
  if (token.quality === '噪声偏高' || metrics.exhaustion) return false;
  if (token.score < EARLY_LAUNCH_SCORE) return false;
  if (token.stage !== '潜伏' && token.stage !== '启动') return false;
  if (change24h >= 40 || change24h <= -15) return false;
  if (metrics.change5m !== null && metrics.change5m >= 8) return false;
  const minuteStart = metrics.change1m !== null && metrics.change1m >= 0.4
    && (metrics.change5m === null || metrics.change5m >= 0.5);
  const momentum = metrics.volumeAccelerating === true || minuteStart;
  return momentum || earlyChain.smart || earlyChain.swap;
}

export function alertRules(token) {
  const change1m = optionalNumber(token.metrics?.change1m);
  const change5m = optionalNumber(token.metrics?.change5m);
  const flow5m = optionalNumber(token.metrics?.flow5mRatio);
  const change24h = optionalNumber(token.change24h);
  const chain = token.chainIntel || {};
  const tradable = token.quality !== '噪声偏高';
  return [
    {
      type: 'smart-money', priority: 8, active: chain.available && chain.smartNetUsd >= 25_000 && chain.smartWallets >= 2 && token.score >= 58,
      level: 'critical', label: 'Smart Money 净买入',
      message: `15分钟净买入 $${(chain.smartNetUsd / 1000).toFixed(1)}K，涉及 ${chain.smartWallets} 个地址`
    },
    {
      type: 'liquidity-drain', priority: 8, active: chain.available && chain.liquidityChange5m !== null && chain.liquidityChange5m <= -8,
      level: 'risk', label: '池子流动性下降',
      message: `5分钟池子流动性 ${Number(chain.liquidityChange5m || 0).toFixed(2)}%，注意撤池风险`
    },
    {
      type: 'large-swap', priority: 7, active: chain.available && chain.largeSwapNetUsd >= 75_000 && chain.largeSwapCount >= 2,
      level: 'high', label: '大额 Swap 净流入',
      message: `15分钟大额成交净流入 $${(chain.largeSwapNetUsd / 1000).toFixed(1)}K，共 ${chain.largeSwapCount} 笔`
    },
    {
      type: 'holder-concentration', priority: 7, active: chain.available && chain.top10Percent !== null && chain.top10Percent >= 80,
      level: 'risk', label: '持仓高度集中',
      message: `Top10 地址合计持仓 ${Number(chain.top10Percent || 0).toFixed(2)}%`
    },
    {
      type: 'confluence', priority: 5, active: token.metrics.multiWindowConfluence && token.score >= 65,
      level: 'critical', label: '多周期确认',
      message: `1/5/15 分钟动量共振，5分钟 ${change5m === null ? '—' : `${change5m.toFixed(2)}%`}`
    },
    {
      type: 'flow-surge', priority: 4,
      active: tradable && token.metrics.volumeAccelerating && flow5m !== null && flow5m >= FLOW_SURGE_RATIO && token.score >= FLOW_SURGE_SCORE,
      level: 'high', label: '资金加速',
      message: `成交增量加速，5分钟资金强度 ${flow5m === null ? '—' : `${(flow5m * 100).toFixed(2)}%`}`
    },
    {
      type: 'launch', priority: 3, active: tradable && token.stage === '启动' && token.score >= LAUNCH_SCORE,
      level: 'high', label: '启动信号',
      message: `异动评分 ${token.score}，成交增量开始加速`
    },
    {
      type: 'early-launch', priority: 2.5, active: earlyLaunchActive(token),
      level: 'high', label: '早期启动',
      message: `阶段 ${token.stage}，评分 ${token.score}，1分钟 ${change1m === null ? '—' : `${change1m.toFixed(2)}%`}，5分钟 ${change5m === null ? '—' : `${change5m.toFixed(2)}%`}`
    },
    {
      type: 'strong', priority: 2, active: token.score >= 78 && token.quality !== '噪声偏高' && change24h !== null && change24h < 60,
      level: 'medium', label: '强信号',
      message: `评分升至 ${token.score}，当前建议：${token.action}`
    },
    {
      type: 'exhaustion', priority: 1, active: token.metrics.exhaustion,
      level: 'risk', label: '动量衰竭',
      message: `短周期动量转弱，24H ${change24h === null ? '—' : `${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%`}`
    }
  ];
}

export function canEmitAlert(rule, previous, now = Date.now(), cooldownMs = ALERT_COOLDOWN_MS) {
  if (!rule?.active) return false;
  const prior = previous || { active: false, lastAlertAt: 0 };
  if (prior.active) return false;
  const lastAlertAt = Number(prior.lastAlertAt);
  const neverAlerted = !Number.isFinite(lastAlertAt) || lastAlertAt <= 0;
  if (neverAlerted && FIRST_ALERT_EXEMPT_TYPES.has(rule.type)) return true;
  const anchor = Number.isFinite(lastAlertAt) && lastAlertAt > 0 ? lastAlertAt : 0;
  return now - anchor >= cooldownMs;
}
