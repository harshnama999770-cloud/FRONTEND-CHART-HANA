// ══════════════════════════════════════════════════════════════
//  HANA FOOTPRINT  script.js  v7 — Full Order Flow Engine
//  ──────────────────────────────────────────────────────────────
//  NEW in v7 (9 features):
//   1. Footprint cells display  BidVol × AskVol  per price level
//      with larger font (proportional to rowHeight, min 9px)
//   2. Delta Per Candle  = AskVol − BidVol; shown below each candle
//   3. CVD Panel  — session CVD + continuous global CVD, both
//      accumulated from every trade / footprint diff
//   4. POC Highlight  — yellow border on highest-vol row in candle
//   5. Stacked Imbalance  — 3+ consecutive imb rows → signal
//   6. Absorption Detection  — price stall + large vol + low delta
//   7. Order Book Depth Bars  — bars proportional to order qty
//   8. Liquidity Wall Detection  — 85th-pct percentile threshold
//   9. Time & Sales Tape  — time | price | size | BUY/SELL
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  CONFIGURATION & BACKEND CONNECTION
// ══════════════════════════════════════════════════════════════
// UPDATE THIS: Change this to your deployed backend URL (e.g., "hana-chart-api.herokuapp.com")
const BACKEND_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" 
    ? "localhost:8000" 
    : "YOUR_BACKEND_DEPLOY_URL_HERE"; // <--- Put your Cloudflare/Render/etc URL here

// ══════════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════════
const IMBALANCE_RATIO         = 3.0;
const STACK_MIN               = 3;
const SWEEP_MULT              = 2.5;
const DIAGONAL_RATIO          = 3.0;
const ABSORPTION_DELTA_THR    = 0.15;
const ICEBERG_MIN_REPEAT      = 3;
const VALUE_AREA_PCT          = 0.70;
const DOM_WALL_PERCENTILE     = 85;   // 85th percentile for wall detection (FIX 8)
const DOM_WALL_MULTIPLIER     = 5.0;  // fallback multiplier when < 5 levels
const DOM_BOOK_DEPTH          = 50;
const DOM_IMBALANCE_THRESHOLD = 1.5;
const HVN_THRESHOLD           = 0.65;
const LVN_THRESHOLD           = 0.08;
const PROFILE_BAR_MAXW        = 50;

const OF_ABSORB_VOL_THR     = 500;   // min total vol to consider absorption (FIX 6)
const OF_ABSORB_DELTA_PCT   = 0.05;  // delta < 5% of vol → absorption (FIX 6)
const OF_STACKED_MIN_LEVELS = 3;
const OF_IMBALANCE_RATIO    = 3.0;
const OF_SETUP_MAX_ENTRIES  = 50;

// FIX 5: Per-candle stacked imbalance dedup
const _stackedFiredForCandle  = new Set();
const STACKED_SIGNAL_COOLDOWN = 10000; // ms
let   _lastStackedSignalTime  = 0;

let SYMBOL   = "btcusdt";
let INTERVAL = 30;

const config = {
  candleWidth     : 90,
  rowHeight       : 20,
  spacing         : 130,
  // FIX 1: font size derived from rowHeight in render; store base here
  fontSize        : 9,
  startX          : 100,
  startY          : 0,
  tick            : 0.10,
  leftPanelWidth  : 80,
  rightPanelWidth : 220,

  // Overlays
  showVWAP            : true,
  showPOCExtension    : true,
  showValueArea       : true,
  showSessionHL       : true,
  showDiagonalImb     : true,
  showAbsorption      : true,
  showExhaustion      : true,
  showIceberg         : true,
  showDeltaPerLevel   : true,  // FIX 2: per-level delta bar
  showCandleDelta     : true,  // FIX 2: candle delta label
  showFootprintText   : true,  // FIX 1: bid×ask text inside cells
  showVolProfile      : true,
  showHVNLVN          : true,
  showDOMImbalance    : true,
  showDOMDepthBars    : true,  // FIX 7: order book depth bars
  showLiqWalls        : true,  // FIX 8: liquidity wall detection
  showAbsorbReversal  : true,  // FIX 6
  showAbsorptionMark  : true,  // FIX 6: yellow circle on absorbed candles
  showStackBreakout   : true,
  showSweepTrap       : true,
  showLVNReject       : true,
  showWallReaction    : true,
};

const TICK_SIZES = {
  btcusdt: 1.0,
  ethusdt: 0.10,
  solusdt: 0.01,
  bnbusdt: 0.10,
  xrpusdt: 0.0001,
};

// ══════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════
const state = {
  candles    : [],
  MAX_CANDLES: 500,

  dom: {
    bids          : new Map(), // price(string) -> qty(number)
    asks          : new Map(),
    snapshotFetched: false,
    lastUpdateId  : 0,
    buffer        : [],
  },

  currentPrice: 0,

  // FIX 3: Dual CVD — session (resets daily) + global (continuous)
  cvd              : 0,
  globalCvd        : parseFloat(sessionStorage.getItem('hana_globalCvd') || '0') || 0,
  cvdHistory       : [],
  globalCvdHistory : [],

  deltaSeries : [],
  tpsCount    : 0,

  // FIX 9: Trade tape buffer (newest first, capped at 300)
  tape: [],

  vwapNumer   : 0,
  vwapDenom   : 0,
  vwap        : 0,

  sessionHigh : parseFloat(sessionStorage.getItem('hana_sessionHigh') || '-Infinity') || -Infinity,
  sessionLow  : parseFloat(sessionStorage.getItem('hana_sessionLow')  ||  'Infinity') ||  Infinity,
  sessionDate : sessionStorage.getItem('hana_sessionDate') || '',

  volumeProfile   : {},
  _volProfileDirty   : false,
  _volProfileCandles : new Set(),

  // FIX 1+5: Per-candle max volume cache for O(1) heat intensity
  candleMaxVolCache: new Map(),

  icebergMap  : {},
  replayActive: false,
  replayIndex : 0,
  replayTrades: [],
  replayTimer : null,

  domAnalytics: {
    totalBidLiq: 0, totalAskLiq: 0, imbalance: 1,
    avgBidSize : 0, avgAskSize : 0,
    walls      : [],
    prevWalls  : [],
    bidWallTh  : 0,   // FIX 8: 85th-percentile thresholds
    askWallTh  : 0,
  },

  strategy: {
    lastCandleDelta : 0,
    avgCandleDelta  : 0,
    lastStackSignal : null,
    sweepTrapWatch  : null,
    prevSweepDir    : null,
    priceHistory    : [],
    wallSizeHistory : {},
  },
  _lastSetupKey: "",
};

// ══════════════════════════════════════════════════════════════
//  MATH HELPERS
// ══════════════════════════════════════════════════════════════
function norm(p) {
  const t = config.tick;
  return Number((Math.round(p / t) * t).toFixed(decimals(t)));
}
function decimals(t) {
  const s = t.toString();
  return s.includes('.') ? s.split('.')[1].length : 0;
}

// FIX 8: percentile helper (linear interpolation)
function percentile(arr, pct) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = (pct / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// FIX 1: Format volume for footprint cells (compact)
function fmtVol(v) {
  if (v === 0)    return "0";
  if (v >= 1000)  return (v / 1000).toFixed(1) + "k";
  if (v >= 100)   return v.toFixed(0);
  if (v >= 1)     return v.toFixed(1);
  return v.toFixed(3);
}

// ══════════════════════════════════════════════════════════════
//  SESSION DATE BOUNDARY
// ══════════════════════════════════════════════════════════════
function todayUTC() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function checkSessionBoundary() {
  const today = todayUTC();
  if (state.sessionDate !== today) {
    state.sessionDate = today;
    state.sessionHigh = -Infinity;
    state.sessionLow  =  Infinity;
    state.vwapNumer   = 0;
    state.vwapDenom   = 0;
    state.vwap        = 0;
    // FIX 3: Only session CVD resets — globalCvd persists
    state.cvd         = 0;
    state.cvdHistory  = [];
    state.volumeProfile      = {};
    state._volProfileDirty   = true;
    state._volProfileCandles.clear();
    sessionStorage.setItem('hana_sessionDate', today);
    sessionStorage.setItem('hana_sessionHigh', '-Infinity');
    sessionStorage.setItem('hana_sessionLow',  'Infinity');
  }
}

function persistSessionHL() {
  sessionStorage.setItem('hana_sessionHigh', state.sessionHigh);
  sessionStorage.setItem('hana_sessionLow',  state.sessionLow);
  sessionStorage.setItem('hana_sessionDate', state.sessionDate);
  // FIX 3: Persist globalCvd across page refresh
  sessionStorage.setItem('hana_globalCvd', state.globalCvd);
}

// ══════════════════════════════════════════════════════════════
//  ROLLING VOLUME PROFILE (incremental)
// ══════════════════════════════════════════════════════════════
function updateVolumeProfile(price, volume) {
  const pStr = price.toFixed(decimals(config.tick));
  state.volumeProfile[pStr] = (state.volumeProfile[pStr] || 0) + volume;
}

function rollVolProfileAdd(candle) {
  if (!candle || !candle.footprint) return;
  for (const pStr in candle.footprint) {
    const vol = (candle.footprint[pStr].bid || 0) + (candle.footprint[pStr].ask || 0);
    if (vol > 0) state.volumeProfile[pStr] = (state.volumeProfile[pStr] || 0) + vol;
  }
  state._volProfileCandles.add(candle._slotStart);
}

function rollVolProfileRemove(candle) {
  if (!candle || !candle.footprint) return;
  for (const pStr in candle.footprint) {
    const vol = (candle.footprint[pStr].bid || 0) + (candle.footprint[pStr].ask || 0);
    if (vol > 0) {
      const cur  = state.volumeProfile[pStr] || 0;
      const next = cur - vol;
      if (next <= 0) delete state.volumeProfile[pStr];
      else           state.volumeProfile[pStr] = next;
    }
  }
  state._volProfileCandles.delete(candle._slotStart);
}

function rebuildVolumeProfileFull() {
  state.volumeProfile = {};
  state._volProfileCandles.clear();
  state.vwapNumer = 0;
  state.vwapDenom = 0;
  for (const c of state.candles) {
    rollVolProfileAdd(c);
    for (const pStr in c.footprint) {
      const vol   = (c.footprint[pStr].bid || 0) + (c.footprint[pStr].ask || 0);
      const price = parseFloat(pStr);
      state.vwapNumer += price * vol;
      state.vwapDenom += vol;
    }
  }
  if (state.vwapDenom > 0) state.vwap = state.vwapNumer / state.vwapDenom;
  state._volProfileDirty = false;
}

function getProfilePOC() {
  let maxVol = 0, pocPrice = null;
  for (const [pStr, vol] of Object.entries(state.volumeProfile)) {
    if (vol > maxVol) { maxVol = vol; pocPrice = Number(pStr); }
  }
  return { price: pocPrice, vol: maxVol };
}

function getProfileValueArea() {
  const entries = Object.entries(state.volumeProfile)
    .map(([p, v]) => ({ price: Number(p), vol: v }))
    .sort((a, b) => b.price - a.price);
  if (!entries.length) return { vah: null, val: null };
  const totalVol = entries.reduce((s, e) => s + e.vol, 0);
  const target   = totalVol * VALUE_AREA_PCT;
  const poc      = getProfilePOC();
  if (!poc.price) return { vah: null, val: null };
  let cumVol = poc.vol, vaHigh = poc.price, vaLow = poc.price;
  const above = entries.filter(e => e.price > poc.price).sort((a, b) => a.price - b.price);
  const below = entries.filter(e => e.price < poc.price).sort((a, b) => b.price - a.price);
  let ai = 0, bi = 0;
  while (cumVol < target && (ai < above.length || bi < below.length)) {
    const upV   = ai < above.length ? above[ai].vol : -1;
    const downV = bi < below.length ? below[bi].vol : -1;
    if (upV >= downV && upV >= 0)  { vaHigh = above[ai].price; cumVol += upV;   ai++; }
    else if (downV >= 0)           { vaLow  = below[bi].price; cumVol += downV; bi++; }
    else break;
  }
  return { vah: vaHigh, val: vaLow };
}

function classifyProfileNode(vol, maxVol) {
  const r = maxVol > 0 ? vol / maxVol : 0;
  if (r >= HVN_THRESHOLD)          return "hvn";
  if (r <= LVN_THRESHOLD && r > 0) return "lvn";
  return "normal";
}

// ══════════════════════════════════════════════════════════════
//  DOM MANAGEMENT — Snapshot + Diff + Map-based
// ══════════════════════════════════════════════════════════════
function bestBid() {
  let best = -Infinity;
  state.dom.bids.forEach((_, p) => { const pn = parseFloat(p); if (pn > best) best = pn; });
  return best === -Infinity ? null : best;
}
function bestAsk() {
  let best = Infinity;
  state.dom.asks.forEach((_, p) => { const pn = parseFloat(p); if (pn < best) best = pn; });
  return best === Infinity ? null : best;
}

function computeSpread() {
  const bb = bestBid(), ba = bestAsk();
  if (bb === null || ba === null || ba <= bb) return null;
  return ba - bb;
}

async function fetchDepthSnapshot() {
  try {
    let url = `http://${BACKEND_URL}/depth?symbol=${SYMBOL.toUpperCase()}`;
    let r   = await fetch(url);
    if (!r.ok) {
      url = `https://api.binance.com/api/v3/depth?symbol=${SYMBOL.toUpperCase()}&limit=50`;
      r   = await fetch(url);
    }
    const d  = await r.json();
    const dc = decimals(config.tick);
    state.dom.bids.clear();
    state.dom.asks.clear();
    state.dom.lastUpdateId = d.lastUpdateId || 0;
    for (const [p, q] of (d.bids || [])) {
      const qty = parseFloat(q);
      if (qty > 0) state.dom.bids.set(parseFloat(p).toFixed(dc), qty);
    }
    for (const [p, q] of (d.asks || [])) {
      const qty = parseFloat(q);
      if (qty > 0) state.dom.asks.set(parseFloat(p).toFixed(dc), qty);
    }
    state.dom.snapshotFetched = true;
    for (const ev of state.dom.buffer) _applyDepthDiff(ev);
    state.dom.buffer = [];
    recomputeDOMAnalytics();
  } catch (e) {
    console.warn('[DOM] snapshot failed, falling back to incremental', e);
    state.dom.snapshotFetched = true;
    for (const ev of state.dom.buffer) _applyDepthDiff(ev);
    state.dom.buffer = [];
  }
}

function _applyDepthDiff(data) {
  if (data.U && data.u && state.dom.lastUpdateId > 0) {
    if (data.u <= state.dom.lastUpdateId) return; // stale
  }
  if (data.u) state.dom.lastUpdateId = data.u;
  const dc = decimals(config.tick);
  if (data.b) {
    for (const [p, q] of data.b) {
      const key = parseFloat(p).toFixed(dc);
      const qty = parseFloat(q);
      if (qty === 0) state.dom.bids.delete(key);
      else           state.dom.bids.set(key, qty);
    }
  }
  if (data.a) {
    for (const [p, q] of data.a) {
      const key = parseFloat(p).toFixed(dc);
      const qty = parseFloat(q);
      if (qty === 0) state.dom.asks.delete(key);
      else           state.dom.asks.set(key, qty);
    }
  }
}

function applyDepthDiff(data) {
  if (!state.dom.snapshotFetched) { state.dom.buffer.push(data); return; }
  _applyDepthDiff(data);
  recomputeDOMAnalytics();
}

// FIX 7+8: recomputeDOMAnalytics — depth bars + percentile walls
function recomputeDOMAnalytics() {
  const dc = decimals(config.tick);

  // FIX-B: top DOM_BOOK_DEPTH levels from full book
  const allBidEntries = [...state.dom.bids.entries()]
    .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
    .slice(0, DOM_BOOK_DEPTH);
  const allAskEntries = [...state.dom.asks.entries()]
    .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
    .slice(0, DOM_BOOK_DEPTH);

  const bidQtys = allBidEntries.map(([, q]) => q);
  const askQtys = allAskEntries.map(([, q]) => q);

  const totalBid  = bidQtys.reduce((a, b) => a + b, 0);
  const totalAsk  = askQtys.reduce((a, b) => a + b, 0);
  const avgBid    = bidQtys.length ? totalBid / bidQtys.length : 0;
  const avgAsk    = askQtys.length ? totalAsk / askQtys.length : 0;
  const imbalance = totalAsk > 0 ? totalBid / totalAsk : totalBid > 0 ? 99 : 1;

  // FIX 8: Liquidity wall threshold — 85th percentile of all sizes
  const allSizes  = [...bidQtys, ...askQtys];
  const bidWallTh = allSizes.length >= 5
    ? percentile(bidQtys, DOM_WALL_PERCENTILE)
    : avgBid * DOM_WALL_MULTIPLIER;
  const askWallTh = allSizes.length >= 5
    ? percentile(askQtys, DOM_WALL_PERCENTILE)
    : avgAsk * DOM_WALL_MULTIPLIER;

  const prevWalls = state.domAnalytics.walls.slice();
  const walls = [];
  for (const [pStr, qty] of allBidEntries) {
    if (qty >= bidWallTh) walls.push({ price: parseFloat(pStr), side: "bid", size: qty });
  }
  for (const [pStr, qty] of allAskEntries) {
    if (qty >= askWallTh) walls.push({ price: parseFloat(pStr), side: "ask", size: qty });
  }

  state.domAnalytics = {
    totalBidLiq: totalBid, totalAskLiq: totalAsk, imbalance,
    avgBidSize: avgBid, avgAskSize: avgAsk,
    bidWallTh, askWallTh,
    walls, prevWalls,
  };

  if (imbalance >= DOM_IMBALANCE_THRESHOLD * 2)
    pushSignal("domimb", state.currentPrice, `📊 DOM IMBALANCE BUY ${imbalance.toFixed(1)}:1 @ ${state.currentPrice.toFixed(dc)}`);
  else if (imbalance <= 1 / (DOM_IMBALANCE_THRESHOLD * 2))
    pushSignal("domimb", state.currentPrice, `📊 DOM IMBALANCE SELL 1:${(1/imbalance).toFixed(1)} @ ${state.currentPrice.toFixed(dc)}`);

  // Track wall size history for spoof detection
  for (const w of walls) {
    const key = w.price.toFixed(dc);
    if (!state.strategy.wallSizeHistory[key]) state.strategy.wallSizeHistory[key] = [];
    const hist = state.strategy.wallSizeHistory[key];
    hist.push(w.size);
    if (hist.length > 6) hist.shift();
  }

  if (config.showWallReaction) detectWallReaction(walls, prevWalls);
}

// FIX 7+9: Render DOM with depth bars in the right panel (PixiJS)
function renderDOMPanel(g, ladder, scrW, scrH, dc, fs) {
  const pStartX  = scrW - config.rightPanelWidth;
  const halfDomW = (config.rightPanelWidth - 42) / 2;
  const deltaColX = scrW - 40;

  const allBidQtys = [...state.dom.bids.values()];
  const allAskQtys = [...state.dom.asks.values()];
  const domMax = Math.max(...allBidQtys, ...allAskQtys, 1);

  g.beginFill(0x080B10, 0.99);
  g.drawRect(pStartX, 0, config.rightPanelWidth, scrH);
  g.endFill();
  g.lineStyle(1, 0x141C2A);
  g.moveTo(pStartX, 0); g.lineTo(pStartX, scrH);
  g.lineStyle(0);

  // DOM imbalance bar at top
  if (config.showDOMImbalance) {
    const imb     = state.domAnalytics.imbalance;
    const clipped = Math.min(imb, 4) / 4;
    const bidBarW = halfDomW * clipped;
    g.beginFill(0x26A69A, 0.6); g.drawRect(pStartX, 0, bidBarW, 4); g.endFill();
    g.beginFill(0xEF5350, 0.6); g.drawRect(pStartX + bidBarW, 0, config.rightPanelWidth - bidBarW, 4); g.endFill();
  }

  getPooledText("DOM",  pStartX + halfDomW,     13, 11, 0x2E3A4E, "center");
  getPooledText("BIDS", pStartX + halfDomW - 5, 24, 10, 0x26A69A, "right");
  getPooledText("ASKS", pStartX + halfDomW + 5, 24, 10, 0xEF5350, "left");
  getPooledText("Δ",    deltaColX + 19,          17, 10, 0x546E7A, "center");
  g.lineStyle(1, 0x141C2A, 0.9);
  g.moveTo(pStartX + halfDomW, 32); g.lineTo(pStartX + halfDomW, scrH);
  g.moveTo(deltaColX - 2, 32);      g.lineTo(deltaColX - 2, scrH);
  g.lineStyle(0);

  const curCandle = state.candles[state.candles.length - 1];

  for (let j = 0; j < ladder.length; j++) {
    const price = ladder[j];
    const yOff  = config.startY + j * config.rowHeight;
    if (yOff < 32 || yOff > scrH) continue;
    const pStr = price.toFixed(dc);
    const cY   = yOff + config.rowHeight / 2;
    const isCP = Math.abs(price - state.currentPrice) < config.tick * 0.5;

    if (isCP) {
      g.beginFill(0x1565C0, 0.2);
      g.drawRect(pStartX, yOff, config.rightPanelWidth, config.rowHeight);
      g.endFill();
      g.lineStyle(1, 0x1976D2, 0.6);
      g.moveTo(pStartX, yOff); g.lineTo(pStartX + config.rightPanelWidth, yOff);
      g.lineStyle(0);
    }

    // FIX 8: Highlight liquidity walls
    if (config.showLiqWalls) {
      const wall = state.domAnalytics.walls.find(wl => Math.abs(wl.price - price) < config.tick * 0.5);
      if (wall) {
        const wColor = wall.side === "bid" ? 0x26A69A : 0xEF5350;
        g.beginFill(wColor, 0.16); g.drawRect(pStartX, yOff, config.rightPanelWidth, config.rowHeight); g.endFill();
        g.lineStyle(1, wColor, 0.6); g.moveTo(pStartX, yOff + config.rowHeight); g.lineTo(pStartX + config.rightPanelWidth, yOff + config.rowHeight); g.lineStyle(0);
        // "WALL" label
        if (fs >= 7) getPooledText("WALL", pStartX + 4, cY, 7, wColor, "left");
      }
    }

    // FIX 7: Depth bars — proportional to order qty / domMax
    const bidQty = state.dom.bids.get(pStr);
    if (bidQty && bidQty > 0) {
      const bw = config.showDOMDepthBars
        ? Math.max(1, (bidQty / domMax) * halfDomW)
        : Math.min((bidQty / domMax) * halfDomW, halfDomW);
      g.beginFill(0x26A69A, 0.25);
      g.drawRect(pStartX + halfDomW - bw, yOff + 1, bw, config.rowHeight - 2);
      g.endFill();
      if (fs >= 7) getPooledText(bidQty.toFixed(2), pStartX + halfDomW - 4, cY, fs, 0x26A69A, "right");
    }
    const askQty = state.dom.asks.get(pStr);
    if (askQty && askQty > 0) {
      const bw = config.showDOMDepthBars
        ? Math.max(1, (askQty / domMax) * halfDomW)
        : Math.min((askQty / domMax) * halfDomW, halfDomW);
      g.beginFill(0xEF5350, 0.25);
      g.drawRect(pStartX + halfDomW, yOff + 1, bw, config.rowHeight - 2);
      g.endFill();
      if (fs >= 7) getPooledText(askQty.toFixed(2), pStartX + halfDomW + 4, cY, fs, 0xEF5350, "left");
    }

    // FIX 2: Per-level delta in DOM column (ask - bid at that price)
    if (curCandle && fs >= 7) {
      const fp = curCandle.footprint[pStr];
      if (fp && (fp.bid > 0 || fp.ask > 0)) {
        const lvlDelta  = fp.ask - fp.bid;
        const dColor    = lvlDelta >= 0 ? 0x26A69A : 0xEF5350;
        getPooledText((lvlDelta >= 0 ? "+" : "") + lvlDelta.toFixed(1), deltaColX + 38, cY, Math.max(7, fs - 1), dColor, "right");
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  FIX 9: TIME & SALES TAPE
// ══════════════════════════════════════════════════════════════
const MAX_TAPE_ROWS = 300;
let   _tpsWindow    = []; // rolling 1-second window

function computeTPS() {
  const now    = Date.now();
  const cutoff = now - 1000;
  while (_tpsWindow.length && _tpsWindow[0] < cutoff) _tpsWindow.shift();
  return _tpsWindow.length;
}

function addTapeEntry(time, price, qty, isBuy, isIceberg) {
  _tpsWindow.push(time);
  state.tpsCount++;

  const entry = { time, price, qty, isBuy, isIceberg };
  state.tape.unshift(entry);
  if (state.tape.length > MAX_TAPE_ROWS) state.tape.pop();

  const tapeBody = document.getElementById("tapeBody");
  if (!tapeBody) return;

  const dc   = decimals(config.tick);
  const ts   = new Date(time);
  const hh   = String(ts.getHours()).padStart(2, "0");
  const mm   = String(ts.getMinutes()).padStart(2, "0");
  const ss   = String(ts.getSeconds()).padStart(2, "0");
  const timeStr = `${hh}:${mm}:${ss}`;
  const side    = isBuy ? "BUY" : "SEL";
  const sideClr = isBuy ? "#26A69A" : "#EF5350";

  const recentSizes = state.tape.slice(0, 50).map(e => e.qty);
  const avgSize     = recentSizes.length ? recentSizes.reduce((a, b) => a + b, 0) / recentSizes.length : 0.5;
  const isLarge     = qty >= avgSize * 3;

  const row = document.createElement("div");
  row.className = "tape-row" +
    (isBuy ? " tape-buy" : " tape-sell") +
    (isLarge   ? " big"         : "") +
    (isIceberg ? " iceberg-hit" : "");

  row.innerHTML =
    `<span class="tape-time">${timeStr}</span>` +
    `<span class="tape-price">${price.toFixed(dc)}</span>` +
    `<span class="tape-sz">${fmtVol(qty)}</span>` +
    `<span class="tape-side" style="color:${sideClr};font-size:8px;text-align:center;font-weight:700">${side}</span>`;

  tapeBody.insertBefore(row, tapeBody.firstChild);
  while (tapeBody.childElementCount > MAX_TAPE_ROWS) tapeBody.removeChild(tapeBody.lastChild);

  const tpsEl = document.getElementById("tapeTPS") || document.getElementById("liveTPS");
  if (tpsEl) tpsEl.textContent = computeTPS() + " t/s";
}

// ══════════════════════════════════════════════════════════════
//  STRATEGY 1 — ABSORPTION REVERSAL  (FIX 6 enhanced)
// ══════════════════════════════════════════════════════════════
function detectAbsorptionReversal(candle) {
  if (!config.showAbsorbReversal) return;
  const dc = decimals(config.tick);
  let totalBid = 0, totalAsk = 0;
  for (const p in candle.footprint) {
    totalBid += candle.footprint[p].bid || 0;
    totalAsk += candle.footprint[p].ask || 0;
  }
  const priceMove   = Math.abs(candle.close - candle.open);
  const candleRange = candle.high - candle.low || config.tick;
  const isFlat      = priceMove < candleRange * 0.4;
  const sellAbsorb  = totalBid > totalAsk * 2.5 && isFlat && candle.close >= candle.open;
  const buyAbsorb   = totalAsk > totalBid * 2.5 && isFlat && candle.close <= candle.open;
  const atLVN       = isNearLVN(candle.close);

  if (sellAbsorb) {
    const conf = atLVN ? "★★★ HIGH" : "★★ MED";
    const msg  = `🟢 ABSORB REVERSAL LONG ${conf} @ ${candle.close.toFixed(dc)}`;
    pushSignal("absreversal", candle.close, msg);
    candle.signals.push({ type: "absReversalLong", price: candle.close, label: msg, confidence: atLVN ? 3 : 2 });
  }
  if (buyAbsorb) {
    const conf = atLVN ? "★★★ HIGH" : "★★ MED";
    const msg  = `🔴 ABSORB REVERSAL SHORT ${conf} @ ${candle.close.toFixed(dc)}`;
    pushSignal("absreversal", candle.close, msg);
    candle.signals.push({ type: "absReversalShort", price: candle.close, label: msg, confidence: atLVN ? 3 : 2 });
  }
}

function detectAbsorptionEnhanced(candle, prevCandle) {
  if (!config.showAbsorptionMark) return;
  const dc = decimals(config.tick);
  let totalBid = 0, totalAsk = 0;
  for (const p in candle.footprint) {
    totalBid += candle.footprint[p].bid || 0;
    totalAsk += candle.footprint[p].ask || 0;
  }
  const totalVol   = totalBid + totalAsk;
  if (totalVol < OF_ABSORB_VOL_THR) return;

  const delta      = totalAsk - totalBid;
  const deltaRatio = totalVol > 0 ? Math.abs(delta) / totalVol : 1;
  if (deltaRatio >= OF_ABSORB_DELTA_PCT) return;

  const priceMove = Math.abs(candle.close - candle.open);
  const prevRange = prevCandle ? Math.abs(prevCandle.close - prevCandle.open) : priceMove;
  const priceStall = priceMove < (prevRange || config.tick) * 0.5;
  if (!priceStall) return;

  const msg = `◈ ABSORPTION @ ${candle.close.toFixed(dc)} vol=${fmtVol(totalVol)} Δratio=${(deltaRatio * 100).toFixed(1)}%`;
  pushSignal("absorption", candle.close, msg);
  if (!candle.signals.some(s => s.type === "ofAbsorption")) {
    candle.signals.push({ type: "ofAbsorption", price: candle.close, label: msg });
    addSetup("◈ Absorption — price stall + heavy vol + balanced delta", "warning");
  }
}

function isNearLVN(price) {
  const maxVol = Math.max(...Object.values(state.volumeProfile), 1);
  for (let i = -3; i <= 3; i++) {
    const p    = norm(price + i * config.tick);
    const pStr = p.toFixed(decimals(config.tick));
    const vol  = state.volumeProfile[pStr] || 0;
    if (classifyProfileNode(vol, maxVol) === "lvn") return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════
//  STRATEGY 2 — STACKED BREAKOUT  (FIX 5 enhanced)
// ══════════════════════════════════════════════════════════════
function detectStackedBreakout(candle) {
  if (!config.showStackBreakout) return;
  const dc     = decimals(config.tick);
  const sorted = Object.keys(candle.footprint).map(Number).sort((a, b) => b - a);
  const imb    = computeImbalances(candle.footprint);
  let buyRun = 0, sellRun = 0, buyRunLevels = [], sellRunLevels = [];

  for (const p of sorted) {
    const k = p.toFixed(dc);
    if (imb[k] === "buy") {
      buyRun++; buyRunLevels.push(p); sellRun = 0; sellRunLevels = [];
    } else if (imb[k] === "sell") {
      sellRun++; sellRunLevels.push(p); buyRun = 0; buyRunLevels = [];
    } else {
      buyRun = 0; sellRun = 0; buyRunLevels = []; sellRunLevels = [];
    }

    if (buyRun >= STACK_MIN) {
      const topOfStack = Math.max(...buyRunLevels);
      const thinAbove  = isThinDOMAbove(topOfStack);
      if (candle.close >= topOfStack) {
        const msg = `⬆⬆ STACK BREAKOUT LONG ${thinAbove ? "★★★" : "★★"} @ ${topOfStack.toFixed(dc)}`;
        pushSignal("stackbreakout", topOfStack, msg);
        candle.signals.push({ type: "stackBreakoutLong", price: topOfStack, label: msg });
      }
      buyRun = 0; buyRunLevels = [];
    }
    if (sellRun >= STACK_MIN) {
      const botOfStack = Math.min(...sellRunLevels);
      const thinBelow  = isThinDOMBelow(botOfStack);
      if (candle.close <= botOfStack) {
        const msg = `⬇⬇ STACK BREAKOUT SHORT ${thinBelow ? "★★★" : "★★"} @ ${botOfStack.toFixed(dc)}`;
        pushSignal("stackbreakout", botOfStack, msg);
        candle.signals.push({ type: "stackBreakoutShort", price: botOfStack, label: msg });
      }
      sellRun = 0; sellRunLevels = [];
    }
  }
}

function isThinDOMAbove(price) {
  let askSum = 0;
  const dc = decimals(config.tick);
  for (let i = 1; i <= 5; i++) askSum += (state.dom.asks.get(norm(price + i * config.tick).toFixed(dc)) || 0);
  return askSum < state.domAnalytics.avgAskSize * 2.5;
}
function isThinDOMBelow(price) {
  let bidSum = 0;
  const dc = decimals(config.tick);
  for (let i = 1; i <= 5; i++) bidSum += (state.dom.bids.get(norm(price - i * config.tick).toFixed(dc)) || 0);
  return bidSum < state.domAnalytics.avgBidSize * 2.5;
}

// ══════════════════════════════════════════════════════════════
//  STRATEGY 3 — SWEEP TRAP
// ══════════════════════════════════════════════════════════════
let sweepTrapCooldown = 0;
function checkSweepTrap(delta, price, tradeTimeMs) {
  if (!config.showSweepTrap) return;
  const dc = decimals(config.tick);
  if (state.strategy.sweepTrapWatch) {
    const watch   = state.strategy.sweepTrapWatch;
    const elapsed = tradeTimeMs - watch.time;
    watch.ticksLeft--;
    const priceReversed = watch.dir === "BUY" ? price <= watch.price : price >= watch.price;
    const deltaFlipped  = watch.dir === "BUY" ? delta < 0 : delta > 0;
    if (priceReversed && deltaFlipped && elapsed < 4000) {
      const trapDir = watch.dir === "BUY" ? "SELL TRAP" : "BUY TRAP";
      const em      = watch.dir === "BUY" ? "🪤🔴" : "🪤🟢";
      const msg     = `${em} SWEEP TRAP ${trapDir} @ ${price.toFixed(dc)}`;
      pushSignal("sweeptrap", price, msg);
      const cur = state.candles[state.candles.length - 1];
      if (cur) cur.signals.push({ type: watch.dir === "BUY" ? "sweepTrapShort" : "sweepTrapLong", price, label: msg });
      state.strategy.sweepTrapWatch = null;
      sweepTrapCooldown = 60;
      return;
    }
    if (watch.ticksLeft <= 0 || elapsed > 5000) state.strategy.sweepTrapWatch = null;
  }
}

let sweepCooldown = 0;
function detectSweep(delta, price, tradeTimeMs) {
  state.deltaSeries.push(Math.abs(delta));
  if (state.deltaSeries.length > 50) state.deltaSeries.shift();
  const avg = state.deltaSeries.reduce((a, b) => a + b, 0) / state.deltaSeries.length;
  sweepCooldown--;
  if (sweepCooldown > 0 || avg < 0.01) return;
  const dc = decimals(config.tick);
  if (Math.abs(delta) > avg * SWEEP_MULT) {
    const dir = delta > 0 ? "BUY" : "SELL";
    const em  = delta > 0 ? "🔵" : "🔴";
    pushSignal("sweep", price, `${em} SWEEP ${dir} Δ${delta > 0 ? "+" : ""}${delta.toFixed(dc)} @ ${price.toFixed(dc)}`);
    sweepCooldown = 30;
    if (sweepTrapCooldown <= 0)
      state.strategy.sweepTrapWatch = { price, dir, time: tradeTimeMs, ticksLeft: 40 };
  }
  sweepTrapCooldown = Math.max(0, sweepTrapCooldown - 1);
}

// ══════════════════════════════════════════════════════════════
//  STRATEGY 4 — LVN REJECTION
// ══════════════════════════════════════════════════════════════
let lvnRejCooldown = 0;
function detectLVNRejection(candle) {
  if (!config.showLVNReject) return;
  const dc = decimals(config.tick);
  if (!isNearLVN(candle.close)) return;
  if (lvnRejCooldown > 0) { lvnRejCooldown--; return; }
  const hasExhBuy  = candle.signals.some(s => s.type === "exhaustionBuy");
  const hasExhSell = candle.signals.some(s => s.type === "exhaustionSell");
  if (hasExhSell && candle.close > candle.open) {
    const msg = `📈 LVN REJECT LONG @ ${candle.close.toFixed(dc)}`;
    pushSignal("lvnreject", candle.close, msg);
    candle.signals.push({ type: "lvnRejectLong", price: candle.close, label: msg });
    lvnRejCooldown = 15;
  }
  if (hasExhBuy && candle.close < candle.open) {
    const msg = `📉 LVN REJECT SHORT @ ${candle.close.toFixed(dc)}`;
    pushSignal("lvnreject", candle.close, msg);
    candle.signals.push({ type: "lvnRejectShort", price: candle.close, label: msg });
    lvnRejCooldown = 15;
  }
}

// ══════════════════════════════════════════════════════════════
//  STRATEGY 5 — WALL REACTION  (FIX 8: uses percentile threshold)
// ══════════════════════════════════════════════════════════════
let wallReactionCooldown = 0;
function detectWallReaction(currentWalls, prevWalls) {
  if (!config.showWallReaction) return;
  const dc = decimals(config.tick);
  if (wallReactionCooldown > 0) { wallReactionCooldown--; return; }

  for (const pw of prevWalls) {
    const nowWall  = currentWalls.find(w => Math.abs(w.price - pw.price) < config.tick * 0.5);
    const pStr     = pw.price.toFixed(dc);
    const hist     = state.strategy.wallSizeHistory[pStr] || [];
    const prevMax  = hist.length > 1 ? Math.max(...hist.slice(0, -1)) : pw.size;
    const nowSize  = nowWall ? nowWall.size : 0;
    const shrinkPct= prevMax > 0 ? (prevMax - nowSize) / prevMax : 0;

    if (shrinkPct > 0.6 && Math.abs(state.currentPrice - pw.price) < config.tick * 3) {
      const side = pw.side === "bid" ? "BID WALL PULLED↓" : "ASK WALL PULLED↑";
      const em   = pw.side === "bid" ? "⚠️🔴" : "⚠️🟢";
      const msg  = `${em} ${side} @ ${pw.price.toFixed(dc)} — possible SPOOF`;
      pushSignal("wallpull", pw.price, msg);
      const cur = state.candles[state.candles.length - 1];
      if (cur) cur.signals.push({ type: pw.side === "bid" ? "wallPullBid" : "wallPullAsk", price: pw.price, label: msg });
      wallReactionCooldown = 20;
      return;
    }
  }

  for (const w of currentWalls) {
    const priceDist = Math.abs(state.currentPrice - w.price);
    if (priceDist < config.tick * 4) {
      const cur = state.candles[state.candles.length - 1];
      if (!cur) continue;
      const pStr = w.price.toFixed(dc);
      let hits = 0;
      if (w.side === "bid" && cur.footprint[pStr]) hits = cur.footprint[pStr].bid || 0;
      if (w.side === "ask" && cur.footprint[pStr]) hits = cur.footprint[pStr].ask || 0;
      if (hits > state.domAnalytics.avgBidSize * 2) {
        const holdDir = w.side === "bid" ? "BOUNCE LONG ↑" : "BOUNCE SHORT ↓";
        const em      = w.side === "bid" ? "🟢🧱" : "🔴🧱";
        const msg     = `${em} WALL HOLDS ${holdDir} @ ${w.price.toFixed(dc)}`;
        pushSignal("wallhold", w.price, msg);
        cur.signals.push({ type: w.side === "bid" ? "wallHoldBid" : "wallHoldAsk", price: w.price, label: msg });
        wallReactionCooldown = 25;
        return;
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  ORDER FLOW SETUP PANEL
// ══════════════════════════════════════════════════════════════
function footprintToLevels(footprint) {
  return Object.entries(footprint)
    .map(([pStr, data]) => ({ price: Number(pStr), bid: data.bid || 0, ask: data.ask || 0 }))
    .sort((a, b) => b.price - a.price);
}

function detectStackedImbalance(levels) {
  if (!Array.isArray(levels) || levels.length < OF_STACKED_MIN_LEVELS) return false;
  let runBuy = 0, runSell = 0;
  for (const { bid, ask } of levels) {
    if (ask > 0 && ask >= bid * OF_IMBALANCE_RATIO) { runBuy++;  runSell = 0; if (runBuy  >= OF_STACKED_MIN_LEVELS) return "buy";  }
    else if (bid > 0 && bid >= ask * OF_IMBALANCE_RATIO) { runSell++; runBuy  = 0; if (runSell >= OF_STACKED_MIN_LEVELS) return "sell"; }
    else { runBuy = 0; runSell = 0; }
  }
  return false;
}

function detectAbsorption(levels) {
  if (!Array.isArray(levels) || !levels.length) return false;
  for (const { bid, ask } of levels) {
    const vol        = bid + ask;
    const deltaRatio = vol > 0 ? Math.abs(ask - bid) / vol : 1;
    if (vol > OF_ABSORB_VOL_THR && deltaRatio < OF_ABSORB_DELTA_PCT) return true;
  }
  return false;
}

function detectDeltaDivergence(priceMove, deltaMove) {
  if (typeof priceMove !== "number" || typeof deltaMove !== "number") return null;
  if (priceMove > 0 && deltaMove < 0) return "Bearish Divergence";
  if (priceMove < 0 && deltaMove > 0) return "Bullish Divergence";
  return null;
}

function addSetup(text, type = "info") {
  const panel = document.getElementById("setupList");
  if (!panel) return;
  const item = document.createElement("div");
  item.classList.add("setup-item", `setup-item--${type}`);
  const ts = new Date().toTimeString().slice(0, 8);
  item.innerHTML = `<span class="setup-item__time">${ts}</span><span class="setup-item__text">${text}</span>`;
  panel.insertBefore(item, panel.firstChild);
  const entries = panel.querySelectorAll(".setup-item");
  if (entries.length > OF_SETUP_MAX_ENTRIES) panel.removeChild(entries[entries.length - 1]);
}

function processFootprint(candle, prevCandle) {
  if (!candle || !candle.footprint) return;
  const levels = footprintToLevels(candle.footprint);
  if (!levels.length) return;
  const candleKey = String(candle._slotStart);
  const now       = Date.now();

  const stackResult = detectStackedImbalance(levels);
  if (stackResult && !_stackedFiredForCandle.has(candleKey) && (now - _lastStackedSignalTime) > STACKED_SIGNAL_COOLDOWN) {
    _stackedFiredForCandle.add(candleKey);
    _lastStackedSignalTime = now;
    if (stackResult === "buy") {
      addSetup("🟢 LONG: Stacked Buy Imbalance (3+ rows ask≥bid×3)", "long");
      candle.signals.push({ type: "ofStackedImbalance", price: candle.close, label: "🟢 Stacked Buy Imb" });
    } else {
      addSetup("🔴 SHORT: Stacked Sell Imbalance (3+ rows bid≥ask×3)", "short");
      candle.signals.push({ type: "ofStackedImbalanceSell", price: candle.close, label: "🔴 Stacked Sell Imb" });
    }
  }

  if (detectAbsorption(levels) && !candle.signals.some(s => s.type === "ofAbsorption")) {
    addSetup("⚡ Absorption — large vol + balanced delta", "warning");
    candle.signals.push({ type: "ofAbsorption", price: candle.close, label: "⚡ Absorption" });
  }

  const priceMove = candle.close - candle.open;
  let totalBid = 0, totalAsk = 0;
  for (const l of levels) { totalBid += l.bid; totalAsk += l.ask; }
  const deltaMove  = totalAsk - totalBid;
  const divergence = detectDeltaDivergence(priceMove, deltaMove);
  if (divergence === "Bearish Divergence" && !candle.signals.some(s => s.type === "ofBearishDivergence")) {
    addSetup("🔴 Bearish Divergence: Price↑ but Delta↓", "short");
    candle.signals.push({ type: "ofBearishDivergence", price: candle.close, label: "🔴 Bearish Div" });
  } else if (divergence === "Bullish Divergence" && !candle.signals.some(s => s.type === "ofBullishDivergence")) {
    addSetup("🟢 Bullish Divergence: Price↓ but Delta↑", "long");
    candle.signals.push({ type: "ofBullishDivergence", price: candle.close, label: "🟢 Bullish Div" });
  }
}

setInterval(() => {
  if (_stackedFiredForCandle.size > 100) {
    const arr = [..._stackedFiredForCandle];
    arr.slice(0, arr.length - 100).forEach(k => _stackedFiredForCandle.delete(k));
  }
}, 60000);

// ══════════════════════════════════════════════════════════════
//  CANDLE MANAGEMENT
// ══════════════════════════════════════════════════════════════
function getOrCreateCandle(tradeTimeMs) {
  const slotStart = Math.floor(tradeTimeMs / (INTERVAL * 1000)) * (INTERVAL * 1000);
  if (!state.candles.length || state.candles[state.candles.length - 1]._slotStart !== slotStart) {
    if (state.candles.length > 0) {
      const closing = state.candles[state.candles.length - 1];
      const prev    = state.candles.length > 1 ? state.candles[state.candles.length - 2] : null;
      detectStackedImbalances(closing);
      detectExhaustion(closing);
      detectAbsorption_original(closing);
      detectAbsorptionEnhanced(closing, prev);
      computeCandleAnalytics(closing);
      detectAbsorptionReversal(closing);
      detectStackedBreakout(closing);
      detectLVNRejection(closing);
      processFootprint(closing, prev);
    }
    const c = {
      _slotStart : slotStart,
      open       : state.currentPrice, high: state.currentPrice,
      low        : state.currentPrice, close: state.currentPrice,
      footprint  : {}, poc: null, vah: null, val: null, totalVol: 0,
      signals    : [], delta: 0, bidVol: 0, askVol: 0,
    };
    state.candles.push(c);
    if (state.candles.length > state.MAX_CANDLES) {
      const removed = state.candles.shift();
      if (removed) {
        state.candleMaxVolCache.delete(removed._slotStart);
        rollVolProfileRemove(removed);
      }
    }
  }
  return state.candles[state.candles.length - 1];
}

function processTrade(price, qty, isBuyerMaker, tradeTimeMs) {
  price = norm(price);
  state.currentPrice = price;

  checkSessionBoundary();
  if (price > state.sessionHigh) { state.sessionHigh = price; persistSessionHL(); }
  if (price < state.sessionLow)  { state.sessionLow  = price; persistSessionHL(); }

  state.vwapNumer += price * qty;
  state.vwapDenom += qty;
  if (state.vwapDenom > 0) state.vwap = state.vwapNumer / state.vwapDenom;

  updateVolumeProfile(price, qty);

  const candle = getOrCreateCandle(tradeTimeMs);
  if (price > candle.high) candle.high = price;
  if (price < candle.low)  candle.low  = price;
  candle.close     = price;
  candle.totalVol += qty;

  const dc   = decimals(config.tick);
  const pStr = price.toFixed(dc);

  if (!candle.footprint[pStr]) candle.footprint[pStr] = { bid: 0, ask: 0 };
  if (isBuyerMaker) {
    candle.footprint[pStr].bid += qty;
    candle.bidVol              += qty;
  } else {
    candle.footprint[pStr].ask += qty;
    candle.askVol              += qty;
  }
  candle.delta = candle.askVol - candle.bidVol;

  const delta = isBuyerMaker ? -qty : qty;
  state.cvd       += delta;
  state.globalCvd += delta;
  state.cvdHistory.push(state.cvd);
  state.globalCvdHistory.push(state.globalCvd);
  if (state.cvdHistory.length > 2000)       state.cvdHistory.shift();
  if (state.globalCvdHistory.length > 2000) state.globalCvdHistory.shift();

  state.candleMaxVolCache.delete(candle._slotStart);

  detectSweep(delta, price, tradeTimeMs);
  checkSweepTrap(delta, price, tradeTimeMs);
  trackIceberg(price, qty, pStr);

  const isIceberg = checkIcebergStatus(price, qty, pStr);
  addTapeEntry(tradeTimeMs, price, qty, !isBuyerMaker, isIceberg);

  state.strategy.priceHistory.push({ price, time: tradeTimeMs });
  if (state.strategy.priceHistory.length > 30) state.strategy.priceHistory.shift();
}

// ══════════════════════════════════════════════════════════════
//  CANDLE ANALYTICS — FIX 2+4
// ══════════════════════════════════════════════════════════════
function computeCandleAnalytics(candle) {
  const dc     = decimals(config.tick);
  const sorted = Object.keys(candle.footprint).map(Number).sort((a, b) => b - a);
  if (!sorted.length) return;

  let maxVol = 0, poc = sorted[0];
  let totalBid = 0, totalAsk = 0;
  for (const p of sorted) {
    const pStr = p.toFixed(dc);
    const data = candle.footprint[pStr] || { bid: 0, ask: 0 };
    const v    = (data.bid || 0) + (data.ask || 0);
    if (v > maxVol) { maxVol = v; poc = p; }
    totalBid += data.bid || 0;
    totalAsk += data.ask || 0;
  }
  candle.poc    = poc;
  candle.bidVol = totalBid;
  candle.askVol = totalAsk;
  candle.delta  = totalAsk - totalBid;

  const totalVol = totalBid + totalAsk;
  const target   = totalVol * VALUE_AREA_PCT;
  let cumVol = 0, vaHigh = poc, vaLow = poc;
  const above = sorted.filter(p => p > poc).sort((a, b) => a - b);
  const below = sorted.filter(p => p < poc).sort((a, b) => b - a);
  let ai = 0, bi = 0;
  const pocData = candle.footprint[poc.toFixed(dc)] || { bid: 0, ask: 0 };
  cumVol += (pocData.bid || 0) + (pocData.ask || 0);

  while (cumVol < target && (ai < above.length || bi < below.length)) {
    const upData   = ai < above.length ? (candle.footprint[above[ai].toFixed(dc)] || {bid:0,ask:0}) : null;
    const downData = bi < below.length ? (candle.footprint[below[bi].toFixed(dc)] || {bid:0,ask:0}) : null;
    const upV      = upData   ? (upData.bid||0)   + (upData.ask||0)   : -1;
    const downV    = downData ? (downData.bid||0) + (downData.ask||0) : -1;
    if (upV >= downV && upV >= 0)  { vaHigh = above[ai]; cumVol += upV;   ai++; }
    else if (downV >= 0)           { vaLow  = below[bi]; cumVol += downV; bi++; }
    else break;
  }
  candle.vah = vaHigh;
  candle.val = vaLow;
  detectDiagonalImbalances(candle);
}

// ══════════════════════════════════════════════════════════════
//  IMBALANCE HELPERS
// ══════════════════════════════════════════════════════════════
function computeImbalances(footprint) {
  const result = {};
  for (const p in footprint) {
    const { bid, ask } = footprint[p];
    if (ask > 0 && bid === 0)                { result[p] = "buy";  continue; }
    if (bid > 0 && ask === 0)                { result[p] = "sell"; continue; }
    if (ask > 0 && bid > 0) {
      if (ask / bid >= IMBALANCE_RATIO)      { result[p] = "buy";  continue; }
      if (bid / ask >= IMBALANCE_RATIO)      { result[p] = "sell"; continue; }
    }
    result[p] = null;
  }
  return result;
}

function detectStackedImbalances(candle) {
  const dc     = decimals(config.tick);
  const sorted = Object.keys(candle.footprint).map(Number).sort((a, b) => b - a);
  const imb    = computeImbalances(candle.footprint);
  let buyRun = 0, sellRun = 0;

  for (const p of sorted) {
    const k = p.toFixed(dc);
    if      (imb[k] === "buy")  { buyRun++;  sellRun = 0; }
    else if (imb[k] === "sell") { sellRun++; buyRun  = 0; }
    else { buyRun = 0; sellRun = 0; }

    if (buyRun >= STACK_MIN) {
      const sigKey = `${candle._slotStart}_buy_${p.toFixed(dc)}`;
      if (!candle._stackedFired) candle._stackedFired = new Set();
      if (!candle._stackedFired.has(sigKey)) {
        candle._stackedFired.add(sigKey);
        pushSignal("imbalance", p, `⬆ Stacked BUY ×${buyRun} @ ${p.toFixed(dc)}`);
        candle.signals.push({ type: "stackBuy", price: p });
      }
      buyRun = 0;
    }
    if (sellRun >= STACK_MIN) {
      const sigKey = `${candle._slotStart}_sell_${p.toFixed(dc)}`;
      if (!candle._stackedFired) candle._stackedFired = new Set();
      if (!candle._stackedFired.has(sigKey)) {
        candle._stackedFired.add(sigKey);
        pushSignal("imbalance", p, `⬇ Stacked SELL ×${sellRun} @ ${p.toFixed(dc)}`);
        candle.signals.push({ type: "stackSell", price: p });
      }
      sellRun = 0;
    }
  }
}

function detectDiagonalImbalances(candle) {
  const dc     = decimals(config.tick);
  const sorted = Object.keys(candle.footprint).map(Number).sort((a, b) => b - a);
  for (let i = 0; i < sorted.length - 1; i++) {
    const pH = sorted[i], pL = sorted[i + 1];
    const aH = candle.footprint[pH.toFixed(dc)]?.ask || 0;
    const bL = candle.footprint[pL.toFixed(dc)]?.bid || 0;
    if (bL > 0 && aH / bL >= DIAGONAL_RATIO)
      candle.signals.push({ type: "diagBuy",  price: pH, label: `↗ Diag BUY @ ${pH.toFixed(dc)}` });
    const bH = candle.footprint[pH.toFixed(dc)]?.bid || 0;
    const aL = candle.footprint[pL.toFixed(dc)]?.ask || 0;
    if (aL > 0 && bH / aL >= DIAGONAL_RATIO)
      candle.signals.push({ type: "diagSell", price: pL, label: `↘ Diag SELL @ ${pL.toFixed(dc)}` });
  }
}

function detectAbsorption_original(candle) {
  const dc = decimals(config.tick);
  let totalBid = 0, totalAsk = 0;
  for (const p in candle.footprint) {
    totalBid += candle.footprint[p].bid  || 0;
    totalAsk += candle.footprint[p].ask  || 0;
  }
  const priceMove = Math.abs(candle.close - candle.open);
  const avgPrice  = (candle.open + candle.close) / 2;
  const movePct   = avgPrice > 0 ? priceMove / avgPrice : 0;
  if (totalBid > totalAsk * 1.5 && movePct < ABSORPTION_DELTA_THR * 0.001 && candle.close >= candle.open) {
    const msg = `🟡 Absorption BUY @ ${candle.close.toFixed(dc)}`;
    pushSignal("absorption", candle.close, msg);
    candle.signals.push({ type: "absorptionBuy", price: candle.close, label: msg });
  } else if (totalAsk > totalBid * 1.5 && movePct < ABSORPTION_DELTA_THR * 0.001 && candle.close <= candle.open) {
    const msg = `🟠 Absorption SELL @ ${candle.close.toFixed(dc)}`;
    pushSignal("absorption", candle.close, msg);
    candle.signals.push({ type: "absorptionSell", price: candle.close, label: msg });
  }
}

function detectExhaustion(candle) {
  const dc     = decimals(config.tick);
  const sorted = Object.keys(candle.footprint).map(Number).sort((a, b) => b - a);
  if (sorted.length < 4) return;
  const topN = sorted.slice(0, Math.max(3, Math.floor(sorted.length * 0.2)));
  const midN = sorted.slice(Math.floor(sorted.length / 2), Math.floor(sorted.length / 2) + 3);
  const botN = sorted.slice(-Math.max(3, Math.floor(sorted.length * 0.2)));
  const topAskVol = topN.reduce((s, p) => s + (candle.footprint[p.toFixed(dc)]?.ask || 0), 0) / topN.length;
  const midAskVol = midN.length ? midN.reduce((s, p) => s + (candle.footprint[p.toFixed(dc)]?.ask || 0), 0) / midN.length : 0;
  const botBidVol = botN.reduce((s, p) => s + (candle.footprint[p.toFixed(dc)]?.bid || 0), 0) / botN.length;
  const midBidVol = midN.length ? midN.reduce((s, p) => s + (candle.footprint[p.toFixed(dc)]?.bid || 0), 0) / midN.length : 0;
  if (candle.close > candle.open && midAskVol > 0 && topAskVol < midAskVol * 0.3) {
    const msg = `😮 Buy Exhaustion @ ${candle.high.toFixed(dc)}`;
    pushSignal("exhaustion", candle.high, msg);
    candle.signals.push({ type: "exhaustionBuy", price: candle.high, label: msg });
  }
  if (candle.close < candle.open && midBidVol > 0 && botBidVol < midBidVol * 0.3) {
    const msg = `😮 Sell Exhaustion @ ${candle.low.toFixed(dc)}`;
    pushSignal("exhaustion", candle.low, msg);
    candle.signals.push({ type: "exhaustionSell", price: candle.low, label: msg });
  }
}

function trackIceberg(price, qty, pStr) {
  const dc = decimals(config.tick);
  if (!state.icebergMap[pStr]) state.icebergMap[pStr] = { count: 0, lastQty: 0, totalQty: 0 };
  const entry = state.icebergMap[pStr];
  entry.totalQty += qty;
  if (Math.abs(qty - entry.lastQty) / Math.max(qty, 0.0001) < 0.15) {
    entry.count++;
    if (entry.count === ICEBERG_MIN_REPEAT)
      pushSignal("iceberg", price, `🧊 ICEBERG @ ${price.toFixed(dc)} (×${entry.count} refreshes)`);
  } else { entry.count = 1; entry.lastQty = qty; }
  if (entry.count > 50) { entry.count = 0; entry.totalQty = 0; }
}

function checkIcebergStatus(price, qty, pStr) {
  const entry = state.icebergMap[pStr];
  return !!(entry && entry.count >= ICEBERG_MIN_REPEAT);
}

function getCandleMaxVol(candle) {
  const key = candle._slotStart;
  if (state.candleMaxVolCache.has(key)) return state.candleMaxVolCache.get(key);
  let maxVol = 0;
  for (const p in candle.footprint) {
    const v = (candle.footprint[p].bid || 0) + (candle.footprint[p].ask || 0);
    if (v > maxVol) maxVol = v;
  }
  state.candleMaxVolCache.set(key, maxVol);
  return maxVol;
}

// ══════════════════════════════════════════════════════════════
//  WEBSOCKET
// ══════════════════════════════════════════════════════════════
let ws = null, wsReconnectTimer = null;

function getTfString(seconds) {
  const map = { 30:"30s", 60:"1m", 300:"5m", 900:"15m", 1800:"30m", 3600:"1h", 7200:"2h" };
  return map[seconds] || "1m";
}

async function fetchInitialCandles() {
  const tf = getTfString(INTERVAL);
  try {
    const res     = await fetch(`http://${BACKEND_URL}/candles?tf=${tf}&symbol=${SYMBOL}`);
    const candles = await res.json();
    state.candles = candles.map(c => {
      const nc = {
        _slotStart : c.time,
        open       : c.open, high: c.high, low: c.low, close: c.close,
        totalVol   : c.volume,
        footprint  : c.footprint || {},
        signals    : [],
        bidVol: 0, askVol: 0, delta: 0,
      };
      for (const pStr in nc.footprint) {
        nc.bidVol += nc.footprint[pStr].bid || 0;
        nc.askVol += nc.footprint[pStr].ask || 0;
      }
      nc.delta = nc.askVol - nc.bidVol;
      computeCandleAnalytics(nc);
      return nc;
    });
    state._volProfileDirty = true;
    rebuildVolumeProfileFull();
    triggerRender();
  } catch (e) {
    console.error("Failed to fetch initial candles", e);
  }
}

function connectWS() {
  if (ws) { ws.onclose = null; ws.close(); }
  clearTimeout(wsReconnectTimer);
  setConnStatus("yellow", "Connecting to Server…");

  config.tick = TICK_SIZES[SYMBOL] || 0.01;
  state.candles = [];
  state.candleMaxVolCache.clear();
  _stackedFiredForCandle.clear();
  state.volumeProfile      = {};
  state._volProfileDirty   = true;
  state._volProfileCandles.clear();
  state.vwapNumer = 0; state.vwapDenom = 0; state.vwap = 0;
  state.cvd              = 0; state.cvdHistory       = [];
  state.globalCvd        = 0; state.globalCvdHistory = [];
  sessionStorage.setItem('hana_globalCvd', '0');
  state.tape = [];
  const tapeBody = document.getElementById("tapeBody");
  if (tapeBody) tapeBody.innerHTML = "";

  fetchInitialCandles();

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${BACKEND_URL}/ws`);

  ws.onopen = () => {
    setConnStatus("green", "Server Connected");
    fetchDepthSnapshot();
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const tf = getTfString(INTERVAL);

    if (msg.type === "update") {
      if (msg.tf === tf && msg.symbol === SYMBOL) handleServerCandleUpdate(msg.candle);
    } else if (msg.type === "depth") {
      if (msg.symbol === SYMBOL) applyDepthDiff(msg.data);
    } else if (msg.type === "trade") {
      if (msg.symbol === SYMBOL && msg.data) {
        const t = msg.data;
        processTrade(parseFloat(t.p), parseFloat(t.q), t.m === true, t.T || Date.now());
        updateHUD();
        triggerRender();
      }
    }
  };

  ws.onerror  = () => setConnStatus("red", "Server Error");
  ws.onclose  = () => {
    setConnStatus("red", "Disconnected — reconnecting…");
    wsReconnectTimer = setTimeout(connectWS, 3000);
  };
}

function handleServerCandleUpdate(sCandle) {
  const slotStart = sCandle.time;
  let last = state.candles[state.candles.length - 1];

  if (!last || last._slotStart !== slotStart) {
    if (last) {
      const prev = state.candles.length > 1 ? state.candles[state.candles.length - 2] : null;
      processFootprint(last, prev);
      detectStackedImbalances(last);
      detectExhaustion(last);
      detectAbsorption_original(last);
      detectAbsorptionEnhanced(last, prev);
      computeCandleAnalytics(last);
      detectAbsorptionReversal(last);
      detectStackedBreakout(last);
      detectLVNRejection(last);
    }
    const nc = {
      _slotStart : slotStart,
      open       : sCandle.open, high: sCandle.high,
      low        : sCandle.low,  close: sCandle.close,
      totalVol   : sCandle.volume || 0,
      footprint  : sCandle.footprint || {},
      signals    : [],
      bidVol     : 0, askVol: 0, delta: 0,
    };
    for (const pStr in nc.footprint) {
      nc.bidVol += nc.footprint[pStr].bid || 0;
      nc.askVol += nc.footprint[pStr].ask || 0;
    }
    nc.delta = nc.askVol - nc.bidVol;

    state.candles.push(nc);
    if (state.candles.length > state.MAX_CANDLES) {
      const removed = state.candles.shift();
      if (removed) {
        state.candleMaxVolCache.delete(removed._slotStart);
        rollVolProfileRemove(removed);
      }
    }
  } else {
    const oldFP = last.footprint;
    const newFP = sCandle.footprint || {};
    let newBidVol = 0, newAskVol = 0;

    for (const pStr in newFP) {
      newBidVol += newFP[pStr].bid || 0;
      newAskVol += newFP[pStr].ask || 0;
      const oldVal = oldFP[pStr] || { bid: 0, ask: 0 };
      const bidDiff = (newFP[pStr].bid || 0) - (oldVal.bid || 0);
      const askDiff = (newFP[pStr].ask || 0) - (oldVal.ask || 0);
      if (bidDiff > 0 || askDiff > 0) {
        const delta = askDiff - bidDiff;
        state.cvd       += delta;
        state.globalCvd += delta;
        state.cvdHistory.push(state.cvd);
        state.globalCvdHistory.push(state.globalCvd);
        if (state.cvdHistory.length > 2000)       state.cvdHistory.shift();
        if (state.globalCvdHistory.length > 2000) state.globalCvdHistory.shift();
        state.tpsCount++;
        detectSweep(delta, parseFloat(pStr), Date.now());
        checkSweepTrap(delta, parseFloat(pStr), Date.now());
        if (bidDiff > 0) trackIceberg(parseFloat(pStr), bidDiff, pStr);
        if (askDiff > 0) trackIceberg(parseFloat(pStr), askDiff, pStr);
      }
    }

    last.high      = sCandle.high;
    last.low       = sCandle.low;
    last.close     = sCandle.close;
    last.totalVol  = sCandle.volume || 0;
    last.footprint = newFP;
    last.bidVol    = newBidVol;
    last.askVol    = newAskVol;
    last.delta     = newAskVol - newBidVol;

    state.candleMaxVolCache.delete(last._slotStart);
  }

  state.currentPrice = sCandle.close;
  checkSessionBoundary();
  if (sCandle.high > state.sessionHigh) { state.sessionHigh = sCandle.high; persistSessionHL(); }
  if (sCandle.low  < state.sessionLow)  { state.sessionLow  = sCandle.low;  persistSessionHL(); }

  recalculateSessionStats();
  computeCandleAnalytics(state.candles[state.candles.length - 1]);
  updateHUD();
  triggerRender();
}

function recalculateSessionStats() {
  checkSessionBoundary();
  if (state._volProfileDirty) { rebuildVolumeProfileFull(); return; }
  for (const c of state.candles) {
    if (c.high > state.sessionHigh) { state.sessionHigh = c.high; persistSessionHL(); }
    if (c.low  < state.sessionLow)  { state.sessionLow  = c.low;  persistSessionHL(); }
    if (state._volProfileCandles.has(c._slotStart)) continue;
    rollVolProfileAdd(c);
    for (const pStr in c.footprint) {
      const vol   = (c.footprint[pStr].bid || 0) + (c.footprint[pStr].ask || 0);
      const price = parseFloat(pStr);
      state.vwapNumer += price * vol;
      state.vwapDenom += vol;
    }
  }
  if (state.vwapDenom > 0) state.vwap = state.vwapNumer / state.vwapDenom;
}

function setConnStatus(color, text) {
  const dot = document.getElementById("connDot");
  const lbl = document.getElementById("connLbl");
  if (dot) dot.className = `dot ${color}`;
  if (lbl) lbl.textContent = text;
}

// ══════════════════════════════════════════════════════════════
//  HUD  — FIX 2+3: delta + dual CVD
// ══════════════════════════════════════════════════════════════
function updateHUD() {
  const p  = state.currentPrice;
  const dc = decimals(config.tick);

  const elPrice = document.getElementById("livePrice");
  if (elPrice) elPrice.textContent = p.toFixed(dc);

  const spread = computeSpread();
  const elSpread = document.getElementById("liveSpread");
  if (elSpread) elSpread.textContent = (spread !== null && spread > 0) ? spread.toFixed(dc) : "—";

  const cur        = state.candles[state.candles.length - 1];
  const candleDelta = cur ? (cur.delta || 0) : 0;
  const dEl = document.getElementById("liveDelta");
  if (dEl) {
    dEl.style.color = candleDelta >= 0 ? "#26A69A" : "#EF5350";
    dEl.textContent = (candleDelta >= 0 ? "+" : "") + candleDelta.toFixed(2);
  }

  const cEl = document.getElementById("liveCVD");
  if (cEl) {
    cEl.style.color = state.cvd >= 0 ? "#26A69A" : "#EF5350";
    cEl.textContent = (state.cvd >= 0 ? "+" : "") + state.cvd.toFixed(2);
  }
  const gcEl = document.getElementById("liveGlobalCVD");
  if (gcEl) {
    gcEl.style.color = state.globalCvd >= 0 ? "#26A69A" : "#EF5350";
    gcEl.textContent = (state.globalCvd >= 0 ? "+" : "") + state.globalCvd.toFixed(2);
  }

  const vEl = document.getElementById("liveVWAP");
  if (vEl) vEl.textContent = state.vwap > 0 ? state.vwap.toFixed(dc) : "—";

  const shEl = document.getElementById("liveSessionH");
  if (shEl) shEl.textContent = state.sessionHigh > -Infinity ? state.sessionHigh.toFixed(dc) : "—";
  const slEl = document.getElementById("liveSessionL");
  if (slEl) slEl.textContent = state.sessionLow < Infinity ? state.sessionLow.toFixed(dc) : "—";

  const diEl = document.getElementById("liveDOMImb");
  if (diEl) {
    const imb = state.domAnalytics.imbalance;
    diEl.textContent = imb.toFixed(2);
    diEl.style.color = imb >= 1 ? "#26A69A" : "#EF5350";
  }
}

setInterval(() => {
  const el = document.getElementById("liveTPS");
  if (el) el.textContent = state.tpsCount;
  state.tpsCount = 0;
}, 1000);

// ══════════════════════════════════════════════════════════════
//  SIGNAL FEED
// ══════════════════════════════════════════════════════════════
const signalFeed = document.getElementById("signals") || document.getElementById("signalBody");
const recentSigs = new Set();

function pushSignal(type, price, msg) {
  if (recentSigs.has(msg)) return;
  recentSigs.add(msg);
  setTimeout(() => recentSigs.delete(msg), 5000);
  if (!signalFeed) return;
  const pill = document.createElement("div");
  pill.className = `signal-pill ${type}`;
  pill.textContent = msg;
  signalFeed.prepend(pill);
  if (signalFeed.children.length > 60) signalFeed.removeChild(signalFeed.lastChild);
  setTimeout(() => { pill.style.opacity = "0.3"; }, 4000);
}

// ══════════════════════════════════════════════════════════════
//  REPLAY MODE
// ══════════════════════════════════════════════════════════════
function startReplay(trades) {
  if (!trades || !trades.length) return;
  stopReplay();
  state.replayTrades = trades; state.replayIndex = 0; state.replayActive = true;
  state.candles = [];
  state.cvd = 0; state.cvdHistory = [];
  state.globalCvd = 0; state.globalCvdHistory = [];
  state.deltaSeries = [];
  state.vwapNumer = 0; state.vwapDenom = 0; state.vwap = 0;
  state.sessionHigh = -Infinity; state.sessionLow = Infinity;
  state.volumeProfile = {}; state._volProfileDirty = false; state._volProfileCandles.clear();
  state.candleMaxVolCache.clear();
  state.tape = [];
  const tapeBody = document.getElementById("tapeBody");
  if (tapeBody) tapeBody.innerHTML = "";
  const btn = document.getElementById("btnReplay");
  if (btn) { btn.textContent = "⏹ Stop"; btn.classList.add("active"); }
  const ov = document.getElementById("replayOverlay");
  if (ov) ov.style.display = "block";
  function step() {
    if (!state.replayActive || state.replayIndex >= state.replayTrades.length) { stopReplay(); return; }
    const t = state.replayTrades[state.replayIndex++];
    processTrade(t.price, t.qty, t.isBuyerMaker, t.time);
    updateHUD(); triggerRender();
    state.replayTimer = setTimeout(step, 30);
  }
  step();
}
function stopReplay() {
  state.replayActive = false;
  clearTimeout(state.replayTimer);
  const btn = document.getElementById("btnReplay");
  if (btn) { btn.textContent = "▶ Replay"; btn.classList.remove("active"); }
  const ov = document.getElementById("replayOverlay");
  if (ov) ov.style.display = "none";
}

// ══════════════════════════════════════════════════════════════
//  PIXI SETUP
// ══════════════════════════════════════════════════════════════
const container = document.getElementById("chartContainer");
const tooltip   = document.getElementById("tooltip");

const app = new PIXI.Application({
  resizeTo: container, backgroundColor: 0x080B10,
  resolution: window.devicePixelRatio || 1, autoDensity: true, antialias: false,
});
container.appendChild(app.view);
app.view.style.position = "absolute";
app.view.style.top  = "0";
app.view.style.left = "0";

PIXI.BitmapFont.from("FPFont",
  { fontFamily: "Consolas, monospace", fontSize: 36, fill: "#ffffff", fontWeight: "700" },
  { chars: PIXI.BitmapFont.ASCII }
);

const g = new PIXI.Graphics();
app.stage.addChild(g);
const textPool = []; let textIndex = 0;

function getPooledText(str, x, y, size, color, align) {
  if (size < 7) return null;
  let t;
  if (textIndex < textPool.length) { t = textPool[textIndex]; t.visible = true; }
  else { t = new PIXI.BitmapText("", { fontName: "FPFont" }); textPool.push(t); app.stage.addChild(t); }
  t.text = String(str); t.fontSize = size; t.tint = color; t.y = y; t.anchor.y = 0.5;
  if      (align === "right")  { t.x = x; t.anchor.x = 1;   }
  else if (align === "center") { t.x = x; t.anchor.x = 0.5; }
  else                         { t.x = x; t.anchor.x = 0;   }
  textIndex++; return t;
}

function heatColor(ratio) {
  if (ratio > 0.80) return 0xFFD600;  // extreme — yellow
  if (ratio > 0.55) return 0xFF6D00;  // high    — orange
  if (ratio > 0.28) return 0x1565C0;  // mid     — blue
  if (ratio > 0.08) return 0x0D3B6E;  // low     — dark blue
  return 0x080C14;                     // empty
}

// ══════════════════════════════════════════════════════════════
//  RENDER ENGINE
// ══════════════════════════════════════════════════════════════
function triggerRender() {
  g.clear(); textIndex = 0;
  if (!state.candles.length) {
    getPooledText("Waiting for live data…", app.renderer.width / 2, app.renderer.height / 2, 16, 0x4A5568, "center");
    for (let i = textIndex; i < textPool.length; i++) textPool[i].visible = false;
    return;
  }

  let globalHigh = -Infinity, globalLow = Infinity;
  for (const c of state.candles) {
    if (c.high > globalHigh) globalHigh = c.high;
    if (c.low  < globalLow)  globalLow  = c.low;
  }

  const dc      = decimals(config.tick);
  const refHigh = norm(globalHigh + config.tick * 5);
  const refLow  = norm(globalLow  - config.tick * 5);
  const ladder  = [];
  for (let p = refHigh; p >= refLow - config.tick * 0.5; p = norm(p - config.tick)) {
    ladder.push(p); if (ladder.length > 3000) break;
  }

  const scrW = app.renderer.width, scrH = app.renderer.height;
  const w    = config.candleWidth, hW = w / 2;
  const fs   = Math.max(9, Math.min(14, Math.floor(config.rowHeight * 0.48)));

  const maxProfileVol = Math.max(...Object.values(state.volumeProfile), 1);
  const sessionPOC    = getProfilePOC();
  const sessionVA     = getProfileValueArea();

  // ── Grid ──
  g.lineStyle(1, 0x0E1420, 0.7);
  for (let j = 0; j < ladder.length; j++) {
    const yOff = config.startY + j * config.rowHeight;
    if (yOff < 0 || yOff > scrH) continue;
    g.moveTo(config.leftPanelWidth, yOff);
    g.lineTo(scrW - config.rightPanelWidth, yOff);
  }
  g.lineStyle(0);

  // ── Session VA shading ──
  if (config.showVolProfile && sessionVA.vah != null && sessionVA.val != null) {
    const vahIdx = ladder.findIndex(p => Math.abs(p - sessionVA.vah) < config.tick * 0.5);
    const valIdx = ladder.findIndex(p => Math.abs(p - sessionVA.val) < config.tick * 0.5);
    if (vahIdx >= 0 && valIdx >= 0) {
      g.beginFill(0x0D2040, 0.18);
      g.drawRect(config.leftPanelWidth,
        config.startY + vahIdx * config.rowHeight,
        scrW - config.rightPanelWidth - config.leftPanelWidth,
        (config.startY + valIdx * config.rowHeight + config.rowHeight) - (config.startY + vahIdx * config.rowHeight));
      g.endFill();
    }
  }

  // ── Session H/L ──
  if (config.showSessionHL && state.sessionHigh > -Infinity) {
    [["sessionHigh", 0xFFD600, "SH"], ["sessionLow", 0xFF6D00, "SL"]].forEach(([key, clr, lbl]) => {
      const idx = ladder.findIndex(p => Math.abs(p - state[key]) < config.tick * 0.5);
      if (idx < 0) return;
      const yOff = config.startY + idx * config.rowHeight;
      g.lineStyle(1, clr, 0.6);
      g.moveTo(config.leftPanelWidth, yOff); g.lineTo(scrW - config.rightPanelWidth, yOff);
      g.lineStyle(0);
      getPooledText(lbl, scrW - config.rightPanelWidth - 28, yOff + config.rowHeight / 2, 8, clr, "left");
    });
  }

  // ── VWAP ──
  if (config.showVWAP && state.vwap > 0) {
    const vIdx = ladder.findIndex(p => Math.abs(p - norm(state.vwap)) < config.tick * 0.5);
    if (vIdx >= 0) {
      const vy = config.startY + vIdx * config.rowHeight + config.rowHeight / 2;
      g.lineStyle(2, 0xAB47BC, 0.85);
      g.moveTo(config.leftPanelWidth, vy); g.lineTo(scrW - config.rightPanelWidth, vy);
      g.lineStyle(0);
      getPooledText("VWAP", scrW - config.rightPanelWidth - 52, vy, 8, 0xAB47BC, "left");
    }
  }

  // ── Session POC ──
  if (config.showVolProfile && sessionPOC.price != null) {
    const pocIdx = ladder.findIndex(p => Math.abs(p - sessionPOC.price) < config.tick * 0.5);
    if (pocIdx >= 0) {
      const pocY = config.startY + pocIdx * config.rowHeight + config.rowHeight / 2;
      g.lineStyle(1, 0xFFD600, 0.5);
      g.moveTo(config.leftPanelWidth, pocY); g.lineTo(scrW - config.rightPanelWidth, pocY);
      g.lineStyle(0);
      getPooledText("sPOC", scrW - config.rightPanelWidth - 40, pocY, 8, 0xFFD600, "left");
    }
  }

  // ══ Footprint Candles ══
  for (let i = 0; i < state.candles.length; i++) {
    const xOff = config.startX + i * config.spacing;
    if (xOff + config.spacing < config.leftPanelWidth || xOff > scrW - config.rightPanelWidth) continue;

    const candle  = state.candles[i];
    const maxVol  = getCandleMaxVol(candle);
    const pocPrice = candle.poc;
    const imb     = computeImbalances(candle.footprint);
    let topY = null, bottomY = null;

    if (config.showValueArea && candle.vah != null && candle.val != null) {
      const vahIdx = ladder.findIndex(p => Math.abs(p - candle.vah) < config.tick * 0.5);
      const valIdx = ladder.findIndex(p => Math.abs(p - candle.val) < config.tick * 0.5);
      if (vahIdx >= 0 && valIdx >= 0) {
        g.beginFill(0x1A237E, 0.12);
        g.drawRect(xOff, config.startY + vahIdx * config.rowHeight, w,
          (config.startY + valIdx * config.rowHeight + config.rowHeight) - (config.startY + vahIdx * config.rowHeight));
        g.endFill();
      }
    }

    for (let j = 0; j < ladder.length; j++) {
      const price = ladder[j];
      const yOff  = config.startY + j * config.rowHeight;
      if (yOff + config.rowHeight < 0 || yOff > scrH) continue;
      if (price > candle.high + config.tick * 0.5 || price < candle.low - config.tick * 0.5) continue;
      if (topY === null) topY = yOff;
      bottomY = yOff + config.rowHeight;

      const pStr   = price.toFixed(dc);
      const dat    = candle.footprint[pStr] || { bid: 0, ask: 0 };
      const bid    = dat.bid, ask = dat.ask;
      const vol    = bid + ask;
      const delta  = ask - bid;
      const isPOC  = (Math.abs(price - pocPrice) < config.tick * 0.5 && vol > 0);
      const cY     = yOff + config.rowHeight / 2;
      const imbType = imb[pStr];
      const profVol = state.volumeProfile[pStr] || 0;
      const nodeType = config.showHVNLVN ? classifyProfileNode(profVol, maxProfileVol) : "normal";

      const ratio = maxVol > 0 ? vol / maxVol : 0;

      if      (imbType === "buy"  && vol > 0) g.beginFill(0x003D33, 0.88);
      else if (imbType === "sell" && vol > 0) g.beginFill(0x3D0000, 0.88);
      else                                    g.beginFill(heatColor(ratio), vol > 0 ? 0.78 : 0.04);
      g.drawRect(xOff, yOff, w, config.rowHeight); g.endFill();

      if (nodeType === "hvn") { g.beginFill(0xFFD600, 0.07); g.drawRect(xOff, yOff, w, config.rowHeight); g.endFill(); }
      if (nodeType === "lvn") { g.beginFill(0xEF5350, 0.06); g.drawRect(xOff, yOff, w, config.rowHeight); g.endFill(); }

      if (candle.signals) {
        const ofStack = candle.signals.find(s => (s.type === "ofStackedImbalance" || s.type === "ofStackedImbalanceSell") && Math.abs(s.price - price) < config.tick * 3);
        if (ofStack) {
          const sc = ofStack.type === "ofStackedImbalanceSell" ? 0xFF6D00 : 0x00E5FF;
          g.beginFill(sc, 0.09); g.drawRect(xOff, yOff, w, config.rowHeight); g.endFill();
          g.lineStyle(1, sc, 0.35); g.drawRect(xOff, yOff, w, config.rowHeight); g.lineStyle(0);
        }
        const ofAbs = candle.signals.find(s => s.type === "ofAbsorption" && Math.abs(s.price - price) < config.tick * 3);
        if (ofAbs) { g.beginFill(0xFFD600, 0.12); g.drawRect(xOff, yOff, w, config.rowHeight); g.endFill(); }
        const ofBearDiv = candle.signals.find(s => s.type === "ofBearishDivergence" && Math.abs(s.price - price) < config.tick * 3);
        if (ofBearDiv) { g.beginFill(0xFF1744, 0.10); g.drawRect(xOff, yOff, w, config.rowHeight); g.endFill(); }
        const ofBullDiv = candle.signals.find(s => s.type === "ofBullishDivergence" && Math.abs(s.price - price) < config.tick * 3);
        if (ofBullDiv) { g.beginFill(0x00E676, 0.10); g.drawRect(xOff, yOff, w, config.rowHeight); g.endFill(); }

        const absRev = candle.signals.find(s => (s.type === "absReversalLong" || s.type === "absReversalShort") && Math.abs(s.price - price) < config.tick * 2);
        if (absRev && config.showAbsorbReversal) {
          const clr = absRev.type === "absReversalLong" ? 0x00E676 : 0xFF1744;
          g.beginFill(clr, 0.15); g.drawRect(xOff, yOff, w, config.rowHeight); g.endFill();
          g.lineStyle(1, clr, 0.6); g.drawRect(xOff, yOff, w, config.rowHeight); g.lineStyle(0);
        }
        const stackBo = candle.signals.find(s => (s.type === "stackBreakoutLong" || s.type === "stackBreakoutShort") && Math.abs(s.price - price) < config.tick);
        if (stackBo && config.showStackBreakout) {
          const clr = stackBo.type === "stackBreakoutLong" ? 0x00E5FF : 0xFF6D00;
          g.lineStyle(2, clr, 0.9); g.moveTo(xOff-3, yOff + config.rowHeight/2); g.lineTo(xOff+6, yOff + config.rowHeight/2); g.lineStyle(0);
          g.beginFill(clr, 0.8); g.drawPolygon(stackBo.type === "stackBreakoutLong" ? [xOff+6,yOff+2,xOff+6,yOff+config.rowHeight-2,xOff+10,yOff+config.rowHeight/2] : [xOff+10,yOff+2,xOff+10,yOff+config.rowHeight-2,xOff+6,yOff+config.rowHeight/2]); g.endFill();
        }
        const sweepTrap = candle.signals.find(s => (s.type === "sweepTrapShort" || s.type === "sweepTrapLong") && Math.abs(s.price - price) < config.tick * 2);
        if (sweepTrap && config.showSweepTrap) {
          const clr = sweepTrap.type === "sweepTrapShort" ? 0xFF1744 : 0x00E676;
          g.lineStyle(1, clr, 0.8);
          g.moveTo(xOff+hW-6, yOff+2); g.lineTo(xOff+hW, yOff+config.rowHeight/2); g.lineTo(xOff+hW+6, yOff+2);
          g.lineStyle(0);
          g.beginFill(clr, 0.5); g.drawCircle(xOff+hW, yOff+config.rowHeight/2, 3); g.endFill();
        }
        const lvnRej = candle.signals.find(s => (s.type === "lvnRejectLong" || s.type === "lvnRejectShort") && Math.abs(s.price - price) < config.tick * 2);
        if (lvnRej && config.showLVNReject) {
          const clr = lvnRej.type === "lvnRejectLong" ? 0x76FF03 : 0xFF6D00;
          g.beginFill(clr, 0.25); g.drawRect(xOff, yOff, w, config.rowHeight); g.endFill();
          g.lineStyle(1, clr, 0.5); g.drawRect(xOff, yOff, w, config.rowHeight); g.lineStyle(0);
        }
        const wallSig = candle.signals.find(s => ["wallHoldBid","wallHoldAsk","wallPullBid","wallPullAsk"].includes(s.type) && Math.abs(s.price - price) < config.tick * 2);
        if (wallSig && config.showWallReaction) {
          const clr   = wallSig.type.includes("Hold") ? (wallSig.type.includes("Bid") ? 0x00BFA5 : 0xEF5350) : 0xFF6D00;
          const alpha = wallSig.type.includes("Pull") ? 0.3 : 0.18;
          g.beginFill(clr, alpha); g.drawRect(xOff, yOff, w, config.rowHeight); g.endFill();
          if (wallSig.type.includes("Pull")) {
            g.lineStyle(1, 0xFF6D00, 0.8);
            g.moveTo(xOff, yOff + config.rowHeight/2); g.lineTo(xOff + w, yOff + config.rowHeight/2);
            g.lineStyle(0);
          }
        }
      }

      if (imbType === "buy")  { g.lineStyle(1, 0x00BFA5, 0.85); g.drawRect(xOff, yOff, w, config.rowHeight); g.lineStyle(0); }
      else if (imbType === "sell") { g.lineStyle(1, 0xEF5350, 0.85); g.drawRect(xOff, yOff, w, config.rowHeight); g.lineStyle(0); }

      if (config.showDiagonalImb && candle.signals) {
        const ds = candle.signals.find(s => (s.type === "diagBuy" || s.type === "diagSell") && Math.abs(s.price - price) < config.tick * 0.5);
        if (ds) {
          const clr = ds.type === "diagBuy" ? 0x00E5FF : 0xFF6E40;
          g.lineStyle(1, clr, 0.7); g.moveTo(xOff, yOff + config.rowHeight); g.lineTo(xOff + w*0.3, yOff); g.lineStyle(0);
        }
      }

      if (isPOC) {
        g.lineStyle(2, 0xFFD600, 1);
        g.drawRect(xOff+1, yOff+1, w-2, config.rowHeight-2);
        g.lineStyle(0);
      }

      if (vol > 0 && config.rowHeight > 9) {
        g.lineStyle(1, 0x0A1020, 0.8);
        g.moveTo(xOff + hW, yOff+2); g.lineTo(xOff + hW, yOff + config.rowHeight-2);
        g.lineStyle(0);
      }

      if (config.showFootprintText && fs >= 8 && config.rowHeight >= 10) {
        const isPocColor = isPOC ? 0xFFD600 : 0xBEC8D8;
        const bidColor   = imbType === "sell" ? 0xFF7043 : imbType === "buy" ? 0x546E7A : isPocColor;
        const askColor   = imbType === "buy"  ? 0x26A69A : imbType === "sell" ? 0x546E7A : isPocColor;

        if (bid > 0) getPooledText(fmtVol(bid), xOff + hW - 4, cY, fs, bidColor, "right");
        if (ask > 0) getPooledText(fmtVol(ask), xOff + hW + 4, cY, fs, askColor, "left");

        if (config.showDeltaPerLevel && vol > 0 && config.rowHeight > 12) {
          const deltaColor = delta >= 0 ? 0x26A69A : 0xEF5350;
          const barW = Math.min(Math.abs(delta) / Math.max(vol, 1) * (w * 0.08), w * 0.08);
          g.beginFill(deltaColor, 0.7);
          g.drawRect(xOff + w - barW - 1, yOff+2, barW, config.rowHeight-4);
          g.endFill();
        }
      }
    }

    if (topY !== null) {
      const bodyColor = candle.close >= candle.open ? 0x26A69A : 0xEF5350;
      g.lineStyle(1, bodyColor, 0.4);
      g.drawRect(xOff, topY, w, bottomY - topY);
      g.lineStyle(0);
    }

    if (config.showPOCExtension && candle.poc != null && i < state.candles.length - 1) {
      const nextXOff = config.startX + (i+1) * config.spacing;
      const pocIdx   = ladder.findIndex(p => Math.abs(p - candle.poc) < config.tick * 0.5);
      if (pocIdx >= 0) {
        const pocYOff = config.startY + pocIdx * config.rowHeight + config.rowHeight / 2;
        if (pocYOff > 0 && pocYOff < scrH) {
          g.lineStyle(1, 0xFFD600, 0.35);
          g.moveTo(xOff + w, pocYOff); g.lineTo(nextXOff, pocYOff);
          g.lineStyle(0);
        }
      }
    }

    if (config.showCandleDelta && topY !== null && bottomY !== null) {
      const candleDelta  = candle.delta || 0;
      const deltaStr     = (candleDelta >= 0 ? "+" : "") + candleDelta.toFixed(1);
      const deltaColor   = candleDelta >= 0 ? 0x26A69A : 0xEF5350;
      const deltaY       = bottomY + (config.rowHeight * 0.6);
      if (deltaY > 0 && deltaY < scrH)
        getPooledText(deltaStr, xOff + hW, deltaY, Math.max(8, fs - 1), deltaColor, "center");

      if (config.rowHeight > 12 && topY > 14) {
        const bidTotal = candle.bidVol || 0;
        const askTotal = candle.askVol || 0;
        if (bidTotal > 0) getPooledText(fmtVol(bidTotal), xOff + 2, topY - 5, Math.max(7, fs-2), 0xEF5350, "left");
        if (askTotal > 0) getPooledText(fmtVol(askTotal), xOff + w - 2, topY - 5, Math.max(7, fs-2), 0x26A69A, "right");
      }
    }

    if (candle.signals) {
      for (const sig of candle.signals) {
        if (sig.type === "absorptionBuy"  || sig.type === "exhaustionSell") {
          if (bottomY !== null) { g.beginFill(sig.type === "absorptionBuy" ? 0xFFD600 : 0xEF5350, 0.85); g.drawCircle(xOff+hW, bottomY+5, 4); g.endFill(); }
        } else if (sig.type === "absorptionSell" || sig.type === "exhaustionBuy") {
          if (topY !== null)    { g.beginFill(sig.type === "absorptionSell" ? 0xFF6D00 : 0x26A69A, 0.85); g.drawCircle(xOff+hW, topY-5, 4);    g.endFill(); }
        }
      }
      const ofAbsSig = candle.signals.find(s => s.type === "ofAbsorption");
      if (ofAbsSig && config.showAbsorptionMark && topY !== null) {
        const ay = topY - 16;
        if (ay > 0 && ay < scrH) {
          g.beginFill(0xFFD600, 0.9); g.drawCircle(xOff+hW, ay, 5); g.endFill();
          g.lineStyle(1, 0xFFD600, 0.7); g.drawCircle(xOff+hW, ay, 8); g.lineStyle(0);
          getPooledText("ABS", xOff+hW, ay-12, Math.max(7, fs-2), 0xFFD600, "center");
        }
      }
      const absRevSig = candle.signals.find(s => s.type === "absReversalLong" || s.type === "absReversalShort");
      if (absRevSig && config.showAbsorbReversal) {
        const clr = absRevSig.type === "absReversalLong" ? 0x00E676 : 0xFF1744;
        const sy  = absRevSig.type === "absReversalLong"
          ? (bottomY != null ? bottomY+14 : 0)
          : (topY    != null ? topY-14    : 0);
        if (sy > 0 && sy < scrH) { g.beginFill(clr, 1); g.drawStar(xOff+hW, sy, 5, 7, 3); g.endFill(); g.lineStyle(1, clr, 0.7); g.drawCircle(xOff+hW, sy, 10); g.lineStyle(0); }
      }
      const stackBoSig = candle.signals.find(s => s.type === "stackBreakoutLong" || s.type === "stackBreakoutShort");
      if (stackBoSig && config.showStackBreakout) {
        const clr = stackBoSig.type === "stackBreakoutLong" ? 0x00E5FF : 0xFF6D00;
        const sy  = stackBoSig.type === "stackBreakoutLong" ? (bottomY != null ? bottomY+12 : 0) : (topY != null ? topY-12 : 0);
        if (sy > 0 && sy < scrH) getPooledText(stackBoSig.type === "stackBreakoutLong" ? "⬆⬆" : "⬇⬇", xOff + hW, sy, 12, clr, "center");
      }
    }
  }

  if (config.showVolProfile) {
    const profX = scrW - config.rightPanelWidth - PROFILE_BAR_MAXW - 6;
    for (let j = 0; j < ladder.length; j++) {
      const price = ladder[j], yOff = config.startY + j * config.rowHeight;
      if (yOff < 0 || yOff > scrH) continue;
      const pStr = price.toFixed(dc), vol = state.volumeProfile[pStr] || 0;
      if (vol === 0) continue;
      const bw = (vol / maxProfileVol) * PROFILE_BAR_MAXW;
      const nodeType = classifyProfileNode(vol, maxProfileVol);
      const barColor = nodeType === "hvn" ? 0x1E4A7E : nodeType === "lvn" ? 0x3D1A1A : 0x1E3A5F;
      g.beginFill(barColor, nodeType === "hvn" ? 0.80 : nodeType === "lvn" ? 0.55 : 0.50);
      g.drawRect(profX + PROFILE_BAR_MAXW - bw, yOff + 1, bw, config.rowHeight - 2);
      g.endFill();
      if (sessionPOC.price != null && Math.abs(price - sessionPOC.price) < config.tick * 0.5) {
        g.lineStyle(1, 0xFFD600, 0.9);
        g.moveTo(profX, yOff + config.rowHeight / 2);
        g.lineTo(profX + PROFILE_BAR_MAXW, yOff + config.rowHeight / 2);
        g.lineStyle(0);
      }
    }
  }

  g.beginFill(0x080B10, 0.97); g.drawRect(0, 0, config.leftPanelWidth, scrH); g.endFill();
  g.lineStyle(1, 0x141C2A); g.moveTo(config.leftPanelWidth, 0); g.lineTo(config.leftPanelWidth, scrH); g.lineStyle(0);

  const labelEvery = Math.max(1, Math.round(40 / config.rowHeight));
  for (let j = 0; j < ladder.length; j++) {
    const yOff  = config.startY + j * config.rowHeight;
    if (yOff < -config.rowHeight || yOff > scrH) continue;
    const price = ladder[j];
    const isCP   = Math.abs(price - state.currentPrice) < config.tick * 0.5;
    if (isCP) {
      g.beginFill(0x1565C0, 0.85);
      g.drawRect(0, yOff, config.leftPanelWidth, config.rowHeight);
      g.endFill();
      getPooledText(price.toFixed(dc), config.leftPanelWidth - 6, yOff + config.rowHeight / 2, Math.max(9, fs), 0xFFFFFF, "right");
    } else if (j % labelEvery === 0) {
      getPooledText(price.toFixed(dc), config.leftPanelWidth - 6, yOff + config.rowHeight / 2, Math.max(8, fs), 0x3D4A5C, "right");
    }
  }

  renderDOMPanel(g, ladder, scrW, scrH, dc, fs);

  for (let i = textIndex; i < textPool.length; i++) textPool[i].visible = false;
}

// ══════════════════════════════════════════════════════════════
//  INTERACTION & BOOT
// ══════════════════════════════════════════════════════════════
container.addEventListener("wheel", e => {
  e.preventDefault();
  const rect = container.getBoundingClientRect();
  const mX = e.clientX - rect.left, mY = e.clientY - rect.top;
  const z = e.deltaY < 0 ? 1.09 : 0.91;
  const lX = (mX - config.startX) / config.spacing, lY = (mY - config.startY) / config.rowHeight;
  config.spacing    = Math.max(20, Math.min(700, config.spacing * z));
  config.rowHeight  = Math.max(5, Math.min(160, config.rowHeight * z));
  config.candleWidth = config.spacing * 0.65;
  config.fontSize   = Math.max(7, Math.floor(config.rowHeight * 0.44));
  config.startX = mX - lX * config.spacing;
  config.startY = mY - lY * config.rowHeight;
  triggerRender();
}, { passive: false });

let isDragging = false, dragX = 0, dragY = 0;
container.addEventListener("mousedown", e => { isDragging = true; dragX = e.clientX; dragY = e.clientY; });
window.addEventListener("mouseup", () => { isDragging = false; });
window.addEventListener("mousemove", e => {
  const rect = container.getBoundingClientRect();
  const mX = e.clientX - rect.left, mY = e.clientY - rect.top;
  if (isDragging) {
    config.startX += e.clientX - dragX; config.startY += e.clientY - dragY;
    dragX = e.clientX; dragY = e.clientY;
    tooltip.style.display = "none"; triggerRender(); return;
  }
  const cIdx = Math.floor((mX - config.startX) / config.spacing);
  if (cIdx >= 0 && cIdx < state.candles.length) {
    const candle = state.candles[cIdx], xOff = config.startX + cIdx * config.spacing;
    if (mX >= xOff && mX <= xOff + config.candleWidth && state.candles.length > 0) {
      const globalHigh = Math.max(...state.candles.map(c => c.high));
      const refHigh    = norm(globalHigh);
      const rowIdx     = Math.floor((mY - config.startY) / config.rowHeight);
      const dc         = decimals(config.tick), hoverPrice = norm(refHigh - rowIdx * config.tick), pStr = hoverPrice.toFixed(dc);
      const dat        = candle.footprint[pStr] || { bid: 0, ask: 0 };
      const bid = dat.bid, ask = dat.ask, delta = ask - bid, vol = bid + ask;
      document.getElementById("ttPrice").textContent = hoverPrice.toFixed(dc);
      document.getElementById("ttBid").textContent   = bid.toFixed(4);
      document.getElementById("ttAsk").textContent   = ask.toFixed(4);
      const dEl = document.getElementById("ttDelta");
      dEl.textContent = (delta >= 0 ? "+" : "") + delta.toFixed(4);
      dEl.style.color = delta >= 0 ? "#26A69A" : "#EF5350";
      document.getElementById("ttVol").textContent = vol.toFixed(4);
      document.getElementById("ttPOC").textContent = candle.poc != null ? candle.poc.toFixed(dc) : "—";
      document.getElementById("ttVAH").textContent = candle.vah != null ? candle.vah.toFixed(dc) : "—";
      document.getElementById("ttVAL").textContent = candle.val != null ? candle.val.toFixed(dc) : "—";
      tooltip.style.display = "block";
      tooltip.style.left = (mX + 18) + "px";
      tooltip.style.top  = Math.min(mY + 12, container.clientHeight - 260) + "px";
      return;
    }
  }
  tooltip.style.display = "none";
});

document.getElementById("symSel")?.addEventListener("change", e => { SYMBOL = e.target.value; connectWS(); });
document.getElementById("ivBtns")?.addEventListener("click", e => {
  if (e.target.dataset.s) {
    INTERVAL = parseInt(e.target.dataset.s);
    document.querySelectorAll(".iv-btn").forEach(b => b.classList.toggle("active", b === e.target));
    state.candles = []; state.cvd = 0; state.cvdHistory = []; state.deltaSeries = [];
    state.candleMaxVolCache.clear();
    _stackedFiredForCandle.clear();
    fetchInitialCandles();
  }
});

["btnVWAP","btnPOCExt","btnVA","btnSHL","btnDiag","btnVolProfile","btnHVNLVN","btnDOMImb","btnLiqWalls",
 "btnAbsRev","btnStackBo","btnSweepTrap","btnLVNRej","btnWallReact","btnFP","btnAbsorb","btnDOMDepth"].forEach(id => {
  const el = document.getElementById(id); if (!el) return;
  el.addEventListener("click", () => {
    const map = {
      btnVWAP:"showVWAP", btnPOCExt:"showPOCExtension", btnVA:"showValueArea",
      btnSHL:"showSessionHL", btnDiag:"showDiagonalImb", btnVolProfile:"showVolProfile",
      btnHVNLVN:"showHVNLVN", btnDOMImb:"showDOMImbalance", btnLiqWalls:"showLiqWalls",
      btnAbsRev:"showAbsorbReversal", btnStackBo:"showStackBreakout",
      btnSweepTrap:"showSweepTrap", btnLVNRej:"showLVNReject", btnWallReact:"showWallReaction",
      btnFP:"showFootprintText", btnAbsorb:"showAbsorptionMark", btnDOMDepth:"showDOMDepthBars"
    };
    const key = map[id]; config[key] = !config[key];
    el.classList.toggle("active", config[key]); triggerRender();
  });
});

window.addEventListener("resize", () => { app.renderer.resize(container.clientWidth, container.clientHeight); triggerRender(); });

connectWS();
