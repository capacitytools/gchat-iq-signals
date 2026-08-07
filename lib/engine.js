const nodemailer = require("nodemailer");
const store = require("./store");

const COINS = [
  { label: "BTC/USD", binance: "BTCUSDT", coinbase: "BTC-USD", kraken: "XBTUSD", gecko: "bitcoin" },
  { label: "BNB/USD", binance: "BNBUSDT", coinbase: null, kraken: null, gecko: "binancecoin" },
  { label: "ETH/USD", binance: "ETHUSDT", coinbase: "ETH-USD", kraken: "ETHUSD", gecko: "ethereum" },
  { label: "SOL/USD", binance: "SOLUSDT", coinbase: "SOL-USD", kraken: "SOLUSD", gecko: "solana" },
  { label: "XRP/USD", binance: "XRPUSDT", coinbase: "XRP-USD", kraken: "XRPUSD", gecko: "ripple" }
];

function timeoutFetch(url, ms = 4000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
}

const parseBinance = d => d.map(k => ({ time: +k[0], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
const parseCoinbase = d => d.map(k => ({ time: +k[0] * 1000, high: +k[2], low: +k[1], close: +k[4], volume: +k[5] }));
const parseKraken = d => {
  const r = d.result || {};
  const key = Object.keys(r).find(k => k !== "last");
  if (!key) throw new Error("kraken parse");
  return r[key].map(k => ({ time: +k[0] * 1000, high: +k[2], low: +k[3], close: +k[4], volume: +k[6] }));
};
const parseGecko = d => d.map(k => ({ time: +k[0], high: +k[2], low: +k[3], close: +k[4], volume: null }));

function sourcesFor(coin) {
  const list = [];
  if (coin.coinbase) list.push({ name: "Coinbase", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://api.exchange.coinbase.com/products/${coin.coinbase}/candles?granularity=300`);
    if (!r.ok) throw new Error("cb " + r.status); return parseCoinbase(await r.json()); }});
  if (coin.kraken) list.push({ name: "Kraken", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://api.kraken.com/0/public/OHLC?pair=${coin.kraken}&interval=5`);
    if (!r.ok) throw new Error("kr " + r.status); return parseKraken(await r.json()); }});
  list.push({ name: "Binance", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://api.binance.com/api/v3/klines?symbol=${coin.binance}&interval=5m&limit=100`);
    if (!r.ok) throw new Error("bn " + r.status); return parseBinance(await r.json()); }});
  list.push({ name: "BinanceVision", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://data-api.binance.vision/api/v3/klines?symbol=${coin.binance}&interval=5m&limit=100`);
    if (!r.ok) throw new Error("bv " + r.status); return parseBinance(await r.json()); }});
  list.push({ name: "CoinGecko", noVol: true, run: async () => {
    const r = await timeoutFetch(`https://api.coingecko.com/api/v3/coins/${coin.gecko}/ohlc?vs_currency=usd&days=2`);
    if (!r.ok) throw new Error("gk " + r.status); return parseGecko(await r.json()); }});
  return list;
}

function emaLast(v, p) { if (!v || v.length < p) return null;
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p; const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; }
function rsiLast(c, p = 14) { if (!c || c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / p, al = l / p;
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

function analyze(rows, allowNoVolume) {
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
  const volatilityOk = atrPct >= 0.04 && atrPct <= 3.0;
  const momentumOk = trendUp ? (rsi !== null && rsi >= 50 && rsi <= 73)
    : trendDown ? (rsi !== null && rsi <= 50 && rsi >= 27) : false;

  const good = Boolean((trendUp || trendDown) && momentumOk && volumeOk && volatilityOk);
  const direction = good ? (trendUp ? "BUY" : "SELL") : "WAIT";

  let conf = 48;
  if (trendUp || trendDown) conf += 12;
  if (momentumOk) conf += 14;
  if (volumeOk) conf += 8;
  if (volatilityOk) conf += 8;
  if (trendUp && rsi && rsi >= 55 && rsi <= 68) conf += 6;  if (trendDown && rsi && rsi <= 45 && rsi >= 32) conf += 6;

  return { good, direction, confidence: Math.min(93, Math.round(conf)),
    rsi: rsi ? Math.round(rsi) : 0, atrPct: Number(atrPct.toFixed(4)), price: last };
}

async function checkCoin(coin) {
  try {
    const win = await Promise.any(sourcesFor(coin).map(async src => {
      const rows = await src.run();
      if (!rows || rows.length < 55) throw new Error("short");
      return { src, rows };
    }));
    return { symbol: coin.label, source: win.src.name, ...analyze(win.rows, win.src.noVol) };
  } catch (e) {
    return { symbol: coin.label, good: false, direction: "WAIT", confidence: 0, error: "all feeds failed" };
  }
}

async function fetchPriceAt(coin, tsMs) {
  try {
    const rows = await Promise.any(sourcesFor(coin).map(async src => {
      const r = await src.run();
      if (!r || !r.length) throw new Error("short");
      return r;
    }));
    const target = rows.find(r => r.time <= tsMs && r.time + 300000 > tsMs);
    if (target) return target.close;
    let best = null, bestDiff = Infinity;
    for (const r of rows) {
      const d = Math.abs(r.time + 150000 - tsMs);
      if (d < bestDiff) { bestDiff = d; best = r; }
    }
    return best && bestDiff <= 10 * 60000 ? best.close : null;
  } catch (e) { return null; }
}

function buildSignal(a) {
  const entry = new Date(); entry.setSeconds(0, 0); entry.setMinutes(entry.getMinutes() + 1);
  const expiry = new Date(entry.getTime() + 5 * 60000);
  return {
    id: entry.getTime() + "-" + a.symbol.replace("/", "-"),
    symbol: a.symbol, direction: a.direction, confidence: a.confidence,
    source: a.source || "feed", timeframe: "5m",
    entryTime: entry.toISOString(), expiryTime: expiry.toISOString(),
    entryPrice: a.price, expiryPrice: null, status: "pending"
  };
}

function stats(signals) {  const wins = signals.filter(s => s.status === "win").length;
  const losses = signals.filter(s => s.status === "loss").length;
  const pending = signals.filter(s => s.status === "pending").length;
  const decided = wins + losses;
  return { total: signals.length, wins, losses, pending,
    winRate: decided ? Math.round((wins / decided) * 100) : 0 };
}

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
    return `<div style="border:1px solid #eee;border-radius:8px;padding:12px;margin-bottom:10px;">
      <b>🚨 TRADE NOW!!</b><br>📊 ${s.symbol}<br>⏱ Timeframe: 5-min expiry<br>
      🤖 AI Confidence: ${s.confidence}%<br>🕰 Entry: ${formatTime(e)}<br>
      📈 Direction: ${s.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"}<br><br>
      📊 Martingale Levels:<br>• Level 1 → ${formatTime(l1)}<br>• Level 2 → ${formatTime(l2)}<br>• Level 3 → ${formatTime(l3)}
    </div>`;
  }).join("");

  await transporter.sendMail({
    from: `"G-Chat IQ Signals" <${process.env.GMAIL_USER}>`,
    to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
    subject: `🚨 NEW SIGNAL ${newSignals[0] ? newSignals[0].symbol + " " + newSignals[0].direction : ""} — ${formatTime(now)}`,
    html: `<div style="font-family:Arial;max-width:600px;margin:0 auto;">
      <div style="background:#075E54;color:#fff;padding:14px;border-radius:8px;"><h2 style="margin:0;">G-Chat IQ Signals</h2></div>
      <div style="padding:14px;">${blocks}
      <p style="color:#667781;font-size:12px;">Educational only. Not financial advice.</p></div></div>`
  });
  return true;
}

async function run({ email = false, force = false, checkOnly = false } = {}) {
  const file = "signals.json";
  const { data, sha } = await store.readJSON(file, { signals: [], meta: {} });
  const signals = data.signals || [];
  const meta = data.meta || {};

  /* auto evaluate expired signals */  let changed = false;
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

  /* scan market */
  const assets = await Promise.all(COINS.map(checkCoin));
  const minConf = parseInt(process.env.MIN_CONFIDENCE || "75", 10);
  const goodAssets = assets.filter(a => a.good && a.confidence >= minConf);

  let newSignals = [];
  if (!checkOnly) {
    for (const a of goodAssets) {
      const sig = buildSignal(a);
      if (!signals.some(x => x.id === sig.id)) { newSignals.push(sig); signals.unshift(sig); changed = true; }
    }
    if (signals.length > 300) signals.length = 300;
  }

  /* email with 15-min cooldown */
  let emailed = false;
  const cooldown = 15 * 60 * 1000;
  if (!checkOnly && (force || (newSignals.length && Date.now() - (meta.lastEmailAt || 0) > cooldown))) {
    emailed = await sendSignalEmail(newSignals, goodAssets).catch(() => false);
    if (emailed) meta.lastEmailAt = Date.now();
    changed = true;
  }

  if (changed || checkOnly === false) {
    await store.writeJSON(file, { signals, meta }, sha);
  }

  return { assets, goodAssets, newSignals, stats: stats(signals), emailed, minConf };
}

module.exports = { run, stats };