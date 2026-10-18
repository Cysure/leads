// Hosted API (Vercel function; vercel.json routes /api/* here). Everything except login needs a session cookie
// or an API key (Authorization: Bearer wbdf_...). /api/mcp is the MCP server for Claude, /api/v1/* the REST API.
// Data lives in Postgres (see lib/db.mjs), written by the local sync script (src/sync.mjs).
import { db, ensureSchema } from "../lib/db.mjs";
import { apiKeyFrom, checkPassword, clearCookie, loadKey, sessionCookie, userFrom, userFromApiKey } from "../lib/auth.mjs";
import { callTool, mcpHttp } from "../lib/mcp.mjs";

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

// First request on a fresh database creates the tables and the session key; later ones skip it.
let readyP = null;
const ready = () => (readyP ??= (async () => { await ensureSchema(); await loadKey(db()); })().catch((e) => { readyP = null; throw e; }));

const STATUSES = new Set(["new", "emailed", "called", "meeting", "won", "lost"]);

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const route = (url.searchParams.get("route") || url.pathname.replace(/^\/api\/?/, "")).replace(/\/+$/, "");
  try {
    await ready();
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

    const key = apiKeyFrom(req, route);
    const user = key ? await userFromApiKey(db(), key) : userFrom(req);
    if (!user) return send(res, 401, { error: key ? "invalid API key" : "login required" }, key || route.startsWith("mcp") || route.startsWith("v1") ? { "WWW-Authenticate": 'Bearer realm="dealflow"' } : {});

    // MCP (Streamable HTTP, stateless): POST JSON-RPC, JSON response. No server-sent events, so GET is not offered.
    if (route === "mcp" || route.startsWith("mcp/k/")) {
      if (req.method !== "POST") return send(res, 405, { error: "POST JSON-RPC messages to this endpoint" }, { Allow: "POST" });
      const out = await mcpHttp(db(), await readBody(req), user);
      if (out === null) { res.statusCode = 202; return res.end(); }
      return send(res, 200, out);
    }
    // REST: the same operations as the MCP tools, for scripts and other tools.
    if (route.startsWith("v1/")) {
      const parts = route.split("/").slice(1).map(decodeURIComponent);
      const q = Object.fromEntries(url.searchParams);
      delete q.route;
      try {
        if (parts[0] === "summary" && req.method === "GET") return send(res, 200, await callTool(db(), "pipeline_summary", {}, user));
        if (parts[0] === "leads" && !parts[1] && req.method === "GET") {
          const list = (v) => (v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : undefined);
          const bool = (v) => (v == null ? undefined : v === "true" || v === "1");
          const num = (v) => (v == null || v === "" ? undefined : Number(v));
          return send(res, 200, await callTool(db(), "search_leads", { query: q.query, tier: list(q.tier), status: list(q.status), country: q.country,
            city: q.city, industry: q.industry, max_visibility: num(q.max_visibility), has_phone: bool(q.has_phone), hiring: bool(q.hiring),
            needs_relaunch: bool(q.needs_relaunch), owner: q.owner, sort: q.sort, limit: num(q.limit), offset: num(q.offset) }, user));
        }
        if (parts[0] === "leads" && parts[1] && req.method === "GET") return send(res, 200, await callTool(db(), "get_lead", { domain: parts[1] }, user));
        if (parts[0] === "leads" && parts[1] && (req.method === "PATCH" || req.method === "POST"))
          return send(res, 200, await callTool(db(), "update_lead", { ...(await readBody(req)), domain: parts[1] }, user));
      } catch (e) {
        return send(res, 400, { error: String(e.message || e) });
      }
      return send(res, 404, { error: "unknown route", routes: ["GET /api/v1/summary", "GET /api/v1/leads?query=&tier=A,B&...", "GET /api/v1/leads/{domain}", "PATCH /api/v1/leads/{domain}"] });
    }

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
