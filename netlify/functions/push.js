// ── YoEcho push + reminders API (Netlify Function) ──────────────────────────
// POST { action, ... } → JSON. Needs the tables from supabase-push.sql.
const L = require("./_push-lib");
const H = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
const ok = (o) => ({ statusCode: 200, headers: H, body: JSON.stringify(o) });
const bad = (code, msg) => ({ statusCode: code, headers: H, body: JSON.stringify({ error: msg }) });
const cleanRem = (r, pid) => ({
  id: String(r.id).slice(0, 64), profile_id: pid, title: String(r.title || "").slice(0, 200), due_at: new Date(r.at || r.due_at).toISOString(),
  repeat: ["none", "daily", "weekly", "weekdays", "weekends"].includes(r.repeat) ? r.repeat : "none", tz: L.safeTz(r.tz || "UTC"), done: !!r.done,
});

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: H, body: "" };
  if (event.httpMethod !== "POST") return bad(405, "POST only");
  let b; try { b = JSON.parse(event.body || "{}"); } catch (e) { return bad(400, "bad json"); }
  const pid = String(b.profileId || "").slice(0, 80);
  try {
    switch (b.action) {
      case "config": { const v = await L.vapid(); return ok({ ready: true, publicKey: v.publicKey }); }
      case "subscribe": {
        const s = b.subscription || {}; if (!pid || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return bad(400, "bad subscription");
        const prefs = b.prefs && typeof b.prefs === "object" ? b.prefs : {};
        if (!prefs.hour) prefs.hour = 10 + Math.floor(Math.random() * 8);
        await L.upsert("push_subs", [{ endpoint: s.endpoint, profile_id: pid, p256dh: s.keys.p256dh, auth: s.keys.auth, tz: L.safeTz(b.tz || "UTC"), prefs, last_seen: new Date().toISOString() }], "endpoint");
        return ok({ subscribed: true, hour: prefs.hour });
      }
      case "unsubscribe": { if (b.endpoint) await L.sb(`push_subs?endpoint=eq.${encodeURIComponent(b.endpoint)}`, { method: "DELETE" }); return ok({ subscribed: false }); }
      case "prefs": {
        if (!b.endpoint) return bad(400, "endpoint needed");
        const rows = await L.sb(`push_subs?endpoint=eq.${encodeURIComponent(b.endpoint)}&select=prefs`);
        if (!rows || !rows.length) return ok({ subscribed: false });
        const prefs = Object.assign({}, rows[0].prefs || {}, b.prefs || {});
        await L.sb(`push_subs?endpoint=eq.${encodeURIComponent(b.endpoint)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ prefs, tz: L.safeTz(b.tz || "UTC") }) });
        return ok({ prefs });
      }
      case "seen": { if (b.endpoint) await L.sb(`push_subs?endpoint=eq.${encodeURIComponent(b.endpoint)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_seen: new Date().toISOString() }) }); return ok({}); }
      case "reminder_upsert": {
        if (!pid) return bad(400, "profileId needed");
        const rows = (Array.isArray(b.reminders) ? b.reminders : []).slice(0, 50).filter((r) => r && r.id && (r.at || r.due_at)).map((r) => cleanRem(r, pid));
        if (b.reset) rows.forEach((r) => { r.notified_at = null; });
        if (rows.length) await L.upsert("reminders", rows, "id");
        return ok({ saved: rows.length });
      }
      case "reminder_delete": { if (!pid || !b.id) return bad(400, "id needed"); await L.sb(`reminders?id=eq.${encodeURIComponent(b.id)}&profile_id=eq.${encodeURIComponent(pid)}`, { method: "DELETE" }); return ok({ deleted: true }); }
      case "reminder_list": {
        if (!pid) return bad(400, "profileId needed");
        const since = new Date(Date.now() - 2 * 86400000).toISOString();
        const rows = await L.sb(`reminders?profile_id=eq.${encodeURIComponent(pid)}&due_at=gte.${encodeURIComponent(since)}&select=*&order=due_at.asc&limit=100`);
        return ok({ reminders: (rows || []).map((r) => ({ id: r.id, title: r.title, at: r.due_at, repeat: r.repeat, tz: r.tz, done: r.done || !!r.notified_at && r.repeat === "none" })) });
      }
      case "test": {
        if (!b.endpoint) return bad(400, "endpoint needed");
        const rows = await L.sb(`push_subs?endpoint=eq.${encodeURIComponent(b.endpoint)}&select=*`);
        if (!rows || !rows.length) return bad(404, "not subscribed");
        const r = await L.sendPush(rows[0], { kind: "test", title: "YoEcho", body: "This is how I'll tap you on the shoulder — for reminders, and now and then just to say hi.", tag: "test" }, { ttl: 300 });
        if (r.gone) await L.sb(`push_subs?endpoint=eq.${encodeURIComponent(b.endpoint)}`, { method: "DELETE" });
        return ok({ sent: r.ok, status: r.status });
      }
      default: return bad(400, "unknown action");
    }
  } catch (e) {
    console.error("[push]", e.message);
    return { statusCode: 200, headers: H, body: JSON.stringify({ ready: false, error: String(e.message).slice(0, 200) }) };
  }
};
