<script setup>
import { computed, reactive, ref, onMounted, onBeforeUnmount, watch } from 'vue';

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
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
    bids.push({ price: pBid, qty: qBid });
    asks.push({ price: pAsk, qty: qAsk });
  }
  return { bids, asks };
}

function perturbBook(book, rand) {
  for (const side of [book.bids, book.asks]) {
    for (let i = 0; i < side.length; i++) {
      side[i].price += (rand() - 0.5) * 0.08;
      side[i].qty = Math.max(0.01, side[i].qty + (rand() - 0.5) * 0.1);
      if (rand() < 0.03) side[i].qty = Math.max(0.05, 0.2 + rand() * 2);
    }
  }
  if (rand() < 0.2) {
    const i = Math.floor(rand() * book.bids.length);
    book.bids[i] = { price: book.bids[i].price + (rand() - 0.5) * 0.5, qty: 0.2 + rand() * 2 };
  }
  if (rand() < 0.2) {
    const i = Math.floor(rand() * book.asks.length);
    book.asks[i] = { price: book.asks[i].price + (rand() - 0.5) * 0.5, qty: 0.2 + rand() * 2 };
  }
}

const tick = ref(0);
const timeStr = ref('');

const config = reactive({
  symbol: 'XYZ-USD',
  venue: 'SIM',
  midPrice: 100.0,
  spreadTicks: 2,
  qtyScale: 1.0,
  maxLevels: 12,
  riskLimits: {
    maxNotional: 250000,
    maxOrderQty: 50,
    maxSkew: 0.6,
  },
});

const rnd = seededRandom(1234567);
const book = reactive(genInitialBook(config.midPrice, config.maxLevels, 424242));

function regenerateBook() {
  const levels = Math.max(1, Math.min(100, Math.floor(config.maxLevels || 1)));
  const { bids, asks } = genInitialBook(config.midPrice, levels, 424242);
  // Replace array contents to preserve reactivity references
  book.bids.splice(0, book.bids.length, ...bids);
  book.asks.splice(0, book.asks.length, ...asks);
}

watch(() => config.maxLevels, () => {
  regenerateBook();
});

const bidsSorted = computed(() => {
  const sorted = [...book.bids].sort((a, b) => b.price - a.price);
  let cum = 0;
  return sorted.map((r) => {
    cum += r.qty;
    return { ...r, cum };
  });
});

const asksSorted = computed(() => {
  const sorted = [...book.asks].sort((a, b) => a.price - b.price);
  let cum = 0;
  return sorted.map((r) => {
    cum += r.qty;
    return { ...r, cum };
  });
});

const bidMax = computed(() => bidsSorted.value.reduce((m, r) => Math.max(m, r.cum), 0) || 1);
const askMax = computed(() => asksSorted.value.reduce((m, r) => Math.max(m, r.cum), 0) || 1);

const prettyConfig = computed(() => JSON.stringify(config, null, 2));

function randomizeConfig() {
  config.midPrice = 80 + rnd() * 40;
  config.spreadTicks = Math.floor(1 + rnd() * 4);
  config.qtyScale = +(0.5 + rnd() * 1.5).toFixed(2);
  config.maxLevels = 10 + Math.floor(rnd() * 8);
  config.riskLimits.maxNotional = 100000 + Math.floor(rnd() * 500000);
  config.riskLimits.maxOrderQty = 5 + Math.floor(rnd() * 95);
  config.riskLimits.maxSkew = +(0.1 + rnd()).toFixed(2);
}

let intervalId;
let clockId;

const externalConfigText = ref('');
const externalError = ref('');
const externalLoading = ref(true);

async function loadExternal() {
  externalLoading.value = true;
  externalError.value = '';
  try {
    const res = await fetch('/api/config/pricing-engine', { cache: 'no-store' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `HTTP ${res.status}`);
    }
    const text = await res.text();
    // Pretty-print if valid JSON, else show raw
    try {
      const parsed = JSON.parse(text);
      externalConfigText.value = JSON.stringify(parsed, null, 2);
    } catch {
      externalConfigText.value = text;
    }
  } catch (e) {
    externalError.value = e?.message || String(e);
  } finally {
    externalLoading.value = false;
  }
}

function reloadExternal() {
  loadExternal();
}

onMounted(() => {
  clockId = setInterval(() => {
    timeStr.value = new Date().toLocaleString();
  }, 500);

  loadExternal();

  intervalId = setInterval(() => {
    perturbBook(book, rnd);
    for (const s of [book.bids, book.asks]) {
      for (const r of s) r.qty = Math.max(0.01, r.qty * config.qtyScale);
    }
    const currentMid =
      (Math.max(...book.bids.map((b) => b.price)) + Math.min(...book.asks.map((a) => a.price))) / 2;
    const drift = (config.midPrice - currentMid) * 0.02;
    for (const r of book.bids) r.price += drift;
    for (const r of book.asks) r.price += drift;
    tick.value++;
  }, 700);
});

onBeforeUnmount(() => {
  clearInterval(intervalId);
  clearInterval(clockId);
});
</script>

<template>
  <header>
    <div>
      <div class="title">Pricing Engine UI</div>
      <div class="subtitle">Custom Order Book (Bids in green, Asks in red)</div>
    </div>
    <div class="subtitle">Local time: <span>{{ timeStr }}</span></div>
  </header>

  <div class="container">
    <!-- Left: Configuration JSON -->
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Pricing Engine Configuration</div>
        <button @click="randomizeConfig" style="all:unset; cursor:pointer; color: var(--accent);">randomize</button>
      </div>
      <div class="panel-body">
        <form class="config-form" @submit.prevent>
          <div class="form-grid">
            <label>
              <span>Symbol</span>
              <input v-model="config.symbol" type="text" autocomplete="off" />
            </label>
            <label>
              <span>Venue</span>
              <input v-model="config.venue" type="text" autocomplete="off" />
            </label>
            <label>
              <span>Mid Price</span>
              <input v-model.number="config.midPrice" type="number" step="0.01" />
            </label>
            <label>
              <span>Spread Ticks</span>
              <input v-model.number="config.spreadTicks" type="number" step="1" min="0" />
            </label>
            <label>
              <span>Qty Scale</span>
              <input v-model.number="config.qtyScale" type="number" step="0.01" min="0.01" />
            </label>
            <label>
              <span>Max Levels</span>
              <input v-model.number="config.maxLevels" type="number" step="1" min="1" max="100" />
            </label>
          </div>
          <fieldset class="fieldset">
            <legend>Risk Limits</legend>
            <div class="form-grid">
              <label>
                <span>Max Notional</span>
                <input v-model.number="config.riskLimits.maxNotional" type="number" step="1000" min="0" />
              </label>
              <label>
                <span>Max Order Qty</span>
                <input v-model.number="config.riskLimits.maxOrderQty" type="number" step="1" min="1" />
              </label>
              <label>
                <span>Max Skew</span>
                <input v-model.number="config.riskLimits.maxSkew" type="number" step="0.01" min="0" max="1" />
              </label>
            </div>
          </fieldset>
        </form>
        <details class="json-preview">
          <summary>JSON (config service)</summary>
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
            <pre class="json">{{ externalConfigText }}</pre>
            <div style="margin-top:6px; font-size:12px; color: var(--muted);">
              <button style="all:unset; cursor:pointer; color: var(--accent);" @click="reloadExternal">refresh</button>
            </div>
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
            <div>Quantity</div>
          </div>
          <div class="rows">
            <div v-for="(row, i) in bidsSorted" :key="'bid-'+i" class="row">
              <div class="bid">{{ row.price.toFixed(2) }}</div>
              <div>{{ row.cum.toFixed(4) }}</div>
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
              <div>{{ row.cum.toFixed(4) }}</div>
              <div class="ask">{{ row.price.toFixed(2) }}</div>
            </div>
          </div>
        </div>
      </div>
      <footer class="note">
        Suggestion for realtime tables with Vue:
        <ul>
          <li>AG Grid Community (Vue wrapper) – very fast and feature-rich.</li>
          <li>TanStack Table (Vue Table) – lightweight headless table; pair with your own styling.</li>
        </ul>
        This demo uses plain Vue reactivity without extra libs for minimal setup.
      </footer>
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

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial, "Apple Color Emoji", "Segoe UI Emoji";
  color: var(--text);
  background: linear-gradient(to bottom right, #0f1220, #0b0e1a);
  min-height: 100vh;
}

header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--divider);
  background: rgba(23,26,43,0.7);
  backdrop-filter: blur(6px);
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title { font-weight: 700; letter-spacing: 0.3px; }
.subtitle { color: var(--muted); font-size: 12px; }

.container {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 16px;
  padding: 16px;
  height: calc(100vh - 60px);
}

.panel {
  background: rgba(23,26,43,0.75);
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
.panel-title { font-weight: 600; }

.panel-body { padding: 10px; overflow: auto; flex: 1; }

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
.form-grid input[type="text"],
.form-grid input[type="number"],
.fieldset input[type="number"] {
  appearance: none;
  background: #0b0f19;
  border: 1px solid #223;
  color: var(--text);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
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
  grid-template-columns: 1fr 1fr 1fr;
  padding: 8px 10px;
  border-bottom: 1px solid var(--divider);
  font-size: 12px;
  color: var(--muted);
}
.table-title { font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--divider); }

.rows { overflow: auto; flex: 1; }

.row { display: grid; grid-template-columns: 1fr 1fr 1fr; padding: 6px 10px; font-size: 13px; align-items: center; }
.row:nth-child(even) { background: rgba(255,255,255,0.02); }

.bid { color: var(--bid); }
.ask { color: var(--ask); }

.depth-bar {
  position: relative;
  overflow: hidden;
  border-radius: 4px;
  height: 18px;
  background: rgba(255,255,255,0.04);
  display: flex;
  align-items: center;
  padding: 0 6px;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}
.depth-fill { position: absolute; top: 0; bottom: 0; left: 0; opacity: 0.15; }
.depth-fill.bid { background: var(--bid); right: 0; left: auto; }
.depth-fill.ask { background: var(--ask); }
.depth-text { position: relative; z-index: 1; }

footer.note { padding: 10px 16px; color: var(--muted); border-top: 1px solid var(--divider); font-size: 12px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

@media (max-width: 900px) {
  .container { grid-template-columns: 1fr; height: auto; }
  .panel { min-height: 300px; }
}
</style>
