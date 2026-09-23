const defaultRules = {
  minScore: 0, minLiquidity: 0, minMarketCap: 0, minHolders: 0,
  minChange: -100, maxChange: 10000, minTurnover: 0, maxDilution: 100,
  minChange5m: -100, minFlow5m: 0, maxRange: 10000, minSamples: 0,
  minSmartNet: 0, minLargeSwap: 0, minLiquidityChange: -100, maxTop10: 100,
  excludeThin: false, excludeBots: false, excludeDilution: false, onlyQuality: false,
  requireConfluence: false, requireAcceleration: false, excludeExhaustion: false, excludeNew: false
};
const PAPER_KEY = 'alpha-radar-paper-v1';
const ALERT_SEEN_KEY = 'alpha-radar-alert-seen-v1';
const ALERT_NOTIFY_KEY = 'alpha-radar-alert-notify-v1';
const ALERT_MUTED_TOKENS_KEY = 'alpha-radar-alert-muted-tokens-v1';
const ALERT_MUTED_RULES_KEY = 'alpha-radar-alert-muted-rules-v1';
const COMPACT_KEY = 'alpha-radar-compact-v1';
const PAPER_CAPITAL = 100_000;
function emptyPaper() { return { updatedAt:Date.now(), cash:PAPER_CAPITAL, positions:{}, realized:0, trades:[] }; }
function normalizePaper(value) {
  const source = value && typeof value === 'object' ? value : {};
  const positions = {};
  for (const [address, position] of Object.entries(source.positions || {})) {
    const qty = Number(position?.qty), avgCost = Number(position?.avgCost);
    if (!address || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(avgCost) || avgCost < 0) continue;
    positions[address] = {
      symbol:String(position.symbol || ''), name:String(position.name || ''), qty, avgCost,
      lastPrice:Number.isFinite(Number(position.lastPrice)) ? Number(position.lastPrice) : avgCost
    };
  }
  return {
    updatedAt:Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : Date.now(),
    cash:Number.isFinite(Number(source.cash)) && Number(source.cash) >= 0 ? Number(source.cash) : PAPER_CAPITAL,
    positions, realized:Number.isFinite(Number(source.realized)) ? Number(source.realized) : 0,
    trades:Array.isArray(source.trades) ? source.trades.slice(0,100) : []
  };
}
function loadStringSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key)) || []); }
  catch { return new Set(); }
}
function loadPaper() {
  try {
    const saved = JSON.parse(localStorage.getItem(PAPER_KEY));
    if (saved && Number.isFinite(saved.cash) && saved.positions) return normalizePaper(saved);
  } catch {}
  return emptyPaper();
}
const state = {
  tokens: [], filtered: [], view: 'signals', action: 'all', query: '', page: 1,
  pageSize: 12, fetchedAt: 0, loading: false, rules: {...defaultRules},
  paper:loadPaper(), drawerAddress:null,
  realtime: { connected:false, status:'connecting', lastEvent:0 },
  chainIntelStatus:{ configured:false, status:'not_configured', lastEvent:0, trackedTokens:0 },
  alerts:[], alertsLoaded:false, alertFilter:'all', lastAlertSeen:Number(localStorage.getItem(ALERT_SEEN_KEY)) || 0,
  mutedTokens:loadStringSet(ALERT_MUTED_TOKENS_KEY), mutedRules:loadStringSet(ALERT_MUTED_RULES_KEY),
  compact:localStorage.getItem(COMPACT_KEY) === '1', performance:null, performanceHorizon:'15m'
};
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const money = (value) => value >= 1 ? `$${fmt.format(value)}` : `$${Number(value).toPrecision(3)}`;
const pct = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
const shortAddress = (address) => address ? `${address.slice(0, 7)}…${address.slice(-5)}` : '—';
const escapeHtml = (value='') => String(value).replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const signedMoney = (value) => `${value >= 0 ? '+' : '-'}${money(Math.abs(value))}`;
const metricPct = (value) => value === null || value === undefined ? '建立中' : pct(value);
const iconUrl = (token) => token?.alphaId ? `/api/icon/${encodeURIComponent(token.alphaId)}` : token?.icon || '';

function sparklinePath(values=[], width=64, height=24) {
  const points = values.filter((value)=>Number.isFinite(value) && value > 0);
  if (points.length < 2) return '';
  const min = Math.min(...points), max = Math.max(...points), range = max - min || max * 0.002 || 1;
  return points.map((value,index) => {
    const x = 2 + (index / (points.length - 1)) * (width - 4);
    const y = height - 3 - ((value - min) / range) * (height - 6);
    return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function applyCompactMode() {
  document.body.classList.toggle('compact-mode', state.compact);
  $('compactToggle').classList.toggle('active', state.compact);
  $('compactToggle').setAttribute('aria-pressed', String(state.compact));
  $('compactToggle').querySelector('span').textContent = state.compact ? '展开概览' : '紧凑模式';
}

function renderSystemStatus(fallback='Binance Alpha') {
  const live = state.realtime.connected && Date.now() - state.realtime.lastEvent < 10_000;
  $('statusDot').className = live ? 'live' : state.realtime.status === 'error' ? 'error' : '';
  $('systemText').textContent = live
    ? `Binance Alpha WS · 实时推送 · ${state.tokens.length} 个 BSC 资产`
    : `${fallback} · REST 备用行情 · ${state.tokens.length} 个 BSC 资产`;
}

let liveRenderTimer = null;
function scheduleLiveRender() {
  if (liveRenderTimer) return;
  liveRenderTimer = setTimeout(() => {
    liveRenderTimer = null;
    renderKpis();
    renderPortfolio();
    updateLiveRows();
    if (state.drawerAddress) {
      const token = state.tokens.find((t)=>t.address===state.drawerAddress);
      if (token) {
        if ($('drawerLivePrice')) $('drawerLivePrice').textContent = money(token.price);
        if ($('tradeLivePrice')) $('tradeLivePrice').textContent = money(token.price);
        if ($('drawerLiveChange')) {
          $('drawerLiveChange').textContent = pct(token.change24h);
          $('drawerLiveChange').className = token.change24h >= 0 ? 'positive' : 'negative';
        }
        if ($('drawerLiveVolume')) $('drawerLiveVolume').textContent = money(token.volume24h);
        const signalReturn = $('signalReturn');
        const firstPrice = Number(signalReturn?.dataset.firstPrice);
        if (signalReturn && firstPrice > 0) {
          const returnPct = ((token.price / firstPrice) - 1) * 100;
          signalReturn.textContent = pct(returnPct);
          signalReturn.className = returnPct >= 0 ? 'positive' : 'negative';
          const signalStatus = $('signalStatus');
          if (signalStatus) signalStatus.textContent = signalStatusText(returnPct);
        }
      }
    }
  }, 80);
}

function updateLiveRows() {
  const byAddress = new Map(state.tokens.map((token)=>[token.address,token]));
  document.querySelectorAll('#tokenRows tr[data-address]').forEach((row) => {
    const token = byAddress.get(row.dataset.address);
    if (!token) return;
    const price = row.querySelector('.live-price');
    const change = row.querySelector('.live-change');
    const volume = row.querySelector('.live-volume');
    if (price) price.textContent = money(token.price);
    if (change) {
      change.textContent = pct(token.change24h);
      change.className = `delta live-change ${token.change24h >= 0 ? 'positive':'negative'}`;
    }
    if (volume) volume.textContent = money(token.volume24h);
  });
}

function connectRealtime() {
  const stream = new EventSource('/api/stream');
  stream.addEventListener('status', (event) => {
    try {
      const status = JSON.parse(event.data);
      state.realtime.status = status.status;
      renderSystemStatus();
    } catch {}
  });
  stream.onopen = () => {
    state.realtime.status = 'connected';
    renderSystemStatus();
  };
  stream.addEventListener('alert', (event) => {
    try {
      const alert = JSON.parse(event.data);
      if (state.alerts.some((item)=>item.id===alert.id)) return;
      state.alerts.unshift(alert);
      state.alerts = state.alerts.slice(0, 300);
      renderAlerts();
      notifyAlert(alert);
    } catch {}
  });
  stream.addEventListener('chain-status',(event)=>{
    try { state.chainIntelStatus = JSON.parse(event.data); }
    catch {}
  });
  stream.onmessage = (event) => {
    try {
      const updates = JSON.parse(event.data);
      const byAlphaId = new Map(state.tokens.map((token)=>[String(token.alphaId || '').toUpperCase(),token]));
      let changed = false;
      let websocketChanged = false;
      for (const update of updates) {
        const token = byAlphaId.get(update.alphaId);
        if (!token || !Number.isFinite(update.price)) continue;
        token.price = update.price;
        if (update.change24h !== null) token.change24h = update.change24h;
        if (update.high24h) token.high24h = update.high24h;
        if (update.low24h) token.low24h = update.low24h;
        if (update.volume24h) token.volume24h = update.volume24h;
        token.livePriceAt = update.eventTime;
        token.priceSource = update.source || 'Binance Alpha WS';
        if (token.priceSource === 'Binance Alpha WS') websocketChanged = true;
        changed = true;
      }
      if (!changed) return;
      if (websocketChanged) {
        state.realtime.connected = true;
        state.realtime.status = 'live';
        state.realtime.lastEvent = Date.now();
      }
      $('updatedAt').textContent = `${websocketChanged ? '实时' : '校准'} ${new Date().toLocaleTimeString('zh-CN',{hour12:false})}`;
      renderSystemStatus();
      scheduleLiveRender();
    } catch {}
  };
  stream.onerror = () => {
    state.realtime.connected = false;
    state.realtime.status = 'error';
    renderSystemStatus('连接恢复中');
  };
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(timestamp).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'});
}

function renderNotificationState() {
  const supported = 'Notification' in window;
  const enabled = supported && Notification.permission === 'granted' && localStorage.getItem(ALERT_NOTIFY_KEY) === '1';
  $('notificationToggle').classList.toggle('enabled', enabled);
  $('notificationStatus').textContent = !supported ? '当前浏览器不支持' : enabled ? '已开启，页面运行时推送' : Notification.permission === 'denied' ? '已被浏览器阻止' : '点击开启';
  $('notificationToggle').querySelector('em').textContent = enabled ? '关闭' : '开启';
}

function renderAlerts() {
  const opportunity = new Set(['critical','high','medium']);
  const visible = state.alerts.filter((item) => !state.mutedTokens.has(item.address) && !state.mutedRules.has(item.type));
  const filtered = visible.filter((item) => state.alertFilter === 'all'
    || (state.alertFilter === 'risk' && item.level === 'risk')
    || (state.alertFilter === 'high' && (item.level === 'critical' || item.level === 'high'))
    || (state.alertFilter === 'opportunity' && opportunity.has(item.level)));
  const grouped = new Map();
  for (const item of filtered) {
    const current = grouped.get(item.address);
    if (!current) grouped.set(item.address,{...item,groupCount:1,firstSignalAt:item.firstSignalAt});
    else {
      current.groupCount += 1;
      current.firstSignalAt = Math.min(current.firstSignalAt,item.firstSignalAt);
    }
  }
  const items = [...grouped.values()];
  $('alertList').innerHTML = items.length ? items.map((item) => `
    <button class="alert-item level-${escapeHtml(item.level)}" data-address="${escapeHtml(item.address)}">
      <span class="alert-icon"><span>${escapeHtml(item.symbol.slice(0,2))}</span>${iconUrl(item) ? `<img src="${escapeHtml(iconUrl(item))}" alt="" onerror="this.remove()">` : ''}</span>
      <span class="alert-body"><span class="alert-title"><b>${escapeHtml(item.symbol)}</b><em>${escapeHtml(item.label)}</em>${item.groupCount > 1 ? `<span class="alert-count">${item.groupCount} 条</span>` : ''}<time>${relativeTime(item.createdAt)}</time></span>
      <strong>${escapeHtml(item.message)}</strong><small>评分 ${item.score} · ${escapeHtml(item.stage || '观察')} · 首次异动 ${new Date(item.firstSignalAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}</small>
      <span class="alert-actions"><span class="alert-mute" data-mute-address="${escapeHtml(item.address)}">屏蔽币种</span><span class="alert-rule-mute" data-mute-rule="${escapeHtml(item.type)}">暂停规则</span></span></span>
    </button>`).join('') : '<div class="alert-empty">当前分类还没有异动记录</div>';
  document.querySelectorAll('.alert-item[data-address]').forEach((item)=>item.addEventListener('click',(event)=>{
    if (event.target.closest('[data-mute-address],[data-mute-rule]')) return;
    closeAlertCenter();
    openDrawer(item.dataset.address);
  }));
  document.querySelectorAll('[data-mute-address]').forEach((control)=>control.addEventListener('click',(event)=>{
    event.stopPropagation();
    state.mutedTokens.add(control.dataset.muteAddress);
    saveAlertMutes(); renderAlerts(); showToast('已屏蔽该币种提醒');
  }));
  document.querySelectorAll('[data-mute-rule]').forEach((control)=>control.addEventListener('click',(event)=>{
    event.stopPropagation();
    state.mutedRules.add(control.dataset.muteRule);
    saveAlertMutes(); renderAlerts(); showToast('已暂停该类提醒规则');
  }));
  const unread = visible.filter((item)=>item.createdAt > state.lastAlertSeen).length;
  $('alertUnread').textContent = unread > 99 ? '99+' : unread;
  $('alertUnread').hidden = unread === 0;
  $('alertsButton').classList.toggle('has-alerts', unread > 0);
  const mutedCount = state.mutedTokens.size + state.mutedRules.size;
  $('muteSummary').hidden = mutedCount === 0;
  $('muteSummaryText').textContent = `已屏蔽 ${state.mutedTokens.size} 个币种 · 暂停 ${state.mutedRules.size} 类规则`;
}

function saveAlertMutes() {
  localStorage.setItem(ALERT_MUTED_TOKENS_KEY,JSON.stringify([...state.mutedTokens]));
  localStorage.setItem(ALERT_MUTED_RULES_KEY,JSON.stringify([...state.mutedRules]));
}

async function loadAlerts() {
  try {
    const response = await fetch('/api/alerts?chain=56&limit=300');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '提醒读取失败');
    state.alerts = data.alerts;
    state.alertsLoaded = true;
    renderAlerts();
  } catch (error) {
    $('alertList').innerHTML = `<div class="alert-empty">${escapeHtml(error.message)}</div>`;
  }
}

function notifyAlert(alert) {
  if (state.mutedTokens.has(alert.address) || state.mutedRules.has(alert.type)) return;
  if (!('Notification' in window) || Notification.permission !== 'granted' || localStorage.getItem(ALERT_NOTIFY_KEY) !== '1') return;
  const notification = new Notification(`${alert.symbol} · ${alert.label}`, {
    body:`${alert.message}｜评分 ${alert.score}`,
    icon:iconUrl(alert) ? new URL(iconUrl(alert),location.origin).href : undefined,
    tag:`alphapulse-${alert.address}-${alert.type}`,
    renotify:true
  });
  notification.onclick = () => { window.focus(); openDrawer(alert.address); notification.close(); };
}

function openAlertCenter() {
  closePerformanceCenter();
  renderAlerts();
  $('alertCenter').classList.add('open');
  $('alertBackdrop').classList.add('open');
  $('alertCenter').setAttribute('aria-hidden','false');
}

function closeAlertCenter() {
  $('alertCenter').classList.remove('open');
  $('alertBackdrop').classList.remove('open');
  $('alertCenter').setAttribute('aria-hidden','true');
}

function performanceValue(value, digits=2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  return `${number >= 0 ? '+' : ''}${number.toFixed(digits)}%`;
}

function performanceStatus(rule) {
  if (rule.samples < 5) return { label:'积累样本', tone:'building' };
  if (rule.winRate >= 65 && rule.average > 0) return { label:'初步有效', tone:'good' };
  if (rule.winRate >= 52 && rule.average > 0) return { label:'继续验证', tone:'watch' };
  return { label:'需要调整', tone:'weak' };
}

function renderPerformance() {
  const data = state.performance;
  if (!data?.ready) {
    $('performanceRules').innerHTML = '<div class="performance-empty">策略数据库正在初始化…</div>';
    return;
  }
  const overall = data.overall || {};
  $('performanceTotal').textContent = fmt.format(data.totalSignals || 0);
  $('performanceCompleted').textContent = fmt.format(data.completed || 0);
  $('performanceTracking').textContent = `正在追踪 ${fmt.format(data.tracking || 0)}`;
  $('performanceWinRate').textContent = overall.winRate === null || overall.winRate === undefined ? '建立中' : `${overall.winRate.toFixed(1)}%`;
  $('performanceWinRate').className = overall.winRate >= 55 ? 'positive' : overall.winRate === null || overall.winRate === undefined ? '' : 'negative';
  $('performanceAverage').textContent = performanceValue(overall.average);
  $('performanceAverage').className = overall.average === null || overall.average === undefined ? '' : overall.average >= 0 ? 'positive' : 'negative';
  $('performanceSampleBadge').textContent = data.completed > 99 ? '99+' : data.completed;
  $('performanceSampleBadge').hidden = data.completed === 0;
  $('performanceSnapshots').textContent = `${fmt.format(data.snapshots || 0)} 分钟快照`;
  const horizonLabel = { '5m':'5 分钟', '15m':'15 分钟', '1h':'1 小时', '4h':'4 小时' }[data.horizon] || data.horizon;
  $('performanceRuleNote').textContent = `按 ${horizonLabel}结果统计`;
  $('performanceRules').innerHTML = data.rules?.length ? data.rules.map((rule)=>{
    const status = performanceStatus(rule);
    return `<div class="performance-rule level-${escapeHtml(rule.level)}">
      <span class="performance-rule-name"><i></i><b>${escapeHtml(rule.label)}</b><small>${rule.level === 'risk' ? '风险预警' : '机会信号'} · 共 ${rule.total} 次</small></span>
      <span>${rule.samples || 0}</span>
      <span class="${rule.winRate >= 55 ? 'positive' : rule.winRate === null ? '' : 'negative'}">${rule.winRate === null ? '—' : rule.winRate.toFixed(0)+'%'}</span>
      <span class="${rule.average === null ? '' : rule.average >= 0 ? 'positive' : 'negative'}">${performanceValue(rule.average)}</span>
      <span>${performanceValue(rule.averageFavorable)}</span>
      <span class="negative">${rule.samples ? '-'+Math.abs(rule.averageDrawdown).toFixed(2)+'%' : '—'}</span>
      <span><em class="performance-status ${status.tone}">${status.label}</em></span>
    </div>`;
  }).join('') : '<div class="performance-empty">等待监控规则触发首批信号</div>';
  $('performanceRecent').innerHTML = data.recent?.length ? data.recent.map((item)=>`
    <article class="performance-recent-item level-${escapeHtml(item.level)}">
      <span><i></i><b>${escapeHtml(item.symbol)}</b><em>${escapeHtml(item.label)}</em></span>
      <small>${new Date(item.createdAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})} · 评分 ${item.score}</small>
      <strong class="${item.effect >= 0 ? 'positive' : 'negative'}">${performanceValue(item.effect)}</strong>
    </article>`).join('') : '<div class="performance-empty">等待首个观察周期完成</div>';
}

async function loadPerformance() {
  try {
    const response = await fetch(`/api/performance?horizon=${encodeURIComponent(state.performanceHorizon)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '策略统计读取失败');
    state.performance = data;
    renderPerformance();
  } catch (error) {
    $('performanceRules').innerHTML = `<div class="performance-empty">${escapeHtml(error.message)}</div>`;
  }
}

function openPerformanceCenter() {
  closeAlertCenter();
  loadPerformance();
  $('performanceCenter').classList.add('open');
  $('performanceBackdrop').classList.add('open');
  $('performanceCenter').setAttribute('aria-hidden','false');
}

function closePerformanceCenter() {
  if (!$('performanceCenter')) return;
  $('performanceCenter').classList.remove('open');
  $('performanceBackdrop').classList.remove('open');
  $('performanceCenter').setAttribute('aria-hidden','true');
}

let paperSaveTimer = null;
function hasPaperActivity(paper) {
  return Object.keys(paper?.positions || {}).length > 0 || (paper?.trades || []).length > 0 ||
    Number(paper?.cash) !== PAPER_CAPITAL || Number(paper?.realized) !== 0;
}

async function syncPaperToServer() {
  try {
    const response = await fetch('/api/paper-portfolio', {
      method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify(state.paper)
    });
    if (!response.ok) throw new Error('模拟仓同步失败');
  } catch {}
}

function savePaper() {
  state.paper.updatedAt = Date.now();
  try { localStorage.setItem(PAPER_KEY, JSON.stringify(state.paper)); } catch {}
  clearTimeout(paperSaveTimer);
  paperSaveTimer = setTimeout(syncPaperToServer, 150);
}

async function loadPaperFromServer() {
  try {
    const response = await fetch('/api/paper-portfolio');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '模拟仓读取失败');
    const localPaper = state.paper;
    const remotePaper = normalizePaper(data.portfolio);
    if ((!data.persisted || (hasPaperActivity(localPaper) && localPaper.updatedAt > remotePaper.updatedAt)) && hasPaperActivity(localPaper)) {
      await syncPaperToServer();
      return;
    }
    state.paper = remotePaper;
    try { localStorage.setItem(PAPER_KEY, JSON.stringify(state.paper)); } catch {}
    renderPortfolio();
    if (typeof renderTable === 'function') renderTable();
  } catch {}
}

function exportPaperPortfolio() {
  const blob = new Blob([JSON.stringify({...state.paper, exportedAt:new Date().toISOString()}, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `alphapulse-paper-${new Date().toISOString().slice(0,10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('模拟仓已导出');
}

async function importPaperPortfolio(file) {
  if (!file) return;
  try {
    const imported = normalizePaper(JSON.parse(await file.text()));
    if (!confirm('导入后会覆盖当前模拟仓，确定继续吗？')) return;
    state.paper = {...imported, updatedAt:Date.now()};
    savePaper(); renderPortfolio(); renderTable();
    showToast('模拟仓已导入并同步');
  } catch { showToast('导入文件格式不正确', true); }
}

function showToast(message, error=false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(()=>toast.className='toast',2200);
}

function portfolioSnapshot() {
  let marketValue = 0, cost = 0;
  const positions = Object.entries(state.paper.positions).map(([address,position]) => {
    const token = state.tokens.find((t)=>t.address===address);
    const price = token?.price || position.lastPrice || position.avgCost;
    const value = position.qty * price;
    const positionCost = position.qty * position.avgCost;
    const pnl = value - positionCost;
    const pnlPct = positionCost > 0 ? (pnl / positionCost) * 100 : 0;
    marketValue += value; cost += positionCost;
    return {address, position, token, price, value, pnl, pnlPct};
  }).sort((a,b)=>b.value-a.value);
  const unrealized = marketValue - cost;
  const equity = state.paper.cash + marketValue;
  const totalPnl = equity - PAPER_CAPITAL;
  return {
    positions, marketValue, cost, unrealized, equity, totalPnl,
    unrealizedPct:cost > 0 ? (unrealized / cost) * 100 : 0,
    totalPnlPct:(totalPnl / PAPER_CAPITAL) * 100
  };
}

function renderPortfolio() {
  const p = portfolioSnapshot();
  $('paperEquity').textContent = money(p.equity);
  $('paperCash').textContent = money(state.paper.cash);
  $('paperUnrealized').textContent = `${signedMoney(p.unrealized)} · ${pct(p.unrealizedPct)}`;
  $('paperUnrealized').className = p.unrealized >= 0 ? 'positive' : 'negative';
  $('paperTotalPnl').textContent = `总盈亏 ${signedMoney(p.totalPnl)} · ${pct(p.totalPnlPct)}`;
  $('paperTotalPnl').className = p.totalPnl >= 0 ? 'positive' : 'negative';
  $('paperPositionCount').textContent = p.positions.length;
  $('paperPositions').innerHTML = p.positions.length ? p.positions.map(({address,position,price,value,pnl,pnlPct})=>`
    <button class="paper-position" data-address="${escapeHtml(address)}">
      <strong>${escapeHtml(position.symbol)}</strong><b>${money(value)}</b>
      <small>${fmt.format(position.qty)} 枚 · 均价 ${money(position.avgCost)} · 现价 ${money(price)}</small><em class="${pnl>=0?'positive':'negative'}">${signedMoney(pnl)} · ${pct(pnlPct)}</em>
    </button>`).join('') : '<div class="paper-empty">点击榜单资产，在详情中模拟买入</div>';
  document.querySelectorAll('.paper-position[data-address]').forEach((el)=>el.addEventListener('click',()=>openDrawer(el.dataset.address)));
}

function scoreColor(score) {
  if (score >= 78) return '#83f28f';
  if (score >= 60) return '#f2c76e';
  if (score >= 40) return '#ff9f79';
  return '#ff6b72';
}

function adviceText(token) {
  if (token.chainIntel?.liquidityChange5m !== null && token.chainIntel?.liquidityChange5m <= -8) return '池子流动性正在快速下降，优先回避并等待流动性恢复，避免撤池风险。';
  if (token.chainIntel?.top10Percent >= 80) return '筹码高度集中在 Top10 地址，价格容易被少数地址影响，降低仓位优先级。';
  if (token.chainIntel?.smartNetUsd >= 25_000 && token.chainIntel?.smartWallets >= 2) return 'Smart Money 与量价信号出现共振，仍需结合流动性和大额卖单确认持续性。';
  if (token.stage === '衰竭') return '短周期动量已经转弱，优先等待重新放量站稳，避免接力追高。';
  if (token.stage === '过热') return '价格处于过热区，信号强但盈亏比下降，等待回踩确认更稳妥。';
  if (token.stage === '启动') return '成交增量正在加速，但多周期趋势尚未完全确认，适合小仓观察。';
  if (token.action === '试仓') return '多项指标共振，但建议仅小仓验证并设置止损。';
  if (token.action === '重点观察') return '异动成立，等待回踩、流动性或独立买盘进一步确认。';
  if (token.action === '减仓') return '高换手伴随明显回撤，优先保护利润并避免补仓摊薄。';
  if (token.action === '回避') return '风险指标压过动量信号，暂不参与。';
  return '信号强度尚不足，保持观察。';
}

function signalStatusText(value) {
  if (value === null || value === undefined) return '等待首次信号';
  if (value >= 20) return '已明显拉升';
  if (value >= 5) return '信号兑现中';
  if (value <= -10) return '信号后明显回撤';
  if (value <= -3) return '信号后回撤';
  return '仍在信号附近';
}

function chainStatusText(chain) {
  if (chain?.status === 'disabled') return '已跳过';
  if (!chain?.configured) return '待配置';
  if (chain.status === 'live') return chain.available ? '实时数据' : '已连接 · 等待事件';
  if (chain.status === 'authenticating') return '正在鉴权';
  if (chain.status === 'connecting' || chain.status === 'reconnecting') return '正在连接';
  if (chain.status === 'subscription_required') return '需开通 Market API';
  if (chain.status === 'error') return '连接异常';
  return '数据建立中';
}

function chainDelta(value) {
  return value === null || value === undefined ? '建立中' : performanceValue(value);
}

function updateDrawerChainIntel(token) {
  const chain = token.chainIntel || {};
  if ($('chainIntelStatus')) {
    $('chainIntelStatus').textContent = chainStatusText(chain);
    $('chainIntelStatus').className = `chain-intel-status ${chain.status === 'live' ? 'live' : chain.configured ? 'waiting' : 'disabled'}`;
  }
  if ($('chainSmartNet')) {
    $('chainSmartNet').textContent = signedMoney(chain.smartNetUsd || 0);
    $('chainSmartNet').className = (chain.smartNetUsd || 0) >= 0 ? 'positive' : 'negative';
    $('chainSmartWallets').textContent = `${chain.smartWallets || 0} 个地址 · ${chain.smartSignals || 0} 次聚合信号`;
    $('chainLargeSwap').textContent = signedMoney(chain.largeSwapNetUsd || 0);
    $('chainLargeSwap').className = (chain.largeSwapNetUsd || 0) >= 0 ? 'positive' : 'negative';
    $('chainLargeSwapCount').textContent = `${chain.largeSwapCount || 0} 笔 · 门槛 ${money(chain.largeSwapThreshold || 10_000)}`;
    $('chainLiquidityDelta').textContent = chainDelta(chain.liquidityChange5m);
    $('chainLiquidityDelta').className = chain.liquidityChange5m === null || chain.liquidityChange5m === undefined ? '' : chain.liquidityChange5m >= 0 ? 'positive' : 'negative';
    $('chainLiquidityNow').textContent = `当前 ${money(chain.liquidity || token.liquidity)}`;
    $('chainTop10').textContent = chain.top10Percent === null || chain.top10Percent === undefined ? '建立中' : `${chain.top10Percent.toFixed(2)}%`;
    $('chainTop10').className = chain.top10Percent >= 80 ? 'negative' : chain.top10Percent === null || chain.top10Percent === undefined ? '' : 'positive';
    $('chainHolderCount').textContent = chain.holders ? `${fmt.format(chain.holders)} 个地址` : '等待集中度事件';
  }
}

function applyFilters() {
  const q = state.query.toLowerCase().trim();
  let list = state.tokens.filter((t) => !q || `${t.symbol} ${t.name} ${t.address} ${t.alphaId}`.toLowerCase().includes(q));
  if (state.action !== 'all') list = list.filter((t) => t.action === state.action);
  const r = state.rules;
  list = list.filter((t) => {
    const flags = t.metrics.riskFlags || {};
    const dilution = t.metrics.unlockRatio || 0;
    const chain = t.chainIntel || {};
    return t.score >= r.minScore
      && t.liquidity >= r.minLiquidity * 1000
      && t.marketCap >= r.minMarketCap * 1_000_000
      && t.holders >= r.minHolders
      && t.change24h >= r.minChange && t.change24h <= r.maxChange
      && t.metrics.volumeRatio * 100 >= r.minTurnover
      && dilution <= r.maxDilution
      && (r.minChange5m <= -100 || (t.metrics.change5m !== null && t.metrics.change5m >= r.minChange5m))
      && (r.minFlow5m <= 0 || (t.metrics.flow5mRatio !== null && t.metrics.flow5mRatio * 100 >= r.minFlow5m))
      && t.metrics.rangePct <= r.maxRange
      && t.metrics.sampleMinutes >= r.minSamples
      && (r.minSmartNet <= 0 || (chain.available && chain.smartNetUsd >= r.minSmartNet * 1000))
      && (r.minLargeSwap <= 0 || (chain.available && chain.largeSwapNetUsd >= r.minLargeSwap * 1000))
      && (r.minLiquidityChange <= -100 || (chain.available && chain.liquidityChange5m !== null && chain.liquidityChange5m >= r.minLiquidityChange))
      && (r.maxTop10 >= 100 || (chain.available && chain.top10Percent !== null && chain.top10Percent <= r.maxTop10))
      && (!r.excludeThin || !flags.thinLiquidity)
      && (!r.excludeBots || !flags.botLike)
      && (!r.excludeDilution || !flags.highDilution)
      && (!r.onlyQuality || t.quality === '高质量')
      && (!r.requireConfluence || t.metrics.multiWindowConfluence)
      && (!r.requireAcceleration || t.metrics.volumeAccelerating)
      && (!r.excludeExhaustion || !t.metrics.exhaustion)
      && (!r.excludeNew || t.metrics.ageHours >= 24);
  });
  const sorts = {
    signals: (a,b) => b.score - a.score || b.metrics.shortChange - a.metrics.shortChange,
    gainers: (a,b) => b.change24h - a.change24h,
    turnover: (a,b) => b.metrics.volumeRatio - a.metrics.volumeRatio,
    risk: (a,b) => b.risks.length - a.risks.length || a.score - b.score
  };
  state.filtered = list.sort(sorts[state.view]);
  if (q) state.filtered.sort((a,b) => Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q));
  const pages = Math.max(1, Math.ceil(list.length / state.pageSize));
  state.page = Math.min(state.page, pages);
  renderTable();
}

const ruleFields = {
  minScore: 'ruleMinScore', minLiquidity: 'ruleMinLiquidity', minMarketCap: 'ruleMinMarketCap',
  minHolders: 'ruleMinHolders', minChange: 'ruleMinChange', maxChange: 'ruleMaxChange',
  minTurnover: 'ruleMinTurnover', maxDilution: 'ruleMaxDilution', excludeThin: 'ruleExcludeThin',
  minChange5m: 'ruleMinChange5m', minFlow5m: 'ruleMinFlow5m', maxRange: 'ruleMaxRange', minSamples: 'ruleMinSamples',
  minSmartNet:'ruleMinSmartNet', minLargeSwap:'ruleMinLargeSwap', minLiquidityChange:'ruleMinLiquidityChange', maxTop10:'ruleMaxTop10',
  excludeBots: 'ruleExcludeBots', excludeDilution: 'ruleExcludeDilution', onlyQuality: 'ruleOnlyQuality',
  requireConfluence: 'ruleRequireConfluence', requireAcceleration: 'ruleRequireAcceleration',
  excludeExhaustion: 'ruleExcludeExhaustion', excludeNew: 'ruleExcludeNew'
};

const presets = {
  breakout: { minScore:55, minLiquidity:200, minMarketCap:2, minHolders:500, minChange:5, maxChange:80, minTurnover:5, maxDilution:5, excludeThin:true, excludeBots:true, excludeDilution:false, onlyQuality:false },
  confirmed: { minScore:70, minLiquidity:500, minMarketCap:5, minHolders:2000, minChange:3, maxChange:45, minTurnover:8, maxDilution:3, excludeThin:true, excludeBots:true, excludeDilution:true, onlyQuality:false },
  ake: { minScore:0, minLiquidity:300, minMarketCap:10, minHolders:1000, minChange:15, maxChange:10000, minTurnover:5, maxDilution:10, excludeThin:false, excludeBots:false, excludeDilution:false, onlyQuality:false },
  safe: { minScore:72, minLiquidity:1000, minMarketCap:10, minHolders:5000, minChange:0, maxChange:30, minTurnover:3, maxDilution:2.5, excludeThin:true, excludeBots:true, excludeDilution:true, onlyQuality:true, excludeExhaustion:true },
  flowStart: { minScore:58, minLiquidity:300, minMarketCap:2, minHolders:800, minChange:-5, maxChange:40, minTurnover:3, maxDilution:5, minChange5m:-3, minFlow5m:0.05, minSamples:5, requireAcceleration:true, excludeThin:true, excludeBots:true, excludeExhaustion:true },
  trendConfirm: { minScore:70, minLiquidity:500, minMarketCap:5, minHolders:1500, minChange:2, maxChange:50, minTurnover:5, maxDilution:4, minChange5m:1.2, minFlow5m:0.2, minSamples:15, requireConfluence:true, excludeThin:true, excludeBots:true, excludeExhaustion:true },
  antiFomo: { minScore:65, minLiquidity:500, minMarketCap:5, minHolders:1000, minChange:0, maxChange:30, minTurnover:3, maxDilution:3, minChange5m:-2, minFlow5m:0.05, maxRange:70, minSamples:15, excludeThin:true, excludeBots:true, excludeDilution:true, excludeExhaustion:true, excludeNew:true },
  onchainConfirm: { minScore:58, minLiquidity:300, minMarketCap:2, minHolders:800, minChange:-5, maxChange:45, minTurnover:3, maxDilution:5, minSmartNet:25, minLargeSwap:50, minLiquidityChange:-3, maxTop10:80, excludeThin:true, excludeBots:true, excludeExhaustion:true }
};

function syncRuleInputs(rules = state.rules) {
  Object.entries(ruleFields).forEach(([key,id]) => {
    const input = $(id);
    if (input.type === 'checkbox') input.checked = Boolean(rules[key]);
    else input.value = rules[key];
  });
}

function readRules() {
  const next = {};
  Object.entries(ruleFields).forEach(([key,id]) => {
    const input = $(id);
    next[key] = input.type === 'checkbox' ? input.checked : (Number(input.value) || 0);
  });
  state.rules = next;
  updateRuleSummary();
  state.page = 1;
  applyFilters();
}

function updateRuleSummary() {
  const r = state.rules;
  const items = [];
  if (r.minScore > 0) items.push(`评分 ≥ ${r.minScore}`);
  if (r.minLiquidity > 0) items.push(`流动性 ≥ $${r.minLiquidity}K`);
  if (r.minMarketCap > 0) items.push(`市值 ≥ $${r.minMarketCap}M`);
  if (r.minHolders > 0) items.push(`持币地址 ≥ ${fmt.format(r.minHolders)}`);
  if (r.minChange > -100) items.push(`涨幅 ≥ ${r.minChange}%`);
  if (r.maxChange < 10000) items.push(`涨幅 ≤ ${r.maxChange}%`);
  if (r.minTurnover > 0) items.push(`换手 ≥ ${r.minTurnover}%`);
  if (r.maxDilution < 100) items.push(`FDV/市值 ≤ ${r.maxDilution}x`);
  if (r.minChange5m > -100) items.push(`5分钟涨幅 ≥ ${r.minChange5m}%`);
  if (r.minFlow5m > 0) items.push(`5分钟资金强度 ≥ ${r.minFlow5m}%`);
  if (r.maxRange < 10000) items.push(`日内振幅 ≤ ${r.maxRange}%`);
  if (r.minSamples > 0) items.push(`样本 ≥ ${r.minSamples}分钟`);
  if (r.minSmartNet > 0) items.push(`Smart Money 净流入 ≥ $${r.minSmartNet}K`);
  if (r.minLargeSwap > 0) items.push(`大额 Swap 净流入 ≥ $${r.minLargeSwap}K`);
  if (r.minLiquidityChange > -100) items.push(`池子5分钟变化 ≥ ${r.minLiquidityChange}%`);
  if (r.maxTop10 < 100) items.push(`Top10 持仓 ≤ ${r.maxTop10}%`);
  if (r.excludeThin) items.push('排除薄流动性');
  if (r.excludeBots) items.push('排除机器人噪声');
  if (r.excludeDilution) items.push('排除高稀释');
  if (r.onlyQuality) items.push('仅高质量');
  if (r.requireConfluence) items.push('多周期共振');
  if (r.requireAcceleration) items.push('成交加速');
  if (r.excludeExhaustion) items.push('排除衰竭');
  if (r.excludeNew) items.push('排除新币');
  $('activeRuleCount').textContent = items.length;
  $('ruleSummary').textContent = items.length ? `已启用 ${items.length} 条：${items.join(' · ')}` : '当前未启用额外规则';
}

function createTokenRow(token) {
  const row = document.createElement('tr');
  row.dataset.address = token.address;
  row.innerHTML = `
    <td><div class="asset"><span class="token-icon-shell"><span class="token-initials"></span><img class="token-icon" alt=""></span><div><strong class="token-symbol"></strong><small class="token-alpha"></small><span class="token-badges"><span class="holding-slot"></span><span class="chain-badge-slot"></span></span></div></div></td>
    <td><div class="score"><b class="row-score"></b><span class="score-track"><i></i></span></div></td>
    <td><div class="price-spark-cell"><span><span class="price live-price"></span><span class="delta live-change"></span></span><svg class="mini-spark" viewBox="0 0 64 24" aria-hidden="true"><path></path></svg></div></td>
    <td><span class="metric live-volume"></span><small class="row-trades"></small></td>
    <td><span class="metric row-liquidity"></span><small class="row-liquidity-ratio"></small></td>
    <td><span class="metric row-turnover"></span><small>成交额 / 市值</small></td>
    <td><span class="action row-action"></span><span class="stage row-stage"></span></td>`;
  const icon = row.querySelector('.token-icon');
  icon.addEventListener('error', () => { icon.hidden = true; });
  row.addEventListener('click', () => openDrawer(row.dataset.address));
  updateTokenRow(row, token);
  return row;
}

function updateTokenRow(row, token) {
  row.dataset.address = token.address;
  row.querySelector('.token-symbol').textContent = token.symbol;
  row.querySelector('.token-alpha').textContent = token.alphaId || shortAddress(token.address);
  row.querySelector('.token-initials').textContent = token.symbol.slice(0,2).toUpperCase();
  const icon = row.querySelector('.token-icon');
  const source = iconUrl(token);
  if (icon.dataset.src !== source) {
    icon.dataset.src = source;
    icon.hidden = !source;
    if (source) icon.src = source;
  }
  const holdingSlot = row.querySelector('.holding-slot');
  holdingSlot.innerHTML = state.paper.positions[token.address] ? '<span class="holding-badge">● 模拟持仓</span>' : '';
  const chain = token.chainIntel || {};
  const chainBadge = row.querySelector('.chain-badge-slot');
  chainBadge.innerHTML = chain.available && chain.smartNetUsd >= 25_000
    ? '<span class="chain-badge smart">SM 净买</span>'
    : chain.available && chain.largeSwapNetUsd >= 50_000
      ? '<span class="chain-badge swap">大额流入</span>'
      : chain.available && chain.liquidityChange5m !== null && chain.liquidityChange5m <= -8
        ? '<span class="chain-badge risk">流动性下降</span>' : '';
  const color = scoreColor(token.score);
  const score = row.querySelector('.row-score');
  score.textContent = token.score;
  score.style.color = color;
  const scoreBar = row.querySelector('.score-track i');
  scoreBar.style.width = `${token.score}%`;
  scoreBar.style.background = color;
  row.querySelector('.live-price').textContent = money(token.price);
  const change = row.querySelector('.live-change');
  change.textContent = pct(token.change24h);
  change.className = `delta live-change ${token.change24h >= 0 ? 'positive':'negative'}`;
  const spark = row.querySelector('.mini-spark');
  const sparkValues = token.sparkline5m || [];
  spark.querySelector('path').setAttribute('d',sparklinePath(sparkValues));
  spark.setAttribute('class',`mini-spark ${sparkValues.length > 1 && sparkValues.at(-1) < sparkValues[0] ? 'down' : 'up'}${sparkValues.length < 2 ? ' empty' : ''}`);
  row.querySelector('.live-volume').textContent = money(token.volume24h);
  row.querySelector('.row-trades').textContent = `${fmt.format(token.trades24h)} 笔`;
  row.querySelector('.row-liquidity').textContent = money(token.liquidity);
  row.querySelector('.row-liquidity-ratio').textContent = `占市值 ${(token.metrics.liquidityRatio*100).toFixed(2)}%`;
  row.querySelector('.row-turnover').textContent = `${(token.metrics.volumeRatio*100).toFixed(1)}%`;
  const action = row.querySelector('.row-action');
  action.textContent = token.action;
  action.className = `action row-action ${token.tone}`;
  const stage = row.querySelector('.row-stage');
  stage.textContent = token.stage || '观察';
  stage.className = `stage row-stage stage-${token.stage || '观察'}`;
}

function renderTable() {
  const start = (state.page - 1) * state.pageSize;
  const pageItems = state.filtered.slice(start, start + state.pageSize);
  const body = $('tokenRows');
  if (!pageItems.length) {
    body.innerHTML = '<tr><td colspan="7" class="loading">没有符合当前条件的资产</td></tr>';
  } else {
    const existing = new Map([...body.querySelectorAll('tr[data-address]')].map((row)=>[row.dataset.address,row]));
    const orderedRows = pageItems.map((token) => {
      const row = existing.get(token.address) || createTokenRow(token);
      updateTokenRow(row, token);
      return row;
    });
    const currentAddresses = [...body.querySelectorAll('tr[data-address]')].map((row)=>row.dataset.address);
    const nextAddresses = orderedRows.map((row)=>row.dataset.address);
    const orderChanged = currentAddresses.length !== nextAddresses.length || currentAddresses.some((address,index)=>address !== nextAddresses[index]);
    if (orderChanged || body.querySelector('tr:not([data-address])')) body.replaceChildren(...orderedRows);
  }
  $('resultCount').textContent = `${state.filtered.length} 个结果`;
  const pages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  $('pageNo').textContent = `${state.page} / ${pages}`;
}

function renderKpis() {
  const active = state.tokens.filter((t) => t.score >= 62).length;
  $('totalTokens').textContent = fmt.format(state.tokens.length);
  $('strongSignals').textContent = fmt.format(state.tokens.filter((t) => t.score >= 78).length);
  $('riskSignals').textContent = fmt.format(state.tokens.filter((t) => t.risks.length >= 2 || t.tone === 'avoid').length);
  $('totalVolume').textContent = money(state.tokens.reduce((sum,t) => sum + t.volume24h, 0));
  $('heroSignalCount').textContent = active;
}

function renderFeed() {
  const items = [...state.tokens].filter((t) => t.score >= 62 || t.metrics.shortChange >= 2).sort((a,b) => b.score-a.score).slice(0,7);
  $('feed').innerHTML = items.map((t) => `
    <button class="feed-item" data-address="${escapeHtml(t.address)}" style="background:none;border-left:0;border-right:0;text-align:left;color:inherit;cursor:pointer;width:100%">
      <span class="feed-top"><span class="feed-token"><img src="${escapeHtml(iconUrl(t))}" alt="" onerror="this.style.display='none'"><b>${escapeHtml(t.symbol)}</b><span class="action ${t.tone}">${escapeHtml(t.action)}</span></span><span class="feed-score">${t.score}</span></span>
      <p>${escapeHtml([...t.positives,...t.risks].slice(0,2).join(' · ') || '指标正在建立基线')}</p>
      <small>24H ${pct(t.change24h)} · 换手 ${(t.metrics.volumeRatio*100).toFixed(1)}%</small>
    </button>`).join('') || '<div class="loading">暂无强信号</div>';
  document.querySelectorAll('.feed-item[data-address]').forEach((el) => el.addEventListener('click', () => openDrawer(el.dataset.address)));
}

function openDrawer(address) {
  const t = state.tokens.find((x) => x.address === address);
  if (!t) return;
  state.drawerAddress = address;
  const range = t.high24h > t.low24h ? ((t.price-t.low24h)/(t.high24h-t.low24h))*100 : 50;
  const tokenAlerts = state.alerts
    .filter((item)=>item.address === address)
    .sort((a,b)=>b.createdAt-a.createdAt);
  const firstAlert = tokenAlerts.at(-1);
  const firstSignalTime = t.firstSignalAt || firstAlert?.createdAt || null;
  const firstSignalPrice = Number(firstAlert?.price) || null;
  const signalReturn = firstSignalPrice ? ((t.price / firstSignalPrice) - 1) * 100 : null;
  const trendValues = (t.sparkline15m || t.sparkline5m || []).filter((value)=>Number.isFinite(value) && value > 0);
  const trendPath = sparklinePath(trendValues,420,96);
  const trendDown = trendValues.length > 1 && trendValues.at(-1) < trendValues[0];
  const eventTimeline = tokenAlerts.slice(0,6);
  const chain = t.chainIntel || {};
  $('drawerContent').innerHTML = `
    <p class="eyebrow">TOKEN INTELLIGENCE / ${escapeHtml(t.chainName)}</p>
    <div class="drawer-asset"><img src="${escapeHtml(iconUrl(t))}" alt="" onerror="this.style.visibility='hidden'"><div><h2>${escapeHtml(t.symbol)} <span style="color:#66716b;font-weight:400">${escapeHtml(t.name)}</span></h2><p>${escapeHtml(t.address)}</p></div></div>
    <div class="verdict"><div class="verdict-head"><div><h3>综合建议</h3><span class="action ${t.tone}">${escapeHtml(t.action)}</span> <span class="action">${escapeHtml(t.quality || '待确认')}</span> <span class="stage stage-${escapeHtml(t.stage)}">${escapeHtml(t.stage || '观察')} · 置信度${escapeHtml(t.confidence || '建立中')}</span></div><strong style="color:${scoreColor(t.score)}">${t.score}<small style="font-size:12px;color:#6f7a74"> / 100</small></strong></div><p>${adviceText(t)}</p></div>
    <section class="signal-journey">
      <div class="journey-head"><div><span>信号追踪</span><strong id="signalStatus">${signalStatusText(signalReturn)}</strong></div><em>15 MIN</em></div>
      <div class="journey-stats">
        <div><span>首次异动</span><b>${firstSignalTime ? new Date(firstSignalTime).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : '尚未触发'}</b></div>
        <div><span>首次异动价</span><b>${firstSignalPrice ? money(firstSignalPrice) : '等待记录'}</b></div>
        <div><span>信号后涨跌</span><b id="signalReturn" data-first-price="${firstSignalPrice || ''}" class="${signalReturn === null || signalReturn >= 0 ? 'positive' : 'negative'}">${signalReturn === null ? '—' : pct(signalReturn)}</b></div>
        <div><span>异动事件</span><b>${tokenAlerts.length} 次</b></div>
      </div>
      <div class="journey-chart ${trendDown ? 'down' : 'up'}">
        ${trendPath ? `<svg viewBox="0 0 420 96" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(t.symbol)} 近十五分钟价格趋势"><defs><linearGradient id="journeyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path class="journey-area" d="${trendPath} L418 93 L2 93 Z"/><path class="journey-line" d="${trendPath}"/></svg>` : '<div class="journey-empty">正在积累 15 分钟趋势样本</div>'}
        <span>15 分钟前</span><span>现在</span>
      </div>
      <div class="journey-events">
        <div class="journey-events-head"><span>异动事件时间线</span><small>最近 ${Math.min(eventTimeline.length,6)} 条</small></div>
        ${eventTimeline.length ? eventTimeline.map((item)=>`<article class="journey-event level-${escapeHtml(item.level)}"><i></i><div><span><b>${escapeHtml(item.label)}</b><time>${new Date(item.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</time></span><p>${escapeHtml(item.message)}</p><small>评分 ${item.score} · ${escapeHtml(item.stage || '观察')} · ${item.price ? money(item.price) : '价格未记录'}</small></div></article>`).join('') : '<div class="journey-no-events">当前币种还没有触发监控规则</div>'}
      </div>
    </section>
    <section class="chain-intelligence ${chain.configured ? '' : 'not-configured'}">
      <div class="chain-intel-head"><div><span>链上资金确认</span><strong>SMART MONEY / SWAP / LIQUIDITY</strong></div><em id="chainIntelStatus" class="chain-intel-status ${chain.status === 'live' ? 'live' : chain.configured ? 'waiting' : 'disabled'}">${chainStatusText(chain)}</em></div>
      ${chain.configured ? `<div class="chain-intel-grid">
        <div><span>Smart Money 15M 净流入</span><b id="chainSmartNet" class="${(chain.smartNetUsd || 0) >= 0 ? 'positive' : 'negative'}">${signedMoney(chain.smartNetUsd || 0)}</b><small id="chainSmartWallets">${chain.smartWallets || 0} 个地址 · ${chain.smartSignals || 0} 次聚合信号</small></div>
        <div><span>大额 Swap 15M 净流入</span><b id="chainLargeSwap" class="${(chain.largeSwapNetUsd || 0) >= 0 ? 'positive' : 'negative'}">${signedMoney(chain.largeSwapNetUsd || 0)}</b><small id="chainLargeSwapCount">${chain.largeSwapCount || 0} 笔 · 门槛 ${money(chain.largeSwapThreshold || 10_000)}</small></div>
        <div><span>池子流动性 5M 变化</span><b id="chainLiquidityDelta" class="${chain.liquidityChange5m === null || chain.liquidityChange5m === undefined ? '' : chain.liquidityChange5m >= 0 ? 'positive' : 'negative'}">${chainDelta(chain.liquidityChange5m)}</b><small id="chainLiquidityNow">当前 ${money(chain.liquidity || t.liquidity)}</small></div>
        <div><span>Top10 持仓集中度</span><b id="chainTop10" class="${chain.top10Percent >= 80 ? 'negative' : chain.top10Percent === null || chain.top10Percent === undefined ? '' : 'positive'}">${chain.top10Percent === null || chain.top10Percent === undefined ? '建立中' : chain.top10Percent.toFixed(2)+'%'}</b><small id="chainHolderCount">${chain.holders ? fmt.format(chain.holders)+' 个地址' : '等待集中度事件'}</small></div>
      </div><p class="chain-intel-note">实时订阅评分最高及近期触发告警的 24 个币种；Smart Money 全市场信号独立监听。</p>` : chain.status === 'disabled' ? `<div class="chain-intel-setup"><i></i><div><b>OKX 付费链上监控已跳过</b><p>当前继续使用 Binance Alpha 实时行情、异动规则和模拟仓，不会连接 OKX Market API。</p></div></div>` : `<div class="chain-intel-setup"><i></i><div><b>OKX 链上数据源尚未配置</b><p>当前继续使用 Binance Alpha 行情评分。配置本机开发者凭据后，Smart Money、大额 Swap、池子变化和集中度会自动参与评分。</p></div></div>`}
    </section>
    <div class="detail-grid">
      <div><span>当前价格</span><b id="drawerLivePrice">${money(t.price)}</b></div><div><span>24H 涨跌</span><b id="drawerLiveChange" class="${t.change24h>=0?'positive':'negative'}">${pct(t.change24h)}</b></div>
      <div><span>市值</span><b>${money(t.marketCap)}</b></div><div><span>FDV</span><b>${money(t.fdv)}</b></div>
      <div><span>24H 成交额</span><b id="drawerLiveVolume">${money(t.volume24h)}</b></div><div><span>流动性</span><b>${money(t.liquidity)}</b></div>
      <div><span>持币地址</span><b>${fmt.format(t.holders)}</b></div><div><span>24H 交易笔数</span><b>${fmt.format(t.trades24h)}</b></div>
      <div><span>成交额 / 流动性</span><b>${t.metrics.volumeLiquidityRatio.toFixed(2)}x</b></div><div><span>平均每笔</span><b>${money(t.metrics.averageTradeUsd)}</b></div>
      <div><span>日内价格位置</span><b>${(t.metrics.intradayPosition*100).toFixed(0)}%</b></div><div><span>FDV / 市值</span><b>${t.metrics.unlockRatio.toFixed(2)}x</b></div>
      <div><span>1分钟动量</span><b>${metricPct(t.metrics.change1m)}</b></div><div><span>5分钟动量</span><b>${metricPct(t.metrics.change5m)}</b></div>
      <div><span>15分钟动量</span><b>${metricPct(t.metrics.change15m)}</b></div><div><span>5分钟资金强度</span><b>${t.metrics.flow5mRatio===null?'建立中':(t.metrics.flow5mRatio*100).toFixed(2)+'%'}</b></div>
      <div><span>首次异动</span><b>${t.firstSignalAt ? new Date(t.firstSignalAt).toLocaleString('zh-CN',{hour12:false}) : '尚未触发'}</b></div><div><span>行情来源</span><b>${escapeHtml(t.priceSource || 'Binance Alpha')}</b></div>
    </div>
    <div class="range"><div class="range-label"><span>24H LOW ${money(t.low24h)}</span><span>HIGH ${money(t.high24h)}</span></div><div class="range-track"><i style="left:${Math.max(0,Math.min(100,range))}%"></i></div></div>
    <section class="trade-ticket" id="tradeTicket">
      <div class="trade-ticket-head"><h3>模拟交易</h3><span>实时价 <b id="tradeLivePrice">${money(t.price)}</b></span></div>
      <div class="trade-sides"><button class="active" data-side="buy">模拟买入</button><button data-side="sell">模拟卖出</button></div>
      <label class="trade-input"><input id="tradeAmount" type="number" min="0" step="10" placeholder="输入金额"><span>USDT</span></label>
      <div class="trade-presets" id="tradePresets"></div>
      <button class="trade-submit" id="tradeSubmit">按市价模拟买入</button>
      <div class="trade-balance"><span id="tradeAvailable"></span><span>不计手续费与滑点</span></div>
    </section>
    <div class="reason-columns"><div class="good"><h4>正向信号</h4><ul>${(t.positives.length?t.positives:['暂无明确正向共振']).map(x=>`<li>＋ ${escapeHtml(x)}</li>`).join('')}</ul></div><div class="bad"><h4>风险扣分</h4><ul>${(t.risks.length?t.risks:['暂未触发结构性风险']).map(x=>`<li>－ ${escapeHtml(x)}</li>`).join('')}</ul></div></div>`;
  setupTradeTicket(t);
  $('drawer').classList.add('open'); $('drawerBackdrop').classList.add('open'); $('drawer').setAttribute('aria-hidden','false');
}

function setupTradeTicket(token) {
  let side = 'buy';
  const input = $('tradeAmount');
  const submit = $('tradeSubmit');
  const available = $('tradeAvailable');
  const presetsEl = $('tradePresets');
  const sync = () => {
    const position = state.paper.positions[token.address];
    const sellValue = (position?.qty || 0) * token.price;
    document.querySelectorAll('.trade-sides button').forEach((button)=>button.classList.toggle('active',button.dataset.side===side));
    submit.textContent = side === 'buy' ? '按市价模拟买入' : '按市价模拟卖出';
    submit.className = `trade-submit${side==='sell'?' sell':''}`;
    available.textContent = side === 'buy' ? `可用 ${money(state.paper.cash)}` : `可卖 ${money(sellValue)}`;
    presetsEl.innerHTML = side === 'buy'
      ? '<button data-value="500">$500</button><button data-value="1000">$1K</button><button data-value="5000">$5K</button><button data-max="1">MAX</button>'
      : '<button data-pct="25">25%</button><button data-pct="50">50%</button><button data-pct="75">75%</button><button data-pct="100">MAX</button>';
  };
  document.querySelector('.trade-sides').addEventListener('click',(event)=>{
    if (!event.target.dataset.side) return;
    side = event.target.dataset.side; input.value=''; sync();
  });
  presetsEl.addEventListener('click',(event)=>{
    const position = state.paper.positions[token.address];
    if (event.target.dataset.max) input.value = Math.floor(state.paper.cash * 100) / 100;
    else if (event.target.dataset.value) input.value = event.target.dataset.value;
    else if (event.target.dataset.pct) input.value = (((position?.qty||0)*token.price*Number(event.target.dataset.pct))/100).toFixed(2);
  });
  submit.addEventListener('click',()=>executePaperTrade(token,side,Number(input.value)));
  sync();
}

function executePaperTrade(token, side, amount) {
  token = state.tokens.find((t)=>t.address===token.address) || token;
  if (!Number.isFinite(amount) || amount <= 0) return showToast('请输入有效的 USDT 金额',true);
  if (!token.price) return showToast('当前价格不可用',true);
  const existing = state.paper.positions[token.address];
  if (side === 'buy') {
    if (amount > state.paper.cash + 0.001) return showToast('模拟账户可用资金不足',true);
    const qty = amount / token.price;
    const oldQty = existing?.qty || 0;
    const oldCost = oldQty * (existing?.avgCost || 0);
    state.paper.positions[token.address] = { symbol:token.symbol, name:token.name, qty:oldQty+qty, avgCost:(oldCost+amount)/(oldQty+qty), lastPrice:token.price };
    state.paper.cash -= amount;
    showToast(`已模拟买入 ${token.symbol} · ${money(amount)}`);
  } else {
    if (!existing?.qty) return showToast(`当前没有 ${token.symbol} 模拟持仓`,true);
    const maxValue = existing.qty * token.price;
    if (amount > maxValue + 0.01) return showToast('卖出金额超过当前持仓',true);
    const qty = Math.min(existing.qty, amount / token.price);
    const proceeds = qty * token.price;
    state.paper.cash += proceeds;
    state.paper.realized += (token.price-existing.avgCost)*qty;
    existing.qty -= qty;
    existing.lastPrice = token.price;
    if (existing.qty < 1e-10) delete state.paper.positions[token.address];
    showToast(`已模拟卖出 ${token.symbol} · ${money(proceeds)}`);
  }
  state.paper.trades.unshift({side,symbol:token.symbol,address:token.address,amount,price:token.price,time:Date.now()});
  state.paper.trades = state.paper.trades.slice(0,100);
  savePaper(); renderPortfolio(); renderTable(); openDrawer(token.address);
}

function closeDrawer() { state.drawerAddress=null; $('drawer').classList.remove('open'); $('drawerBackdrop').classList.remove('open'); $('drawer').setAttribute('aria-hidden','true'); }

async function loadTokens(force=false) {
  if (state.loading) return;
  state.loading = true; $('refreshBtn').classList.add('spin');
  try {
    const response = await fetch(`/api/tokens?chain=56${force?'&refresh=1':''}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '数据请求失败');
    state.tokens = data.tokens; state.fetchedAt = data.fetchedAt;
    if (data.error) {
      $('statusDot').className = 'error';
      $('systemText').textContent = `缓存模式 · ${data.error}`;
    } else renderSystemStatus(data.source);
    $('updatedAt').textContent = `更新于 ${new Date(data.fetchedAt).toLocaleTimeString('zh-CN',{hour12:false})}`;
    renderKpis(); renderFeed(); renderPortfolio(); applyFilters();
    if (state.drawerAddress) {
      const live = state.tokens.find((t)=>t.address===state.drawerAddress);
      if (live) {
        if ($('drawerLivePrice')) $('drawerLivePrice').textContent = money(live.price);
        if ($('tradeLivePrice')) $('tradeLivePrice').textContent = money(live.price);
        updateDrawerChainIntel(live);
      }
    }
  } catch (error) {
    $('statusDot').className = 'error'; $('systemText').textContent = error.message;
    $('tokenRows').innerHTML = `<tr><td colspan="7" class="loading">${escapeHtml(error.message)}</td></tr>`;
  } finally { state.loading = false; $('refreshBtn').classList.remove('spin'); }
}

$('searchInput').addEventListener('input', (e) => { state.query=e.target.value; state.page=1; applyFilters(); });
$('actionFilter').addEventListener('change', (e) => { state.action=e.target.value; state.page=1; applyFilters(); });
$('viewTabs').addEventListener('click', (e) => { if (!e.target.dataset.view) return; document.querySelectorAll('#viewTabs button').forEach(b=>b.classList.toggle('active',b===e.target)); state.view=e.target.dataset.view; state.page=1; applyFilters(); });
$('prevPage').addEventListener('click',()=>{if(state.page>1){state.page--;renderTable();}});
$('nextPage').addEventListener('click',()=>{const pages=Math.ceil(state.filtered.length/state.pageSize);if(state.page<pages){state.page++;renderTable();}});
$('refreshBtn').addEventListener('click',()=>loadTokens(true));
$('exportPortfolio').addEventListener('click',exportPaperPortfolio);
$('importPortfolio').addEventListener('click',()=>$('portfolioFile').click());
$('portfolioFile').addEventListener('change',(event)=>{ importPaperPortfolio(event.target.files?.[0]); event.target.value=''; });
$('resetPortfolio').addEventListener('click',()=>{
  if (!confirm('确定清空全部模拟持仓和交易记录，并恢复 100,000 USDT 吗？')) return;
  state.paper = emptyPaper();
  savePaper(); renderPortfolio(); renderTable(); showToast('模拟仓已重置');
});
$('rulesToggle').addEventListener('click',()=>{
  const panel = $('rulesPanel');
  panel.hidden = !panel.hidden;
  $('rulesToggle').classList.toggle('active', !panel.hidden);
});
$('resetRules').addEventListener('click',()=>{
  state.rules = {...defaultRules}; syncRuleInputs(); updateRuleSummary(); state.page=1; applyFilters();
  document.querySelectorAll('#presets button').forEach((button)=>button.classList.remove('active'));
});
$('presets').addEventListener('click',(event)=>{
  const name = event.target.dataset.preset;
  if (!name || !presets[name]) return;
  state.rules = {...defaultRules,...presets[name]}; syncRuleInputs(); updateRuleSummary(); state.page=1; applyFilters();
  document.querySelectorAll('#presets button').forEach((button)=>button.classList.toggle('active',button===event.target));
});
Object.values(ruleFields).forEach((id)=>$(id).addEventListener('input',()=>{
  document.querySelectorAll('#presets button').forEach((button)=>button.classList.remove('active'));
  readRules();
}));
$('drawerClose').addEventListener('click',closeDrawer); $('drawerBackdrop').addEventListener('click',closeDrawer);
$('compactToggle').addEventListener('click',()=>{
  state.compact = !state.compact;
  localStorage.setItem(COMPACT_KEY,state.compact ? '1' : '0');
  applyCompactMode();
});
$('alertsButton').addEventListener('click',openAlertCenter);
$('alertClose').addEventListener('click',closeAlertCenter); $('alertBackdrop').addEventListener('click',closeAlertCenter);
$('performanceButton').addEventListener('click',openPerformanceCenter);
$('performanceClose').addEventListener('click',closePerformanceCenter); $('performanceBackdrop').addEventListener('click',closePerformanceCenter);
$('performanceTabs').addEventListener('click',(event)=>{
  if (!event.target.dataset.horizon) return;
  state.performanceHorizon = event.target.dataset.horizon;
  document.querySelectorAll('#performanceTabs button').forEach((button)=>button.classList.toggle('active',button===event.target));
  loadPerformance();
});
$('alertTabs').addEventListener('click',(event)=>{
  if (!event.target.dataset.alertFilter) return;
  state.alertFilter = event.target.dataset.alertFilter;
  document.querySelectorAll('#alertTabs button').forEach((button)=>button.classList.toggle('active',button===event.target));
  renderAlerts();
});
$('markAlertsRead').addEventListener('click',()=>{
  state.lastAlertSeen = Math.max(Date.now(),...state.alerts.map((item)=>item.createdAt));
  localStorage.setItem(ALERT_SEEN_KEY,String(state.lastAlertSeen));
  renderAlerts(); showToast('全部提醒已标记为已读');
});
$('clearAlertMutes').addEventListener('click',()=>{
  state.mutedTokens.clear(); state.mutedRules.clear(); saveAlertMutes(); renderAlerts(); showToast('已恢复全部提醒');
});
$('notificationToggle').addEventListener('click',async()=>{
  if (!('Notification' in window)) return showToast('当前浏览器不支持桌面通知',true);
  if (Notification.permission === 'granted' && localStorage.getItem(ALERT_NOTIFY_KEY) === '1') {
    localStorage.setItem(ALERT_NOTIFY_KEY,'0'); renderNotificationState(); showToast('桌面通知已关闭'); return;
  }
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission === 'granted') {
    localStorage.setItem(ALERT_NOTIFY_KEY,'1'); renderNotificationState(); showToast('桌面通知已开启');
  } else { renderNotificationState(); showToast('需要在浏览器中允许通知权限',true); }
});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape'){closeDrawer();closeAlertCenter();closePerformanceCenter();}});
setInterval(()=>{$('clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false});},1000);
setInterval(()=>loadTokens(false),5_000);
syncRuleInputs(); updateRuleSummary();
renderPortfolio();
renderNotificationState();
applyCompactMode();
connectRealtime();
loadAlerts();
loadPaperFromServer();
loadPerformance();
loadTokens(true);
setInterval(loadAlerts,15_000);
setInterval(loadPerformance,30_000);
