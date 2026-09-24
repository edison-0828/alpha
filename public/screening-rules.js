export const defaultScreeningRules = {
  minScore: 0, minLiquidity: 0, minMarketCap: 0, minHolders: 0,
  minChange: -100, maxChange: 10000, minTurnover: 0, maxDilution: 100,
  minChange5m: -100, minFlow5m: 0, maxRange: 10000, minSamples: 0,
  minSmartNet: 0, minLargeSwap: 0, minLiquidityChange: -100, maxTop10: 100,
  excludeThin: false, excludeBots: false, excludeDilution: false, onlyQuality: false,
  requireConfluence: false, requireAcceleration: false, excludeExhaustion: false, excludeNew: false,
  allowedStages: []
};

export const screeningPresets = {
  breakout: { minScore:55, minLiquidity:200, minMarketCap:2, minHolders:500, minChange:5, maxChange:80, minTurnover:5, maxDilution:5, excludeThin:true, excludeBots:true, excludeDilution:false, onlyQuality:false },
  confirmed: { minScore:70, minLiquidity:500, minMarketCap:5, minHolders:2000, minChange:3, maxChange:45, minTurnover:8, maxDilution:3, excludeThin:true, excludeBots:true, excludeDilution:true, onlyQuality:false },
  ake: { minScore:0, minLiquidity:300, minMarketCap:10, minHolders:1000, minChange:15, maxChange:10000, minTurnover:5, maxDilution:10, excludeThin:false, excludeBots:false, excludeDilution:false, onlyQuality:false },
  safe: { minScore:72, minLiquidity:1000, minMarketCap:10, minHolders:5000, minChange:0, maxChange:30, minTurnover:3, maxDilution:2.5, excludeThin:true, excludeBots:true, excludeDilution:true, onlyQuality:true, excludeExhaustion:true },
  flowStart: { minScore:58, minLiquidity:300, minMarketCap:2, minHolders:800, minChange:-5, maxChange:40, minTurnover:3, maxDilution:5, minChange5m:-3, minFlow5m:0.05, minSamples:5, requireAcceleration:true, excludeThin:true, excludeBots:true, excludeExhaustion:true },
  trendConfirm: { minScore:70, minLiquidity:500, minMarketCap:5, minHolders:1500, minChange:2, maxChange:50, minTurnover:5, maxDilution:4, minChange5m:1.2, minFlow5m:0.2, minSamples:15, requireConfluence:true, excludeThin:true, excludeBots:true, excludeExhaustion:true },
  antiFomo: { minScore:65, minLiquidity:500, minMarketCap:5, minHolders:1000, minChange:0, maxChange:30, minTurnover:3, maxDilution:3, minChange5m:-2, minFlow5m:0.05, maxRange:70, minSamples:15, excludeThin:true, excludeBots:true, excludeDilution:true, excludeExhaustion:true, excludeNew:true },
  onchainConfirm: { minScore:58, minLiquidity:300, minMarketCap:2, minHolders:800, minChange:-5, maxChange:45, minTurnover:3, maxDilution:5, minSmartNet:25, minLargeSwap:50, minLiquidityChange:-3, maxTop10:80, excludeThin:true, excludeBots:true, excludeExhaustion:true },
  smallBet: {
    minScore: 42, minLiquidity: 120, minMarketCap: 0.3, minHolders: 200,
    minChange: -10, maxChange: 35, minTurnover: 1, maxDilution: 8,
    minChange5m: -100, minFlow5m: 0, maxRange: 120, minSamples: 0,
    excludeThin: true, excludeBots: true, excludeDilution: false, onlyQuality: false,
    requireConfluence: false, requireAcceleration: false, excludeExhaustion: true, excludeNew: false,
    allowedStages: ['潜伏', '启动']
  }
};

export function rulesForPreset(name) {
  const preset = screeningPresets[name];
  if (!preset) throw new Error(`Unknown screening preset: ${name}`);
  return { ...defaultScreeningRules, ...preset };
}

export function passesScreeningRules(token, rules) {
  const flags = token.metrics?.riskFlags || {};
  const dilution = token.metrics?.unlockRatio || 0;
  const chain = token.chainIntel || {};
  const metrics = token.metrics || {};
  if (Array.isArray(rules.allowedStages) && rules.allowedStages.length && !rules.allowedStages.includes(token.stage)) return false;
  return token.score >= rules.minScore
    && token.liquidity >= rules.minLiquidity * 1000
    && token.marketCap >= rules.minMarketCap * 1_000_000
    && token.holders >= rules.minHolders
    && token.change24h >= rules.minChange && token.change24h <= rules.maxChange
    && metrics.volumeRatio * 100 >= rules.minTurnover
    && dilution <= rules.maxDilution
    && (rules.minChange5m <= -100 || (metrics.change5m !== null && metrics.change5m >= rules.minChange5m))
    && (rules.minFlow5m <= 0 || (metrics.flow5mRatio !== null && metrics.flow5mRatio * 100 >= rules.minFlow5m))
    && metrics.rangePct <= rules.maxRange
    && metrics.sampleMinutes >= rules.minSamples
    && (rules.minSmartNet <= 0 || (chain.available && chain.smartNetUsd >= rules.minSmartNet * 1000))
    && (rules.minLargeSwap <= 0 || (chain.available && chain.largeSwapNetUsd >= rules.minLargeSwap * 1000))
    && (rules.minLiquidityChange <= -100 || (chain.available && chain.liquidityChange5m !== null && chain.liquidityChange5m >= rules.minLiquidityChange))
    && (rules.maxTop10 >= 100 || (chain.available && chain.top10Percent !== null && chain.top10Percent <= rules.maxTop10))
    && (!rules.excludeThin || !flags.thinLiquidity)
    && (!rules.excludeBots || !flags.botLike)
    && (!rules.excludeDilution || !flags.highDilution)
    && (!rules.onlyQuality || token.quality === '高质量')
    && (!rules.requireConfluence || metrics.multiWindowConfluence)
    && (!rules.requireAcceleration || metrics.volumeAccelerating)
    && (!rules.excludeExhaustion || !metrics.exhaustion)
    && (!rules.excludeNew || metrics.ageHours >= 24);
}
