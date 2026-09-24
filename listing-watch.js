const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export const LISTING_TYPE = 'alpha-new';
export const DELIST_TYPE = 'alpha-delist';
export const DEFAULT_CONFIRM_MISSES = 3;
export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60_000;
export const DEFAULT_HOT_MS = 2 * 60 * 60_000;
export const DEFAULT_SNAPSHOT_CAP = 1_500;
export const DEFAULT_PENDING_CAP = 64;
export const DEFAULT_COOLDOWN_CAP = 400;
export const DEFAULT_RECENT_CAP = 64;
export const DEFAULT_MAX_NEW_PER_CYCLE = 8;
export const DEFAULT_MAX_DELIST_PER_CYCLE = 8;
export const DEFAULT_MIN_BASELINE = 40;
export const DEFAULT_DROP_RATIO = 0.25;
export const DEFAULT_GROWTH_RATIO = 0.3;

const ADDRESS_RE = /^0x[a-f0-9]{40}$/;
const ALPHA_ID_RE = /^ALPHA_\d+$/;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function intEnv(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return clamp(fallback, min, max);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return clamp(fallback, min, max);
  return clamp(Math.floor(parsed), min, max);
}

export function readListingWatchConfig(env = {}) {
  return {
    chainId: '56',
    confirmMisses: intEnv(env.ALPHAPULSE_LISTING_CONFIRM_MISSES, DEFAULT_CONFIRM_MISSES, 2, 6),
    cooldownMs: intEnv(env.ALPHAPULSE_LISTING_COOLDOWN_MS, DEFAULT_COOLDOWN_MS, 5 * 60_000, 48 * 60 * 60_000),
    hotMs: intEnv(env.ALPHAPULSE_LISTING_HOT_MS, DEFAULT_HOT_MS, 60_000, 24 * 60 * 60_000),
    snapshotCap: intEnv(env.ALPHAPULSE_LISTING_SNAPSHOT_CAP, DEFAULT_SNAPSHOT_CAP, 32, 2_000),
    pendingCap: DEFAULT_PENDING_CAP,
    cooldownCap: DEFAULT_COOLDOWN_CAP,
    recentCap: DEFAULT_RECENT_CAP,
    maxNewPerCycle: DEFAULT_MAX_NEW_PER_CYCLE,
    maxDelistPerCycle: DEFAULT_MAX_DELIST_PER_CYCLE,
    minBaseline: DEFAULT_MIN_BASELINE,
    dropRatio: DEFAULT_DROP_RATIO,
    growthRatio: DEFAULT_GROWTH_RATIO
  };
}

export function createListingWatch() {
  return {
    seen: new Map(),
    pending: new Map(),
    cooldowns: new Map(),
    recentListings: new Map(),
    primed: false,
    lastDiffAt: 0,
    lastStatus: 'idle',
    lastListed: 0,
    lastDelisted: 0,
    listedTotal: 0,
    delistedTotal: 0,
    jitterResets: 0,
    skippedIncomplete: 0,
    suppressedCooldown: 0
  };
}

export function listingKey(token) {
  if (!token || typeof token !== 'object') return '';
  const chainId = String(token.chainId || '0');
  const address = String(token.contractAddress || token.address || '').trim().toLowerCase();
  if (ADDRESS_RE.test(address)) return `${chainId}:addr:${address}`;
  const alphaId = String(token.alphaId || '').trim().toUpperCase();
  if (ALPHA_ID_RE.test(alphaId)) return `${chainId}:alpha:${alphaId}`;
  const tokenId = String(token.tokenId || token.id || '').trim();
  if (/^[A-Za-z0-9:_-]{1,64}$/.test(tokenId) && !/^alpha_/i.test(tokenId)) return `${chainId}:id:${tokenId}`;
  return '';
}

function isOffline(token) {
  return token?.offline === true || token?.offline === 1 || token?.offline === '1' || token?.offline === 'true';
}

function listingTimeMs(value) {
  const time = num(value);
  if (time > 1e12) return time;
  if (time > 1e9) return time * 1000;
  return 0;
}

function compactToken(token, key) {
  const address = String(token.address || token.contractAddress || '').trim().toLowerCase();
  const symbol = String(token.symbol || '').trim().slice(0, 32);
  return {
    key,
    address,
    alphaId: String(token.alphaId || '').trim().toUpperCase(),
    chainId: String(token.chainId || ''),
    symbol: symbol || '未知',
    name: String(token.name || '').trim().slice(0, 80),
    icon: String(token.icon || token.iconUrl || '').slice(0, 180),
    price: num(token.price),
    liquidity: num(token.liquidity),
    listingTime: listingTimeMs(token.listingTime),
    score: num(token.score),
    stage: String(token.stage || '').slice(0, 16),
    action: String(token.action || '').slice(0, 16),
    change24h: num(token.change24h ?? token.percentChange24h)
  };
}

function collectActive(tokens, config) {
  const records = new Map();
  for (const token of tokens || []) {
    if (!token || isOffline(token)) continue;
    if (config.chainId && String(token.chainId) !== String(config.chainId)) continue;
    const key = listingKey(token);
    if (!key) continue;
    records.set(key, compactToken(token, key));
    if (records.size > config.snapshotCap) return { records, overflow: true };
  }
  return { records, overflow: false };
}

function resolveOptions(options) {
  const defaults = readListingWatchConfig();
  const merged = { ...defaults, ...options };
  merged.confirmMisses = Math.max(2, Math.floor(num(merged.confirmMisses) || defaults.confirmMisses));
  merged.maxNewPerCycle = Math.max(1, Math.floor(num(merged.maxNewPerCycle) || defaults.maxNewPerCycle));
  merged.maxDelistPerCycle = Math.max(1, Math.floor(num(merged.maxDelistPerCycle) || defaults.maxDelistPerCycle));
  merged.snapshotCap = Math.max(1, Math.floor(num(merged.snapshotCap) || defaults.snapshotCap));
  merged.pendingCap = Math.max(1, Math.floor(num(merged.pendingCap) || defaults.pendingCap));
  merged.cooldownCap = Math.max(1, Math.floor(num(merged.cooldownCap) || defaults.cooldownCap));
  merged.recentCap = Math.max(1, Math.floor(num(merged.recentCap) || defaults.recentCap));
  merged.cooldownMs = Math.max(0, num(merged.cooldownMs));
  merged.hotMs = Math.max(0, num(merged.hotMs));
  merged.minBaseline = Math.max(1, Math.floor(num(merged.minBaseline) || defaults.minBaseline));
  return merged;
}

function shortAddress(address) {
  const value = String(address || '');
  if (!value) return '未知合约';
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatUsd(value) {
  const amount = num(value);
  if (!(amount > 0)) return '暂无';
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toExponential(2)}`;
}

function formatListingTime(value) {
  const time = listingTimeMs(value);
  if (!time) return '时间未知';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(time));
  } catch {
    return '时间未知';
  }
}

function buildListingEvent(record) {
  return {
    kind: 'listing',
    type: LISTING_TYPE,
    level: 'high',
    label: 'Alpha 新上架',
    priority: 9,
    message: `${record.symbol} 新进入 Alpha 列表，合约 ${shortAddress(record.address)}，上线 ${formatListingTime(record.listingTime)}，现价 ${formatUsd(record.price)}，流动性 ${formatUsd(record.liquidity)}`,
    token: record
  };
}

function buildDelistEvent(record, misses) {
  const safe = record || {
    key: '', address: '', alphaId: '', chainId: '56', symbol: '未知', name: '', icon: '',
    price: 0, liquidity: 0, listingTime: 0, score: 0, stage: '', action: '', change24h: 0
  };
  return {
    kind: 'delisting',
    type: DELIST_TYPE,
    level: 'risk',
    label: 'Alpha 下架',
    priority: 9,
    misses,
    message: `${safe.symbol} 已连续 ${misses} 次未出现在 Alpha 列表，合约 ${shortAddress(safe.address)}，最后价格 ${formatUsd(safe.price)}，流动性 ${formatUsd(safe.liquidity)}`,
    token: safe
  };
}

function cooling(state, type, key, now, cooldownMs) {
  if (!(cooldownMs > 0)) return false;
  const at = state.cooldowns.get(`${type}:${key}`);
  return Number.isFinite(at) && now - at < cooldownMs;
}

function rememberCooldown(state, type, key, now, config) {
  state.cooldowns.set(`${type}:${key}`, now);
  if (state.cooldowns.size <= config.cooldownCap) return;
  let oldestKey = '';
  let oldest = Infinity;
  for (const [id, at] of state.cooldowns) {
    if (at < oldest) {
      oldest = at;
      oldestKey = id;
    }
  }
  if (oldestKey) state.cooldowns.delete(oldestKey);
}

function rememberListing(state, record, now, config) {
  if (!record.address) return;
  state.recentListings.set(record.key, { at: now, address: record.address });
  pruneRecent(state, now, config);
}

function pruneRecent(state, now, config) {
  for (const [key, row] of state.recentListings) {
    if (!row || now - num(row.at) > config.hotMs) state.recentListings.delete(key);
  }
  if (state.recentListings.size <= config.recentCap) return;
  const rows = [...state.recentListings.entries()].sort((a, b) => num(b[1]?.at) - num(a[1]?.at));
  state.recentListings = new Map(rows.slice(0, config.recentCap));
}

function prunePending(state, config) {
  if (state.pending.size <= config.pendingCap) return;
  const rows = [...state.pending.entries()].sort((a, b) => num(b[1]?.misses) - num(a[1]?.misses) || String(a[0]).localeCompare(String(b[0])));
  state.pending = new Map(rows.slice(0, config.pendingCap));
}

function suspiciousShrink(seenSize, removed, config) {
  if (seenSize < config.minBaseline) return false;
  if (removed <= config.maxDelistPerCycle) return false;
  return removed / seenSize >= config.dropRatio;
}

function suspiciousGrowth(seenSize, added, config) {
  if (seenSize < config.minBaseline) return false;
  const burst = Math.max(config.maxNewPerCycle * 3, 15);
  if (added < burst) return false;
  return added / seenSize >= config.growthRatio;
}

function finish(state, events, status) {
  state.lastStatus = status;
  return { events, status };
}

export function diffAlphaListings(state, tokens, now = Date.now(), options = {}) {
  const config = resolveOptions(options);
  const active = collectActive(tokens, config);
  state.lastDiffAt = now;
  state.lastListed = 0;
  state.lastDelisted = 0;

  if (active.overflow) {
    state.skippedIncomplete += 1;
    return finish(state, [], 'overflow');
  }

  if (!state.primed) {
    if (!active.records.size) return finish(state, [], 'waiting');
    state.seen = active.records;
    state.primed = true;
    return finish(state, [], 'baseline');
  }

  const current = active.records;
  const removed = [];
  for (const key of state.seen.keys()) if (!current.has(key)) removed.push(key);
  let added = 0;
  for (const key of current.keys()) {
    if (!state.seen.has(key) && !state.pending.has(key)) added += 1;
  }

  if (!current.size && state.seen.size) {
    state.skippedIncomplete += 1;
    return finish(state, [], 'empty');
  }
  if (suspiciousShrink(state.seen.size, removed.length, config)) {
    state.skippedIncomplete += 1;
    return finish(state, [], 'incomplete');
  }
  if (suspiciousGrowth(state.seen.size, added, config)) {
    state.seen = current;
    state.pending.clear();
    state.skippedIncomplete += 1;
    return finish(state, [], 'rebaseline');
  }

  const returning = new Set();
  for (const key of [...state.pending.keys()]) {
    if (!current.has(key)) continue;
    state.pending.delete(key);
    returning.add(key);
    state.jitterResets += 1;
  }

  for (const [key, existing] of [...state.pending.entries()]) {
    if (current.has(key)) continue;
    state.pending.set(key, {
      misses: num(existing?.misses) + 1,
      since: existing?.since || now,
      record: existing?.record || state.seen.get(key) || null
    });
  }
  for (const key of removed) {
    if (state.pending.has(key)) continue;
    state.pending.set(key, {
      misses: 1,
      since: now,
      record: state.seen.get(key) || null
    });
  }

  const events = [];
  const nextSeen = new Map();
  for (const [key, record] of current) {
    if (state.seen.has(key) || returning.has(key)) {
      nextSeen.set(key, record);
      continue;
    }
    if (state.lastListed >= config.maxNewPerCycle) continue;
    if (cooling(state, LISTING_TYPE, key, now, config.cooldownMs)) {
      state.suppressedCooldown += 1;
      nextSeen.set(key, record);
      continue;
    }
    events.push(buildListingEvent(record));
    rememberCooldown(state, LISTING_TYPE, key, now, config);
    rememberListing(state, record, now, config);
    nextSeen.set(key, record);
    state.lastListed += 1;
    state.listedTotal += 1;
  }

  const confirmed = [...state.pending.entries()]
    .filter(([, row]) => num(row?.misses) >= config.confirmMisses)
    .sort((a, b) => num(a[1]?.misses) - num(b[1]?.misses) || String(a[0]).localeCompare(String(b[0])));
  for (const [key, row] of confirmed) {
    if (state.lastDelisted >= config.maxDelistPerCycle) break;
    if (cooling(state, DELIST_TYPE, key, now, config.cooldownMs)) {
      state.suppressedCooldown += 1;
      state.pending.delete(key);
      continue;
    }
    events.push(buildDelistEvent(row.record, row.misses));
    rememberCooldown(state, DELIST_TYPE, key, now, config);
    state.pending.delete(key);
    state.recentListings.delete(key);
    state.lastDelisted += 1;
    state.delistedTotal += 1;
  }

  state.seen = nextSeen;
  pruneRecent(state, now, config);
  prunePending(state, config);
  return finish(state, events, 'diff');
}

export function toListingAlert(event, now, id) {
  const token = event?.token || {};
  const listing = event?.kind === 'listing';
  return {
    id: String(id),
    type: event?.type,
    kind: event?.kind,
    level: event?.level,
    label: event?.label,
    message: event?.message,
    createdAt: now,
    via: 'rest',
    firstSignalAt: now,
    symbol: String(token.symbol || '未知'),
    name: String(token.name || ''),
    address: String(token.address || '').toLowerCase(),
    alphaId: String(token.alphaId || ''),
    chainId: String(token.chainId || '56'),
    icon: String(token.icon || ''),
    score: num(token.score),
    stage: listing ? (token.stage || '观察') : '下架',
    action: listing ? (token.action || '观察') : '已离开列表',
    price: num(token.price),
    change24h: num(token.change24h),
    change5m: null,
    flow5mRatio: null,
    liquidity: num(token.liquidity),
    listingTime: num(token.listingTime) || null
  };
}

export function recentListingAddresses(state, now = Date.now(), hotMs = DEFAULT_HOT_MS) {
  const addresses = [];
  for (const row of state?.recentListings?.values?.() || []) {
    if (!row?.address || now - num(row.at) > hotMs) continue;
    addresses.push(String(row.address).toLowerCase());
  }
  return addresses;
}

export function listingWatchSummary(state, config = {}) {
  return {
    primed: Boolean(state?.primed),
    lastDiffAt: state?.lastDiffAt || null,
    lastStatus: state?.lastStatus || 'idle',
    tracked: state?.seen?.size || 0,
    pendingMissing: state?.pending?.size || 0,
    listings: state?.listedTotal || 0,
    delistings: state?.delistedTotal || 0,
    lastListings: state?.lastListed || 0,
    lastDelistings: state?.lastDelisted || 0,
    jitterResets: state?.jitterResets || 0,
    skippedIncomplete: state?.skippedIncomplete || 0,
    suppressedCooldown: state?.suppressedCooldown || 0,
    recentListings: state?.recentListings?.size || 0,
    confirmMisses: config.confirmMisses || DEFAULT_CONFIRM_MISSES,
    cooldownMs: config.cooldownMs || DEFAULT_COOLDOWN_MS
  };
}

export function exportListingWatch(state, cap = DEFAULT_SNAPSHOT_CAP) {
  const limit = Math.max(1, Math.floor(num(cap) || DEFAULT_SNAPSHOT_CAP));
  return {
    primed: Boolean(state?.primed),
    seen: [...(state?.seen?.values?.() || [])].slice(-limit),
    pending: [...(state?.pending?.entries?.() || [])].slice(-DEFAULT_PENDING_CAP),
    cooldowns: [...(state?.cooldowns?.entries?.() || [])].slice(-DEFAULT_COOLDOWN_CAP),
    recentListings: [...(state?.recentListings?.entries?.() || [])].slice(-DEFAULT_RECENT_CAP),
    listedTotal: state?.listedTotal || 0,
    delistedTotal: state?.delistedTotal || 0,
    jitterResets: state?.jitterResets || 0,
    skippedIncomplete: state?.skippedIncomplete || 0,
    suppressedCooldown: state?.suppressedCooldown || 0
  };
}

export function hydrateListingWatch(saved, cap = DEFAULT_SNAPSHOT_CAP) {
  const state = createListingWatch();
  if (!saved || typeof saved !== 'object') return state;
  const limit = Math.max(1, Math.floor(num(cap) || DEFAULT_SNAPSHOT_CAP));
  for (const row of (Array.isArray(saved.seen) ? saved.seen : []).slice(-limit)) {
    if (!row?.key) continue;
    state.seen.set(row.key, row);
  }
  for (const entry of Array.isArray(saved.pending) ? saved.pending : []) {
    const [key, row] = entry || [];
    if (!key || !row) continue;
    state.pending.set(key, {
      misses: Math.max(0, Math.floor(num(row.misses))),
      since: num(row.since),
      record: row.record || null
    });
  }
  for (const entry of Array.isArray(saved.cooldowns) ? saved.cooldowns : []) {
    const [key, at] = entry || [];
    if (!key || !(num(at) > 0)) continue;
    state.cooldowns.set(key, num(at));
  }
  for (const entry of Array.isArray(saved.recentListings) ? saved.recentListings : []) {
    const [key, row] = entry || [];
    if (!key || !row?.address) continue;
    state.recentListings.set(key, { at: num(row.at), address: String(row.address).toLowerCase() });
  }
  state.primed = Boolean(saved.primed && state.seen.size);
  state.listedTotal = Math.max(0, Math.floor(num(saved.listedTotal)));
  state.delistedTotal = Math.max(0, Math.floor(num(saved.delistedTotal)));
  state.jitterResets = Math.max(0, Math.floor(num(saved.jitterResets)));
  state.skippedIncomplete = Math.max(0, Math.floor(num(saved.skippedIncomplete)));
  state.suppressedCooldown = Math.max(0, Math.floor(num(saved.suppressedCooldown)));
  return state;
}
