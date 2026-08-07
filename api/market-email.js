const nodemailer = require("nodemailer");

const CRYPTO_SYMBOLS = [
  "BTCUSDT",
  "BNBUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT"
];

function emaLast(values, period) {
  if (!values || values.length < period) return null;

  let ema =
    values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

function rsiLast(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];

    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atrLast(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 1) return null;

  const trs = [];

  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );

    trs.push(tr);
  }

  if (trs.length < period) return null;

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return atr;
}

function average(values) {
  if (!values || !values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function analyze(rows) {
  if (!rows || rows.length < 60) {
    return {
      good: false,
      direction: "WAIT",
      confidence: 0,
      reason: "Not enough candles"
    };
  }

  const closes = rows.map(r => Number(r.close));
  const highs = rows.map(r => Number(r.high));
  const lows = rows.map(r => Number(r.low));  const volumes = rows.map(r => Number(r.volume || 0));

  const lastClose = closes[closes.length - 1] || 0;

  const ema9 = emaLast(closes, 9);
  const ema21 = emaLast(closes, 21);
  const ema50 = emaLast(closes, 50);

  const trendUp =
    ema9 !== null &&
    ema21 !== null &&
    ema50 !== null &&
    ema9 > ema21 &&
    ema21 > ema50;

  const trendDown =
    ema9 !== null &&
    ema21 !== null &&
    ema50 !== null &&
    ema9 < ema21 &&
    ema21 < ema50;

  const rsi = rsiLast(closes, 14);
  const atr = atrLast(highs, lows, closes, 14);
  const atrPct = atr && lastClose ? (atr / lastClose) * 100 : 0;

  const avgVolume = average(volumes.slice(-21, -1));
  const currentVolume = volumes[volumes.length - 1] || 0;

  const volumeOk = avgVolume > 0 && currentVolume >= avgVolume * 0.8;

  const volatilityOk = atrPct >= 0.04 && atrPct <= 3.0;

  const momentumOk = trendUp
    ? rsi !== null && rsi >= 50 && rsi <= 73
    : trendDown
    ? rsi !== null && rsi <= 50 && rsi >= 27
    : false;

  const good = Boolean(
    (trendUp || trendDown) &&
      momentumOk &&
      volumeOk &&
      volatilityOk
  );

  const direction = good
    ? trendUp
      ? "BUY"
      : "SELL"    : "WAIT";

  let confidence = 48;

  if (trendUp || trendDown) confidence += 12;
  if (momentumOk) confidence += 14;
  if (volumeOk) confidence += 8;
  if (volatilityOk) confidence += 8;

  if (trendUp && rsi && rsi >= 55 && rsi <= 68) confidence += 6;
  if (trendDown && rsi && rsi <= 45 && rsi >= 32) confidence += 6;

  confidence = Math.min(93, Math.round(confidence));

  return {
    good,
    direction,
    confidence,
    trendUp,
    trendDown,
    rsi: rsi ? Math.round(rsi) : 0,
    atrPct: Number(atrPct.toFixed(4)),
    volumeOk,
    volatilityOk,
    momentumOk
  };
}

async function fetchCandles(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=100`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Binance error ${response.status}`);
  }

  const data = await response.json();

  return data.map(k => ({
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

function formatTime(date) {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",    minute: "2-digit",
    timeZone: process.env.TIME_ZONE || "UTC"
  });
}

module.exports = async (req, res) => {
  try {
    const force = req.query.force === "true";

    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      return res.status(500).json({
        ok: false,
        error:
          "Missing Gmail environment variables. Set GMAIL_USER and GMAIL_APP_PASSWORD in Vercel."
      });
    }

    const assets = await Promise.all(
      CRYPTO_SYMBOLS.map(async symbol => {
        const displaySymbol = symbol.replace("USDT", "/USD");

        try {
          const rows = await fetchCandles(symbol);
          return {
            symbol: displaySymbol,
            ...analyze(rows)
          };
        } catch (error) {
          return {
            symbol: displaySymbol,
            good: false,
            direction: "WAIT",
            confidence: 0,
            error: error.message
          };
        }
      })
    );

    const minConfidence = parseInt(process.env.MIN_CONFIDENCE || "75", 10);

    const goodAssets = assets.filter(
      asset => asset.good && asset.confidence >= minConfidence
    );

    if (!force && goodAssets.length === 0) {
      return res.json({
        ok: false,
        emailed: false,
        message:          "No good market conditions right now. Try again in a few minutes.",
        minConfidence,
        assets
      });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    const toEmail = process.env.ALERT_EMAIL || process.env.GMAIL_USER;

    const now = new Date();

    const windows = [5, 10, 15]
      .map(minutes => {
        const endTime = new Date(now.getTime() + minutes * 60000);

        return `
          <li>
            Next ${minutes} min: until
            <b>${formatTime(endTime)}</b>
          </li>
        `;
      })
      .join("");

    const tableRows = (goodAssets.length ? goodAssets : assets)
      .map(asset => {
        return `
          <tr>
            <td style="padding:7px;border:1px solid #ddd;">${asset.symbol}</td>
            <td style="padding:7px;border:1px solid #ddd;">${asset.direction || "WAIT"}</td>
            <td style="padding:7px;border:1px solid #ddd;">${asset.confidence || 0}%</td>
            <td style="padding:7px;border:1px solid #ddd;">${asset.good ? "GOOD" : "NO"}</td>
          </tr>
        `;
      })
      .join("");

    const subject = `${force ? "TEST " : ""}✅ G-Chat IQ Signals: Market GOOD at ${formatTime(now)}`;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#075E54;color:#fff;padding:14px;border-radius:8px;">
          <h2 style="margin:0;">G-Chat IQ Signals</h2>          <p style="margin:6px 0 0 0;">
            Market Condition: ${goodAssets.length ? "GOOD" : "TEST"}
          </p>
          <p style="margin:4px 0 0 0;">Time: ${formatTime(now)}</p>
        </div>

        <div style="padding:14px;border:1px solid #eee;border-radius:8px;margin-top:10px;">
          <h3 style="margin-top:0;">Signal Scan Windows</h3>

          <ul style="margin:0;padding-left:18px;">
            ${windows}
          </ul>

          <h3>Assets Checked</h3>

          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr>
                <th style="padding:7px;border:1px solid #ddd;background:#f5f5f5;">Asset</th>
                <th style="padding:7px;border:1px solid #ddd;background:#f5f5f5;">Bias</th>
                <th style="padding:7px;border:1px solid #ddd;background:#f5f5f5;">Confidence</th>
                <th style="padding:7px;border:1px solid #ddd;background:#f5f5f5;">Status</th>
              </tr>
            </thead>
            <tbody>
              ${tableRows}
            </tbody>
          </table>

          <p style="color:#667781;font-size:12px;margin-top:14px;">
            Disclaimer: Educational only. Not financial advice.
            Market conditions can change quickly. Signals are not guaranteed.
          </p>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: `"G-Chat IQ Signals" <${process.env.GMAIL_USER}>`,
      to: toEmail,
      subject,
      html
    });

    return res.json({
      ok: true,
      emailed: true,
      message: "Market email sent. Check your Gmail inbox/spam folder.",
      goodAssets,
      allAssets: assets    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};