/**
 * ============================================================
 *  Hana Chart — Order Flow Setup Detection Module
 *  File: orderflow-detection.js
 *
 *  SAFE TO ADD: This file only appends new logic.
 *  It does NOT modify any existing chart rendering functions.
 *  Integration point: call processFootprint(levels) wherever
 *  your footprint data is received / updated.
 * ============================================================
 */

// ─────────────────────────────────────────────────────────────
// 1. STACKED IMBALANCE DETECTION
// ─────────────────────────────────────────────────────────────
/**
 * Detects stacked imbalances across consecutive price levels.
 *
 * A single imbalance level is where: ask > bid × 3
 * A "stacked" imbalance requires 3 or more consecutive such levels.
 *
 * @param  {Array<{price: number, bid: number, ask: number}>} levels
 * @returns {boolean} true if a stacked imbalance is detected
 *
 * @example
 * detectStackedImbalance([
 *   { price: 100, bid: 20, ask: 80 },  // ask(80) > bid(20) × 3 → YES
 *   { price: 101, bid: 15, ask: 70 },  // ask(70) > bid(15) × 3 → YES
 *   { price: 102, bid: 18, ask: 75 },  // ask(75) > bid(18) × 3 → YES
 * ]);
 * // → true  (3 consecutive levels)
 */
function detectStackedImbalance(levels) {
  if (!Array.isArray(levels) || levels.length < 3) return false;

  let consecutiveCount = 0;

  for (const level of levels) {
    const { bid, ask } = level;

    // Guard: skip malformed levels
    if (typeof bid !== "number" || typeof ask !== "number") {
      consecutiveCount = 0;
      continue;
    }

    const isImbalanced = ask > bid * 3;

    if (isImbalanced) {
      consecutiveCount++;
      // Early exit — condition met
      if (consecutiveCount >= 3) return true;
    } else {
      // Reset streak on any non-imbalanced level
      consecutiveCount = 0;
    }
  }

  return false;
}

// ─────────────────────────────────────────────────────────────
// 2. ABSORPTION DETECTION
// ─────────────────────────────────────────────────────────────
/**
 * Detects absorption at a price level.
 *
 * Absorption occurs when:
 *   - Total volume (bid + ask) > 500  →  high participation
 *   - |ask - bid| < 20               →  neither side dominates
 *
 * This signals that aggressive orders are being absorbed by
 * passive resting liquidity — a potential reversal signal.
 *
 * @param  {Array<{price: number, bid: number, ask: number}>} levels
 * @returns {boolean} true if absorption is detected on any level
 *
 * @example
 * detectAbsorption([{ price: 100, bid: 260, ask: 270 }]);
 * // → true  (total=530 > 500, |270-260|=10 < 20)
 */
function detectAbsorption(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return false;

  for (const level of levels) {
    const { bid, ask } = level;

    if (typeof bid !== "number" || typeof ask !== "number") continue;

    const totalVolume = bid + ask;
    const delta = Math.abs(ask - bid);

    const highVolume  = totalVolume > 500;
    const balanced    = delta < 20;

    if (highVolume && balanced) return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────
// 3. DELTA DIVERGENCE DETECTION
// ─────────────────────────────────────────────────────────────
/**
 * Detects delta divergence between price movement and delta movement.
 *
 * Divergence signals that the apparent price direction is NOT
 * confirmed by order flow — a high-probability reversal warning.
 *
 * @param  {number} priceMove  Positive = price moved up, Negative = down
 * @param  {number} deltaMove  Positive = delta moved up, Negative = down
 * @returns {string|null}
 *   "Bearish Divergence" | "Bullish Divergence" | null (no divergence)
 *
 * @example
 * detectDeltaDivergence(+10, -5);  // → "Bearish Divergence"
 * detectDeltaDivergence(-8,  +3);  // → "Bullish Divergence"
 * detectDeltaDivergence(+5,  +2);  // → null
 */
function detectDeltaDivergence(priceMove, deltaMove) {
  if (typeof priceMove !== "number" || typeof deltaMove !== "number") {
    console.warn("[HanaChart] detectDeltaDivergence: expected numbers, got", priceMove, deltaMove);
    return null;
  }

  const priceUp  = priceMove > 0;
  const priceDown = priceMove < 0;
  const deltaUp  = deltaMove > 0;
  const deltaDown = deltaMove < 0;

  // Price up + delta down → selling pressure hiding beneath rising price
  if (priceUp && deltaDown) return "Bearish Divergence";

  // Price down + delta up → buying pressure absorbing falling price
  if (priceDown && deltaUp) return "Bullish Divergence";

  // No divergence (both move in same direction, or one is flat)
  return null;
}

// ─────────────────────────────────────────────────────────────
// 4. SETUP DISPLAY PANEL
// ─────────────────────────────────────────────────────────────
/**
 * Inserts a new setup alert into the #setupList panel.
 *
 * Each entry is prepended (newest at top) and includes a
 * timestamp so the trader knows exactly when it fired.
 *
 * @param  {string} text   Human-readable setup description
 * @param  {string} [type] Optional: "long" | "short" | "warning" | "info"
 *                         Used to colour-code the entry.
 * @returns {void}
 *
 * @example
 * addSetup("LONG Setup: Stacked Imbalance", "long");
 * addSetup("Absorption Detected", "warning");
 */
function addSetup(text, type = "info") {
  const panel = document.getElementById("setupList");

  if (!panel) {
    // Fail gracefully — don't crash the chart if the panel isn't rendered yet
    console.warn("[HanaChart] addSetup: #setupList element not found. Setup skipped:", text);
    return;
  }

  // Build the alert element
  const item = document.createElement("div");
  item.classList.add("setup-item", `setup-item--${type}`);

  // Timestamp (HH:MM:SS)
  const now = new Date();
  const ts  = now.toTimeString().slice(0, 8);

  item.innerHTML = `
    <span class="setup-item__time">${ts}</span>
    <span class="setup-item__text">${text}</span>
  `;

  // Newest alert always appears at the top
  panel.insertBefore(item, panel.firstChild);

  // Optional: cap the panel at 50 entries to prevent DOM bloat
  const MAX_ENTRIES = 50;
  const entries = panel.querySelectorAll(".setup-item");
  if (entries.length > MAX_ENTRIES) {
    panel.removeChild(entries[entries.length - 1]);
  }
}

// ─────────────────────────────────────────────────────────────
// 5. FOOTPRINT PROCESSING HOOK  ← INTEGRATION POINT
// ─────────────────────────────────────────────────────────────
/**
 * Master processing function — call this whenever new footprint
 * data arrives (websocket tick, bar close, manual refresh, etc.)
 *
 * This is the ONLY function you need to wire into your existing
 * data pipeline. Everything else is called internally.
 *
 * @param  {Array<{price: number, bid: number, ask: number}>} levels
 * @param  {{ priceMove?: number, deltaMove?: number }} [context]
 *         Optional context for delta divergence detection.
 *         Pass the bar's net price change and net delta change.
 * @returns {void}
 *
 * ── HOW TO INTEGRATE ────────────────────────────────────────
 *
 *  Option A — WebSocket feed:
 *    socket.on("footprint", (data) => {
 *      renderFootprintBar(data);        // ← your existing render call
 *      processFootprint(data.levels, { // ← ADD this line beneath it
 *        priceMove: data.closePrice - data.openPrice,
 *        deltaMove: data.closeDelta - data.openDelta,
 *      });
 *    });
 *
 *  Option B — Bar-close callback:
 *    function onBarClose(bar) {
 *      updateChart(bar);                // ← your existing function
 *      processFootprint(bar.levels);   // ← ADD this line
 *    }
 *
 *  Option C — Polling / manual trigger:
 *    setInterval(() => {
 *      const levels = getLatestLevels(); // your existing getter
 *      processFootprint(levels);
 *    }, 1000);
 *
 * ────────────────────────────────────────────────────────────
 */
function processFootprint(levels, context = {}) {
  // ── Input validation ──────────────────────────────────────
  if (!Array.isArray(levels) || levels.length === 0) {
    console.warn("[HanaChart] processFootprint: received empty or invalid levels array.");
    return;
  }

  const { priceMove = null, deltaMove = null } = context;

  // ── Run all detectors ────────────────────────────────────
  const hasStackedImbalance = detectStackedImbalance(levels);
  const hasAbsorption       = detectAbsorption(levels);
  const divergence          = (priceMove !== null && deltaMove !== null)
    ? detectDeltaDivergence(priceMove, deltaMove)
    : null;

  // ── Fire setup alerts for any detected conditions ─────────

  // Stacked Imbalance → bullish bias (ask dominates = buyers aggressive)
  if (hasStackedImbalance) {
    addSetup("🟢 LONG Setup: Stacked Imbalance", "long");
    console.log("[HanaChart] Setup detected: Stacked Imbalance");
  }

  // Absorption → price likely to reverse from current level
  if (hasAbsorption) {
    addSetup("⚡ Absorption Detected", "warning");
    console.log("[HanaChart] Setup detected: Absorption");
  }

  // Delta Divergence → directional warning
  if (divergence === "Bearish Divergence") {
    addSetup("🔴 Bearish Divergence: Price ↑ but Delta ↓", "short");
    console.log("[HanaChart] Setup detected: Bearish Divergence");
  } else if (divergence === "Bullish Divergence") {
    addSetup("🟢 Bullish Divergence: Price ↓ but Delta ↑", "long");
    console.log("[HanaChart] Setup detected: Bullish Divergence");
  }
}

// ─────────────────────────────────────────────────────────────
// 6. EXPORTS  (works in both browser globals and ES modules)
// ─────────────────────────────────────────────────────────────
if (typeof module !== "undefined" && module.exports) {
  // CommonJS / Node.js (for unit testing)
  module.exports = {
    detectStackedImbalance,
    detectAbsorption,
    detectDeltaDivergence,
    addSetup,
    processFootprint,
  };
} else if (typeof window !== "undefined") {
  // Browser globals — attach to window so existing code can call them
  window.HanaChart = window.HanaChart || {};
  Object.assign(window.HanaChart, {
    detectStackedImbalance,
    detectAbsorption,
    detectDeltaDivergence,
    addSetup,
    processFootprint,
  });
}