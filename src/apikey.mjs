// API keys for the hosted dashboard (Claude via MCP, or scripts via /api/v1). A key acts as its user: CRM
// changes made with it are recorded as "<user> (API)". The key is shown once (or written to --out) and only
// its hash is stored.
// Usage: node src/apikey.mjs create <username> [label] [--out file]
//        node src/apikey.mjs list
//        node src/apikey.mjs revoke <id>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of fs.existsSync(path.join(root, ".env")) ? fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { db, ensureSchema } = await import("../lib/db.mjs");
const { newApiKey } = await import("../lib/auth.mjs");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const [cmd, a1, ...rest] = args;
await ensureSchema();
const pool = db();
const SITE = process.env.DEALFLOW_PUBLIC_URL || "https://leads-jet-tau.vercel.app";

if (cmd === "create" && a1) {
  const user = a1.toLowerCase();
  const exists = await pool.query("select 1 from users where username = $1", [user]);
  if (!exists.rowCount) { console.error(`No dashboard user "${user}". Create it first: npm run adduser ${user}`); process.exit(1); }
  const k = newApiKey();
  await pool.query("insert into api_keys (id, username, key_hash, label) values ($1, $2, $3, $4)", [k.id, user, k.hash, rest.join(" ")]);
  const text = [
    `WEB BETTER DEAL FLOW API key for ${user} (id ${k.id}). Keep it secret: it gives full access to the leads.`,
    ``,
    `Key: ${k.key}`,
    ``,
    `Claude Code:`,
    `  claude mcp add --transport http webbetter-leads ${SITE}/api/mcp --header "Authorization: Bearer ${k.key}"`,
    ``,
    `Claude.ai / Claude Desktop (Settings > Connectors > Add custom connector), URL:`,
    `  ${SITE}/api/mcp/k/${k.key}`,
    ``,
    `REST: curl -H "Authorization: Bearer ${k.key}" "${SITE}/api/v1/leads?tier=A,B&limit=10"`,
    ``,
    `Revoke: node src/apikey.mjs revoke ${k.id}`,
    ``,
  ].join("\n");
  if (out) { fs.writeFileSync(out, text, { mode: 0o600 }); console.log(`Key ${k.id} for ${user} written to ${out}`); }
  else console.log(text);
} else if (cmd === "list") {
  const { rows } = await pool.query("select id, username, label, created_at, last_used_at from api_keys order by created_at");
  console.table(rows.map((r) => ({ id: r.id, user: r.username, label: r.label, created: r.created_at?.toISOString().slice(0, 16), last_used: r.last_used_at?.toISOString().slice(0, 16) || "never" })));
} else if (cmd === "revoke" && a1) {
  const r = await pool.query("delete from api_keys where id = $1", [a1]);
  console.log(r.rowCount ? `Revoked ${a1}` : `No key ${a1}`);
} else {
  console.error("Usage: node src/apikey.mjs create <username> [label] [--out file] | list | revoke <id>");
  process.exit(1);
}
await pool.end();
