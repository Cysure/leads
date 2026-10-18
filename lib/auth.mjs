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
