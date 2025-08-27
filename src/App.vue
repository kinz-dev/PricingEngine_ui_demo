<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch} from 'vue';

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) {
    s += 2147483646;
  }
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function genInitialBook(mid = 100.0, levels = 12, seed = Date.now()) {
  const rand = seededRandom(seed);
  const bids = [];
  const asks = [];
  for (let i = 0; i < levels; i++) {
    const pBid = mid - (i + 1) * 0.5 - rand();
    const pAsk = mid + (i + 1) * 0.5 + rand();
    const qBid = 0.2 + rand() * 1.8;
    const qAsk = 0.2 + rand() * 1.8;
    bids.push({price: pBid, qty: qBid});
    asks.push({price: pAsk, qty: qAsk});
  }
  return {bids, asks};
}

function perturbBook(book, rand) {
  for (const side of [book.bids, book.asks]) {
    for (let i = 0; i < side.length; i++) {
      side[i].price += (rand() - 0.5) * 0.08;
      side[i].qty = Math.max(0.01, side[i].qty + (rand() - 0.5) * 0.1);
      if (rand() < 0.03) {
        side[i].qty = Math.max(0.05, 0.2 + rand() * 2);
      }
    }
  }
  if (rand() < 0.2) {
    const i = Math.floor(rand() * book.bids.length);
    book.bids[i] = {price: book.bids[i].price + (rand() - 0.5) * 0.5, qty: 0.2 + rand() * 2};
  }
  if (rand() < 0.2) {
    const i = Math.floor(rand() * book.asks.length);
    book.asks[i] = {price: book.asks[i].price + (rand() - 0.5) * 0.5, qty: 0.2 + rand() * 2};
  }
}

const tick = ref(0);
const timeStr = ref('');

// Simple in-app navigation between pages
const activePage = ref('pricing'); // 'pricing' | 'execution'

const config = reactive({
  symbol: 'XYZ-USD',
  venue: 'SIM',
  midPrice: 100.0,
  spreadTicks: 2,
  qtyScale: 1.0,
  maxLevels: 20,
  riskLimits: {
    maxNotional: 250000,
    maxOrderQty: 50,
    maxSkew: 0.6,
  },
});

// const wsUrl = ref('ws://localhost:48000/api/v7');
const wsUrl = ref('wss://md-ws-gateway.uat.immix.xyz/');


// WebSocket connection state
const ws = ref(null);
const wsStatus = ref('disconnected'); // 'connecting' | 'connected' | 'disconnected' | 'error'
const wsStatusDisplay = computed(() => {
  switch (wsStatus.value) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'error':
      return 'Error';
    default:
      return 'Disconnected';
  }
});

// subscription payload and helpers
const SUBSCRIBE_PAYLOAD = {
  op: 'subscribe',
  params: {topics: ['pe_orderbook.9999.BTCUSDT-PE-OB.100ms']},
  reqId: 'sub-1',
};

function sendSubscribe(socket = ws.value) {
  if (!socket || socket.readyState !== 1 /* OPEN */) {
    return;
  }
  try {
    socket.send(JSON.stringify(SUBSCRIBE_PAYLOAD));
    console.log('[WS] sent subscribe:', SUBSCRIBE_PAYLOAD);
  } catch (e) {
    console.error('[WS] failed to send subscribe:', e);
  }
}

let wsSubIntervalId = null;

function cleanupWs() {
  try {
    if (wsSubIntervalId) {
      clearInterval(wsSubIntervalId);
      wsSubIntervalId = null;
    }
    if (ws.value) {
      ws.value.onopen = null;
      ws.value.onmessage = null;
      ws.value.onclose = null;
      ws.value.onerror = null;
      ws.value.close();
    }
  } catch (e) {
    // swallow
  } finally {
    ws.value = null;
  }
}

function connectWs() {
  cleanupWs();
  if (!wsUrl.value) {
    wsStatus.value = 'disconnected';
    return;
  }
  try {
    wsStatus.value = 'connecting';

    // TODO hardcode
    // const socket = new WebSocket(wsUrl.value);
    const socket = new WebSocket('ws://localhost:48000/api/v7');
    ws.value = socket;

    socket.onopen = () => {
      wsStatus.value = 'connected';
      // send initial subscribe and start periodic resubscribe
      sendSubscribe(socket);
      if (wsSubIntervalId) {
        clearInterval(wsSubIntervalId);
      }
      wsSubIntervalId = setInterval(() => {
        if (wsStatus.value === 'connected') {
          sendSubscribe(socket);
        }
      }, 15000);
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg && (msg.event === 'pe_orderbook' || (msg.topic && String(msg.topic).startsWith('pe_orderbook')))) {
          if (msg.data) {
            applyOrderBookMessage(msg.data);
          }
        }
      } catch (e) {
        // ignore non-JSON messages
      }
    };

    socket.onclose = (ev) => {
      wsStatus.value = 'disconnected';
      if (wsSubIntervalId) {
        clearInterval(wsSubIntervalId);
        wsSubIntervalId = null;
      }
      console.log('[WS] closed:', {code: ev.code, reason: ev.reason});
    };

    socket.onerror = (err) => {
      wsStatus.value = 'error';
      if (wsSubIntervalId) {
        clearInterval(wsSubIntervalId);
        wsSubIntervalId = null;
      }
      console.error('[WS] error:', err);
    };
  } catch (e) {
    wsStatus.value = 'error';
    if (wsSubIntervalId) {
      clearInterval(wsSubIntervalId);
      wsSubIntervalId = null;
    }
    console.error('[WS] exception while connecting:', e);
  }
}

function toggleWs() {
  if (wsStatus.value === 'connected' || wsStatus.value === 'connecting') {
    console.log('[WS] manual disconnect requested');
    cleanupWs();
    wsStatus.value = 'disconnected';
  } else {
    console.log('[WS] manual connect requested');
    connectWs();
  }
}

// Reconnect when the URL changes
watch(wsUrl, (n, o) => {
  if (n !== o && activePage.value === 'pricing') {
    connectWs();
  }
});

// Execution Service WebSocket state
const esWsUrl = ref('ws://localhost:48010/api/v4');
const esWs = ref(null);
const esWsStatus = ref('disconnected'); // 'connecting' | 'connected' | 'disconnected' | 'error'
const esWsStatusDisplay = computed(() => {
  switch (esWsStatus.value) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'error':
      return 'Error';
    default:
      return 'Disconnected';
  }
});

function cleanupEsWs() {
  try {
    if (esWs.value) {
      esWs.value.onopen = null;
      esWs.value.onmessage = null;
      esWs.value.onclose = null;
      esWs.value.onerror = null;
      esWs.value.close();
    }
  } catch (e) {
    // ignore
  } finally {
    esWs.value = null;
  }
}

function connectEsWs() {
  cleanupEsWs();
  if (!esWsUrl.value) {
    esWsStatus.value = 'disconnected';
    return;
  }
  try {
    esWsStatus.value = 'connecting';
    const socket = new WebSocket(esWsUrl.value);
    esWs.value = socket;
    socket.onopen = () => {
      esWsStatus.value = 'connected';
    };
    socket.onclose = () => {
      esWsStatus.value = 'disconnected';
    };
    socket.onerror = () => {
      esWsStatus.value = 'error';
    };
    socket.onmessage = (ev) => {
      try {
        const text = typeof ev.data === 'string' ? ev.data : '';
        const msg = text ? JSON.parse(text) : ev.data;
        const evName = String(msg?.event || '').toLowerCase();
        const topic = String(msg?.topic || '').toLowerCase();
        if (!(evName === 'executionorder' || topic.startsWith('executionorder'))) {
          return;
        }
        // Convert gatewayTimeNs (string) to milliseconds safely using BigInt when available
        const nsStr = msg?.gatewayTimeNs != null ? String(msg.gatewayTimeNs) : '';
        let tsMs = Date.now();
        try {
          if (nsStr) {
            tsMs = Number(BigInt(nsStr) / 1000000n);
          }
        } catch (_) {
          if (nsStr && nsStr.length > 6) {
            tsMs = Number(nsStr.slice(0, nsStr.length - 6));
          }
        }
        const d = new Date(tsMs);
        const pad2 = (n) => String(n).padStart(2, '0');
        const timeStr = isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
            d.getMinutes())}:${pad2(d.getSeconds())}`;
        const arr = Array.isArray(msg?.data) ? msg.data : [];
        const mapped = arr.map((it, idx) => {
          const orderId = it?.orderId != null ? String(it.orderId) : (it?.clOrdId ? String(it.clOrdId) : `tmp-${idx}`);
          const statusRaw = String((it?.status ?? it?.strategyStatus ?? '')).toUpperCase().replace(/\s+/g, '_');
          const status = statusRaw === 'CANCELLED' ? 'CANCELED' : statusRaw;
          return {
            symbol: String(it?.symbol ?? ''),
            algoId: String(it?.algoId ?? ''),
            orderId,
            qty: String(it?.qty ?? ''),
            tif: String(it?.tif ?? ''),
            clOrdId: String(it?.clOrdId ?? ''),
            side: String(it?.side ?? '').toUpperCase(),
            limitPx: String(it?.limitPx ?? ''),
            cumQty: String(it?.cumQty ?? ''),
            leavesQty: String(it?.leavesQty ?? ''),
            avgFillPrice: String(it?.avgFillPrice ?? ''),
            status,
            strategyStatus: String(it?.strategyStatus ?? ''),
            rejectReason: String(it?.rejectReason ?? ''),
            rejectSource: String(it?.rejectSource ?? ''),
          };
        });
        if (mapped.length) {
          // Merge by clOrdId: update existing rows with same clOrdId, add new rows for new clOrdId
          const current = Array.isArray(orders.value) ? orders.value : [];
          for (const m of mapped) {
            const key = String(m?.clOrdId || '');
            if (!key) {
              // If clOrdId is missing, append as-is
              current.push(m);
              continue;
            }
            const idx = current.findIndex(r => String(r?.clOrdId || '') === key);
            if (idx >= 0) {
              // Preserve object reference for reactivity-friendly updates
              const existing = current[idx];
              Object.assign(existing, m);
            } else {
              current.push(m);
            }
          }
          orders.value = current;
        }
      } catch (e) {
        // ignore parse errors/unrelated messages
      }
    };
  } catch (e) {
    esWsStatus.value = 'error';
  }
}

function toggleEsWs() {
  if (esWsStatus.value === 'connected' || esWsStatus.value === 'connecting') {
    cleanupEsWs();
    esWsStatus.value = 'disconnected';
  } else {
    connectEsWs();
  }
}

watch(esWsUrl, (n, o) => {
  if (n !== o && activePage.value === 'execution') {
    connectEsWs();
  }
});

// Execution form state and payload
const execForm = reactive({
  op: 'placeOrder',
  reqId: 'req-1',
  orgId: '9999',
  symbol: 'BTC/USDT',
  strategy: 'TWAP',
  px: '121600',
  qty: '0.06',
  side: 'BUY',
  accountBookKey: 'okx_main',
  accountBookValue: 'BOOK_1',
  timeInForce: 'GOOD_TILL_CANCEL',
  clientOrderId: 'cl-0001',
  params: {
    startTimeMillis: String(Date.now()),
    endTimeMillis: String(Date.now()),
    intervalMillis: 300000,
  },
});

// --- Date/Time helpers for datetime-local inputs (local timezone) ---
function pad2(n) {
  return String(n).padStart(2, '0');
}

function millisToLocalInput(msStr) {
  const n = Number(msStr);
  if (!isFinite(n)) {
    return '';
  }
  const d = new Date(n);
  if (isNaN(d.getTime())) {
    return '';
  }
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  // Include seconds and set step=1 on input so seconds are allowed
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}`;
}

function localInputToMillis(str) {
  if (!str) {
    return '';
  }
  const d = new Date(str);
  const t = d.getTime();
  if (isNaN(t)) {
    return '';
  }
  return String(t);
}

// Local datetime input models for UX; we map them to millis in execForm
const startLocal = ref(millisToLocalInput(execForm.params.startTimeMillis));
const endLocal = ref(millisToLocalInput(execForm.params.endTimeMillis));

watch(startLocal, (v) => {
  execForm.params.startTimeMillis = localInputToMillis(v);
});
watch(endLocal, (v) => {
  execForm.params.endTimeMillis = localInputToMillis(v);
});

const execPayload = computed(() => ({
  op: execForm.op,
  reqId: execForm.reqId,
  orgId: execForm.orgId,
  symbol: execForm.symbol,
  strategy: execForm.strategy,
  px: execForm.px,
  qty: execForm.qty,
  side: execForm.side,
  accountBookMapping: {[execForm.accountBookKey || 'okx_main']: execForm.accountBookValue || 'BOOK_1'},
  timeInForce: execForm.timeInForce,
  clientOrderId: execForm.clientOrderId,
  params: {
    startTimeMillis: execForm.params.startTimeMillis,
    endTimeMillis: execForm.params.endTimeMillis,
    intervalMillis: Number(execForm.params.intervalMillis),
  }
}));

const execPayloadText = computed(() => JSON.stringify(execPayload.value, null, 2));
const execSendStatus = ref('');
const execSendError = ref('');

// --- ID helpers: reqId and clientOrderId sequencing and duplicate validation ---
const reqSeq = ref(0);
const clSeq = ref(0);

function parseNumWithPrefix(str, prefix) {
  const m = String(str || '').match(new RegExp('^' + prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '(\\d+)$', 'i'));
  return m ? Number(m[1]) : 0;
}

function padLeft(num, width = 4) {
  const n = Math.max(0, Number(num) | 0);
  return String(n).padStart(width, '0');
}

function ensureReqSeq() {
  if (!reqSeq.value) {
    const n = parseNumWithPrefix(execForm.reqId, 'req-');
    reqSeq.value = n > 0 ? n : 1;
  }
}

function ensureClSeq() {
  if (!clSeq.value) {
    const n = parseNumWithPrefix(execForm.clientOrderId, 'cl-');
    clSeq.value = n > 0 ? n : 1;
  }
}

function bumpReq() {
  ensureReqSeq();
  reqSeq.value += 1;
  execForm.reqId = `req-${reqSeq.value}`;
  return execForm.reqId;
}

function bumpCl() {
  ensureClSeq();
  clSeq.value += 1;
  execForm.clientOrderId = `cl-${padLeft(clSeq.value, 4)}`;
  return execForm.clientOrderId;
}

function isClOrdIdDuplicate(id) {
  const target = String(id || '');
  if (!target) {
    return false;
  }
  try {
    return Array.isArray(orders.value) && orders.value.some(o => String(o?.clOrdId || '') === target);
  } catch (_) {
    return false;
  }
}

// Mock data for Orders, Child Orders and Trades (displayed on right panel)
const orders = ref([]);
const childOrders = ref([
  {orderId: 'co-3001', time: '2025-08-26 19:41:00', symbol: 'BTC/USDT', side: 'BUY', qty: '0.02', px: '121610', status: 'New'},
]);
const trades = ref([
  {tradeId: 't-2001', time: '2025-08-26 19:41:30', side: 'BUY', qty: '0.02', px: '121620', orderId: 'o-1001'},
  {tradeId: 't-2002', time: '2025-08-26 19:41:58', side: 'SELL', qty: '0.01', px: '121770', orderId: 'o-1002'},
]);

function isCancelDisabled(status) {
  const s = String(status || '').toUpperCase().replace(/\s+/g, '_');
  const normalized = s === 'CANCELLED' ? 'CANCELED' : s;
  return normalized === 'PENDING_CANCELED'
      || normalized === 'FILLED'
      || normalized === 'REJECTED'
      || normalized === 'EXPIRED'
      || normalized === 'CANCELED';
}

function cancelOrder(order) {
  if (!order) {
    return;
  }
  if (isCancelDisabled(order.status)) {
    return;
  }
  const socket = esWs.value;
  if (!socket || socket.readyState !== 1) {
    console.warn('[ES] WebSocket not connected, cannot send cancel');
    return;
  }
  try {
    ensureReqSeq();
    const currentReqId = `req-${reqSeq.value}`;
    const clientOrderId = String(order?.clOrdId || '').trim();
    if (!clientOrderId) {
      console.warn('[ES] cancelOrder: missing clientOrderId on row');
      return;
    }
    const msg = {
      op: 'cancelOrder',
      reqId: currentReqId,
      orgId: execForm.orgId || '9999',
      clientOrderId,
    };
    socket.send(JSON.stringify(msg));
    // Next reqId for subsequent actions
    bumpReq();
    // Optimistic UI update
    order.status = 'PENDING_CANCELED';
  } catch (e) {
    console.error('[ES] cancelOrder send failed', e);
  }
}

function sendExec() {
  execSendStatus.value = '';
  execSendError.value = '';
  const socket = esWs.value;
  if (!socket || socket.readyState !== 1) {
    execSendError.value = 'WebSocket not connected';
    return;
  }
  // Validate duplicate clientOrderId against Execution Order table
  const clId = String(execForm.clientOrderId || '').trim();
  if (!clId) {
    execSendError.value = 'clientOrderId is required';
    return;
  }
  if (isClOrdIdDuplicate(clId)) {
    execSendError.value = `Duplicate clientOrderId: ${clId}`;
    return;
  }
  try {
    // Ensure sequences are initialized from current form values
    ensureReqSeq();
    ensureClSeq();
    const text = execPayloadText.value;
    socket.send(text);
    execSendStatus.value = 'Sent';
    // Auto-increment reqId and clientOrderId for the next order
    bumpReq();
    bumpCl();
  } catch (e) {
    execSendError.value = e?.message || String(e);
  }
}

// Manage WS connections based on active page
watch(activePage, (n, o) => {
  if (n === 'pricing') {
    connectWs();
    cleanupEsWs();
  } else if (n === 'execution') {
    connectEsWs();
    cleanupWs();
  }
});

// Efficient order book storage using reactive Maps keyed by numeric price
const bidsMap = reactive(new Map()); // Map<number(price), number(qty)>
const asksMap = reactive(new Map()); // Map<number(price), number(qty)>
const bidsExchangesMap = reactive(new Map()); // Map<number(price), string(csv exchange ids)>
const asksExchangesMap = reactive(new Map()); // Map<number(price), string(csv exchange ids)>

function applyLevels(side, levels) {
  const qtyTarget = side === 'bids' ? bidsMap : asksMap;
  const exTarget = side === 'bids' ? bidsExchangesMap : asksExchangesMap;
  if (!Array.isArray(levels)) {
    return;
  }
  // Aggregate per message by price: sum quantities and gather exchanges
  const agg = new Map(); // Map<number, { qty:number, exchanges:Set<string> }>
  for (const lvl of levels) {
    if (!Array.isArray(lvl) || lvl.length < 2) {
      continue;
    }
    const priceNum = Number(lvl[0]);
    const qtyNum = Number(lvl[1]);
    const exch = (lvl.length >= 3 && lvl[2] != null) ? String(lvl[2]).trim() : '';
    if (!isFinite(priceNum) || !isFinite(qtyNum)) {
      continue;
    }
    const rec = agg.get(priceNum) || {qty: 0, exchanges: new Set()};
    rec.qty += qtyNum;
    if (exch) {
      rec.exchanges.add(exch);
    }
    agg.set(priceNum, rec);
  }
  for (const [price, {qty, exchanges}] of agg.entries()) {
    if (qty <= 0) {
      console.log('[OB] remove level', {side, price});
      qtyTarget.delete(price);
      exTarget.delete(price);
    } else {
      qtyTarget.set(price, qty);
      exTarget.set(price, Array.from(exchanges).join(','));
    }
  }
}

function applyOrderBookMessage(data) {
  if (!data) {
    return;
  }
  // If snapshot=true, replace content; otherwise, apply incremental
  if (data.snapshot === true) {
    bidsMap.clear();
    asksMap.clear();
    bidsExchangesMap.clear();
    asksExchangesMap.clear();
  }
  if (Array.isArray(data.bids)) {
    applyLevels('bids', data.bids);
  }
  if (Array.isArray(data.asks)) {
    applyLevels('asks', data.asks);
  }
  tick.value++;
}

const bidsSorted = computed(() => {
  const entries = [];
  bidsMap.forEach((qty, priceKey) => {
    const price = Number(priceKey);
    if (!isFinite(price) || qty <= 0) {
      return;
    }
    const exchanges = bidsExchangesMap.get(price) || '';
    entries.push({price, qty, exchanges});
  });
  entries.sort((a, b) => b.price - a.price);
  const limit = Math.max(1, Math.min(100, Math.floor(config.maxLevels || entries.length || 1)));
  let cum = 0;
  return entries.slice(0, limit).map((r) => ({...r, cum: (cum += r.qty)}));
});

const asksSorted = computed(() => {
  const entries = [];
  asksMap.forEach((qty, priceKey) => {
    const price = Number(priceKey);
    if (!isFinite(price) || qty <= 0) {
      return;
    }
    const exchanges = asksExchangesMap.get(price) || '';
    entries.push({price, qty, exchanges});
  });
  entries.sort((a, b) => a.price - b.price);
  const limit = Math.max(1, Math.min(100, Math.floor(config.maxLevels || entries.length || 1)));
  let cum = 0;
  return entries.slice(0, limit).map((r) => ({...r, cum: (cum += r.qty)}));
});

const bidMax = computed(() => bidsSorted.value.reduce((m, r) => Math.max(m, r.cum), 0) || 1);
const askMax = computed(() => asksSorted.value.reduce((m, r) => Math.max(m, r.cum), 0) || 1);

// Exchange icons mapping
const EX_ICON_BINANCE = 'https://image.immix.xyz/exchanges/binance_spot-colour-dark.svg';
const EX_ICON_OKX = 'https://image.immix.xyz/exchanges/okx-colour-light.svg';

function mapExchangesToIcons(exchangesCsv) {
  try {
    if (!exchangesCsv) {
      return [];
    }
    const parts = String(exchangesCsv)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
    let hasBinance = false;
    let hasOkx = false;
    for (const p of parts) {
      if (p.startsWith('100')) {
        hasBinance = true;
      } else if (p.startsWith('300')) {
        hasOkx = true;
      }
    }
    const icons = [];
    if (hasOkx) {
      icons.push({url: EX_ICON_OKX, alt: 'OKX', title: 'OKX'});
    }
    if (hasBinance) {
      icons.push({url: EX_ICON_BINANCE, alt: 'Binance Spot', title: 'Binance Spot'});
    }
    return icons;
  } catch (e) {
    return [];
  }
}

// Top-of-book and spread (bps)
const bestBid = computed(() => (bidsSorted.value.length ? bidsSorted.value[0].price : NaN));
const bestAsk = computed(() => (asksSorted.value.length ? asksSorted.value[0].price : NaN));
const spread = computed(() => {
  const b = bestBid.value;
  const a = bestAsk.value;
  return Number.isFinite(b) && Number.isFinite(a) ? a - b : NaN;
});
const spreadBps = computed(() => {
  const b = bestBid.value;
  const a = bestAsk.value;
  const s = spread.value;
  if (!Number.isFinite(b) || !Number.isFinite(a) || !Number.isFinite(s)) {
    return NaN;
  }
  const mid = (a + b) / 2;
  if (!Number.isFinite(mid) || mid === 0) {
    return NaN;
  }
  return (s / mid) * 10000;
});
const spreadBpsDisplay = computed(() =>
    Number.isFinite(spreadBps.value) ? `${spreadBps.value >= 0 ? '+' : ''}${spreadBps.value.toFixed(1)}` : '—'
);
const spreadSignClass = computed(() => {
  const v = spreadBps.value;
  if (!Number.isFinite(v)) {
    return 'zero';
  }
  if (v > 0) {
    return 'pos';
  }
  if (v < 0) {
    return 'neg';
  }
  return 'zero';
});

const prettyConfig = computed(() => JSON.stringify(config, null, 2));

function randomizeConfig() {
  const r = Math.random;
  config.midPrice = 80 + r() * 40;
  config.spreadTicks = Math.floor(1 + r() * 4);
  config.qtyScale = +(0.5 + r() * 1.5).toFixed(2);
  config.maxLevels = 10 + Math.floor(r() * 8);
  config.riskLimits.maxNotional = 100000 + Math.floor(r() * 500000);
  config.riskLimits.maxOrderQty = 5 + Math.floor(r() * 95);
  config.riskLimits.maxSkew = +(0.1 + r()).toFixed(2);
}

let intervalId;
let clockId;

const externalConfigText = ref('');
const externalError = ref('');
const externalLoading = ref(true);
const externalHash = ref('');
// Inline JSON editor state
const isEditing = ref(false);
const editorText = ref('');
const saving = ref(false);
const saveError = ref('');
const saveStatus = ref('');
// DOM refs for sizing the editor equal to preview height
const jsonPreviewEl = ref(null);
const jsonEditorEl = ref(null);

// Compute stable hex SHA-256 of a string using Web Crypto API
async function sha256Hex(str) {
  try {
    const enc = new TextEncoder();
    const data = enc.encode(str);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  } catch (e) {
    // Fallback: simple checksum if crypto.subtle is unavailable (very unlikely in modern browsers)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return String(hash);
  }
}

async function loadExternal(withLoading = false) {
  if (withLoading) {
    externalLoading.value = true;
  }
  externalError.value = '';
  try {
    const res = await fetch('/api/config/pricing-engine', {cache: 'no-store'});
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `HTTP ${res.status}`);
    }
    const text = await res.text();
    const newHash = await sha256Hex(text);
    if (newHash !== externalHash.value) {
      externalHash.value = newHash;
      // Only update the on-screen JSON if not currently editing
      if (!isEditing.value) {
        try {
          const parsed = JSON.parse(text);
          externalConfigText.value = JSON.stringify(parsed, null, 2);
        } catch {
          externalConfigText.value = text;
        }
      }
    }
  } catch (e) {
    externalError.value = e?.message || String(e);
  } finally {
    if (withLoading) {
      externalLoading.value = false;
    }
  }
}

function reloadExternal() {
  loadExternal(true);
}

function startEdit() {
  saveError.value = '';
  saveStatus.value = '';
  editorText.value = externalConfigText.value || '';
  // Measure current preview height before switching to edit
  const previewHeight = jsonPreviewEl.value ? jsonPreviewEl.value.clientHeight : 0;
  isEditing.value = true;
  nextTick(() => {
    if (jsonEditorEl.value) {
      const h = Math.max(220, previewHeight || 0);
      jsonEditorEl.value.style.height = h + 'px';
    }
  });
}

function cancelEdit() {
  isEditing.value = false;
  saving.value = false;
  saveError.value = '';
  saveStatus.value = '';
}

async function saveEdit() {
  if (saving.value) {
    return;
  }
  saveError.value = '';
  saveStatus.value = '';
  saving.value = true;
  try {
    // Validate JSON and pretty-print
    const parsed = JSON.parse(editorText.value);
    const pretty = JSON.stringify(parsed, null, 2);
    const res = await fetch('/api/config/pricing-engine', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: pretty,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = j.error || j.message || msg;
      } catch {
      }
      throw new Error(msg);
    }
    externalConfigText.value = pretty;
    externalHash.value = await sha256Hex(pretty);
    saveStatus.value = 'Saved';
    isEditing.value = false;
  } catch (e) {
    saveError.value = e?.message || String(e);
  } finally {
    saving.value = false;
  }
}

// Left drawer collapse state
const drawerCollapsed = ref(false);

function applyDrawerState() {
  const b = document.body;
  if (drawerCollapsed.value) {
    b.classList.add('drawer-collapsed');
  } else {
    b.classList.remove('drawer-collapsed');
  }
}

function toggleDrawer() {
  drawerCollapsed.value = !drawerCollapsed.value;
  try {
    localStorage.setItem('drawerCollapsed', drawerCollapsed.value ? '1' : '0');
  } catch {
  }
  applyDrawerState();
}

onMounted(() => {
  // init drawer collapsed state
  try {
    drawerCollapsed.value = localStorage.getItem('drawerCollapsed') === '1';
  } catch {
  }
  applyDrawerState();

  clockId = setInterval(() => {
    timeStr.value = new Date().toLocaleString();
  }, 500);

  loadExternal(true);
  // Poll external config every 1 second
  intervalId = setInterval(() => loadExternal(false), 1000);

  // Connect to the WebSocket on startup
  connectWs();

  // WebSocket-driven updates; no local simulation interval.
  // tick increments when applying WS messages.
});

onBeforeUnmount(() => {
  clearInterval(intervalId);
  clearInterval(clockId);
  cleanupWs();
  cleanupEsWs();
});
</script>

<template>
  <aside class="nav-drawer">
    <button type="button" class="drawer-toggle" :aria-expanded="!drawerCollapsed" :title="drawerCollapsed ? 'Expand' : 'Collapse'" @click="toggleDrawer">
      <span v-if="drawerCollapsed">»</span>
      <span v-else>«</span>
    </button>
    <div class="nav-brand">IMMIX</div>
    <nav class="nav-menu">
      <a class="nav-item" :class="{ active: activePage === 'pricing' }" href="#" @click.prevent="activePage = 'pricing'">
        <span class="nav-label">Pricing engine</span>
      </a>
      <a class="nav-item" :class="{ active: activePage === 'execution' }" href="#" @click.prevent="activePage = 'execution'">
        <span class="nav-label">Execution service</span>
      </a>
    </nav>
  </aside>
  <header>
    <div>
      <div class="title">{{ activePage === 'pricing' ? 'Pricing Engine' : 'Execution Service' }}</div>
      <div class="subtitle" v-if="activePage === 'pricing'">Custom Order Book (Bids in green, Asks in red)</div>
      <div class="subtitle" v-else>Place orders via WebSocket</div>
    </div>
    <div class="subtitle">Local time: <span>{{ timeStr }}</span></div>
  </header>

  <div class="container" v-if="activePage === 'pricing'">
    <!-- Left: Configuration JSON -->
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Pricing Engine Configuration</div>
        <!--        <button @click="randomizeConfig" style="all:unset; cursor:pointer; color: var(&#45;&#45;accent);">randomize</button>-->
      </div>
      <div class="panel-body">
        <div class="url-input">
          <label>
            <span>URL:</span>
            <div class="url-row">
              <input v-model="wsUrl" type="text" autocomplete="off" placeholder="ws://localhost:48000/api/v7"/>
              <span class="ws-status" :data-status="wsStatus">
                <span class="dot" :class="wsStatus"></span>
                <span class="label">{{ wsStatusDisplay }}</span>
              </span>
              <button type="button" class="ws-btn" @click="toggleWs">
                {{ (wsStatus === 'connected' || wsStatus === 'connecting') ? 'Disconnect' : 'Connect' }}
              </button>
            </div>
          </label>
        </div>
        <form class="config-form" @submit.prevent>
          <div class="form-grid">
            <label>
              <span>Max Levels</span>
              <input v-model.number="config.maxLevels" type="number" step="1" min="1" max="100"/>
            </label>
          </div>
        </form>
        <details class="json-preview" open>
          <summary>JSON (PRICING_ENGINE.json)</summary>
          <template v-if="externalLoading">
            <pre class="json">Loading PRICING_ENGINE.json ...</pre>
          </template>
          <template v-else-if="externalError">
            <pre class="json">Error loading config: {{ externalError }}
Path: /tmp/core/data/configs/configservice/PRICING_ENGINE.json
Ensure the file exists and is readable.
<button style='all:unset; cursor:pointer; color: var(--accent);' @click="reloadExternal">retry</button></pre>
          </template>
          <template v-else>
            <template v-if="isEditing">
              <textarea class="json-editor" v-model="editorText" spellcheck="false" ref="jsonEditorEl"></textarea>
              <div class="editor-actions">
                <button class="btn" @click="cancelEdit" :disabled="saving">Cancel</button>
                <button class="btn primary" @click="saveEdit" :disabled="saving">Save</button>
                <span class="status" v-if="saving">Saving...</span>
                <span class="status error" v-if="!saving && saveError">{{ saveError }}</span>
                <span class="status ok" v-if="!saving && saveStatus">{{ saveStatus }}</span>
              </div>
            </template>
            <template v-else>
              <pre class="json" ref="jsonPreviewEl">{{ externalConfigText }}</pre>
              <div class="editor-actions">
                <button class="btn" @click="reloadExternal">Refresh</button>
                <button class="btn primary" @click="startEdit">Edit</button>
              </div>
            </template>
          </template>
        </details>
      </div>
    </section>

    <!-- Right: Order Book -->
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Order Book</div>
        <div class="subtitle">Updates: {{ tick }}</div>
      </div>
      <div class="panel-body orderbook">
        <div class="table">
          <div class="table-title bid">Bids</div>
          <div class="table-header">
            <div>Price</div>
            <div>Total</div>
            <div>Exchanges</div>
            <div>Quantity</div>
          </div>
          <div class="rows">
            <div v-for="(row, i) in bidsSorted" :key="'bid-'+i" class="row">
              <div class="bid">{{ row.price.toFixed(2) }}</div>
              <div>{{ row.cum.toFixed(4) }}</div>
              <div class="exchanges">
                <template v-if="mapExchangesToIcons(row.exchanges).length">
                  <img
                      v-for="(icon, idx) in mapExchangesToIcons(row.exchanges)"
                      :key="icon.url + '-' + idx"
                      :src="icon.url"
                      :alt="icon.alt"
                      :title="icon.title"
                      class="exch-icon"
                  />
                </template>
                <template v-else>
                  {{ row.exchanges }}
                </template>
              </div>
              <div>
                <div class="depth-bar">
                  <div class="depth-fill bid" :style="{ width: (row.cum/bidMax*100).toFixed(1)+'%' }"></div>
                  <span class="depth-text">{{ row.qty.toFixed(4) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="table">
          <div class="table-title ask">Asks</div>
          <div class="table-header">
            <div>Quantity</div>
            <div>Exchanges</div>
            <div>Total</div>
            <div>Price</div>
          </div>
          <div class="rows">
            <div v-for="(row, i) in asksSorted" :key="'ask-'+i" class="row">
              <div>
                <div class="depth-bar">
                  <div class="depth-fill ask" :style="{ width: (row.cum/askMax*100).toFixed(1)+'%' }"></div>
                  <span class="depth-text">{{ row.qty.toFixed(4) }}</span>
                </div>
              </div>
              <div class="exchanges">
                <template v-if="mapExchangesToIcons(row.exchanges).length">
                  <img
                      v-for="(icon, idx) in mapExchangesToIcons(row.exchanges)"
                      :key="icon.url + '-' + idx"
                      :src="icon.url"
                      :alt="icon.alt"
                      :title="icon.title"
                      class="exch-icon"
                  />
                </template>
                <template v-else>
                  {{ row.exchanges }}
                </template>
              </div>
              <div>{{ row.cum.toFixed(4) }}</div>
              <div class="ask">{{ row.price.toFixed(2) }}</div>
            </div>
          </div>
        </div>
      </div>
      <footer class="note">
        <div>Pricing engine order book</div>
        <div>Spread: <span class="spread" :class="spreadSignClass">{{ spreadBpsDisplay }}</span> bps</div>
      </footer>
    </section>
  </div>

  <!-- Execution Service Page -->
  <div class="container exec" v-else>
    <!-- Left: Execution form and WS controls -->
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Execution Service</div>
      </div>
      <div class="panel-body">
        <div class="url-input">
          <label>
            <span>URL:</span>
            <div class="url-row">
              <input v-model="esWsUrl" type="text" autocomplete="off" placeholder="ws://localhost:48010/api/v4"/>
              <span class="ws-status" :data-status="esWsStatus">
                <span class="dot" :class="esWsStatus"></span>
                <span class="label">{{ esWsStatusDisplay }}</span>
              </span>
              <button type="button" class="ws-btn" @click="toggleEsWs">
                {{ (esWsStatus === 'connected' || esWsStatus === 'connecting') ? 'Disconnect' : 'Connect' }}
              </button>
            </div>
          </label>
        </div>

        <form class="config-form" @submit.prevent>
          <div class="form-grid">
            <label>
              <span>op</span>
              <input v-model="execForm.op" type="text"/>
            </label>
            <label>
              <span>reqId</span>
              <input v-model="execForm.reqId" type="text"/>
            </label>
            <label>
              <span>orgId</span>
              <input v-model="execForm.orgId" type="text"/>
            </label>
            <label>
              <span>symbol</span>
              <input v-model="execForm.symbol" type="text"/>
            </label>
            <label>
              <span>strategy</span>
              <select v-model="execForm.strategy">
                <option value="TWAP">TWAP</option>
              </select>
            </label>
            <label>
              <span>px</span>
              <input v-model="execForm.px" type="text"/>
            </label>
            <label>
              <span>qty</span>
              <input v-model="execForm.qty" type="text"/>
            </label>
            <label>
              <span>side</span>
              <input v-model="execForm.side" type="text"/>
            </label>
            <label>
              <span>accountBookMapping key</span>
              <input v-model="execForm.accountBookKey" type="text"/>
            </label>
            <label>
              <span>accountBookMapping value</span>
              <input v-model="execForm.accountBookValue" type="text"/>
            </label>
            <label>
              <span>timeInForce</span>
              <input v-model="execForm.timeInForce" type="text"/>
            </label>
            <label>
              <span>clientOrderId</span>
              <input v-model="execForm.clientOrderId" type="text"/>
            </label>
          </div>

          <fieldset class="fieldset">
            <legend>params</legend>
            <div class="form-grid">
              <label>
                <span>startTime</span>
                <input v-model="startLocal" type="datetime-local" step="1"/>
              </label>
              <label>
                <span>endTime</span>
                <input v-model="endLocal" type="datetime-local" step="1"/>
              </label>
              <label>
                <span>intervalMillis</span>
                <input v-model.number="execForm.params.intervalMillis" type="number" step="1" min="1"/>
              </label>
            </div>
          </fieldset>
        </form>
        <div class="json-preview">
          <details open>
            <summary>JSON (placeOrder)</summary>
            <pre class="json">{{ execPayloadText }}</pre>
          </details>
          <div class="editor-actions">
            <button class="btn" @click="sendExec" :disabled="esWsStatus !== 'connected'">Send</button>
            <div class="status ok" v-if="execSendStatus">{{ execSendStatus }}</div>
            <div class="status error" v-if="execSendError">{{ execSendError }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- Right: Orders and Trades Tables -->
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Orders & Trades</div>
      </div>
      <div class="panel-body" style="display: flex; flex-direction: column; gap: 12px;">
        <!-- Orders Table -->
        <div class="table">
          <div class="table-title">Execution Order</div>
          <div class="table-header" style="grid-template-columns: repeat(16, minmax(0, 1fr));">
            <div>Symbol</div>
            <div>AlgoId</div>
            <div>OrderId</div>
            <div>Qty</div>
            <div>TIF</div>
            <div>ClOrdId</div>
            <div>Side</div>
            <div>LimitPx</div>
            <div>CumQty</div>
            <div>LeavesQty</div>
            <div>AvgFillPrice</div>
            <div>Status</div>
            <div>StrategyStatus</div>
            <div>RejectReason</div>
            <div>RejectSource</div>
            <div>Action</div>
          </div>
          <div class="rows">
            <div class="row" v-for="o in orders" :key="o.clOrdId || o.orderId || o.algoId" style="grid-template-columns: repeat(16, minmax(0, 1fr));">
              <div>{{ o.symbol }}</div>
              <div>{{ o.algoId }}</div>
              <div>{{ o.orderId }}</div>
              <div>{{ o.qty }}</div>
              <div>{{ o.tif }}</div>
              <div>{{ o.clOrdId }}</div>
              <div :class="o.side === 'BUY' ? 'bid' : 'ask'">{{ o.side }}</div>
              <div>{{ o.limitPx }}</div>
              <div>{{ o.cumQty }}</div>
              <div>{{ o.leavesQty }}</div>
              <div>{{ o.avgFillPrice }}</div>
              <div>{{ o.status }}</div>
              <div>{{ o.strategyStatus }}</div>
              <div>{{ o.rejectReason }}</div>
              <div>{{ o.rejectSource }}</div>
              <div>
                <button class="btn" @click="cancelOrder(o)" :disabled="isCancelDisabled(o.status)">Cancel</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Child Orders Table -->
        <div class="table">
          <div class="table-title">Child Order</div>
          <div class="table-header" style="grid-template-columns: 1.2fr 1fr 0.6fr 1.2fr 1fr 0.8fr;">
            <div>Time</div>
            <div>Symbol</div>
            <div>Side</div>
            <div>Qty @ Px</div>
            <div>Status</div>
            <div>Action</div>
          </div>
          <div class="rows">
            <div class="row" v-for="co in childOrders" :key="co.orderId" style="grid-template-columns: 1.2fr 1fr 0.6fr 1.2fr 1fr 0.8fr;">
              <div>{{ co.time }}</div>
              <div>{{ co.symbol }}</div>
              <div :class="co.side === 'BUY' ? 'bid' : 'ask'">{{ co.side }}</div>
              <div>{{ co.qty }} @ {{ co.px }}</div>
              <div>{{ co.status }}</div>
              <div>
                <button class="btn" @click="cancelOrder(co)" :disabled="isCancelDisabled(co.status)">Cancel</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Trades Table -->
        <div class="table">
          <div class="table-title">Trades</div>
          <div class="table-header" style="grid-template-columns: 1.2fr 0.6fr 1.2fr 1fr;">
            <div>Time</div>
            <div>Side</div>
            <div>Qty @ Px</div>
            <div>Order</div>
          </div>
          <div class="rows">
            <div class="row" v-for="t in trades" :key="t.tradeId" style="grid-template-columns: 1.2fr 0.6fr 1.2fr 1fr;">
              <div>{{ t.time }}</div>
              <div :class="t.side === 'BUY' ? 'bid' : 'ask'">{{ t.side }}</div>
              <div>{{ t.qty }} @ {{ t.px }}</div>
              <div>{{ t.orderId }}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style>
:root {
  --bg: #0f1220;
  --panel: #171a2b;
  --text: #e6e6e6;
  --muted: #a0a6b3;
  --bid: #1db954; /* green */
  --ask: #ff4d4f; /* red */
  --divider: #2a2f45;
  --accent: #3b82f6;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial, "Apple Color Emoji", "Segoe UI Emoji";
  color: var(--text);
  background: linear-gradient(to bottom right, #0f1220, #0b0e1a);
  min-height: 100vh;
  --drawer-w: 220px;
  transition: margin-left 0.2s ease;
}

header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--divider);
  background: rgba(23, 26, 43, 0.7);
  backdrop-filter: blur(6px);
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title {
  font-weight: 700;
  letter-spacing: 0.3px;
}

.subtitle {
  color: var(--muted);
  font-size: 12px;
}

:root {
  --drawer-w: 220px;
}

/* Left navigation drawer */
.nav-drawer {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: var(--drawer-w);
  background: rgba(23, 26, 43, 0.85);
  border-right: 1px solid var(--divider);
  backdrop-filter: blur(6px);
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 20;
  transition: width 0.2s ease, padding 0.2s ease;
}

.drawer-toggle {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: 1px solid var(--divider);
  background: #0b0f19;
  color: var(--text);
  cursor: pointer;
}

.drawer-toggle:hover {
  filter: brightness(1.05);
}

/* Collapsed state via body class; narrows drawer and hides labels */
body.drawer-collapsed {
  --drawer-w: 56px;
}

body.drawer-collapsed .nav-brand,
body.drawer-collapsed .nav-label {
  display: none;
}

body.drawer-collapsed .nav-item {
  justify-content: center;
  padding: 8px;
}

.nav-brand {
  font-weight: 700;
  font-size: 14px;
  color: var(--muted);
  padding: 6px 8px;
}

.nav-menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--text);
  text-decoration: none;
  border: 1px solid transparent;
}

.nav-item .nav-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.8;
}

.nav-item.active {
  background: rgba(59, 130, 246, 0.12);
  border-color: rgba(59, 130, 246, 0.25);
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

/* Offset main content to the right of the drawer */
body {
  margin-left: var(--drawer-w);
}

.container {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 16px;
  padding: 16px;
  height: calc(100vh - 60px);
}

/* Execution page: make left panel narrower, right panel wider */
.container.exec {
  grid-template-columns: 0.7fr 2.3fr;
}

.panel {
  background: rgba(23, 26, 43, 0.75);
  border: 1px solid var(--divider);
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--divider);
}

.panel-title {
  font-weight: 600;
}

.panel-body {
  padding: 10px;
  overflow: auto;
  flex: 1;
}

pre.json {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: #e5e7eb;
  background: #0c0f1a;
  border-radius: 8px;
  padding: 12px;
  border: 1px solid #223;
  white-space: pre-wrap;
  word-break: break-word;
}

.config-form {
  display: block;
  margin-bottom: 10px;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}

.url-input input[type="text"],
.form-grid input[type="text"],
.form-grid input[type="number"],
.form-grid input[type="datetime-local"],
.form-grid select,
.fieldset input[type="number"],
.fieldset input[type="datetime-local"],
.fieldset select {
  appearance: none;
  background: #0b0f19;
  border: 1px solid #223;
  color: var(--text);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  color-scheme: dark;
}

.fieldset {
  border: 1px solid var(--divider);
  border-radius: 8px;
  padding: 8px 10px 12px;
  margin-top: 10px;
}

.fieldset legend {
  padding: 0 6px;
  color: var(--muted);
  font-size: 12px;
}

.url-input {
  margin-bottom: 10px;
}

.url-input label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}

.url-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.url-row input {
  flex: 1;
  min-width: 0;
}

.ws-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  padding: 4px 8px;
  border: 1px solid var(--divider);
  border-radius: 6px;
  background: #0b0f19;
  white-space: nowrap;
}

.ws-status .dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.ws-status .dot.connected {
  background: var(--bid);
}

.ws-status .dot.connecting {
  background: #f59e0b; /* amber */
}

.ws-status .dot.disconnected {
  background: #6b7280; /* gray */
}

.ws-status .dot.error {
  background: var(--ask);
}

.ws-btn {
  appearance: none;
  background: var(--accent);
  color: #fff;
  border: 0;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}

.ws-btn:hover {
  filter: brightness(1.05);
}

.ws-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.json-preview summary {
  cursor: pointer;
  color: var(--accent);
  margin: 8px 0;
}

.orderbook {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  height: 100%;
}

.table {
  border: 1px solid var(--divider);
  border-radius: 8px;
  overflow: hidden;
  background: #0c0f1a;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.table-header {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  padding: 8px 10px;
  border-bottom: 1px solid var(--divider);
  font-size: 12px;
  color: var(--muted);
}

.table-title {
  font-weight: 600;
  padding: 8px 10px;
  border-bottom: 1px solid var(--divider);
}

.rows {
  overflow: auto;
  flex: 1;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  padding: 6px 10px;
  font-size: 13px;
  align-items: center;
}

.row:nth-child(even) {
  background: rgba(255, 255, 255, 0.02);
}

.bid {
  color: var(--bid);
}

.ask {
  color: var(--ask);
}

/* Spread coloring */
.spread {
  font-variant-numeric: tabular-nums;
}

.spread.pos {
  color: var(--bid);
}

.spread.neg {
  color: var(--ask);
}

.spread.zero {
  color: var(--muted);
}

.depth-bar {
  position: relative;
  overflow: hidden;
  border-radius: 4px;
  height: 18px;
  background: rgba(255, 255, 255, 0.04);
  display: flex;
  align-items: center;
  padding: 0 6px;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

.depth-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  opacity: 0.15;
}

.depth-fill.bid {
  background: var(--bid);
  right: 0;
  left: auto;
}

.depth-fill.ask {
  background: var(--ask);
}

.depth-text {
  position: relative;
  z-index: 1;
}

/* Exchanges icons */
.exchanges {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 18px;
}

.exch-icon {
  width: 16px;
  height: 16px;
  display: inline-block;
  object-fit: contain;
}

footer.note {
  padding: 10px 16px;
  color: var(--muted);
  border-top: 1px solid var(--divider);
  font-size: 12px;
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

@media (max-width: 900px) {
  .nav-drawer {
    display: none;
  }

  body {
    margin-left: 0;
  }

  .container, .container.exec {
    grid-template-columns: 1fr;
    height: auto;
  }

  .panel {
    min-height: 300px;
  }
}

/* TODO: TEMP: hide nav-drawer globally until ES issue fixed */
.nav-drawer {
  display: none !important;
}

body {
  margin-left: 0 !important;
}

// END TODO


/* JSON inline editor */
.json-editor {
  width: 100%;
  min-height: 220px;
  resize: vertical;
  background: #0c0f1a;
  color: var(--text);
  border: 1px solid #223;
  border-radius: 8px;
  padding: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  line-height: 1.4;
}

.editor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.btn {
  appearance: none;
  background: #0b0f19;
  color: var(--text);
  border: 1px solid var(--divider);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}

.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.status {
  font-size: 12px;
  color: var(--muted);
}

.status.error {
  color: var(--ask);
}

.status.ok {
  color: var(--bid);
}
</style>
