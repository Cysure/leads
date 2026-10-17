// Logins for the hosted dashboard. Passwords are stored as scrypt hashes; a session is an HMAC-signed cookie
// (username + expiry), so no session table is needed. DEALFLOW_SECRET must be a long random string.
import crypto from "node:crypto";

const DAYS = 14;
const secret = () => {
  const s = process.env.DEALFLOW_SECRET;
  if (!s || s.length < 32) throw new Error("DEALFLOW_SECRET is missing or shorter than 32 characters");
  return s;
};

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function checkPassword(pw, stored) {
  const [kind, salt, key] = String(stored).split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

const sign = (payload) => crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

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
