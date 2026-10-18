// Logins for the hosted dashboard. Passwords are stored as scrypt hashes; a session is an HMAC-signed cookie
// (username + expiry), so no session table is needed. The signing key comes from DEALFLOW_SECRET when set,
// otherwise it is generated once and kept in the database (meta table), so deploying needs no manual secret.
import crypto from "node:crypto";

const DAYS = 14;
let key = null;

/** Loads (or on first use creates) the signing key. Call once per request before sessionCookie/userFrom. */
export async function loadKey(db) {
  if (key) return key;
  if (process.env.DEALFLOW_SECRET && process.env.DEALFLOW_SECRET.length >= 32) return (key = process.env.DEALFLOW_SECRET);
  const fresh = crypto.randomBytes(48).toString("base64url");
  await db.query("insert into meta (key, value) values ('session_key', to_jsonb($1::text)) on conflict (key) do nothing", [fresh]);
  const { rows } = await db.query("select value #>> '{}' as k from meta where key = 'session_key'");
  return (key = rows[0].k);
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const k = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${k.toString("base64")}`;
}

export function checkPassword(pw, stored) {
  const [kind, salt, k] = String(stored).split("$");
  if (kind !== "scrypt" || !salt || !k) return false;
  const want = Buffer.from(k, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

const sign = (payload) => {
  if (!key) throw new Error("session key not loaded");
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
};

export function sessionCookie(username) {
  const exp = Date.now() + DAYS * 864e5;
  const payload = `${Buffer.from(username).toString("base64url")}.${exp}`;
  return `wbdf=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`;
}
export const clearCookie = () => "wbdf=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

// API keys (for Claude via MCP, or any script): "wbdf_<id>_<secret>". Only a sha256 of the whole key is stored,
// the id is a public prefix so keys can be listed and revoked.
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function newApiKey() {
  const id = crypto.randomBytes(4).toString("hex");
  const key = `wbdf_${id}_${crypto.randomBytes(24).toString("base64url")}`;
  return { id, key, hash: sha256(key) };
}

/** Username for a valid API key, or null. Records when the key was last used (at most once a minute). */
export async function userFromApiKey(db, key) {
  if (!/^wbdf_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/.test(key || "")) return null;
  const { rows } = await db.query(
    `update api_keys set last_used_at = now() where key_hash = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')
     returning username`, [sha256(key)]);
  if (rows[0]) return rows[0].username;
  const again = await db.query("select username from api_keys where key_hash = $1", [sha256(key)]);
  return again.rows[0]?.username || null;
}

/** API key from an "Authorization: Bearer" header, or from a /mcp/k/<key> path (for clients that cannot send headers). */
export function apiKeyFrom(req, route) {
  const h = req.headers.authorization || "";
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  const m = route.match(/^mcp\/k\/([^/]+)$/);
  return m ? m[1] : null;
}

/** The logged-in username, or null. */
export function userFrom(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)wbdf=([^;]+)/);
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expect = sign(payload);
  if (expect.length !== parts[2].length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(parts[2]))) return null;
  if (Number(parts[1]) < Date.now()) return null;
  return Buffer.from(parts[0], "base64url").toString();
}
