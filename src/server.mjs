// WEB BETTER DEAL FLOW server: merges leads + scans + Maps reviews, ranks them with public/score.js and
// serves the dashboard. CRM state (status, notes, owner per domain) lives in data/crm.json.
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rankLead, revenueBenchmarks, DEFAULTS } from "../public/score.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 6300);
const D = (f) => path.join(root, "data", f);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

const cache = new Map();
function jsonl(file) {
  const p = D(file);
  if (!fs.existsSync(p)) return new Map();
  const { mtimeMs, size } = fs.statSync(p);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.map;
  const map = new Map();
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); map.set(r.domain, r); } catch {} // a half-written last line during a scan
  }
  cache.set(file, { mtimeMs, size, map });
  return map;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(D(f), "utf8")); } catch { return d; } };

function build() {
  const { leads, rowsPerSource, noDomain } = readJson("leads.json", { leads: [] });
  const H = jsonl("http.jsonl"), R = jsonl("scans.jsonl"), M = jsonl("maps.jsonl");
  const rows = leads.map((l) => {
    const h = H.get(l.domain), r = R.get(l.domain), m = M.get(l.domain);
    return { lead: l, http: h || null, render: r || null, maps: m || null, scanned: !!(h || r) };
  });
  return {
    rows, noDomain: noDomain?.length || 0, rowsPerSource,
    progress: { total: leads.length, http: H.size, render: R.size, maps: M.size },
    bench: revenueBenchmarks(leads), defaults: DEFAULTS, builtAt: new Date().toISOString(),
  };
}

function send(res, code, body, type = "application/json", req = null) {
  let buf = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = { "Content-Type": type, "Cache-Control": "no-store" };
  if (req && /gzip/.test(req.headers["accept-encoding"] || "") && buf.length > 20000) { buf = zlib.gzipSync(buf, { level: 5 }); headers["Content-Encoding"] = "gzip"; }
  res.writeHead(code, headers);
  res.end(buf);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/data") return send(res, 200, build(), "application/json", req);
    if (url.pathname === "/api/progress") {
      const { leads } = readJson("leads.json", { leads: [] });
      return send(res, 200, { total: leads.length, http: jsonl("http.jsonl").size, render: jsonl("scans.jsonl").size, maps: jsonl("maps.jsonl").size });
    }
    if (url.pathname === "/api/crm" && req.method === "GET") return send(res, 200, readJson("crm.json", {}));
    if (url.pathname === "/api/crm" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const { domain, ...patch } = JSON.parse(body || "{}");
      if (!domain) return send(res, 400, { error: "domain required" });
      const crm = readJson("crm.json", {});
      crm[domain] = { ...(crm[domain] || {}), ...patch, updatedAt: new Date().toISOString() };
      fs.writeFileSync(D("crm.json"), JSON.stringify(crm, null, 1));
      return send(res, 200, crm[domain]);
    }
    // Ranked order for the Maps lookup, so reviews get filled in best-leads-first.
    if (url.pathname === "/api/order") {
      const { rows, bench } = build();
      const order = rows.map((x) => ({ d: x.lead.domain, r: rankLead(x.lead, x.http, x.render, x.maps, DEFAULTS, bench) })).filter((x) => x.r.live)
        .sort((a, b) => b.r.dealScore - a.r.dealScore).map((x) => x.d);
      return send(res, 200, order);
    }
    if (url.pathname.startsWith("/shots/")) {
      const f = path.join(root, "data", "shots", path.basename(decodeURIComponent(url.pathname)));
      if (!fs.existsSync(f)) return send(res, 404, "no shot", "text/plain");
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
      return res.end(fs.readFileSync(f));
    }
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([\\/])+/, "");
    if (!p) p = "index.html";
    const file = path.join(root, "public", p);
    if (!file.startsWith(path.join(root, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "not found", "text/plain");
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    return send(res, 500, { error: String(e.message) });
  }
}).listen(PORT, () => console.log(`WEB BETTER DEAL FLOW on http://localhost:${PORT}`));
