import { createHmac } from 'node:crypto';

const ENDPOINT = 'wss://wsdex.okx.com/ws/v6/dex';
const CHAIN_INDEX = '56';
const HEARTBEAT_MS = 25_000;
const RECONNECT_MS = 3_000;
const MAX_FAST_RECONNECTS = 20;
const MAX_TOKEN_SUBSCRIPTIONS = 24;

const addressOf = (value) => String(value || '').toLowerCase();
const numberOf = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function subscriptionKey(arg) {
  return `${arg.channel}:${arg.chainIndex || ''}:${addressOf(arg.tokenContractAddress || arg.walletAddress)}`;
}

export function normalizeOkxPush(message) {
  const channel = message?.arg?.channel;
  if (!channel || !Array.isArray(message.data)) return [];
  if (channel === 'dex-market-new-signal-openapi') return message.data.map((item)=>({
    kind:'smart-signal', source:'OKX Signal', chainIndex:String(item.chainIndex || message.arg.chainIndex || ''),
    address:addressOf(item.token?.tokenAddress), symbol:item.token?.symbol || '', timestamp:numberOf(item.timestamp) || Date.now(),
    walletType:String(item.walletType || ''), walletCount:numberOf(item.triggerWalletCount),
    wallets:String(item.triggerWalletAddress || '').split(',').filter(Boolean), amountUsd:numberOf(item.amountUsd),
    soldRatio:numberOf(item.soldRatioPercentage), top10Percent:numberOf(item.token?.top10HolderPercentage),
    holders:numberOf(item.token?.holders), price:numberOf(item.price)
  }));
  if (channel === 'kol_smartmoney-tracker-activity' || channel === 'address-tracker-activity') return message.data.map((item)=>({
    kind:'smart-trade', source:'OKX Tracker', chainIndex:String(item.chainIndex || ''),
    address:addressOf(item.tokenContractAddress), symbol:item.tokenSymbol || '', timestamp:numberOf(item.tradeTime) || Date.now(),
    wallet:addressOf(item.walletAddress), walletTypes:Array.isArray(item.trackerType) ? item.trackerType.map(Number) : [],
    direction:String(item.tradeType) === '2' ? 'sell' : 'buy', quoteSymbol:String(item.quoteTokenSymbol || '').toUpperCase(),
    quoteAmount:numberOf(item.quoteTokenAmount), price:numberOf(item.tokenPrice), marketCap:numberOf(item.marketCap), txHash:item.txHash || ''
  }));
  if (channel === 'trades') return message.data.map((item)=>({
    kind:'swap', source:'OKX Trades', chainIndex:String(message.arg.chainIndex || ''),
    address:addressOf(message.arg.tokenContractAddress), timestamp:numberOf(item.time) || Date.now(),
    wallet:addressOf(item.userAddress), direction:item.type === 'sell' ? 'sell' : 'buy', amountUsd:numberOf(item.volume),
    price:numberOf(item.price), dexName:item.dexName || '', txHash:item.txHashUrl || '', id:item.id || ''
  }));
  if (channel === 'price-info') return message.data.map((item)=>({
    kind:'token-metrics', source:'OKX Price Info', chainIndex:String(message.arg.chainIndex || ''),
    address:addressOf(message.arg.tokenContractAddress), timestamp:numberOf(item.time) || Date.now(),
    price:numberOf(item.price), marketCap:numberOf(item.marketCap), liquidity:numberOf(item.liquidity), holders:numberOf(item.holders),
    volume5m:numberOf(item.volume5M), volume1h:numberOf(item.volume1H), txs5m:numberOf(item.txs5M),
    change5m:numberOf(item.priceChange5M), change1h:numberOf(item.priceChange1H)
  }));
  return [];
}

export class OkxChainIntelStream {
  constructor({ apiKey, secretKey, passphrase, onEvent, onStatus }) {
    this.credentials = { apiKey, secretKey, passphrase };
    this.onEvent = onEvent || (()=>{});
    this.onStatus = onStatus || (()=>{});
    this.socket = null;
    this.status = apiKey && secretKey && passphrase ? 'idle' : 'not_configured';
    this.lastEvent = 0;
    this.lastPong = 0;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.loggedIn = false;
    this.stopped = false;
    this.priorityTokens = [];
    this.subscriptions = new Map();
    this.emitStatus();
  }

  configured() {
    const { apiKey, secretKey, passphrase } = this.credentials;
    return Boolean(apiKey && secretKey && passphrase);
  }

  snapshot() {
    return {
      configured:this.configured(), status:this.status, lastEvent:this.lastEvent,
      ageMs:this.lastEvent ? Date.now() - this.lastEvent : null,
      subscriptions:this.subscriptions.size, trackedTokens:this.priorityTokens.length,
      reconnectAttempts:this.reconnectAttempts, error:this.lastError
    };
  }

  emitStatus() {
    this.onStatus(this.snapshot());
  }

  start() {
    this.stopped = false;
    if (!this.configured()) {
      this.status = 'not_configured';
      this.emitStatus();
      return;
    }
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    try { this.socket?.close(); } catch {}
    this.socket = null;
    this.loggedIn = false;
    this.status = 'stopped';
    this.emitStatus();
  }

  setPriorityTokens(tokens = []) {
    const unique = new Map();
    for (const token of tokens) {
      const address = addressOf(token.address || token);
      if (address && !unique.has(address)) unique.set(address,{ address, symbol:token.symbol || '' });
      if (unique.size >= MAX_TOKEN_SUBSCRIPTIONS) break;
    }
    this.priorityTokens = [...unique.values()];
    if (this.loggedIn) this.syncTokenSubscriptions();
    this.emitStatus();
  }

  loginPayload() {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = createHmac('sha256', this.credentials.secretKey)
      .update(`${timestamp}GET/users/self/verify`).digest('base64');
    return { op:'login', args:[{ apiKey:this.credentials.apiKey, passphrase:this.credentials.passphrase, timestamp, sign }] };
  }

  connect() {
    if (this.stopped || !this.configured()) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.status = this.reconnectAttempts ? 'reconnecting' : 'connecting';
    this.lastError = null;
    this.loggedIn = false;
    this.subscriptions.clear();
    this.emitStatus();
    try {
      const socket = new WebSocket(ENDPOINT);
      this.socket = socket;
      socket.addEventListener('open',()=>{
        this.status = 'authenticating';
        this.emitStatus();
        socket.send(JSON.stringify(this.loginPayload()));
      });
      socket.addEventListener('message',(event)=>this.handleMessage(event.data));
      socket.addEventListener('close',()=>{
        if (this.socket === socket) this.socket = null;
        this.loggedIn = false;
        this.subscriptions.clear();
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (!this.stopped) this.scheduleReconnect();
      });
      socket.addEventListener('error',()=>{
        this.status = 'error';
        this.lastError = 'OKX WebSocket connection failed';
        this.emitStatus();
        try { socket.close(); } catch {}
      });
    } catch (error) {
      this.status = 'error';
      this.lastError = error.message;
      this.emitStatus();
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    this.status = 'reconnecting';
    this.emitStatus();
    const delay = this.reconnectAttempts <= MAX_FAST_RECONNECTS ? RECONNECT_MS : 5 * 60_000;
    this.reconnectTimer = setTimeout(()=>{
      this.reconnectTimer = null;
      this.connect();
    },delay);
  }

  send(op,args) {
    if (!args.length || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ op, args }));
  }

  baseSubscriptions() {
    return [
      { channel:'kol_smartmoney-tracker-activity' },
      { channel:'dex-market-new-signal-openapi', chainIndex:CHAIN_INDEX }
    ];
  }

  syncTokenSubscriptions() {
    if (!this.loggedIn) return;
    const desired = new Map();
    for (const arg of this.baseSubscriptions()) desired.set(subscriptionKey(arg),arg);
    for (const token of this.priorityTokens) {
      for (const channel of ['price-info','trades']) {
        const arg = { channel, chainIndex:CHAIN_INDEX, tokenContractAddress:token.address };
        desired.set(subscriptionKey(arg),arg);
      }
    }
    const removals = [...this.subscriptions].filter(([key])=>!desired.has(key)).map(([,arg])=>arg);
    const additions = [...desired].filter(([key])=>!this.subscriptions.has(key)).map(([,arg])=>arg);
    this.send('unsubscribe',removals);
    this.send('subscribe',additions);
    for (const arg of removals) this.subscriptions.delete(subscriptionKey(arg));
    for (const arg of additions) this.subscriptions.set(subscriptionKey(arg),arg);
    this.emitStatus();
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.lastPong = Date.now();
    this.heartbeatTimer = setInterval(()=>{
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > HEARTBEAT_MS * 2.4) {
        this.lastError = 'OKX WebSocket heartbeat timeout';
        try { this.socket.close(); } catch {}
        return;
      }
      this.socket.send('ping');
    },HEARTBEAT_MS);
  }

  handleMessage(raw) {
    const text = typeof raw === 'string' ? raw : String(raw);
    if (text === 'pong') { this.lastPong = Date.now(); return; }
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.event === 'login') {
      if (String(message.code || '0') !== '0') {
        this.status = 'error';
        this.lastError = message.msg || 'OKX WebSocket authentication failed';
        this.emitStatus();
        try { this.socket?.close(); } catch {}
        return;
      }
      this.loggedIn = true;
      this.status = 'live';
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.syncTokenSubscriptions();
      this.emitStatus();
      return;
    }
    if (message.event === 'notice') {
      this.lastError = 'OKX service upgrade; reconnecting';
      try { this.socket?.close(); } catch {}
      return;
    }
    if (message.event === 'error') {
      this.lastError = message.msg || 'OKX subscription error';
      if (/active Market API subscription/i.test(this.lastError)) {
        this.status = 'subscription_required';
        this.subscriptions.clear();
      } else {
        this.status = 'error';
      }
      this.emitStatus();
      return;
    }
    const events = normalizeOkxPush(message);
    if (!events.length) return;
    this.lastEvent = Date.now();
    this.status = 'live';
    for (const event of events) this.onEvent(event);
    this.emitStatus();
  }
}
