// indicators.js
// Unified Trading Dashboard - Heatmap + DOM + CVD + Tape
// Optimized version with robust WS handling, dynamic tick sizes, and better rendering.

// ==================== CONFIGS ====================
const SYMBOL_CONFIGS = {
    "BTCUSDT": { tickSize: 0.1, priceWindow: 100, heatmapMax: 500 },
    "ETHUSDT": { tickSize: 0.01, priceWindow: 20, heatmapMax: 2000 },
    "SOLUSDT": { tickSize: 0.01, priceWindow: 2, heatmapMax: 5000 },
    "BNBUSDT": { tickSize: 0.1, priceWindow: 5, heatmapMax: 1000 },
    "XRPUSDT": { tickSize: 0.0001, priceWindow: 0.02, heatmapMax: 1000000 },
    "DEFAULT": { tickSize: 0.1, priceWindow: 100, heatmapMax: 1000 }
};

// ==================== SHARED ORDERBOOK ====================
class SharedOrderBook {
    constructor(symbol = "BTCUSDT") {
        this.symbol = symbol.toUpperCase();
        this.bids = new Map();
        this.asks = new Map();
        this.lastPrice = 0;

        this.lastUpdateId = null;
        this.bufferedDepthEvents = [];
        this.snapshotReady = false;
    }

    applySnapshot(snapshot) {
        this.bids.clear();
        this.asks.clear();

        snapshot.bids.forEach(([p, q]) => {
            const price = parseFloat(p);
            const size = parseFloat(q);
            if (size > 0) this.bids.set(price, size);
        });

        snapshot.asks.forEach(([p, q]) => {
            const price = parseFloat(p);
            const size = parseFloat(q);
            if (size > 0) this.asks.set(price, size);
        });

        this.lastUpdateId = snapshot.lastUpdateId;
        this.snapshotReady = true;

        // Apply buffered events
        const toApply = this.bufferedDepthEvents.filter(ev => ev.u > this.lastUpdateId);
        toApply.sort((a, b) => a.U - b.U);
        toApply.forEach(ev => this.applyDepthEvent(ev, true));
        this.bufferedDepthEvents = [];

        console.log(`[OrderBook] Snapshot applied for ${this.symbol}. LastUpdateId: ${this.lastUpdateId}`);
    }

    applyDepthEvent(event, fromBuffer = false) {
        const { U, u, b, a } = event;

        if (!this.snapshotReady) {
            this.bufferedDepthEvents.push(event);
            return;
        }

        if (u <= this.lastUpdateId) return;

        // Apply updates
        if (Array.isArray(b)) {
            b.forEach(([p, q]) => {
                const price = parseFloat(p);
                const size = parseFloat(q);
                if (size === 0) this.bids.delete(price);
                else this.bids.set(price, size);
            });
        }
        if (Array.isArray(a)) {
            a.forEach(([p, q]) => {
                const price = parseFloat(p);
                const size = parseFloat(q);
                if (size === 0) this.asks.delete(price);
                else this.asks.set(price, size);
            });
        }

        this.lastUpdateId = u;
    }
}

// ==================== SHARED TRADES ====================
class SharedTrades {
    constructor() {
        this.tradesAtPrice = new Map(); // price -> cumulative volume
        this.currentCVD = 0;
        this.buyVolume = 0;
        this.sellVolume = 0;
        this.series = [];
        this.maxPoints = 500;

        this.tapeTrades = [];
        this.maxTapeTrades = 50;
        this.tradeTimes = [];
    }

    recordTrade(priceStr, sizeStr, isBuyerMaker) {
        const price = parseFloat(priceStr);
        const size = parseFloat(sizeStr);

        if (isBuyerMaker) this.sellVolume += size;
        else this.buyVolume += size;

        const currentVol = this.tradesAtPrice.get(price) || 0;
        this.tradesAtPrice.set(price, currentVol + size);

        const trade = {
            price,
            size,
            side: isBuyerMaker ? "sell" : "buy",
            time: Date.now(),
            large: size > 0.5 // Threshold for large trades
        };

        this.tapeTrades.unshift(trade);
        if (this.tapeTrades.length > this.maxTapeTrades) this.tapeTrades.pop();

        this.tradeTimes.push(Date.now());
        const oneSecAgo = Date.now() - 1000;
        while (this.tradeTimes.length > 0 && this.tradeTimes[0] < oneSecAgo) {
            this.tradeTimes.shift();
        }
    }

    finalizeCVDInterval() {
        const delta = this.buyVolume - this.sellVolume;
        this.currentCVD += delta;
        this.series.push({ time: Date.now(), value: this.currentCVD });
        if (this.series.length > this.maxPoints) this.series.shift();
        this.buyVolume = 0;
        this.sellVolume = 0;
    }

    getVolumeAtPrice(price) {
        return this.tradesAtPrice.get(price) || 0;
    }

    clearOldTrades() {
        // Optional: clear trades every N minutes to keep DOM fresh
        // For now we keep them to show historical volume at price
    }
}

// ==================== HEATMAP ====================
class HeatmapEngine {
    constructor(orderbook, config) {
        this.orderbook = orderbook;
        this.config = config;
        this.frames = [];
        this.maxFrames = 400;
    }

    captureFrame() {
        const frameData = new Map();
        
        // Combine bids and asks for the heatmap
        this.orderbook.bids.forEach((size, price) => {
            frameData.set(price, { size, side: 'bid' });
        });
        this.orderbook.asks.forEach((size, price) => {
            frameData.set(price, { size, side: 'ask' });
        });

        this.frames.push({
            time: Date.now(),
            data: frameData
        });

        if (this.frames.length > this.maxFrames) this.frames.shift();
    }
}

class HeatmapRenderer {
    constructor(canvas, orderbook, engine) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d", { alpha: false });
        this.orderbook = orderbook;
        this.engine = engine;
    }

    getColor(size) {
        const max = this.engine.config.heatmapMax || 1000;
        const intensity = Math.min(1, Math.log(size + 1) / Math.log(max));
        const r = Math.floor(255 * intensity);
        const g = Math.floor(180 * intensity);
        const b = Math.floor(50 * intensity);
        return `rgb(${r},${g},${b})`;
    }

    render() {
        const { frames, config } = this.engine;
        const { ctx, canvas, orderbook } = this;
        const { width, height } = canvas;

        ctx.fillStyle = "#050810";
        ctx.fillRect(0, 0, width, height);

        if (frames.length === 0 || !orderbook.lastPrice) return;

        const centerPrice = orderbook.lastPrice;
        const minPrice = centerPrice - config.priceWindow;
        const maxPrice = centerPrice + config.priceWindow;
        const priceRange = maxPrice - minPrice;

        const frameWidth = width / this.engine.maxFrames;
        const xOffset = width - (frames.length * frameWidth);

        frames.forEach((frame, i) => {
            const x = xOffset + (i * frameWidth);
            frame.data.forEach((val, price) => {
                if (price < minPrice || price > maxPrice) return;

                const normY = (price - minPrice) / priceRange;
                const y = height - (normY * height);
                const cellH = Math.max(1, (config.tickSize / priceRange) * height);

                ctx.fillStyle = this.getColor(val.size);
                ctx.fillRect(x, y - cellH, Math.ceil(frameWidth), Math.ceil(cellH));
            });
        });
        
        // Draw last price line
        const lastPriceNormY = (centerPrice - minPrice) / priceRange;
        const lastPriceY = height - (lastPriceNormY * height);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(0, lastPriceY);
        ctx.lineTo(width, lastPriceY);
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

// ==================== DOM LADDER ====================
class DOMLadder {
    constructor(orderbook, trades, config) {
        this.orderbook = orderbook;
        this.trades = trades;
        this.config = config;
        this.range = 30; // 30 ticks up/down
    }

    build() {
        const center = this.orderbook.lastPrice;
        const tick = this.config.tickSize;
        const alignedCenter = Math.round(center / tick) * tick;
        const rows = [];

        for (let i = this.range; i >= -this.range; i--) {
            const price = parseFloat((alignedCenter + (i * tick)).toFixed(8));
            rows.push({
                price,
                bid: this.orderbook.bids.get(price) || 0,
                ask: this.orderbook.asks.get(price) || 0,
                traded: this.trades.getVolumeAtPrice(price)
            });
        }
        return rows;
    }
}

class DOMRenderer {
    constructor(container) {
        this.container = container;
    }

    render(rows, lastPrice) {
        let html = `<div class="dom-row" style="font-weight:bold; border-bottom:1px solid #333; opacity:0.6;">
            <div class="dom-trades">VOL</div>
            <div class="dom-bid">BID</div>
            <div class="dom-price">PRICE</div>
            <div class="dom-ask">ASK</div>
        </div>`;

        rows.forEach(r => {
            const isCurrent = Math.abs(r.price - lastPrice) < 0.00000001 ? " dom-current" : "";
            const bidStr = r.bid ? r.bid.toFixed(2) : "";
            const askStr = r.ask ? r.ask.toFixed(2) : "";
            const tradedStr = r.traded ? Math.floor(r.traded) : "";

            html += `<div class="dom-row${isCurrent}">
                <div class="dom-trades">${tradedStr}</div>
                <div class="dom-bid">${bidStr}</div>
                <div class="dom-price">${r.price}</div>
                <div class="dom-ask">${askStr}</div>
            </div>`;
        });
        this.container.innerHTML = html;
    }
}

// ==================== CVD RENDERER ====================
class CVDRenderer {
    constructor(canvas, trades) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.trades = trades;
    }

    render() {
        const series = this.trades.series;
        const { ctx, canvas } = this;
        const { width, height } = canvas;

        ctx.clearRect(0, 0, width, height);
        if (series.length < 2) return;

        let min = Infinity, max = -Infinity;
        series.forEach(p => {
            if (p.value < min) min = p.value;
            if (p.value > max) max = p.value;
        });
        const range = max - min || 1;
        const stepX = width / (this.trades.maxPoints - 1);
        const xOffset = width - (series.length * stepX);

        ctx.beginPath();
        series.forEach((p, i) => {
            const x = xOffset + (i * stepX);
            const y = height - ((p.value - min) / range * height);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = "#00ffcc";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Label
        ctx.fillStyle = "#00ffcc";
        ctx.font = "10px monospace";
        ctx.fillText(`CVD: ${Math.round(this.trades.currentCVD)}`, 10, 20);
    }
}

// ==================== TAPE RENDERER ====================
class TapeRenderer {
    constructor(container, trades) {
        this.container = container;
        this.trades = trades;
    }

    render() {
        const trades = this.trades.tapeTrades;
        const tps = this.trades.tradeTimes.length;

        let html = `<div style="padding:4px; font-size:10px; color:#666; border-bottom:1px solid #222;">
            TAPE | SPEED: ${tps} t/s
        </div>`;

        trades.forEach(t => {
            const color = t.side === "buy" ? "#00ff88" : "#ff4444";
            const weight = t.large ? "bold" : "normal";
            const timeStr = new Date(t.time).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            
            html += `<div class="tape-row" style="color:${color}; font-weight:${weight}; font-size:11px;">
                <div class="tape-time" style="color:#555">${timeStr}</div>
                <div class="tape-price">${t.price}</div>
                <div class="tape-size">${t.size.toFixed(3)}</div>
            </div>`;
        });
        this.container.innerHTML = html;
    }
}

// ==================== TRADING DASHBOARD (MAIN) ====================
class TradingDashboard {
    constructor(config) {
        this.config = config;
        this.symbol = (document.getElementById("symSel")?.value || "BTCUSDT").toUpperCase();
        this.symConfig = SYMBOL_CONFIGS[this.symbol] || SYMBOL_CONFIGS["DEFAULT"];

        this.orderbook = new SharedOrderBook(this.symbol);
        this.trades = new SharedTrades();

        // Components
        this.heatmapEngine = new HeatmapEngine(this.orderbook, this.symConfig);
        this.heatmapRenderer = new HeatmapRenderer(config.heatmapCanvas, this.orderbook, this.heatmapEngine);
        this.domLadder = new DOMLadder(this.orderbook, this.trades, this.symConfig);
        this.domRenderer = new DOMRenderer(config.domContainer);
        this.cvdRenderer = new CVDRenderer(config.cvdCanvas, this.trades);
        this.tapeRenderer = new TapeRenderer(config.tapeContainer, this.trades);

        this.lastFrameTime = 0;
        this.lastCVDTime = 0;
        this.lastHeatmapCaptureTime = 0;

        this.init();
        this.setupSymbolListener();
    }

    setupSymbolListener() {
        const sel = document.getElementById("symSel");
        if (!sel) return;
        sel.addEventListener("change", (e) => {
            console.log("Symbol changed to:", e.target.value);
            location.reload(); // Simplest way to re-init everything safely
        });
    }

    async init() {
        await this.loadSnapshot();
        this.connectDepthWS();
        this.connectTradeWS();
        this.startLoop();
    }

    async loadSnapshot() {
        try {
            const url = `https://fapi.binance.com/fapi/v1/depth?symbol=${this.symbol}&limit=1000`;
            const res = await fetch(url);
            const data = await res.json();
            if (data.lastUpdateId) {
                this.orderbook.applySnapshot(data);
                if (data.bids.length > 0 && data.asks.length > 0) {
                    this.orderbook.lastPrice = (parseFloat(data.bids[0][0]) + parseFloat(data.asks[0][0])) / 2;
                }
            }
        } catch (e) {
            console.error("Snapshot error:", e);
        }
    }

    connectDepthWS() {
        const ws = new WebSocket(`wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@depth@100ms`);
        ws.onmessage = (e) => {
            const d = JSON.parse(e.data);
            this.orderbook.applyDepthEvent({ U: d.U, u: d.u, b: d.b, a: d.a });
        };
        ws.onclose = () => setTimeout(() => this.connectDepthWS(), 2000);
    }

    connectTradeWS() {
        const ws = new WebSocket(`wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@trade`);
        ws.onmessage = (e) => {
            const d = JSON.parse(e.data);
            this.orderbook.lastPrice = parseFloat(d.p);
            this.trades.recordTrade(d.p, d.q, d.m);
        };
        ws.onclose = () => setTimeout(() => this.connectTradeWS(), 2000);
    }

    startLoop() {
        const animate = (now) => {
            // Heatmap capture (4 times per second)
            if (now - this.lastHeatmapCaptureTime > 250) {
                this.heatmapEngine.captureFrame();
                this.lastHeatmapCaptureTime = now;
            }

            // CVD finalizing (twice per second)
            if (now - this.lastCVDTime > 500) {
                this.trades.finalizeCVDInterval();
                this.cvdRenderer.render();
                this.lastCVDTime = now;
            }

            // Render all (60fps if possible, but limited by browser)
            this.heatmapRenderer.render();
            
            if (this.orderbook.lastPrice) {
                const rows = this.domLadder.build();
                this.domRenderer.render(rows, this.orderbook.lastPrice);
            }
            
            this.tapeRenderer.render();

            requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }
}

// ==================== GLOBAL INIT ====================
window.startTradingDashboard = function(config) {
    return new TradingDashboard(config);
};
