const engine = require("../lib/engine");

module.exports = async (req, res) => {
  try {
    if (req.query.secret !== process.env.ENGINE_SECRET) {
      return res.status(403).json({ ok: false, error: "bad secret" });
    }
    const out = await engine.run({ email: req.query.email === "1" });
    return res.json({ ok: true, stats: out.stats, newSignals: out.newSignals.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};