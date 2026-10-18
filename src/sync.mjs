// Pushes the local scan results to the hosted dashboard: lead rows to Postgres (only those that changed) and
// screenshots, resized, to Vercel Blob. Run it whenever scans have moved on; it is safe to run repeatedly.
// Needs .env with DEALFLOW_DATABASE_URL (and BLOB_READ_WRITE_TOKEN for screenshots).
// Usage: node src/sync.mjs [--no-shots] [--import-crm]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of fs.existsSync(path.join(root, ".env")) ? fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { db, ensureSchema } = await import("../lib/db.mjs");
const { assess, slim, revenueBenchmarks } = await import("../public/score.js");

const D = (f) => path.join(root, "data", f);
const jsonl = (f) => {
  const map = new Map();
  if (!fs.existsSync(D(f))) return map;
  for (const line of fs.readFileSync(D(f), "utf8").split("\n")) { if (line.trim()) try { const r = JSON.parse(line); map.set(r.domain, r); } catch {} }
  return map;
};
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

const { leads, rowsPerSource, noDomain } = JSON.parse(fs.readFileSync(D("leads.json"), "utf8"));
const H = jsonl("http.jsonl"), R = jsonl("scans.jsonl"), M = jsonl("maps.jsonl");
const bench = revenueBenchmarks(leads);
await ensureSchema();
const pool = db();

// 1. Lead rows: upsert the ones whose content changed.
const have = new Map((await pool.query("select domain, hash, shot_m, shot_d from leads")).rows.map((r) => [r.domain, r]));
const changed = [];
for (const l of leads) {
  const h = H.get(l.domain) || null, r = R.get(l.domain) || null, m = M.get(l.domain) || null;
  const summary = slim(assess(l, h, r, m, bench));
  const detail = { lead: l, http: h, render: r, maps: m };
  const hash = crypto.createHash("sha1").update(JSON.stringify([summary, detail])).digest("base64url");
  if (have.get(l.domain)?.hash !== hash) changed.push([l.domain, summary, detail, hash]);
}
log(`${leads.length} leads, ${changed.length} new or changed`);
for (let i = 0; i < changed.length; i += 250) {
  const part = changed.slice(i, i + 250);
  await pool.query(
    `insert into leads (domain, summary, detail, hash, updated_at)
     select * , now() from unnest($1::text[], $2::jsonb[], $3::jsonb[], $4::text[])
     on conflict (domain) do update set summary = excluded.summary, detail = excluded.detail, hash = excluded.hash, updated_at = now()`,
    [part.map((x) => x[0]), part.map((x) => JSON.stringify(x[1])), part.map((x) => JSON.stringify(x[2])), part.map((x) => x[3])]);
  if ((i / 250) % 8 === 0) log(`  rows ${Math.min(i + 250, changed.length)}/${changed.length}`);
}
// Leads that no longer exist locally (merged into another domain) go away.
const keep = leads.map((l) => l.domain);
const del = await pool.query("delete from leads where not (domain = any($1::text[]))", [keep]);
if (del.rowCount) log(`removed ${del.rowCount} leads that were merged or dropped`);

// Dashboard header info (lead count, progress). Written before the slow screenshot upload so the hosted
// dashboard is complete as soon as the rows are in, and again at the end.
async function writeMeta() {
  const info = { bench, rowsPerSource, noDomain: noDomain?.length || 0, syncedAt: new Date().toISOString(),
    progress: { total: leads.length, http: leads.filter((l) => H.has(l.domain)).length, render: leads.filter((l) => R.get(l.domain)?.v === 2).length, maps: leads.filter((l) => M.has(l.domain)).length } };
  await pool.query("insert into meta (key, value) values ('info', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(info)]);
  return info;
}
await writeMeta();

// 2. Screenshots: resize and upload the ones not uploaded yet.
if (!process.argv.includes("--no-shots")) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) log("BLOB_READ_WRITE_TOKEN not set: skipping screenshots");
  else {
    const { put } = await import("@vercel/blob");
    const sharp = (await import("sharp")).default;
    const jobs = [];
    for (const l of leads) {
      const r = R.get(l.domain);
      if (r?.v !== 2) continue;
      for (const v of ["m", "d"]) if (r.shots?.[v] && !have.get(l.domain)?.[`shot_${v}`]) jobs.push([l.domain, v]);
    }
    log(`${jobs.length} screenshots to upload`);
    let done = 0, i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < jobs.length) {
        const [domain, v] = jobs[i++];
        const file = D(`shots/${domain}-${v}.jpg`);
        if (!fs.existsSync(file)) continue;
        try {
          // Phone shots stay 390 px wide (CTA boxes are drawn in page pixels); desktop shots shrink to 900 px.
          const buf = await sharp(file).resize({ width: v === "d" ? 900 : 390, withoutEnlargement: true }).jpeg({ quality: 58, mozjpeg: true }).toBuffer();
          const blob = await put(`shots/${domain}-${v}.jpg`, buf, { access: "public", addRandomSuffix: true, contentType: "image/jpeg" });
          await pool.query(`update leads set shot_${v} = $2 where domain = $1`, [domain, blob.url]);
        } catch (e) { log(`  ${domain}-${v}: ${String(e.message).slice(0, 100)}`); }
        if (++done % 500 === 0) log(`  screenshots ${done}/${jobs.length}`);
      }
    }));
    log(`screenshots uploaded: ${done}`);
  }
}

// 3. Optional: carry over sales status entered in the local dashboard.
if (process.argv.includes("--import-crm") && fs.existsSync(D("crm.json"))) {
  const crm = JSON.parse(fs.readFileSync(D("crm.json"), "utf8"));
  for (const [domain, c] of Object.entries(crm))
    await pool.query(`insert into crm (domain, status, owner, notes, updated_by) values ($1,$2,$3,$4,'local') on conflict (domain) do nothing`,
      [domain, c.status || "new", c.owner || "", c.notes || ""]);
  log(`imported ${Object.keys(crm).length} local CRM entries (existing hosted entries kept)`);
}

log("sync done", JSON.stringify((await writeMeta()).progress));
await pool.end();
