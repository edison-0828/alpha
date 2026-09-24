import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_COOLDOWN_MS, FIRST_ALERT_EXEMPT_TYPES, alertRules, calculateSignal, canEmitAlert
} from '../signal-engine.js';
import { passesScreeningRules, rulesForPreset, screeningPresets } from '../public/screening-rules.js';
import { DEFAULT_TRADING_CONFIG, entryEvaluation } from '../trading-engine.js';

const HOUR = 3_600_000;

function rawToken(overrides = {}) {
  return {
    price: 1.02,
    percentChange24h: 2,
    volume24h: 180_000,
    marketCap: 2_000_000,
    fdv: 2_000_000,
    liquidity: 250_000,
    holders: 1_500,
    count24h: 1_200,
    priceHigh24h: 1.04,
    priceLow24h: 0.98,
    listingTime: Date.now() - 4 * HOUR,
    ...overrides
  };
}

function tape({ price = 1.02, price1m = 1.008, price5m = 1, price15m = 1.005, volume = 180_000, volume1m = 168_000, volume5m = 150_000, volume15m = 140_000 } = {}) {
  const now = Date.now();
  return [
    { t: now - 15 * 60_000 - 1_000, price: price15m, volume: volume15m },
    { t: now - 5 * 60_000 - 1_000, price: price5m, volume: volume5m },
    { t: now - 60_000 - 1_000, price: price1m, volume: volume1m },
    { t: now - 5_000, price, volume }
  ];
}

function flatTape(price = 1.02, volume = 180_000) {
  return tape({
    price, price1m: price, price5m: price, price15m: price,
    volume, volume1m: volume, volume5m: volume, volume15m: volume
  });
}

const earlyChain = {
  available: true,
  smartNetUsd: 10_000,
  smartWallets: 1,
  largeSwapNetUsd: 22_000,
  largeSwapCount: 1,
  liquidityChange5m: 1,
  top10Percent: 30
};

function activeTypes(token) {
  return alertRules(token).filter((rule) => rule.active).map((rule) => rule.type);
}

test('early momentum outscores an already extended 24h move', () => {
  const early = calculateSignal(rawToken(), tape(), earlyChain);
  const late = calculateSignal(rawToken({
    percentChange24h: 75,
    listingTime: Date.now() - 60 * 24 * HOUR
  }), flatTape(), {});
  assert.ok(early.score >= 62, `early score ${early.score} should be worth watching`);
  assert.ok(early.score > late.score, `early ${early.score} should beat late 24h ${late.score}`);
  assert.ok(late.score < 62, `late 24h score ${late.score} should not be worth watching on its own`);
  assert.ok(['潜伏', '启动'].includes(early.stage), early.stage);
  assert.equal(late.stage, '过热');
  assert.ok(early.action === '重点观察' || early.action === '试仓');
});

test('short-window momentum, young listings, and early chain intel each add score', () => {
  const base = rawToken({ listingTime: Date.now() - 45 * 24 * HOUR });
  const flat = calculateSignal(base, flatTape(), {});
  const moving = calculateSignal(base, tape(), {});
  const young = calculateSignal(rawToken(), flatTape(), {});
  const withSmart = calculateSignal(base, flatTape(), {
    available: true, smartNetUsd: 10_000, smartWallets: 1, largeSwapNetUsd: 0, largeSwapCount: 0,
    liquidityChange5m: 0, top10Percent: 30
  });
  const withSwap = calculateSignal(base, flatTape(), {
    available: true, smartNetUsd: 0, smartWallets: 0, largeSwapNetUsd: 22_000, largeSwapCount: 1,
    liquidityChange5m: 0, top10Percent: 30
  });
  assert.ok(moving.score >= flat.score + 8, `moving ${moving.score} vs flat ${flat.score}`);
  assert.equal(moving.metrics.volumeAccelerating, true);
  assert.ok(moving.metrics.change1m > 0.4 && moving.metrics.change5m > 0.8);
  assert.ok(young.score >= flat.score + 4, `young ${young.score} vs older ${flat.score}`);
  assert.ok(young.metrics.ageHours <= 6);
  assert.ok(withSmart.score >= flat.score + 5, `smart ${withSmart.score} vs flat ${flat.score}`);
  assert.ok(withSwap.score >= flat.score + 4, `swap ${withSwap.score} vs flat ${flat.score}`);
  assert.ok(withSmart.positives.includes('早期 Smart Money 买入') || withSmart.score > flat.score);
});

test('latent stage stays research-only even when the score is high', () => {
  const signal = calculateSignal(rawToken({
    percentChange24h: 8,
    volume24h: 700_000,
    liquidity: 400_000,
    holders: 20_000,
    count24h: 20_000
  }), tape({
    price: 1.02, price1m: 1.014, price5m: 1.008, price15m: 1.012,
    volume: 700_000, volume1m: 700_000, volume5m: 700_000, volume15m: 700_000
  }), {});
  assert.equal(signal.stage, '潜伏');
  assert.ok(signal.score >= 78, `expected a high latent score, got ${signal.score}`);
  assert.equal(signal.action, '重点观察');
  const candidate = {
    chainId: '56', address: '0xlatent', symbol: 'LATENT', price: 1.02, offline: false,
    liquidity: 400_000, holders: 20_000, change24h: 8, ...signal
  };
  assert.equal(entryEvaluation(candidate, DEFAULT_TRADING_CONFIG).eligible, false);
});

test('early-launch fires below the old launch threshold and relaxed rules stay selective', () => {
  const early = { ...calculateSignal(rawToken(), tape(), earlyChain), change24h: 2 };
  const earlyTypes = activeTypes(early);
  assert.ok(earlyTypes.includes('early-launch'), earlyTypes.join(','));
  assert.ok(early.score >= 50 ? earlyTypes.includes('launch') : !earlyTypes.includes('launch'));

  const launching = {
    score: 50, stage: '启动', quality: '待确认', change24h: 12, action: '观察',
    metrics: { change5m: 2, change1m: 0.6, flow5mRatio: 0.0012, volumeAccelerating: true, exhaustion: false, multiWindowConfluence: false },
    chainIntel: { available: false }
  };
  assert.ok(activeTypes(launching).includes('launch'));
  assert.ok(activeTypes(launching).includes('flow-surge'));
  assert.ok(activeTypes(launching).includes('early-launch'));
  assert.ok(!activeTypes({ ...launching, score: 49 }).includes('launch'));
  assert.ok(!activeTypes({ ...launching, score: 49 }).includes('flow-surge'));
  assert.ok(activeTypes({ ...launching, score: 42, stage: '潜伏' }).includes('early-launch'));
  assert.ok(!activeTypes({ ...launching, score: 42, stage: '潜伏' }).includes('launch'));
  assert.ok(!activeTypes({ ...launching, score: 41, stage: '潜伏' }).includes('early-launch'));
  assert.ok(!activeTypes({ ...launching, quality: '噪声偏高' }).includes('early-launch'));
  assert.ok(!activeTypes({ ...launching, quality: '噪声偏高' }).includes('launch'));
  assert.ok(!activeTypes({ ...launching, quality: '噪声偏高' }).includes('flow-surge'));
  assert.ok(!activeTypes({ ...launching, metrics: { ...launching.metrics, flow5mRatio: 0.0011 } }).includes('flow-surge'));
  assert.ok(!activeTypes({ ...launching, change24h: 55 }).includes('early-launch'));

  const rules = alertRules(launching);
  assert.ok(rules.find((rule) => rule.type === 'launch').priority > rules.find((rule) => rule.type === 'early-launch').priority);
});

test('first exempt alerts ignore cooldown and repeats still wait', () => {
  const now = 90_000;
  for (const type of ['early-launch', 'launch', 'flow-surge', 'smart-money']) {
    assert.equal(FIRST_ALERT_EXEMPT_TYPES.has(type), true);
    assert.equal(canEmitAlert({ type, active: true }, { active: false, lastAlertAt: 0 }, now), true);
    assert.equal(canEmitAlert({ type, active: true }, { active: false }, now), true);
  }
  assert.equal(canEmitAlert(
    { type: 'early-launch', active: true },
    { active: false, lastAlertAt: now - 60_000 },
    now
  ), false);
  assert.equal(canEmitAlert(
    { type: 'launch', active: true },
    { active: false, lastAlertAt: now - ALERT_COOLDOWN_MS },
    now
  ), true);
  assert.equal(canEmitAlert(
    { type: 'flow-surge', active: true },
    { active: true, lastAlertAt: 0 },
    now
  ), false);
  assert.equal(canEmitAlert(
    { type: 'strong', active: true },
    { active: false, lastAlertAt: 0 },
    now
  ), false);
  assert.equal(canEmitAlert(
    { type: 'strong', active: true },
    { active: false, lastAlertAt: 0 },
    ALERT_COOLDOWN_MS
  ), true);
});

test('以小博大 keeps early stages and a lower score floor than conservative presets', () => {
  const rules = rulesForPreset('smallBet');
  assert.deepEqual(screeningPresets.smallBet.allowedStages, ['潜伏', '启动']);
  assert.ok(rules.minScore < rulesForPreset('flowStart').minScore);
  assert.ok(rules.minScore < rulesForPreset('safe').minScore);
  assert.equal(rules.requireAcceleration, false);
  assert.equal(rules.excludeNew, false);
  assert.ok(rules.maxChange <= 35);

  const metrics = {
    volumeRatio: 0.08, unlockRatio: 1, change5m: 1.2, flow5mRatio: 0.002, rangePct: 20,
    sampleMinutes: 2, multiWindowConfluence: false, volumeAccelerating: true, exhaustion: false, ageHours: 4,
    riskFlags: { thinLiquidity: false, botLike: false, highDilution: false }
  };
  const early = {
    score: 48, stage: '启动', quality: '待确认', liquidity: 200_000, marketCap: 1_000_000,
    holders: 400, change24h: 6, metrics, chainIntel: { available: false }
  };
  assert.equal(passesScreeningRules(early, rules), true);
  assert.equal(passesScreeningRules({ ...early, stage: '过热', score: 90, change24h: 20 }, rules), false);
  assert.equal(passesScreeningRules({ ...early, stage: '确认' }, rules), false);
  assert.equal(passesScreeningRules({ ...early, score: 41 }, rules), false);
  assert.equal(passesScreeningRules({ ...early, change24h: 48 }, rules), false);
  assert.equal(passesScreeningRules({ ...early, stage: '潜伏', metrics: { ...metrics, volumeAccelerating: false } }, rules), true);
});

test('auto trading defaults stay conservative and paper-only', () => {
  assert.equal(DEFAULT_TRADING_CONFIG.enabled, false);
  assert.equal(DEFAULT_TRADING_CONFIG.executionMode, 'paper');
  assert.ok(DEFAULT_TRADING_CONFIG.minScore >= 82);
  assert.equal(DEFAULT_TRADING_CONFIG.requireHighQuality, true);
});
