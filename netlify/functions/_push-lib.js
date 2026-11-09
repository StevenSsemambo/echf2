// ── Shared helpers for push notifications (no npm packages needed) ──────────
// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), using only Node's crypto.
const crypto = require("crypto");

// Notifications can live in their own Supabase project: set PUSH_SUPABASE_URL + PUSH_SUPABASE_KEY (the project's anon key, or its service_role key).
// If those are not set it falls back to the main project (SUPABASE_URL + SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY).
const SEPARATE = !!process.env.PUSH_SUPABASE_URL;
const SUPABASE_URL = SEPARATE ? process.env.PUSH_SUPABASE_URL : process.env.SUPABASE_URL;
const SB_KEY = SEPARATE ? (process.env.PUSH_SUPABASE_SERVICE_KEY || process.env.PUSH_SUPABASE_KEY)
  : (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");

async function sb(path, opts = {}) {
  if (!SUPABASE_URL || !SB_KEY) throw new Error("Supabase is not configured (SUPABASE_URL / key missing)");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, ...(String(SB_KEY).startsWith("sb_") ? {} : { Authorization: `Bearer ${SB_KEY}` }), "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) { const body = await res.text().catch(() => ""); throw new Error(`Supabase ${opts.method || "GET"} /${path} → ${res.status}: ${body.slice(0, 200)}`); }
  if (res.status === 204) return null;
  const txt = await res.text(); return txt ? JSON.parse(txt) : null;
}
const upsert = (table, rows, conflict) => sb(`${table}?on_conflict=${conflict}`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });

// ── VAPID keys: generated once, kept in the push_config table (so nothing to configure by hand) ──
let _vapid = null;
async function vapid() {
  if (_vapid) return _vapid;
  let rows = await sb("push_config?key=eq.vapid&select=value");
  if (!rows || !rows.length) {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = privateKey.export({ format: "jwk" });
    await sb("push_config?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify([{ key: "vapid", value: JSON.stringify({ d: jwk.d, x: jwk.x, y: jwk.y }) }]) });
    rows = await sb("push_config?key=eq.vapid&select=value");
  }
  const k = JSON.parse(rows[0].value);
  _vapid = {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(k.x), fromB64u(k.y)])),
    key: crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: k.d, x: k.x, y: k.y }, format: "jwk" }),
  };
  return _vapid;
}

async function vapidHeader(endpoint) {
  const v = await vapid();
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:hello@yoecho.app" }));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${claims}`), { key: v.key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

// RFC 8291 payload encryption (one record)
function encryptPayload(sub, plaintext) {
  const ua = fromB64u(sub.p256dh), authSecret = fromB64u(sub.auth);
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), shared = ecdh.computeSecret(ua);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}

// returns { ok, gone, status }
async function sendPush(sub, payload, opts = {}) {
  const body = encryptPayload(sub, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      TTL: String(opts.ttl || 3600), Urgency: opts.urgency || "normal",
    },
    body,
  });
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}

// ── time zones ──
function zoneParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const o = {}; f.formatToParts(date).forEach((p) => { o[p.type] = p.value; });
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, wd: o.weekday };
}
function safeTz(tz) { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch (e) { return "UTC"; } }
// wall-clock time in a zone -> UTC Date
function zonedToUtc(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(new Date(guess), tz), seen = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += Date.UTC(y, mo - 1, d, h, mi) - seen;
  }
  return new Date(guess);
}
// next occurrence of a repeating reminder, keeping the same wall-clock time in the person's zone
function nextDue(due, repeat, tz) {
  tz = safeTz(tz); const p = zoneParts(due, tz);
  for (let add = 1; add <= 8; add++) {
    const probe = zonedToUtc(p.y, p.mo, p.d + add, p.h, p.mi, tz), wd = zoneParts(probe, tz).wd;
    if (repeat === "daily") return probe;
    if (repeat === "weekly" && add === 7) return probe;
    if (repeat === "weekdays" && wd !== "Sat" && wd !== "Sun") return probe;
    if (repeat === "weekends" && (wd === "Sat" || wd === "Sun")) return probe;
  }
  return zonedToUtc(p.y, p.mo, p.d + 1, p.h, p.mi, tz);
}

module.exports = { sb, upsert, vapid, sendPush, encryptPayload, vapidHeader, zoneParts, zonedToUtc, nextDue, safeTz, b64u, fromB64u };
