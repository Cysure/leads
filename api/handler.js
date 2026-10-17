// Hosted API (Vercel function; vercel.json routes /api/* here). Everything except login needs a session.
// Data lives in Postgres (see lib/db.mjs), written by the local sync script (src/sync.mjs).
import { db } from "../lib/db.mjs";
import { checkPassword, clearCookie, sessionCookie, userFrom } from "../lib/auth.mjs";

const MAX_ROWS = 2000; // keeps each response well under Vercel's 4.5 MB limit (~1.2 kB per row)

function send(res, code, body, headers = {}) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

const STATUSES = new Set(["new", "emailed", "called", "meeting", "won", "lost"]);

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const route = (url.searchParams.get("route") || url.pathname.replace(/^\/api\/?/, "")).replace(/\/+$/, "");
  try {
    if (route === "login" && req.method === "POST") {
      const { username = "", password = "" } = await readBody(req);
      const u = String(username).trim().toLowerCase();
      const { rows } = await db().query("select pass_hash from users where username = $1", [u]);
      if (!rows[0] || !checkPassword(String(password), rows[0].pass_hash)) {
        await new Promise((r) => setTimeout(r, 700)); // slow down guessing
        return send(res, 401, { error: "Wrong username or password" });
      }
      return send(res, 200, { user: u }, { "Set-Cookie": sessionCookie(u) });
    }
    if (route === "logout") return send(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });

    const user = userFrom(req);
    if (!user) return send(res, 401, { error: "login required" });

    if (route === "me") return send(res, 200, { user, hosted: true });
    if (route === "meta") {
      const { rows } = await db().query("select value from meta where key = 'info'");
      return send(res, 200, rows[0]?.value || {});
    }
    if (route === "rows") {
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(MAX_ROWS, Math.max(1, Number(url.searchParams.get("limit")) || MAX_ROWS));
      const { rows } = await db().query(
        "select l.summary as s, coalesce(c.status, 'new') as status from leads l left join crm c using (domain) order by l.domain offset $1 limit $2",
        [offset, limit]);
      return send(res, 200, rows.map((r) => ({ ...r.s, status: r.status })));
    }
    if (route === "lead") {
      const d = url.searchParams.get("d") || "";
      const { rows } = await db().query("select detail, shot_m, shot_d from leads where domain = $1", [d]);
      if (!rows[0]) return send(res, 404, { error: "not found" });
      return send(res, 200, { ...rows[0].detail, shots: { m: rows[0].shot_m, d: rows[0].shot_d } });
    }
    if (route === "crm" && req.method === "GET") {
      const { rows } = await db().query("select domain, status, owner, notes, updated_by, updated_at from crm");
      return send(res, 200, Object.fromEntries(rows.map((r) => [r.domain, { status: r.status, owner: r.owner, notes: r.notes, updatedBy: r.updated_by, updatedAt: r.updated_at }])));
    }
    if (route === "crm" && req.method === "POST") {
      const { domain, status = "new", owner = "", notes = "" } = await readBody(req);
      if (!domain || !STATUSES.has(status)) return send(res, 400, { error: "domain and a valid status are required" });
      const { rows } = await db().query(
        `insert into crm (domain, status, owner, notes, updated_by, updated_at) values ($1, $2, $3, $4, $5, now())
         on conflict (domain) do update set status = excluded.status, owner = excluded.owner, notes = excluded.notes,
           updated_by = excluded.updated_by, updated_at = now()
         returning status, owner, notes, updated_by, updated_at`,
        [String(domain), status, String(owner).slice(0, 80), String(notes).slice(0, 5000), user]);
      const r = rows[0];
      return send(res, 200, { status: r.status, owner: r.owner, notes: r.notes, updatedBy: r.updated_by, updatedAt: r.updated_at });
    }
    return send(res, 404, { error: "unknown route" });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: "server error" });
  }
}
