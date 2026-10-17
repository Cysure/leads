// Google reviews lookup: searches Google Maps for "<company> <city>" in Chromium (Crawlee + Playwright)
// and reads rating, review count, category and website of the matching listing. A listing counts as a
// match when its website is the lead's domain, or failing that when most of the name words agree.
// One JSON line per domain goes to data/maps.jsonl; finished domains are skipped on a rerun.
// Usage: node src/maps.mjs [--limit N] [--concurrency N] [--only domain,domain] [--from ranked.json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Configuration, LocalEventManager, PlaywrightCrawler, RequestQueue, log, LogLevel } from "crawlee";

log.setLevel(LogLevel.ERROR);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg("limit", 1e9));
const CONC = Number(arg("concurrency", 6));
const ONLY = arg("only", "") ? new Set(arg("only").split(",")) : null;
const OUT = path.join(root, "data", "maps.jsonl");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const leads = JSON.parse(fs.readFileSync(path.join(root, "data", "leads.json"), "utf8")).leads;
const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).domain) : []);
// Optional order file (array of domains, best first) so the leads that matter most are looked up first.
const order = arg("from") ? JSON.parse(fs.readFileSync(arg("from"), "utf8")) : null;
let todo = leads.filter((l) => !done.has(l.domain) && (!ONLY || ONLY.has(l.domain)));
if (order) { const rank = new Map(order.map((d, i) => [d, i])); todo = todo.filter((l) => rank.has(l.domain)).sort((a, b) => rank.get(a.domain) - rank.get(b.domain)); }
todo = todo.slice(0, LIMIT);
console.log(`${done.size} done, ${todo.length} to look up, concurrency ${CONC}`);

const fold = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
const LEGAL = /^(gmbh|ag|sa|sarl|sàrl|kg|ug|ltd|llc|inc|co|und|and|et|the|der|die|das|de|la|le|du|des|von|fur|fuer|mbh|holding|group|gruppe|schweiz|suisse|switzerland)$/;
const nameWords = (s) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !LEGAL.test(w));
function nameScore(a, b) {
  const A = nameWords(a), B = new Set(nameWords(b));
  if (!A.length) return 0;
  return A.filter((w) => B.has(w) || [...B].some((x) => x.startsWith(w) || w.startsWith(x))).length / A.length;
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\d?\./, "").toLowerCase(); } catch { return ""; } };
const sameSite = (u, d) => { const h = hostOf(u); return !!h && (h === d || h.endsWith("." + d) || d.endsWith("." + h)); };

function query(l) {
  const where = l.city || (l.zip ? `${l.zip}` : "") || l.region || "";
  return `${l.company} ${where}`.replace(/\s+/g, " ").trim();
}

// Runs in the Maps page. Reads either the single place panel or the result list.
function readMaps() {
  const num = (s) => { const m = (s || "").replace(/[’'.\s]/g, "").replace(",", ".").match(/[\d.]+/); return m ? Number(m[0]) : null; };
  const h1 = document.querySelector("h1.DUwDvf, h1.fontHeadlineLarge");
  if (h1 && h1.textContent.trim()) {
    const box = document.querySelector("div.F7nice");
    const spans = box ? [...box.querySelectorAll("span[aria-hidden='true']")].map((s) => s.textContent) : [];
    const countEl = box?.querySelector("span[aria-label*='Rezension'], span[aria-label*='review'], span[aria-label*='avis']");
    return { kind: "place", items: [{
      name: h1.textContent.trim(),
      rating: num(spans[0]),
      reviews: num(countEl?.getAttribute("aria-label") || (box?.textContent.match(/\(([\d’'.,\s]+)\)/) || [])[1]) ?? 0,
      category: document.querySelector("button.DkEaL")?.textContent.trim() || "",
      website: document.querySelector("a[data-item-id='authority']")?.href || "",
      address: document.querySelector("button[data-item-id='address']")?.getAttribute("aria-label")?.replace(/^[^:]+:\s*/, "") || "",
      phone: document.querySelector("button[data-item-id^='phone']")?.getAttribute("aria-label")?.replace(/^[^:]+:\s*/, "") || "",
      url: location.href,
    }] };
  }
  const cards = [...document.querySelectorAll("div[role='feed'] > div > div:has(a.hfpxzc)")].slice(0, 8);
  return { kind: cards.length ? "list" : "none", items: cards.map((c) => ({
    name: c.querySelector("a.hfpxzc")?.getAttribute("aria-label") || "",
    rating: num(c.querySelector("span.MW4etd")?.textContent),
    reviews: num(c.querySelector("span.UY7F9")?.textContent) ?? 0,
    category: (c.querySelector(".W4Efsd .W4Efsd span span")?.textContent || "").trim(),
    website: c.querySelector("a[data-value='Website'], a[aria-label*='Website']")?.href || "",
    address: "",
    phone: c.querySelector("span.UsdlK")?.textContent || "",
    url: c.querySelector("a.hfpxzc")?.href || "",
  })) };
}

const cfg = new Configuration({ persistStorage: false, purgeOnStart: true, systemInfoV2: false, memoryMbytes: Math.round(os.totalmem() / 1048576 / 2) });
const events = new LocalEventManager(cfg);
events.getMemoryInfo = async () => { const t = os.totalmem(), f = os.freemem(); return { totalBytes: t, freeBytes: f, usedBytes: t - f, mainProcessBytes: process.memoryUsage().rss, childProcessesBytes: 0 }; };
cfg.useEventManager(events);

const out = fs.createWriteStream(OUT, { flags: "a" });
let n = 0, hits = 0;
const started = Date.now();
setInterval(() => console.log(`${new Date().toLocaleTimeString()} ${n}/${todo.length} matched ${hits} (${(n / ((Date.now() - started) / 60000)).toFixed(1)}/min)`), 30000).unref();
const write = (rec) => { out.write(JSON.stringify({ ...rec, checkedAt: new Date().toISOString() }) + "\n"); n++; if (rec.matched) hits++; };

const queue = await RequestQueue.open(null, { config: cfg });
await queue.addRequests(todo.map((l) => ({
  url: `https://www.google.com/maps/search/${encodeURIComponent(query(l))}?hl=de&gl=ch`,
  uniqueKey: l.domain, userData: { domain: l.domain, company: l.company, q: query(l) },
})));

const crawler = new PlaywrightCrawler({
  requestQueue: queue,
  maxConcurrency: CONC,
  minConcurrency: CONC,
  maxRequestRetries: 2,
  navigationTimeoutSecs: 40,
  requestHandlerTimeoutSecs: 60,
  launchContext: { launchOptions: { headless: true, args: ["--disable-gpu", "--lang=de-CH"] }, userAgent: UA },
  browserPoolOptions: { useFingerprints: false },
  preNavigationHooks: [async ({ page }, gotoOptions) => {
    gotoOptions.waitUntil = "domcontentloaded";
    // Decline Google's consent screen up front: SOCS is the "reject all" choice cookie.
    await page.context().addCookies([{ name: "SOCS", value: "CAESHAgBEhJnd3NfMjAyNDA1MDctMF9SQzEaAmRlIAEaBgiA_LOxBg", domain: ".google.com", path: "/" }]);
    await page.route("**/*", (r) => (["image", "media", "font"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  }],
  async requestHandler({ page, request }) {
    const { domain, company, q } = request.userData;
    if (page.url().includes("consent.google")) {
      await page.locator("form[action*='consent'] button").first().click().catch(() => {});
      await page.waitForURL(/maps/, { timeout: 15000 }).catch(() => {});
    }
    await page.waitForSelector("h1.DUwDvf, div[role='feed'], div.Q2vNVc, .fontHeadlineLarge", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(900);
    let res = await page.evaluate(readMaps);
    // A list whose first card is clearly ours: open it to read the full panel (website, phone, address).
    let pick = null;
    for (const it of res.items) {
      const score = sameSite(it.website, domain) ? 2 : nameScore(company, it.name);
      if (score >= 0.6 && (!pick || score > pick.score)) pick = { ...it, score };
    }
    if (res.kind === "list" && pick && pick.url) {
      await page.goto(pick.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.waitForSelector("h1.DUwDvf", { timeout: 12000 }).catch(() => {});
      const full = await page.evaluate(readMaps);
      if (full.kind === "place") pick = { ...full.items[0], score: sameSite(full.items[0].website, domain) ? 2 : pick.score };
    }
    write({
      domain, query: q, resultKind: res.kind, matched: !!pick,
      matchBy: pick ? (pick.score >= 2 ? "website" : "name") : null,
      ...(pick ? { name: pick.name, rating: pick.rating, reviews: pick.reviews, category: pick.category, website: pick.website, address: pick.address, mapsPhone: pick.phone, mapsUrl: pick.url } : {}),
      candidates: pick ? undefined : res.items.slice(0, 3).map((i) => i.name),
    });
  },
  async failedRequestHandler({ request }, err) {
    write({ domain: request.userData.domain, query: request.userData.q, matched: false, error: String(err?.message).split("\n")[0].slice(0, 140) });
  },
}, cfg);

await crawler.run();
out.end();
console.log(`done: ${n} looked up, ${hits} matched`);
