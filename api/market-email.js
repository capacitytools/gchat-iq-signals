const engine = require("../lib/engine");

module.exports = async (req, res) => {
  try {
    const force = req.query.force === "true";
    const checkOnly = req.query.check === "true";

    const out = await engine.run({ email: !checkOnly, force, checkOnly });

    if (checkOnly) {
      return res.json({ ok: true, time: new Date().toISOString(), assets: out.assets });
    }
    if (out.emailed) {
      return res.json({ ok: true, emailed: true,
        goodAssets: out.newSignals.length ? out.newSignals : out.goodAssets,
        assets: out.assets, message: "Signal email sent. Check Gmail." });
    }
    return res.json({ ok: false, emailed: false, assets: out.assets,
      minConfidence: out.minConf,
      message: "No good market conditions right now. Try again in a few minutes." });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};