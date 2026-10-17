// Runs the hosted setup locally: public/ as static files and api/handler.js for /api/*, the way vercel.json wires
// them on Vercel. For testing login, the database API and the sync before deploying.
// Usage: node src/dev-hosted.mjs --env .env.test [--port 6310]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
for (const line of fs.readFileSync(path.join(root, arg("env", ".env")), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) process.env[m[1]] = m[2];
}
const { default: handler } = await import("../api/handler.js");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg" };
const pub = path.join(root, "public");

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    req.url = `/api/handler?route=${encodeURIComponent(url.pathname.slice(5))}&${url.searchParams}`;
    return handler(req, res);
  }
  const file = path.join(pub, path.normalize(decodeURIComponent(url.pathname)).replace(/^([\\/])+/, "") || "index.html");
  if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
}).listen(Number(arg("port", 6310)), () => console.log(`hosted-mode dev server on http://localhost:${arg("port", 6310)}`));
