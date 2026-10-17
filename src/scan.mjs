// Rendered pass: loads every lead's homepage in Chromium (Crawlee + Playwright) for what only a browser sees:
// JS-built content, mobile layout, load time, the calls-to-action (cta.browser.js) on phone and desktop, and
// screenshots of both (data/shots/<domain>-m.jpg / -d.jpg). scan-http.mjs does the crawler view.
// One JSON line per domain goes to data/scans.jsonl; domains with a finished v2 record are skipped, so it resumes.
// Usage: node src/scan.mjs [--limit N] [--concurrency N] [--only a.ch,b.ch] [--from order.json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Configuration, LocalEventManager, PlaywrightCrawler, RequestQueue, log, LogLevel } from "crawlee";

log.setLevel(LogLevel.ERROR);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg("limit", 1e9));
const CONC = Number(arg("concurrency", 14));
const ONLY = arg("only", "") ? new Set(arg("only").split(",")) : null;
const OUT = path.join(root, "data", "scans.jsonl");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SHOTS = path.join(root, "data", "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const CTA_JS = fs.readFileSync(path.join(root, "src", "cta.browser.js"), "utf8").replace(/^\/\/.*\n/gm, "");

const leads = JSON.parse(fs.readFileSync(path.join(root, "data", "leads.json"), "utf8")).leads;
// v2 records carry screenshots + CTA data; older records get redone. Failed domains are not retried.
const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.v === 2 || !r.ok).map((r) => r.domain) : []);
let todo = leads.map((l) => l.domain).filter((d) => !done.has(d) && (!ONLY || ONLY.has(d)));
if (arg("from")) { const rank = new Map(JSON.parse(fs.readFileSync(arg("from"), "utf8")).map((d, i) => [d, i])); todo.sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9)); }
todo = todo.slice(0, LIMIT);
const out = fs.createWriteStream(OUT, { flags: "a" });
console.log(`${done.size} already scanned, ${todo.length} to go, concurrency ${CONC}`);

// Runs in the page after load. Keep it self-contained.
function extract() {
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const meta = (n) => (q(`meta[name="${n}" i]`) || q(`meta[property="${n}" i]`))?.content?.trim() || "";
  const body = document.body?.innerText || "";
  const host = location.hostname.replace(/^www\./, "");
  const links = qa("a[href]").map((a) => { try { return new URL(a.href, location.href); } catch { return null; } }).filter(Boolean);
  const internal = links.filter((u) => u.hostname.replace(/^www\./, "") === host);
  const ext = links.filter((u) => u.hostname && u.hostname.replace(/^www\./, "") !== host);
  const ld = [];
  for (const s of qa('script[type="application/ld+json"]')) {
    try {
      const walk = (o) => { if (!o || typeof o !== "object") return; if (Array.isArray(o)) return o.forEach(walk); if (o["@type"]) ld.push(...[].concat(o["@type"])); if (o["@graph"]) walk(o["@graph"]); };
      walk(JSON.parse(s.textContent));
    } catch {}
  }
  const micro = qa("[itemtype]").map((e) => e.getAttribute("itemtype").split("/").pop());
  const imgs = qa("img");
  const paths = internal.map((u) => (u.pathname + " " + (u.textContent || "")).toLowerCase());
  const anchorText = qa("a").map((a) => (a.textContent || "").toLowerCase() + " " + (a.getAttribute("href") || "").toLowerCase()).join(" | ");
  const has = (rx) => rx.test(anchorText);
  const years = [...body.matchAll(/(?:©|copyright|\(c\))\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => +m[1]).filter((y) => y > 1995 && y < 2100);
  const social = [...new Set(ext.map((u) => (u.hostname.match(/(linkedin|facebook|instagram|youtube|xing|twitter|x|tiktok)\.com/) || [])[1]).filter(Boolean))];
  return {
    finalUrl: location.href,
    title: document.title.trim(),
    description: meta("description"),
    h1: qa("h1").map((h) => h.innerText.trim()).filter(Boolean).slice(0, 3),
    h2Count: qa("h2").length,
    canonical: q('link[rel="canonical"]')?.href || "",
    robotsMeta: meta("robots"),
    viewport: !!q('meta[name="viewport"]'),
    lang: document.documentElement.lang || "",
    hreflang: qa('link[rel="alternate"][hreflang]').length,
    og: !!meta("og:title") && !!meta("og:image"),
    generator: meta("generator"),
    jsonLd: [...new Set(ld)],
    microdata: [...new Set(micro)],
    words: (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length,
    images: imgs.length,
    imagesNoAlt: imgs.filter((i) => !(i.getAttribute("alt") || "").trim()).length,
    internalLinks: new Set(internal.map((u) => u.pathname)).size,
    social,
    phone: /(\+41|\+49|\+43|0041|0049)[\s\d().\/-]{7,}|\b0\d{2}[\s\/.-]?\d{3}[\s.]?\d{2}[\s.]?\d{2}\b/.test(body),
    address: /\b\d{4,5}\s+[A-ZÄÖÜ][\p{L}.-]+/u.test(body),
    email: /[\w.+-]+@[\w-]+\.[\w.]+/.test(body) || !!q('a[href^="mailto:"]'),
    contactPage: has(/kontakt|contact|impressum/),
    aboutPage: has(/über uns|ueber-uns|about|team|qui sommes|chi siamo|unternehmen/),
    blog: has(/blog|news|aktuell|magazin|actualit|insights|ratgeber|journal/),
    faq: has(/faq|häufige fragen|questions/) || ld.includes("FAQPage"),
    reviewsWidget: /trustpilot|provenexpert|trustindex|elfsight|google-reviews|reviews-widget|kundenstimmen|testimonial|avis client/i.test(document.documentElement.innerHTML.slice(0, 400000)),
    cookieBanner: /cookiebot|onetrust|usercentrics|borlabs|complianz|cookie-?consent|klaro|iubenda/i.test(document.documentElement.innerHTML.slice(0, 400000)),
    copyrightYear: years.length ? Math.max(...years) : null,
    flash: !!q('object[type*="flash"], embed[src$=".swf"]'),
    tables: qa("table").length,
    frames: qa("frameset, frame").length,
    forms: qa("form").length,
    cms: (() => {
      const h = document.documentElement.innerHTML.slice(0, 300000);
      for (const [rx, n] of [[/wp-content|wp-includes/, "WordPress"], [/static\.wixstatic|wix\.com/, "Wix"], [/jimdo/, "Jimdo"], [/squarespace/, "Squarespace"], [/webflow/, "Webflow"], [/typo3/i, "TYPO3"], [/joomla/i, "Joomla"], [/drupal/i, "Drupal"], [/shopify/, "Shopify"], [/framer/, "Framer"], [/hubspot/, "HubSpot"], [/__next|_next\/static/, "Next.js"], [/contao/i, "Contao"], [/weebly/, "Weebly"], [/one\.com|webnode|homepage-baukasten|ionos|mywebsite|strato/i, "Site builder"]])
        if (rx.test(h)) return n;
      return "";
    })(),
  };
}

const cfg = new Configuration({ persistStorage: false, purgeOnStart: true, systemInfoV2: false, memoryMbytes: Math.round(os.totalmem() / 1048576 / 2) });
const events = new LocalEventManager(cfg);
events.getMemoryInfo = async () => { const t = os.totalmem(), f = os.freemem(); return { totalBytes: t, freeBytes: f, usedBytes: t - f, mainProcessBytes: process.memoryUsage().rss, childProcessesBytes: 0 }; };
cfg.useEventManager(events);

let n = 0;
const write = (rec) => { out.write(JSON.stringify({ ...rec, scannedAt: new Date().toISOString() }) + "\n"); ++n; };
const started = Date.now();
setInterval(() => console.log(`${new Date().toLocaleTimeString()} ${n}/${todo.length} (${(n / ((Date.now() - started) / 60000)).toFixed(1)}/min)`), 30000).unref();

const queue = await RequestQueue.open(null, { config: cfg });
await queue.addRequests(todo.map((d) => ({ url: `https://${d}/`, uniqueKey: d, userData: { domain: d } })));

const crawler = new PlaywrightCrawler({
  requestQueue: queue,
  maxConcurrency: CONC,
  minConcurrency: CONC,
  maxRequestRetries: 1,
  navigationTimeoutSecs: 30,
  requestHandlerTimeoutSecs: 90,
  launchContext: { launchOptions: { headless: true, args: ["--disable-gpu", "--ignore-certificate-errors"] }, userAgent: UA },
  browserPoolOptions: { useFingerprints: false },
  preNavigationHooks: [async ({ page, request }, gotoOptions) => {
    gotoOptions.waitUntil = "domcontentloaded";
    await page.setViewportSize({ width: 390, height: 844 }); // phone viewport: mobile-first indexing
    request.userData.bytes = 0;
    page.on("response", async (r) => { const l = Number(r.headers()["content-length"] || 0); request.userData.bytes += l; });
    // Images and fonts load (the screenshots must look like the real site); video and audio do not.
    await page.route("**/*", (route) => (route.request().resourceType() === "media" ? route.abort() : route.continue()));
  }],
  async requestHandler({ page, request, response }) {
    const { domain } = request.userData;
    const t0 = Date.now();
    await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
    const loadMs = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return n ? Math.round(n.loadEventEnd || n.domContentLoadedEventEnd) : null; }).catch(() => null);
    await page.waitForTimeout(1200); // sliders, consent banners and lazy heroes settle
    const facts = await page.evaluate(extract);
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 8).catch(() => null);
    // Phone first: CTAs as a visitor sees them (consent banner included), then the screenshot.
    const ctaMobile = await page.evaluate(`(${CTA_JS})()`).catch((e) => ({ error: String(e.message).slice(0, 100) }));
    const shot = async (suffix, height) => {
      const dims = await page.evaluate(() => ({ w: innerWidth, h: document.documentElement.scrollHeight }));
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(SHOTS, `${domain}-${suffix}.jpg`), type: "jpeg", quality: 62, clip: { x: 0, y: 0, width: dims.w, height: Math.min(height, dims.h) }, timeout: 15000 }).catch(() => {});
      return fs.existsSync(path.join(SHOTS, `${domain}-${suffix}.jpg`));
    };
    const shotM = await shot("m", 1600);
    await page.setViewportSize({ width: 1366, height: 800 });
    await page.waitForTimeout(700);
    const ctaDesktop = await page.evaluate(`(${CTA_JS})()`).catch((e) => ({ error: String(e.message).slice(0, 100) }));
    const shotD = await shot("d", 2200);
    write({ v: 2, domain, ok: true, status: response?.status() ?? 0, https: facts.finalUrl.startsWith("https:"), loadMs, mobileOverflow, bytes: request.userData.bytes,
      ...facts, ctaMobile, ctaDesktop, shots: { m: shotM, d: shotD }, handlerMs: Date.now() - t0 });
  },
  async failedRequestHandler({ request }, err) {
    const { domain } = request.userData;
    write({ domain, ok: false, error: String(err?.message).split("\n")[0].slice(0, 140) });
  },
}, cfg);

await crawler.run();
out.end();
console.log(`done: ${n} scanned`);
