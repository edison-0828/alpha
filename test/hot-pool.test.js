import test from 'node:test';
import assert from 'node:assert/strict';
import { alertRules, calculateSignal } from '../signal-engine.js';
import {
  planInstantTick, planMemoryGuard, pruneMemoryState, readHotPoolConfig,
  runInstantTicks, selectHotPool
} from '../hot-pool.js';

const NOW = 1_700_000_000_000;

function token(overrides = {}) {
  return {
    chainId: '56',
    offline: false,
    address: overrides.address,
    alphaId: overrides.alphaId || 'ALPHA_1',
    symbol: overrides.symbol || overrides.address,
    score: 10,
    stage: '观察',
    ...overrides
  };
}

test('hot pool keeps positions, fresh alerts, high scores, and early names within the cap', () => {
  const tokens = [
    token({ address: '0xpos', symbol: 'POS', score: 10, stage: '观察' }),
    token({ address: '0xmanaged', symbol: 'MNG', score: 15, stage: '观察' }),
    token({ address: '0xalert', symbol: 'ALR', score: 20, stage: '观察' }),
    token({ address: '0xold', symbol: 'OLD', score: 19, stage: '观察' }),
    token({ address: '0xhigh', symbol: 'HIGH', score: 90, stage: '过热' }),
    token({ address: '0xmid', symbol: 'MID', score: 70, stage: '确认' }),
    token({ address: '0xearly', symbol: 'EARLY', score: 48, stage: '启动' }),
    token({ address: '0xquiet', symbol: 'QUIET', score: 30, stage: '观察' }),
    token({ address: '0xlowearly', symbol: 'LOW', score: 41, stage: '潜伏' }),
    token({ address: '0xother', symbol: 'ETH', score: 99, stage: '启动', chainId: '1' }),
    token({ address: '0xoff', symbol: 'OFF', score: 99, stage: '启动', offline: true })
  ];
  const selected = selectHotPool(tokens, {
    positionAddresses: ['0xPOS'],
    managedAddresses: ['0xmanaged', '0xpos'],
    recentAlerts: [
      { address: '0xalert', createdAt: NOW - 60_000, chainId: '56' },
      { address: '0xold', createdAt: NOW - 2 * 60 * 60_000 - 1, chainId: '56' },
      { address: '0xother', createdAt: NOW - 1_000, chainId: '1' }
    ],
    maxSize: 6,
    now: NOW,
    recentAlertMs: 2 * 60 * 60_000,
    highScore: 62,
    earlyScore: 42
  });

  assert.equal(selected.length, 6);
  assert.deepEqual(selected.map((item) => item.address), [
    '0xpos', '0xmanaged', '0xalert', '0xhigh', '0xmid', '0xearly'
  ]);
  assert.equal(selected[0].critical, true);
  assert.deepEqual(selected[0].reasons.sort(), ['managed', 'position']);
  assert.equal(selected.find((item) => item.address === '0xearly').critical, false);
  assert.equal(selected.some((item) => item.address === '0xquiet'), false);
  assert.equal(selected.some((item) => item.address === '0xlowearly'), false);
  assert.equal(selected.some((item) => item.address === '0xold'), false);
});

test('new listings outrank high scores and stay critical, while a position keeps the last seat', () => {
  const tokens = [
    token({ address: '0xlist', symbol: 'NEW', score: 5, stage: '观察' }),
    token({ address: '0xhigh', symbol: 'HIGH', score: 99, stage: '过热' }),
    token({ address: '0xpos', symbol: 'POS', score: 1, stage: '观察' }),
    token({ address: '0xoff', symbol: 'OFF', score: 1, stage: '启动', offline: true })
  ];
  const selected = selectHotPool(tokens, {
    positionAddresses: ['0xpos'],
    listingAddresses: ['0xLIST', '0xmissing', '0xoff'],
    maxSize: 2,
    now: NOW,
    highScore: 62,
    earlyScore: 42
  });
  assert.deepEqual(selected.map((item) => item.address), ['0xpos', '0xlist']);
  const listing = selected.find((item) => item.address === '0xlist');
  assert.equal(listing.critical, true);
  assert.equal(listing.reasons.includes('listing'), true);
  assert.equal(selected.some((item) => item.address === '0xhigh'), false);
});

test('hot pool prefers a position over a higher score when the cap is full', () => {
  const tokens = [
    token({ address: '0xpos', score: 1 }),
    token({ address: '0xhot', score: 99, stage: '启动' })
  ];
  const selected = selectHotPool(tokens, {
    positionAddresses: ['0xpos'],
    maxSize: 1,
    now: NOW,
    highScore: 62,
    earlyScore: 42
  });
  assert.deepEqual(selected.map((item) => item.address), ['0xpos']);
});

test('newer alerts outrank older alerts and the pool never passes the cap', () => {
  const tokens = [];
  const alerts = [];
  for (let index = 0; index < 80; index += 1) {
    const address = `0x${index.toString(16).padStart(4, '0')}`;
    tokens.push(token({ address, score: 40 + (index % 5), stage: index % 2 ? '潜伏' : '启动' }));
    alerts.push({ address, createdAt: NOW - index * 1_000, chainId: '56' });
  }
  const selected = selectHotPool(tokens, {
    recentAlerts: alerts,
    maxSize: 32,
    now: NOW,
    recentAlertMs: 2 * 60 * 60_000,
    highScore: 62,
    earlyScore: 42
  });
  assert.equal(selected.length, 32);
  assert.equal(selected[0].address, '0x0000');
  assert.equal(selected[31].address, '0x001f');
  assert.equal(selected.every((item) => item.reasons.includes('alert')), true);
});

test('debounce and memory pressure decide which ticks recompute', () => {
  assert.deepEqual(planInstantTick({ inHotPool: false, now: 1_000 }), { recompute: false, reason: 'cold' });
  assert.equal(planInstantTick({ inHotPool: true, lastRecomputeAt: 1_000, now: 1_299, debounceMs: 300 }).reason, 'debounced');
  assert.equal(planInstantTick({ inHotPool: true, lastRecomputeAt: 1_000, now: 1_300, debounceMs: 300 }).reason, 'hot');
  assert.equal(planInstantTick({
    inHotPool: true, critical: false, skipNonCritical: true, now: 2_000
  }).reason, 'degraded');
  assert.equal(planInstantTick({
    inHotPool: true, critical: true, skipNonCritical: true, lastRecomputeAt: 0, now: 2_000
  }).reason, 'hot');
});

test('cold ticks are not rescored and hot ticks do not append history every time', () => {
  const now = Date.now();
  const history = [
    { t: now - 15 * 60_000 - 1_000, price: 1, volume: 140_000, score: 40 },
    { t: now - 5 * 60_000 - 1_000, price: 1, volume: 150_000, score: 40 },
    { t: now - 60_000 - 1_000, price: 1, volume: 160_000, score: 40 },
    { t: now - 4_000, price: 1, volume: 170_000, score: 40 }
  ];
  const raw = {
    price: 1,
    percentChange24h: 2,
    volume24h: 180_000,
    marketCap: 2_000_000,
    fdv: 2_000_000,
    liquidity: 250_000,
    holders: 1_500,
    count24h: 1_200,
    priceHigh24h: 1.04,
    priceLow24h: 0.98,
    listingTime: now - 4 * 3_600_000
  };
  const baseline = calculateSignal(raw, history, {});
  const hot = {
    address: '0xhot', chainId: '56', alphaId: 'ALPHA_7', symbol: 'HOT',
    price: raw.price, change24h: raw.percentChange24h, volume24h: raw.volume24h,
    marketCap: raw.marketCap, fdv: raw.fdv, liquidity: raw.liquidity, holders: raw.holders,
    trades24h: raw.count24h, high24h: raw.priceHigh24h, low24h: raw.priceLow24h,
    listingTime: raw.listingTime, chainIntel: {}, ...baseline
  };
  const cold = {
    address: '0xcold', chainId: '56', price: 1, change24h: 1, volume24h: 10,
    score: 5, stage: '观察', metrics: { change1m: 0 }
  };
  const coldHistory = [{ t: now - 5_000, price: 1, volume: 10, score: 5 }];
  const histories = new Map([
    ['0xhot', history],
    ['0xcold', coldHistory]
  ]);
  const calls = [];
  const wrapped = (input, rows, chain) => {
    calls.push(input.price);
    return calculateSignal(input, rows, chain);
  };
  const hotByAddress = new Map([['0xhot', { address: '0xhot', critical: true, reasons: ['position'] }]]);
  const tokenByAddress = new Map([['0xhot', hot], ['0xcold', cold]]);
  const lastRecomputeAt = new Map();
  const updates = [
    { address: '0xcold', price: 9, change24h: 80, volume24h: 99 },
    { address: '0xhot', price: 1.008, change24h: 3, volume24h: 190_000 },
    { address: '0xhot', price: 1.02, change24h: 4, volume24h: 191_000 }
  ];

  const first = runInstantTicks({
    updates, tokenByAddress, hotByAddress, lastRecomputeAt, histories, now,
    debounceMs: 300, historySampleMs: 5_000, historyCap: 240,
    calculateSignal: wrapped
  });

  assert.deepEqual(first.rescored, ['0xhot']);
  assert.deepEqual(calls, [1.008]);
  assert.equal(cold.score, 5);
  assert.equal(cold.stage, '观察');
  assert.equal(coldHistory.length, 1);
  assert.equal(history.length, 4);
  assert.equal(first.sampled, 0);
  assert.equal(first.skipped.cold, 1);
  assert.equal(first.skipped.debounced, 1);
  assert.ok(hot.metrics.change1m >= 0.4, `change1m ${hot.metrics.change1m}`);
  assert.ok(hot.score > baseline.score);
  assert.equal(alertRules(hot).some((rule) => rule.type === 'early-launch' && rule.active), true);
  assert.equal(alertRules(cold).some((rule) => rule.type === 'early-launch' && rule.active), false);

  const second = runInstantTicks({
    updates: [{ address: '0xhot', price: 1.03, change24h: 5, volume24h: 192_000 }],
    tokenByAddress, hotByAddress, lastRecomputeAt, histories,
    now: now + 120, debounceMs: 300, historySampleMs: 5_000, historyCap: 240,
    calculateSignal: wrapped
  });
  assert.deepEqual(second.rescored, []);
  assert.equal(calls.length, 1);
  assert.equal(history.length, 4);
  assert.equal(hot.price, 1.008);

  const sampled = runInstantTicks({
    updates: [{ address: '0xhot', price: 1.01, change24h: 3.4, volume24h: 193_000 }],
    tokenByAddress, hotByAddress, lastRecomputeAt, histories,
    now: now + 5_000, debounceMs: 300, historySampleMs: 5_000, historyCap: 4,
    calculateSignal: wrapped
  });
  assert.deepEqual(sampled.rescored, ['0xhot']);
  assert.equal(sampled.sampled, 1);
  assert.equal(history.length, 4);
  assert.equal(history.at(-1).price, 1.01);
  assert.ok(history.at(-1).t === now + 5_000);
});

test('instant scoring uses the REST volume book and leaves the ticker volume on the token', () => {
  const token = {
    address: '0xhot', price: 1, change24h: 2, volume24h: 999_999, bookVolume24h: 180_000,
    marketCap: 2_000_000, fdv: 2_000_000, liquidity: 250_000, holders: 1_500, trades24h: 1_200,
    high24h: 1.1, low24h: 0.9, listingTime: NOW, score: 40, stage: '观察', metrics: {}
  };
  let scoredVolume = 0;
  const history = [{ t: NOW - 5_000, price: 1, volume: 180_000, score: 40 }];
  const result = runInstantTicks({
    updates: [{ address: '0xhot', price: 1.01, change24h: 3, volume24h: 999_999 }],
    tokenByAddress: new Map([['0xhot', token]]),
    hotByAddress: new Map([['0xhot', { address: '0xhot', critical: true, reasons: ['position'] }]]),
    lastRecomputeAt: new Map(),
    histories: new Map([['0xhot', history]]),
    now: NOW,
    debounceMs: 300,
    historySampleMs: 5_000,
    historyCap: 240,
    calculateSignal: (input) => {
      scoredVolume = input.volume24h;
      return { score: 55, stage: '潜伏', action: '重点观察', tone: 'watch', positives: [], risks: [], quality: '待确认', confidence: '中', metrics: { change1m: 1 } };
    }
  });
  assert.deepEqual(result.rescored, ['0xhot']);
  assert.equal(scoredVolume, 180_000);
  assert.equal(token.volume24h, 999_999);
  assert.equal(token.score, 55);
  assert.equal(token.price, 1.01);
  assert.equal(result.sampled, 1);
  assert.equal(history.at(-1).volume, 180_000);
});

test('memory pressure skips non-critical instant recomputes without throwing', () => {
  const tokenByAddress = new Map([['0xearly', { address: '0xearly', price: 1, score: 50, stage: '启动', metrics: {} }]]);
  const calls = [];
  const result = runInstantTicks({
    updates: [{ address: '0xearly', price: 2, change24h: 10 }],
    tokenByAddress,
    hotByAddress: new Map([['0xearly', { address: '0xearly', critical: false, reasons: ['early'] }]]),
    lastRecomputeAt: new Map(),
    histories: new Map(),
    now: NOW,
    debounceMs: 300,
    historySampleMs: 5_000,
    historyCap: 120,
    skipNonCritical: true,
    calculateSignal: () => { calls.push('scored'); return { score: 1, metrics: {} }; }
  });
  assert.deepEqual(result.rescored, []);
  assert.equal(result.skipped.degraded, 1);
  assert.deepEqual(calls, []);
  assert.equal(tokenByAddress.get('0xearly').score, 50);
});

test('env caps and RSS pressure shrink history and the hot pool', () => {
  const defaults = readHotPoolConfig({});
  assert.equal(defaults.hotPoolMax, 48);
  assert.equal(defaults.debounceMs, 300);
  assert.equal(defaults.historyCap, 240);
  assert.equal(defaults.rssSoftMb, 512);
  assert.equal(defaults.historySampleMs, 5_000);

  const clamped = readHotPoolConfig({
    ALPHAPULSE_HOT_POOL_MAX: '999',
    ALPHAPULSE_HOT_DEBOUNCE_MS: '10',
    ALPHAPULSE_MAX_HISTORY: '9999',
    ALPHAPULSE_RSS_SOFT_MB: '0'
  });
  assert.equal(clamped.hotPoolMax, 64);
  assert.equal(clamped.debounceMs, 200);
  assert.equal(clamped.historyCap, 240);
  assert.equal(clamped.rssSoftMb, 0);
  assert.equal(planMemoryGuard(clamped, { rss: 8 * 1024 ** 3 }).pressure, false);

  const lowered = readHotPoolConfig({ ALPHAPULSE_MAX_HISTORY: '80', ALPHAPULSE_HOT_DEBOUNCE_MS: '900' });
  assert.equal(lowered.historyCap, 80);
  assert.equal(lowered.pressureHistoryCap, 80);
  assert.equal(lowered.debounceMs, 500);

  const config = readHotPoolConfig({});
  const calm = planMemoryGuard(config, { rss: 200 * 1_048_576 });
  assert.equal(calm.pressure, false);
  assert.equal(calm.hotPoolMax, 48);
  assert.equal(calm.historyCap, 240);
  assert.equal(calm.skipNonCriticalInstant, false);

  const hot = planMemoryGuard(config, { rss: 512 * 1_048_576 });
  assert.equal(hot.pressure, true);
  assert.equal(hot.hotPoolMax, 16);
  assert.equal(hot.historyCap, 120);
  assert.equal(hot.maxTrackedHistories, 180);
  assert.equal(hot.maxChainTokens, 24);
  assert.equal(hot.skipNonCriticalInstant, true);
});

test('prune drops cold histories and chain maps but keeps the hot set', () => {
  const histories = new Map();
  for (let index = 0; index < 5; index += 1) {
    const rows = [];
    for (let point = 0; point < 10; point += 1) rows.push({ t: index * 1_000 + point, price: 1, volume: 1, score: 1 });
    histories.set(`0x${index}`, rows);
  }
  const chainEventLog = new Map([
    ['0x0', [{ timestamp: 10 }]],
    ['0x1', [{ timestamp: 50 }]],
    ['0x9', [{ timestamp: 5 }]]
  ]);
  const chainLiquidityHistory = new Map([['0x9', [{ t: 5, liquidity: 1 }]]]);
  const chainHolderState = new Map([['0x1', { lastUpdated: 40 }]]);
  const pruned = pruneMemoryState({
    histories,
    chainEventLog,
    chainLiquidityHistory,
    chainHolderState,
    keepAddresses: new Set(['0x0']),
    historyCap: 4,
    maxTrackedHistories: 2,
    maxChainTokens: 1
  });

  assert.equal(histories.size, 2);
  assert.equal(histories.has('0x0'), true);
  assert.equal(histories.get('0x0').length, 4);
  assert.equal(histories.get('0x0').at(-1).t, 9);
  assert.equal(histories.has('0x4'), true);
  assert.equal(chainEventLog.size, 1);
  assert.equal(chainEventLog.has('0x0'), true);
  assert.equal(chainLiquidityHistory.size, 0);
  assert.equal(chainHolderState.size, 0);
  assert.equal(pruned.droppedChain, 2);
  assert.ok(pruned.truncated >= 1);
});
