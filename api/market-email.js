const nodemailer = require("nodemailer");

const COINS = [
  { label: "BTC/USD", binance: "BTCUSDT", coinbase: "BTC-USD", kraken: "XBTUSD", gecko: "bitcoin" },
  { label: "BNB/USD", binance: "BNBUSDT", coinbase: null,      kraken: null,     gecko: "binancecoin" },
  { label: "ETH/USD", binance: "ETHUSDT", coinbase: "ETH-USD", kraken: "ETHUSD", gecko: "ethereum" },
  { label: "SOL/USD", binance: "SOLUSDT", coinbase: "SOL-USD", kraken: "SOLUSD", gecko: "solana" },
  { label: "XRP/USD", binance: "XRPUSDT", coinbase: "XRP-USD", kraken: "XRPUSD", gecko: "ripple" }
];

function timeoutFetch(url, ms = 4000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
}

/* ---------- parsers ---------- */
const parseBinance = d => d.map(k => ({ high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
const parseCoinbase = d => d.map(k => ({ high: +k[2], low: +k[1], close: +k[4], volume: +k[5] }));
const parseKraken = d => {
  const r = d.result || {};
  const key = Object.keys(r).find(k => k !== "last");
  if (!key) throw new Error("kraken parse failed");
  return r[key].map(k => ({ high: +k[2], low: +k[3], close: +k[4], volume: +k[6] }));
};
const parseGecko = d => d.map(k => ({ high: +k[2], low: +k[3], close: +k[4], volume: null }));

/* ---------- data sources with fallback ---------- */
function sourcesFor(coin) {
  const list = [];
  if (coin.coinbase) list.push({ name: "Coinbase", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://api.exchange.coinbase.com/products/${coin.coinbase}/candles?granularity=300`);
    if (!r.ok) throw new Error("coinbase " + r.status);
    return parseCoinbase(await r.json());
  }});
  if (coin.kraken) list.push({ name: "Kraken", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://api.kraken.com/0/public/OHLC?pair=${coin.kraken}&interval=5`);
    if (!r.ok) throw new Error("kraken " + r.status);
    return parseKraken(await r.json());
  }});
  list.push({ name: "Binance", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://api.binance.com/api/v3/klines?symbol=${coin.binance}&interval=5m&limit=100`);
    if (!r.ok) throw new Error("binance " + r.status);
    return parseBinance(await r.json());
  }});
  list.push({ name: "BinanceVision", noVol: false, run: async () => {
    const r = await timeoutFetch(`https://data-api.binance.vision/api/v3/klines?symbol=${coin.binance}&interval=5m&limit=100`);
    if (!r.ok) throw new Error("vision " + r.status);
    return parseBinance(await r.json());
  }});  list.push({ name: "CoinGecko", noVol: true, run: async () => {
    const r = await timeoutFetch(`https://api.coingecko.com/api/v3/coins/${coin.gecko}/ohlc?vs_currency=usd&days=2`);
    if (!r.ok) throw new Error("gecko " + r.status);
    return parseGecko(await r.json());
  }});
  return list;
}

/* ---------- indicators ---------- */
function emaLast(v, p) {
  if (!v || v.length < p) return null;
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return e;
}
function rsiLast(c, p = 14) {
  if (!c || c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i-1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i-1];
    ag = (ag * (p-1) + (d > 0 ? d : 0)) / p;
    al = (al * (p-1) + (d < 0 ? -d : 0)) / p;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function atrLast(h, l, c, p = 14) {
  if (!h || h.length < p + 1) return null;
  const t = [];
  for (let i = 1; i < h.length; i++)
    t.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  if (t.length < p) return null;
  let a = t.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < t.length; i++) a = (a * (p-1) + t[i]) / p;
  return a;
}
const avg = v => (v && v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

function analyze(rows, allowNoVolume) {
  if (!rows || rows.length < 55) return { good:false, direction:"WAIT", confidence:0 };
  const closes = rows.map(r => Number(r.close));
  const highs  = rows.map(r => Number(r.high));
  const lows   = rows.map(r => Number(r.low));
  const vols   = rows.map(r => Number(r.volume || 0));

  const last = closes[closes.length - 1] || 0;
  const e9 = emaLast(closes, 9), e21 = emaLast(closes, 21), e50 = emaLast(closes, 50);
  const trendUp   = e9 !== null && e21 !== null && e50 !== null && e9 > e21 && e21 > e50;
  const trendDown = e9 !== null && e21 !== null && e50 !== null && e9 < e21 && e21 < e50;

  const rsi = rsiLast(closes, 14);
  const atr = atrLast(highs, lows, closes, 14);
  const atrPct = atr && last ? (atr / last) * 100 : 0;

  const avgVol = avg(vols.slice(-21, -1));
  const curVol = vols[vols.length - 1] || 0;
  const volumeOk = allowNoVolume ? true : (avgVol > 0 && curVol >= avgVol * 0.8);
  const volatilityOk = atrPct >= 0.04 && atrPct <= 3.0;

  const momentumOk = trendUp
    ? (rsi !== null && rsi >= 50 && rsi <= 73)
    : trendDown ? (rsi !== null && rsi <= 50 && rsi >= 27) : false;

  const good = Boolean((trendUp || trendDown) && momentumOk && volumeOk && volatilityOk);
  const direction = good ? (trendUp ? "BUY" : "SELL") : "WAIT";

  let conf = 48;
  if (trendUp || trendDown) conf += 12;
  if (momentumOk) conf += 14;
  if (volumeOk) conf += 8;
  if (volatilityOk) conf += 8;
  if (trendUp && rsi && rsi >= 55 && rsi <= 68) conf += 6;
  if (trendDown && rsi && rsi <= 45 && rsi >= 32) conf += 6;

  return {
    good, direction,
    confidence: Math.min(93, Math.round(conf)),
    rsi: rsi ? Math.round(rsi) : 0,
    atrPct: Number(atrPct.toFixed(4)),
    volumeOk, volatilityOk, momentumOk
  };
}

async function checkCoin(coin) {
  const sources = sourcesFor(coin);
  try {
    const win = await Promise.any(sources.map(async src => {
      const rows = await src.run();
      if (!rows || rows.length < 55) throw new Error("short data");
      return { src, rows };
    }));
    return { symbol: coin.label, source: win.src.name, ...analyze(win.rows, win.src.noVol) };
  } catch (e) {
    return { symbol: coin.label, good:false, direction:"WAIT", confidence:0, error:"All data sources failed" };
  }
}
function formatTime(d) {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
    timeZone: process.env.TIME_ZONE || "UTC"
  });
}

module.exports = async (req, res) => {
  try {
    const force = req.query.force === "true";
    const checkOnly = req.query.check === "true";

    const assets = await Promise.all(COINS.map(checkCoin));

    /* Market tab only — no email */
    if (checkOnly) {
      return res.json({ ok: true, time: new Date().toISOString(), assets });
    }

    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      return res.status(500).json({ ok:false, error:"Missing Gmail env variables in Vercel." });
    }

    const minConf = parseInt(process.env.MIN_CONFIDENCE || "75", 10);
    const goodAssets = assets.filter(a => a.good && a.confidence >= minConf);

    if (!force && goodAssets.length === 0) {
      return res.json({ ok:false, emailed:false, minConfidence:minConf, assets,
        message:"No good market conditions right now. Try again in a few minutes." });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });

    const now = new Date();
    const windows = [5,10,15].map(m =>
      `<li>Next ${m} min: until <b>${formatTime(new Date(now.getTime()+m*60000))}</b></li>`).join("");

    const rowsHtml = (goodAssets.length ? goodAssets : assets).map(a => `
      <tr>
        <td style="padding:7px;border:1px solid #ddd;">${a.symbol}</td>
        <td style="padding:7px;border:1px solid #ddd;">${a.direction}</td>
        <td style="padding:7px;border:1px solid #ddd;">${a.confidence}%</td>
        <td style="padding:7px;border:1px solid #ddd;">${a.good ? "GOOD" : "NO"}</td>
      </tr>`).join("");

    await transporter.sendMail({      from: `"G-Chat IQ Signals" <${process.env.GMAIL_USER}>`,
      to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
      subject: `${force ? "TEST " : ""}✅ G-Chat IQ Signals: Market GOOD at ${formatTime(now)}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#075E54;color:#fff;padding:14px;border-radius:8px;">
            <h2 style="margin:0;">G-Chat IQ Signals</h2>
            <p style="margin:6px 0 0;">Market Condition: ${goodAssets.length ? "GOOD" : "TEST"}</p>
            <p style="margin:4px 0 0;">Time: ${formatTime(now)}</p>
          </div>
          <div style="padding:14px;border:1px solid #eee;border-radius:8px;margin-top:10px;">
            <h3 style="margin-top:0;">Signal Scan Windows</h3>
            <ul>${windows}</ul>
            <h3>Assets Checked</h3>
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <th style="padding:7px;border:1px solid #ddd;background:#f5f5f5;">Asset</th>
                <th style="padding:7px;border:1px solid #ddd;background:#f5f5f5;">Bias</th>
                <th style="padding:7px;border:1px solid #ddd;background:#f5f5f5;">Confidence</th>
                <th style="padding:7px;border:1px solid #ddd;background:#f5f5f5;">Status</th>
              </tr>
              ${rowsHtml}
            </table>
            <p style="color:#667781;font-size:12px;margin-top:14px;">
              Educational only. Not financial advice. Signals are not guaranteed.
            </p>
          </div>
        </div>`
    });

    return res.json({ ok:true, emailed:true, goodAssets, assets,
      message:"Market email sent. Check your Gmail inbox/spam folder." });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message });
  }
};