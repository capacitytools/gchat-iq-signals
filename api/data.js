const store = require("../lib/store");
const engine = require("../lib/engine");

module.exports = async (req, res) => {
  try {
    const type = req.query.type;

    if (req.method === "GET" && type === "history") {
      const { data } = await store.readJSON("signals.json", { signals: [] });
      const signals = (data.signals || []).slice().sort((a, b) =>
        new Date(b.entryTime) - new Date(a.entryTime));
      return res.json({ ok: true, stats: engine.stats(signals), signals });
    }

    if (req.method === "GET" && type === "announcements") {
      const { data } = await store.readJSON("announcements.json", { announcements: [] });
      const active = (data.announcements || []).filter(a => a.active);
      return res.json({ ok: true, announcements: active });
    }

    if (req.method === "POST") {
      let body = {};
      try { body = JSON.parse(req.body); } catch (e) { body = req.body || {}; }
      if (body.pass !== process.env.ADMIN_PASS) {
        return res.status(403).json({ ok: false, error: "wrong passcode" });
      }

      if (body.action === "announce") {
        const { data, sha } = await store.readJSON("announcements.json", { announcements: [] });
        data.announcements = data.announcements || [];
        data.announcements.forEach(a => (a.active = false));
        data.announcements.unshift({
          id: Date.now(), text: String(body.text || "").slice(0, 300),
          time: new Date().toISOString(), active: true
        });
        data.announcements = data.announcements.slice(0, 10);
        await store.writeJSON("announcements.json", data, sha);
        return res.json({ ok: true });
      }

      if (body.action === "clear") {
        const { data, sha } = await store.readJSON("announcements.json", { announcements: [] });
        (data.announcements || []).forEach(a => (a.active = false));
        await store.writeJSON("announcements.json", data, sha);
        return res.json({ ok: true });
      }
    }

    return res.status(400).json({ ok: false, error: "unknown request" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};