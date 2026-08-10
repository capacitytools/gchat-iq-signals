const nodemailer = require("nodemailer");
const store = require("./store");

const COINS = [
  { label: "BTC/USD", binance: "BTCUSDT", coinbase: "BTC-USD", kraken: "XBTUSD", okx: "BTC-USDT", bybit: "BTCUSDT", gecko: "bitcoin" },
  { label: "ETH/USD", binance: "ETHUSDT", coinbase: "ETH-USD", kraken: "ETHUSD", okx: "ETH-USDT", bybit: "ETHUSDT", gecko: "ethereum" },
  { label: "SOL/USD", binance: "SOLUSDT", coinbase: "SOL-USD", kraken: "SOLUSD", okx: "SOL-USDT", bybit: "SOLUSDT", gecko: "solana" },
  { label: "XRP/USD", binance: "XRPUSDT", coinbase: "XRP-USD", kraken: "XRPUSD", okx: "XRP-USDT", bybit: "XRPUSDT", gecko: "ripple" },
  { label: "DOGE/USD", binance: "DOGEUSDT", coinbase: "DOGE-USD", kraken: null, okx: "DOGE-USDT", bybit: "DOGEUSDT", gecko: "dogecoin" },
  { label: "EUR/USD", fx: "EURUSD=X", forex: true },
  { label: "GBP/USD", fx: "GBPUSD=X", forex: true },
  { label: "USD/JPY", fx: "USDJPY=X", forex: true },
  { label: "AUD/USD", fx: "AUDUSD=X", forex: true },
  { label: "USD/CHF", fx: "USDCHF=X", forex: true }
];

const TF_MAP = {
  "1m":  { bn: "1m",  okx: "1m",  bybit: "1",  cb: 60,   kr: 1 },
  "5m":  { bn: "5m",  okx: "5m",  bybit: "5",  cb: 300,  kr: 5 },
  "15m": { bn: "15m", okx: "15m", bybit: "15", cb: 900,  kr: 15 },
  "1h":  { bn: "1h",  okx: "1H",  bybit: "60", cb: 3600, kr: 60 }
};
const STALE_MIN = { "1m": 5, "5m": 20, "15m": 45, "1h": 150 };

function timeoutFetch(url, ms = 4000, headers) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal, headers }).finally(() => clearTimeout(t));
}

const parseBinance = d => d.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
const parseCoinbase = d => d.map(k => ({ time: +k[0] * 1000, open: +k[3], high: +k[2], low: +k[1], close: +k[4], volume: +k[5] }));
const parseKraken = d => { const r = d.result || {}; const key = Object.keys(r).find(k => k !== "last"); if (!key) throw new Error("kraken parse"); return r[key].map(k => ({ time: +k[0] * 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[6] })); };
const parseOKX = d => (d.data || []).map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
const parseBybit = d => ((d.result && d.result.list) || []).map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
const parseGecko = d => d.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: null }));
const parseYahoo = d => {
  const r = d.chart && d.chart.result && d.chart.result[0];
  if (!r || !r.timestamp) throw new Error("yahoo parse");
  const q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({ time: t * 1000, open: q.open ? q.open[i] : q.close[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume ? q.volume[i] : null }))
    .filter(x => x.close !== null && x.close !== undefined);
};

async function fetchYahoo(symbol, tf) {
  const iv = tf === "1h" ? "1h" : tf === "15m" ? "15m" : tf === "1m" ? "1m" : "5m";
  const range = tf === "1h" ? "5d" : "1d";
  const r = await timeoutFetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${iv}&range=${range}`,
    5000, { "User-Agent": "Mozilla/5.0 (Linux; Android 10)" });  if (!r.ok) throw new Error("yahoo " + r.status);
  return parseYahoo(await r.json());
}

function sourcesFor(coin, tf) {
  const m = TF_MAP[tf];
  const list = [];
  list.push({ name: "Binance", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://api.binance.com/api/v3/klines?symbol=${coin.binance}&interval=${m.bn}&limit=100`);
    if (!r.ok) throw new Error("bn " + r.status); return parseBinance(await r.json()); }});
  list.push({ name: "BinanceVision", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://data-api.binance.vision/api/v3/klines?symbol=${coin.binance}&interval=${m.bn}&limit=100`);
    if (!r.ok) throw new Error("bv " + r.status); return parseBinance(await r.json()); }});
  if (coin.okx) list.push({ name: "OKX", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://www.okx.com/api/v5/market/candles?instId=${coin.okx}&bar=${m.okx}&limit=100`);
    if (!r.ok) throw new Error("okx " + r.status); return parseOKX(await r.json()); }});
  if (coin.bybit) list.push({ name: "Bybit", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${coin.bybit}&interval=${m.bybit}&limit=100`);
    if (!r.ok) throw new Error("bybit " + r.status); return parseBybit(await r.json()); }});
  if (coin.coinbase) list.push({ name: "Coinbase", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://api.exchange.coinbase.com/products/${coin.coinbase}/candles?granularity=${m.cb}`);
    if (!r.ok) throw new Error("cb " + r.status); return parseCoinbase(await r.json()); }});
  if (coin.kraken) list.push({ name: "Kraken", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://api.kraken.com/0/public/OHLC?pair=${coin.kraken}&interval=${m.kr}`);
    if (!r.ok) throw new Error("kr " + r.status); return parseKraken(await r.json()); }});
  if (tf === "5m" && coin.gecko) list.push({ name: "CoinGecko", noVol: true, run: async () => {
    const r = await timeoutFetch(`https://api.coingecko.com/api/v3/coins/${coin.gecko}/ohlc?vs_currency=usd&days=2`);
    if (!r.ok) throw new Error("gk " + r.status); return parseGecko(await r.json()); }});
  return list;
}

const sortRows = rows => rows.slice().sort((a, b) => a.time - b.time);

async function fetchTF(coin, tf) {
  const win = await Promise.any(sourcesFor(coin, tf).map(async src => {
    const rows = sortRows(await src.run());
    if (!rows || rows.length < 55) throw new Error("short");
    if (Date.now() - rows[rows.length - 1].time > STALE_MIN[tf] * 60000) throw new Error("stale");
    return { rows, name: src.name, noVol: src.noVol };
  }));
  return win;
}

function emaLast(v, p) { if (!v || v.length < p) return null;
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; }

function rsiLast(c, p = 14) { if (!c || c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }  let ag = g / p, al = l / p;
  for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p; al = (al * (p - 1) + (d < 0 ? -d : 0)) / p; }
  if (al === 0) return 100; return 100 - 100 / (1 + ag / al); }

function atrLast(h, l, c, p = 14) { if (!h || h.length < p + 1) return null;
  const t = []; for (let i = 1; i < h.length; i++)
    t.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  if (t.length < p) return null;
  let a = t.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < t.length; i++) a = (a * (p - 1) + t[i]) / p; return a; }

const avg = v => (v && v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

/* per-timeframe analysis */
function analyzeTF(rows) {
  if (!rows || rows.length < 55) return null;
  const closes = rows.map(r => Number(r.close));
  const highs = rows.map(r => Number(r.high));
  const lows = rows.map(r => Number(r.low));
  const vols = rows.map(r => Number(r.volume || 0));
  const last = rows[rows.length - 1];

  const e9 = emaLast(closes, 9), e21 = emaLast(closes, 21), e50 = emaLast(closes, 50);
  const trend = (e9 !== null && e21 !== null && e50 !== null && e9 > e21 && e21 > e50) ? "UP"
    : (e9 !== null && e21 !== null && e50 !== null && e9 < e21 && e21 < e50) ? "DOWN" : "NONE";

  const rsi = rsiLast(closes, 14);
  const atr = atrLast(highs, lows, closes, 14);
  const atrPct = atr && last.close ? (atr / last.close) * 100 : 0;

  const avgVol = avg(vols.slice(-21, -1));
  const volRatio = avgVol > 0 ? vols[vols.length - 1] / avgVol : 0;

  const body = last.close - last.open;
  const range = (last.high - last.low) || 1;
  const bodyRatio = Math.abs(body) / range;

  const pullUp = (last.close - e21) > -0.6 * atr && (last.close - e21) < 0.8 * atr;
  const resumeUp = last.close > e9;
  const setupUp = trend === "UP" && (pullUp || (rsi !== null && rsi >= 38 && rsi <= 56)) && resumeUp;

  const pullDn = (e21 - last.close) > -0.6 * atr && (e21 - last.close) < 0.8 * atr;
  const resumeDn = last.close < e9;
  const setupDown = trend === "DOWN" && (pullDn || (rsi !== null && rsi >= 44 && rsi <= 62)) && resumeDn;

  const trigUp = body > 0 && (volRatio > 1.1 || bodyRatio > 0.5);
  const trigDown = body < 0 && (volRatio > 1.1 || bodyRatio > 0.5);

  return { trend, rsi, atrPct, volRatio, setupUp, setupDown, trigUp, trigDown, close: last.close };}

/* old single-TF analyze (forex) */
function analyze(rows, allowNoVolume, forex) {
  if (!rows || rows.length < 55) return { good: false, direction: "WAIT", confidence: 0, price: 0 };
  const closes = rows.map(r => Number(r.close));
  const highs = rows.map(r => Number(r.high));
  const lows = rows.map(r => Number(r.low));
  const vols = rows.map(r => Number(r.volume || 0));
  const last = closes[closes.length - 1] || 0;
  const e9 = emaLast(closes, 9), e21 = emaLast(closes, 21), e50 = emaLast(closes, 50);
  const trendUp = e9 !== null && e21 !== null && e50 !== null && e9 > e21 && e21 > e50;
  const trendDown = e9 !== null && e21 !== null && e50 !== null && e9 < e21 && e21 < e50;
  const rsi = rsiLast(closes, 14);
  const atr = atrLast(highs, lows, closes, 14);
  const atrPct = atr && last ? (atr / last) * 100 : 0;
  const avgVol = avg(vols.slice(-21, -1));
  const curVol = vols[vols.length - 1] || 0;
  const volumeOk = allowNoVolume ? true : (avgVol > 0 && curVol >= avgVol * 0.8);
  const volatilityOk = forex ? (atrPct >= 0.008 && atrPct <= 0.6) : (atrPct >= 0.04 && atrPct <= 3.0);
  const momentumOk = trendUp ? (rsi !== null && rsi >= 50 && rsi <= 73) : trendDown ? (rsi !== null && rsi <= 50 && rsi >= 27) : false;
  const good = Boolean((trendUp || trendDown) && momentumOk && volumeOk && volatilityOk);
  const direction = good ? (trendUp ? "BUY" : "SELL") : "WAIT";
  let conf = 48;
  if (trendUp || trendDown) conf += 12;
  if (momentumOk) conf += 14;
  if (volumeOk) conf += 8;
  if (volatilityOk) conf += 8;
  return { good, direction, confidence: Math.min(93, Math.round(conf)), rsi: rsi ? Math.round(rsi) : 0, atrPct: Number(atrPct.toFixed(4)), price: last };
}

async function checkCoin(coin) {
  /* FOREX: simple 5m path */
  if (coin.forex) {
    try {
      const w = await fetchTF(coin, "5m");
      const a = analyze(w.rows, true, true);
      return { symbol: coin.label, source: w.name, ...a,
        mtf: { h1: "-", m15: "-", m5: "-", m1: "-" }, volUp: false, atrUp: false, score: Number(a.atrPct || 0) };
    } catch (e) {
      return { symbol: coin.label, good: false, direction: "WAIT", confidence: 0, error: "feeds failed", mtf: {}, score: 0 };
    }
  }

  /* CRYPTO: 1H → 15M → 5M → 1M */
  try {
    const [w1, w15, w5, w1m] = await Promise.all([
      fetchTF(coin, "1h"), fetchTF(coin, "15m"), fetchTF(coin, "5m"), fetchTF(coin, "1m")
    ]);
    const a1 = analyzeTF(w1.rows), a15 = analyzeTF(w15.rows), a5 = analyzeTF(w5.rows), am = analyzeTF(w1m.rows);    if (!a1 || !a15 || !a5 || !am) throw new Error("analyze");

    const dirUp = a1.trend === "UP" && a15.trend === "UP";
    const dirDn = a1.trend === "DOWN" && a15.trend === "DOWN";
    const setupOk = dirUp ? a5.setupUp : dirDn ? a5.setupDown : false;
    const trigOk = dirUp ? am.trigUp : dirDn ? am.trigDown : false;
    const volUp = a5.volRatio > 1.25;
    const atrUp = a15.atrPct > 0.10;

    let conf = 40;
    if (a1.trend !== "NONE") conf += 12;
    if (dirUp || dirDn) conf += 12;
    if (setupOk) conf += 16;
    if (trigOk) conf += 14;
    if (volUp) conf += 6;
    if (atrUp) conf += 6;
    conf = Math.min(95, conf);

    const good = (dirUp || dirDn) && setupOk && trigOk;
    const direction = good ? (dirUp ? "BUY" : "SELL") : "WAIT";

    return {
      symbol: coin.label, source: w5.name, price: a5.close, direction, confidence: conf, good,
      rsi: Math.round(a5.rsi || 0), atrPct: Number(a15.atrPct.toFixed(3)),
      mtf: { h1: a1.trend, m15: a15.trend, m5: setupOk ? "OK" : "--", m1: trigOk ? "OK" : "--" },
      volUp, atrUp, score: Number((a5.volRatio + a15.atrPct * 8).toFixed(2))
    };
  } catch (e) {
    return { symbol: coin.label, good: false, direction: "WAIT", confidence: 0, error: "feeds failed", mtf: {}, score: 0 };
  }
}

async function fetchPriceAt(coin, tsMs) {
  try {
    const w = await fetchTF(coin, "5m");
    const rows = w.rows;
    const step = rows.length > 1 ? Math.abs(rows[1].time - rows[0].time) : 300000;
    const target = rows.find(r => r.time <= tsMs && r.time + step > tsMs);
    if (target) return target.close;
    let best = null, bestDiff = Infinity;
    for (const r of rows) { const d = Math.abs(r.time + step / 2 - tsMs); if (d < bestDiff) { bestDiff = d; best = r; } }
    return best && bestDiff <= 2 * step ? best.close : null;
  } catch (e) { return null; }
}

function buildSignal(a) {
  const entry = new Date(); entry.setSeconds(0, 0); entry.setMinutes(entry.getMinutes() + 1);
  const expiry = new Date(entry.getTime() + 5 * 60000);
  return {
    id: entry.getTime() + "-" + a.symbol.replace("/", "-"),    symbol: a.symbol, direction: a.direction, confidence: a.confidence,
    source: a.source || "feed", timeframe: "5m", mtf: a.mtf || {},
    entryTime: entry.toISOString(), expiryTime: expiry.toISOString(),
    entryPrice: a.price, expiryPrice: null, status: "pending"
  };
}

function stats(signals) {
  const wins = signals.filter(s => s.status === "win").length;
  const losses = signals.filter(s => s.status === "loss").length;
  const pending = signals.filter(s => s.status === "pending").length;
  const decided = wins + losses;
  return { total: signals.length, wins, losses, pending,
    winRate: decided ? Math.round((wins / decided) * 100) : 0 };
}

const arr = v => v === "UP" ? "⬆" : v === "DOWN" ? "⬇" : "–";

function formatTime(d) {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit",
    timeZone: process.env.TIME_ZONE || "UTC" });
}

async function sendSignalEmail(newSignals, allGood) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return false;
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  const now = new Date();
  const blocks = (newSignals.length ? newSignals : allGood).map(s => {
    const e = new Date(s.entryTime);
    const l1 = new Date(e.getTime() + 5 * 60000), l2 = new Date(e.getTime() + 10 * 60000), l3 = new Date(e.getTime() + 15 * 60000);
    const mtfLine = s.mtf && s.mtf.h1 && s.mtf.h1 !== "-"
      ? `<br>🧭 1H ${arr(s.mtf.h1)} • 15M ${arr(s.mtf.m15)} • 5M ${s.mtf.m5 === "OK" ? "✔" : "–"} • 1M ${s.mtf.m1 === "OK" ? "⚡" : "–"}`
      : "";
    return `<div style="border:1px solid #eee;border-radius:8px;padding:12px;margin-bottom:10px;">
      <b>🚨 TRADE NOW!!</b><br>📊 ${s.symbol}<br>⏱ Timeframe: 5-min expiry<br>
      🤖 AI Confidence: ${s.confidence}%<br>🕰 Entry: ${formatTime(e)}<br>
      📈 Direction: ${s.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"}${mtfLine}<br><br>
      📊 Martingale Levels:<br>• Level 1 → ${formatTime(l1)}<br>• Level 2 → ${formatTime(l2)}<br>• Level 3 → ${formatTime(l3)}
    </div>`;
  }).join("");

  await transporter.sendMail({
    from: `"G-Chat IQ Signals" <${process.env.GMAIL_USER}>`,
    to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
    subject: `🚨 NEW SIGNAL ${newSignals[0] ? newSignals[0].symbol + " " + newSignals[0].direction : ""} — ${formatTime(now)}`,
    html: `<div style="font-family:Arial;max-width:600px;margin:0 auto;">
      <div style="background:#075E54;color:#fff;padding:14px;border-radius:8px;"><h2 style="margin:0;">G-Chat IQ Signals</h2></div>      <div style="padding:14px;">${blocks}
      <p style="color:#667781;font-size:12px;">Educational only. Not financial advice.</p></div></div>`
  });
  return true;
}

async function run({ email = false, force = false, checkOnly = false } = {}) {
  const file = "signals.json";
  const { data, sha } = await store.readJSON(file, { signals: [], meta: {} });
  const signals = data.signals || [];
  const meta = data.meta || {};

  let enabledMap = {};
  try {
    const s = await store.readJSON("settings.json", { enabled: {} });
    enabledMap = (s.data && s.data.enabled) || {};
  } catch (e) { enabledMap = {}; }
  const isOn = sym => enabledMap[sym] !== false;

  let changed = false;
  for (const s of signals) {
    if (s.status !== "pending") continue;
    if (new Date(s.expiryTime).getTime() > Date.now()) continue;
    const coin = COINS.find(c => c.label === s.symbol);
    if (!coin) { s.status = "loss"; changed = true; continue; }
    const p = await fetchPriceAt(coin, new Date(s.expiryTime).getTime());
    if (p == null) continue;
    s.expiryPrice = p;
    s.status = (s.direction === "BUY" ? p > s.entryPrice : p < s.entryPrice) ? "win" : "loss";
    changed = true;
  }

  const assets = await Promise.all(COINS.map(checkCoin));
  const minConf = parseInt(process.env.MIN_CONFIDENCE || "75", 10);
  const goodAssets = assets.filter(a => a.good && a.confidence >= minConf && isOn(a.symbol));

  let newSignals = [];
  if (!checkOnly) {
    for (const a of goodAssets) {
      const sig = buildSignal(a);
      if (!signals.some(x => x.id === sig.id)) { newSignals.push(sig); signals.unshift(sig); changed = true; }
    }
    if (signals.length > 300) signals.length = 300;
  }

  let emailed = false;
  const cooldown = 15 * 60 * 1000;
  if (!checkOnly && (force || (newSignals.length && Date.now() - (meta.lastEmailAt || 0) > cooldown))) {
    emailed = await sendSignalEmail(newSignals, goodAssets).catch(() => false);
    if (emailed) meta.lastEmailAt = Date.now();    changed = true;
  }

  if (changed || checkOnly === false) {
    await store.writeJSON(file, { signals, meta }, sha);
  }

  return { assets, goodAssets, newSignals, stats: stats(signals), emailed, minConf, enabled: enabledMap };
}

module.exports = { run, stats };