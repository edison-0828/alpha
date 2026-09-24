import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createListingWatch, diffAlphaListings, exportListingWatch, hydrateListingWatch,
  listingKey, listingWatchSummary, readListingWatchConfig, recentListingAddresses, toListingAlert
} from '../listing-watch.js';

const NOW = 1_700_000_000_000;
const LISTED_AT = Date.UTC(2026, 0, 2, 0, 30);

function addr(n) {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

function token(n, overrides = {}) {
  const address = overrides.address || addr(n);
  return {
    chainId: '56',
    offline: false,
    address,
    contractAddress: address,
    alphaId: `ALPHA_${n}`,
    symbol: `T${n}`,
    name: `Token ${n}`,
    price: 1.25,
    liquidity: 250_000,
    listingTime: LISTED_AT,
    score: 48,
    stage: '潜伏',
    action: '观察',
    ...overrides,
    address: overrides.address || address,
    contractAddress: overrides.contractAddress || overrides.address || address
  };
}

function quiet(extra = {}) {
  return { minBaseline: 10_000, confirmMisses: 3, cooldownMs: 60_000, ...extra };
}

test('listing identity uses the contract, then alpha id, and never the display name', () => {
  const address = addr(7);
  assert.equal(listingKey({ chainId: '56', contractAddress: address.toUpperCase(), symbol: 'AAA' }), `56:addr:${address}`);
  assert.equal(listingKey({ chainId: '56', address, symbol: 'BBB', alphaId: 'ALPHA_9' }), `56:addr:${address}`);
  assert.equal(listingKey({ chainId: '56', alphaId: 'alpha_15', symbol: 'CCC' }), '56:alpha:ALPHA_15');
  assert.equal(listingKey({ chainId: '56', tokenId: '88', symbol: 'DDD' }), '56:id:88');
  assert.equal(listingKey({ chainId: '56', symbol: 'ONLY', name: 'Only Name' }), '');
  assert.equal(listingKey({ chainId: '56', id: '88' }), '56:id:88');
});

test('the first snapshot is only a baseline', () => {
  const state = createListingWatch();
  const first = diffAlphaListings(state, [token(1), token(2)], NOW, quiet());
  assert.equal(first.status, 'baseline');
  assert.deepEqual(first.events, []);
  assert.equal(state.seen.size, 2);
  const second = diffAlphaListings(state, [token(1), token(2, { symbol: 'RENAMED', price: 9 })], NOW + 5_000, quiet());
  assert.equal(second.status, 'diff');
  assert.deepEqual(second.events, []);
});

test('a new contract emits one alpha-new alert and a duplicate row does not', () => {
  const state = createListingWatch();
  const listed = token(3, { symbol: 'NEW', name: 'New Coin' });
  diffAlphaListings(state, [token(1)], NOW, quiet());
  const result = diffAlphaListings(state, [token(1), listed, { ...listed, symbol: 'NEW-COPY' }], NOW + 5_000, quiet());
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.equal(event.kind, 'listing');
  assert.equal(event.type, 'alpha-new');
  assert.equal(event.level, 'high');
  assert.equal(event.label, 'Alpha 新上架');
  assert.match(event.message, /NEW/);
  assert.match(event.message, /合约 0x0000…0003/);
  assert.match(event.message, /上线/);
  assert.match(event.message, /08:30/);
  assert.match(event.message, /现价 \$1\.25/);
  assert.match(event.message, /流动性 \$250\.0K/);
  assert.doesNotMatch(event.message, /时间未知/);

  const alert = toListingAlert(event, NOW + 5_000, 'alert-1');
  assert.equal(alert.kind, 'listing');
  assert.equal(alert.type, 'alpha-new');
  assert.equal(alert.level, 'high');
  assert.equal(typeof alert.symbol, 'string');
  assert.equal(alert.address, addr(3));
  assert.equal(alert.chainId, '56');
  assert.equal(alert.stage, '潜伏');
  assert.equal(alert.score, 48);
  assert.equal(alert.liquidity, 250_000);
  assert.equal(alert.via, 'rest');

  const repeat = diffAlphaListings(state, [token(1), listed], NOW + 10_000, quiet());
  assert.deepEqual(repeat.events, []);
  assert.deepEqual(recentListingAddresses(state, NOW + 10_000), [addr(3)]);
});

test('the same display name with a new contract is still a listing', () => {
  const state = createListingWatch();
  diffAlphaListings(state, [token(1, { symbol: 'SAME' })], NOW, quiet());
  const result = diffAlphaListings(state, [token(1, { symbol: 'SAME' }), token(2, { symbol: 'SAME' })], NOW + 5_000, quiet());
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].token.address, addr(2));
});

test('a one-cycle gap is jitter and does not delist or relist', () => {
  const state = createListingWatch();
  const options = quiet();
  diffAlphaListings(state, [token(1), token(2)], NOW, options);
  const missing = diffAlphaListings(state, [token(1)], NOW + 5_000, options);
  assert.deepEqual(missing.events, []);
  assert.equal(state.pending.size, 1);
  const back = diffAlphaListings(state, [token(1), token(2)], NOW + 10_000, options);
  assert.deepEqual(back.events, []);
  assert.equal(state.pending.size, 0);
  assert.equal(state.jitterResets, 1);
  assert.equal(state.delistedTotal, 0);
});

test('confirmMisses below 2 still waits for a second miss', () => {
  const state = createListingWatch();
  const options = quiet({ confirmMisses: 1 });
  diffAlphaListings(state, [token(1), token(2)], NOW, options);
  assert.deepEqual(diffAlphaListings(state, [token(1)], NOW + 5_000, options).events, []);
  const confirmed = diffAlphaListings(state, [token(1)], NOW + 10_000, options);
  assert.equal(confirmed.events.length, 1);
  assert.equal(confirmed.events[0].type, 'alpha-delist');
  assert.equal(confirmed.events[0].kind, 'delisting');
});

test('three consecutive misses emit one delist alert and do not repeat', () => {
  const state = createListingWatch();
  const options = quiet();
  const gone = token(4, { symbol: 'OLD', price: 0.42, liquidity: 18_000 });
  diffAlphaListings(state, [token(1), gone], NOW, options);
  assert.deepEqual(diffAlphaListings(state, [token(1)], NOW + 5_000, options).events, []);
  assert.deepEqual(diffAlphaListings(state, [token(1)], NOW + 10_000, options).events, []);
  const result = diffAlphaListings(state, [token(1)], NOW + 15_000, options);
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.equal(event.kind, 'delisting');
  assert.equal(event.type, 'alpha-delist');
  assert.equal(event.level, 'risk');
  assert.equal(event.label, 'Alpha 下架');
  assert.match(event.message, /OLD/);
  assert.match(event.message, /连续 3 次/);
  assert.match(event.message, /合约/);
  assert.match(event.message, /最后价格 \$0\.4200/);
  assert.match(event.message, /流动性 \$18\.0K/);
  const alert = toListingAlert(event, NOW + 15_000, 'alert-2');
  assert.equal(alert.kind, 'delisting');
  assert.equal(alert.level, 'risk');
  assert.equal(alert.stage, '下架');
  assert.equal(alert.action, '已离开列表');
  assert.equal(alert.symbol, 'OLD');
  assert.equal(alert.address, addr(4));
  const repeat = diffAlphaListings(state, [token(1)], NOW + 20_000, options);
  assert.deepEqual(repeat.events, []);
  assert.equal(state.pending.size, 0);
});

test('offline tokens use the same confirmation window', () => {
  const state = createListingWatch();
  const options = quiet({ confirmMisses: 2 });
  diffAlphaListings(state, [token(1), token(2)], NOW, options);
  assert.deepEqual(diffAlphaListings(state, [token(1), token(2, { offline: true })], NOW + 5_000, options).events, []);
  const result = diffAlphaListings(state, [token(1), token(2, { offline: true })], NOW + 10_000, options);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'alpha-delist');
  assert.equal(result.events[0].token.address, addr(2));
});

test('other chains and unkeyed rows are ignored', () => {
  const state = createListingWatch();
  diffAlphaListings(state, [token(1)], NOW, quiet());
  const result = diffAlphaListings(state, [
    token(1),
    token(8, { chainId: '1', symbol: 'ETH' }),
    { chainId: '56', symbol: 'GHOST', name: 'Ghost' }
  ], NOW + 5_000, quiet());
  assert.deepEqual(result.events, []);
  assert.equal(state.seen.size, 1);
});

test('numeric chain id 56 still matches the BSC list', () => {
  const state = createListingWatch();
  diffAlphaListings(state, [token(1)], NOW, quiet());
  const result = diffAlphaListings(state, [token(1), token(9, { chainId: 56, symbol: 'BSC' })], NOW + 5_000, quiet());
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].token.symbol, 'BSC');
});

test('an empty or sharply smaller list does not mass-delist', () => {
  const state = createListingWatch();
  const options = { minBaseline: 40, confirmMisses: 2, maxDelistPerCycle: 8, dropRatio: 0.25 };
  const full = Array.from({ length: 40 }, (_, index) => token(index + 1));
  diffAlphaListings(state, full, NOW, options);
  const empty = diffAlphaListings(state, [], NOW + 5_000, options);
  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.events, []);
  assert.equal(state.seen.size, 40);
  const shrunk = diffAlphaListings(state, full.slice(0, 10), NOW + 10_000, options);
  assert.equal(shrunk.status, 'incomplete');
  assert.deepEqual(shrunk.events, []);
  assert.equal(state.pending.size, 0);
  const restored = diffAlphaListings(state, full, NOW + 15_000, options);
  assert.deepEqual(restored.events, []);
  assert.equal(state.delistedTotal, 0);
});

test('a sudden flood of new keys rebases without alerting', () => {
  const state = createListingWatch();
  const options = { minBaseline: 40, confirmMisses: 3, maxNewPerCycle: 8 };
  const base = Array.from({ length: 40 }, (_, index) => token(index + 1));
  diffAlphaListings(state, base, NOW, options);
  const flood = base.concat(Array.from({ length: 24 }, (_, index) => token(100 + index)));
  const result = diffAlphaListings(state, flood, NOW + 5_000, options);
  assert.equal(result.status, 'rebaseline');
  assert.deepEqual(result.events, []);
  assert.equal(state.seen.size, 64);
  const one = diffAlphaListings(state, flood.concat(token(999, { symbol: 'REAL' })), NOW + 10_000, options);
  assert.equal(one.events.length, 1);
  assert.equal(one.events[0].token.symbol, 'REAL');
});

test('listing cooldown suppresses a quick return and allows a later one', () => {
  const state = createListingWatch();
  const options = quiet({ confirmMisses: 2, cooldownMs: 10_000 });
  const keep = token(1);
  const fresh = token(5, { symbol: 'BACK' });
  diffAlphaListings(state, [keep], 1_000_000, options);
  const listed = diffAlphaListings(state, [keep, fresh], 1_001_000, options);
  assert.equal(listed.events.length, 1);
  diffAlphaListings(state, [keep], 1_002_000, options);
  const delisted = diffAlphaListings(state, [keep], 1_003_000, options);
  assert.equal(delisted.events.length, 1);
  const tooSoon = diffAlphaListings(state, [keep, fresh], 1_004_000, options);
  assert.deepEqual(tooSoon.events, []);
  assert.equal(state.suppressedCooldown, 1);
  diffAlphaListings(state, [keep], 1_014_000, options);
  const removed = diffAlphaListings(state, [keep], 1_015_000, options);
  assert.equal(removed.events.filter((event) => event.type === 'alpha-delist').length, 1);
  const again = diffAlphaListings(state, [keep, fresh], 1_016_000, options);
  assert.equal(again.events.filter((event) => event.type === 'alpha-new').length, 1);
});

test('snapshots stay bounded and JSON state keeps the miss count', () => {
  const state = createListingWatch();
  const options = quiet({ confirmMisses: 3, maxNewPerCycle: 50, pendingCap: 64, cooldownCap: 400, recentCap: 64 });
  diffAlphaListings(state, Array.from({ length: 30 }, (_, index) => token(index + 1)), NOW, options);
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const generation = Array.from({ length: 30 }, (_, index) => token(10_000 + cycle * 30 + index));
    diffAlphaListings(state, generation, NOW + (cycle + 1) * 5_000, options);
  }
  assert.equal(state.seen.size, 30);
  assert.ok(state.pending.size <= 64);
  assert.ok(state.cooldowns.size <= 400);
  assert.ok(state.recentListings.size <= 64);

  const watched = createListingWatch();
  diffAlphaListings(watched, [token(1), token(2)], NOW, options);
  diffAlphaListings(watched, [token(1)], NOW + 5_000, options);
  const restored = hydrateListingWatch(JSON.parse(JSON.stringify(exportListingWatch(watched))));
  assert.equal(restored.primed, true);
  assert.equal(restored.pending.size, 1);
  assert.equal([...restored.pending.values()][0].misses, 1);
  assert.deepEqual(diffAlphaListings(restored, [token(1), token(2)], NOW + 10_000, options).events, []);
  assert.equal(restored.jitterResets, 1);
  diffAlphaListings(restored, [token(1)], NOW + 15_000, options);
  diffAlphaListings(restored, [token(1)], NOW + 20_000, options);
  const delist = diffAlphaListings(restored, [token(1)], NOW + 25_000, options);
  assert.equal(delist.events.length, 1);
  assert.equal(delist.events[0].type, 'alpha-delist');
  const summary = listingWatchSummary(restored, options);
  assert.equal(summary.delistings, 1);
  assert.equal(summary.pendingMissing, 0);
  assert.equal(summary.confirmMisses, 3);
  assert.ok(summary.lastDiffAt > 0);
});

test('an oversized snapshot is ignored instead of trimming into false diffs', () => {
  const state = createListingWatch();
  const overflow = diffAlphaListings(state, [token(1), token(2), token(3)], NOW, quiet({ snapshotCap: 2 }));
  assert.equal(overflow.status, 'overflow');
  assert.equal(state.primed, false);
  const baseline = diffAlphaListings(state, [token(1), token(2)], NOW + 5_000, quiet({ snapshotCap: 2 }));
  assert.equal(baseline.status, 'baseline');
  assert.equal(state.seen.size, 2);
});

test('listing watch config clamps a single-miss delist and a tiny cooldown', () => {
  const defaults = readListingWatchConfig({});
  assert.equal(defaults.confirmMisses, 3);
  assert.equal(defaults.cooldownMs, 6 * 60 * 60_000);
  assert.equal(defaults.hotMs, 2 * 60 * 60_000);
  assert.equal(defaults.chainId, '56');
  const clamped = readListingWatchConfig({
    ALPHAPULSE_LISTING_CONFIRM_MISSES: '1',
    ALPHAPULSE_LISTING_COOLDOWN_MS: '1000',
    ALPHAPULSE_LISTING_HOT_MS: '10'
  });
  assert.equal(clamped.confirmMisses, 2);
  assert.equal(clamped.cooldownMs, 5 * 60_000);
  assert.equal(clamped.hotMs, 60_000);
});
