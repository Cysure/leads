// Fast pass over every lead: fetches the homepage as a non-JS crawler (Googlebot's first wave, GPTBot,
// ClaudeBot, PerplexityBot) sees it and parses it with Cheerio, plus robots.txt, sitemap and llms.txt.
// The Chromium pass (scan.mjs) adds the rendered view on top. Output: data/http.jsonl, resumable.
// Usage: node src/scan-http.mjs [--concurrency N] [--only a.ch,b.ch]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { Agent, fetch as undiciFetch } from "undici";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const CONC = Number(arg("concurrency", 40));
const ONLY = arg("only", "") ? new Set(arg("only").split(",")) : null;
const OUT = path.join(root, "data", "http.jsonl");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "CCBot", "Applebot-Extended"];

const leads = JSON.parse(fs.readFileSync(path.join(root, "data", "leads.json"), "utf8")).leads;
// --retry-failed: run again over domains whose last record failed for a reason other than "domain does not exist"
// (timeouts under load, certificate errors), with a longer timeout. The newer record wins when the data is read.
const RETRY = process.argv.includes("--retry-failed");
const TIMEOUT = Number(arg("timeout", RETRY ? 30000 : 15000));
const last = new Map();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, "utf8").split("\n")) if (l.trim()) { try { const r = JSON.parse(l); last.set(r.domain, r); } catch {} }
const retryable = (r) => r && !r.ok && !r.parked && !/ENOTFOUND/.test(r.error || "");
const todo = leads.map((l) => l.domain).filter((d) => (RETRY ? retryable(last.get(d)) : !last.has(d)) && (!ONLY || ONLY.has(d)));
const done = { size: last.size };
// A site with a broken certificate is still a live site (visitors see a warning): read it anyway and record the fault.
const insecure = new Agent({ connect: { rejectUnauthorized: false } });
const CERT = /CERT|SELF_SIGNED|LEAF_SIGNATURE|ALTNAME|SSL|TLS/i;
const out = fs.createWriteStream(OUT, { flags: "a" });
console.log(`${done.size} done, ${todo.length} to go, concurrency ${CONC}`);

async function get(url, ms = TIMEOUT, max = 1_500_000, allowBadCert = true) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "de-CH,de;q=0.9,en;q=0.8,fr;q=0.7" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, max);
    return { ok: res.ok, status: res.status, url: res.url, ms: Date.now() - t0, text: buf.toString("utf8"), headers: Object.fromEntries(res.headers), bytes: buf.length, redirected: res.redirected };
  } catch (e) {
    const code = String(e.cause?.code || e.name || e).slice(0, 60);
    if (allowBadCert && CERT.test(code)) {
      const r = await get2(url, ms, max);
      if (r.ok) return { ...r, certError: code };
    }
    return { ok: false, status: 0, error: code, ms: Date.now() - t0 };
  }
}
async function get2(url, ms, max) {
  const t0 = Date.now();
  try {
    const res = await undiciFetch(url, { dispatcher: insecure, headers: { "User-Agent": UA, "Accept-Language": "de-CH,de;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, max);
    return { ok: res.ok, status: res.status, url: res.url, ms: Date.now() - t0, text: buf.toString("utf8"), headers: Object.fromEntries(res.headers), bytes: buf.length };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.cause?.code || e.name || e).slice(0, 60) };
  }
}
const countWords = (t) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

function parse(html, pageUrl) {
  const $ = cheerio.load(html);
  const meta = (n) => ($(`meta[name="${n}"]`).attr("content") || $(`meta[property="${n}"]`).attr("content") || "").trim();
  const host = new URL(pageUrl).hostname.replace(/^www\./, "");
  const ld = [];
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const walk = (o) => { if (!o || typeof o !== "object") return; if (Array.isArray(o)) return o.forEach(walk); if (o["@type"]) ld.push(...[].concat(o["@type"])); if (o["@graph"]) walk(o["@graph"]); };
      walk(JSON.parse($(s).text()));
    } catch {}
  });
  const sameAs = [];
  $("a[href]").each((_, a) => { const h = $(a).attr("href") || ""; const m = h.match(/(linkedin|facebook|instagram|youtube|xing|twitter|tiktok)\.com/); if (m) sameAs.push(m[1]); });
  const links = $("a[href]").map((_, a) => { try { return new URL($(a).attr("href"), pageUrl); } catch { return null; } }).get().filter(Boolean);
  const internal = new Set(links.filter((u) => u.hostname.replace(/^www\./, "") === host).map((u) => u.pathname));
  const anchors = $("a").map((_, a) => `${$(a).text()} ${$(a).attr("href") || ""}`.toLowerCase()).get().join(" | ");
  const imgs = $("img");
  const htmlLow = html.slice(0, 600000);
  $("script, style, noscript, svg, template").remove();
  const body = $("body").text().replace(/\s+/g, " ").trim();
  const years = [...body.matchAll(/(?:©|copyright|\(c\))\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => +m[1]).filter((y) => y > 1995 && y < 2100);
  const CMS = [[/wp-content|wp-includes/, "WordPress"], [/static\.wixstatic|wix\.com/, "Wix"], [/jimdo/i, "Jimdo"], [/squarespace/, "Squarespace"], [/webflow/, "Webflow"], [/typo3/i, "TYPO3"], [/joomla/i, "Joomla"], [/drupal/i, "Drupal"], [/shopify/i, "Shopify"], [/framerusercontent|framer\.com/, "Framer"], [/hs-scripts|hubspot/, "HubSpot"], [/_next\/static|__NEXT_DATA__/, "Next.js"], [/contao/i, "Contao"], [/weebly/i, "Weebly"], [/webnode|homepage-baukasten|mywebsite-editor|strato|one\.com/i, "Site builder"]];
  return {
    title: $("title").first().text().trim(),
    description: meta("description"),
    h1: $("h1").map((_, h) => $(h).text().replace(/\s+/g, " ").trim()).get().filter(Boolean).slice(0, 3),
    h2Count: $("h2").length,
    canonical: $('link[rel="canonical"]').attr("href") || "",
    robotsMeta: meta("robots"),
    viewport: $('meta[name="viewport"]').length > 0,
    viewportContent: $('meta[name="viewport"]').attr("content") || "",
    lang: $("html").attr("lang") || "",
    hreflang: $('link[rel="alternate"][hreflang]').length,
    og: !!meta("og:title") && !!meta("og:image"),
    generator: meta("generator"),
    jsonLd: [...new Set(ld)],
    microdata: [...new Set($("[itemtype]").map((_, e) => ($(e).attr("itemtype") || "").split("/").pop()).get())],
    words: countWords(body),
    images: imgs.length,
    imagesNoAlt: imgs.filter((_, i) => !($(i).attr("alt") || "").trim()).length,
    internalLinks: internal.size,
    social: [...new Set(sameAs)],
    phone: /(\+41|\+49|\+43|0041|0049)[\s\d().\/-]{7,}|\b0\d{2}[\s\/.-]?\d{3}[\s.]?\d{2}[\s.]?\d{2}\b/.test(body),
    address: /\b\d{4,5}\s+[A-ZÄÖÜ][\p{L}.-]+/u.test(body),
    email: /[\w.+-]+@[\w-]+\.[\w.]+/.test(body) || /href=["']mailto:/i.test(htmlLow),
    contactPage: /kontakt|contact|impressum/.test(anchors),
    aboutPage: /über uns|ueber-uns|about|team|qui sommes|chi siamo|unternehmen/.test(anchors),
    blog: /blog|news|aktuell|magazin|actualit|insights|ratgeber|journal/.test(anchors),
    faq: /faq|häufige fragen/.test(anchors) || ld.includes("FAQPage"),
    reviewsWidget: /trustpilot|provenexpert|trustindex|elfsight|google-reviews|reviews-widget|kundenstimmen|testimonial|avis client/i.test(htmlLow),
    cookieBanner: /cookiebot|onetrust|usercentrics|borlabs|complianz|cookie-?consent|klaro|iubenda/i.test(htmlLow),
    analytics: /googletagmanager|google-analytics|gtag\(|matomo|plausible|clarity\.ms/i.test(htmlLow),
    copyrightYear: years.length ? Math.max(...years) : null,
    flash: /\.swf["']|application\/x-shockwave/i.test(htmlLow),
    frames: $("frameset, frame").length,
    tableLayout: $("table[width], td[bgcolor], font").length,
    cms: (CMS.find(([rx]) => rx.test(htmlLow)) || [, ""])[1],
    spaShell: countWords(body) < 60 && /id=["'](root|app|__next|__nuxt)["']/i.test(htmlLow),
  };
}

function softRedirect(html, base) {
  const head = html.slice(0, 20000);
  const words = countWords(head.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
  let m = head.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d+\s*;\s*url\s*=\s*['"]?([^"'>\s]+)/i);
  if (!m && words < 80) m = head.match(/(?:window\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']|location\.replace\(\s*["']([^"']+)["']/i);
  const target = m && (m[1] || m[2]);
  if (!target) return null;
  try { const u = new URL(target, base); return u.href !== base && /^https?:/.test(u.protocol) ? u.href : null; } catch { return null; }
}

// Parked, for-sale, placeholder and hosting default pages are not a website to score: they are a pitch of their own.
const PARKED = [
  [/domain (ist|is) (bereits )?(registriert|reserviert|registered|reserved)|diese domain (wurde|ist)|this domain (is|may be) for sale|domain (kaufen|zu verkaufen|for sale)|buy this domain|sedoparking|parkingcrew|bodis\.com|dan\.com\/buy|hugedomains|afternic|domain parking|parked (free|domain)/i, "Parked or for-sale domain"],
  [/(website|webseite|site|seite) (is |ist |befindet sich )?(under construction|im aufbau|in bearbeitung|en construction|in costruzione)|coming soon|bald verfügbar|wir sind bald|demnächst online|neue (website|webseite) (folgt|kommt)/i, "Placeholder / under construction"],
  [/apache2? (ubuntu |debian )?default page|welcome to nginx|it works!|plesk (obsidian|onyx)|default web site page|cpanel|iis windows server|webhosting.{0,40}(eingerichtet|activated)|this site can.?t be reached|web server is returning an unknown error/i, "Hosting default page"],
];
function parkedReason(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const text = `${$("title").text()} ${$("h1, h2").text()} ${$("body").text()}`.replace(/\s+/g, " ").slice(0, 8000);
  const words = countWords(text);
  for (const [rx, reason] of PARKED) if (rx.test(text) && (words < 400 || reason !== "Placeholder / under construction")) return reason;
  return null;
}

async function scanOne(domain) {
  let home = await get(`https://${domain}/`);
  let httpsOk = home.ok;
  if (!home.ok) {
    const alt = await get(`https://www.${domain}/`);
    if (alt.ok) home = alt;
    else { const h = await get(`http://${domain}/`); if (h.ok) home = h; httpsOk = false; }
  }
  if (!home.ok || !home.text) return { domain, ok: false, status: home.status, error: home.error || `HTTP ${home.status}` };
  // Follow meta-refresh / script redirects ("Redirecting to /en/") up to two hops, as a browser would.
  for (let hop = 0; hop < 2; hop++) {
    const next = softRedirect(home.text, home.url);
    if (!next) break;
    const n = await get(next);
    if (!n.ok || !n.text) break;
    home = n;
  }
  const finalUrl = home.url;
  const parked = parkedReason(home.text);
  if (parked) return { domain, ok: false, parked, status: home.status, finalUrl, error: parked };
  const origin = new URL(finalUrl).origin;
  const facts = parse(home.text, finalUrl);
  const [robots, llms] = await Promise.all([get(origin + "/robots.txt", 10000, 300_000), get(origin + "/llms.txt", 10000, 60_000)]);
  const robotsOk = robots.ok && !/<html/i.test(robots.text.slice(0, 500));
  let sitemaps = [], blocksAll = false, aiBlocked = [];
  if (robotsOk) {
    const rp = robotsParser(origin + "/robots.txt", robots.text);
    sitemaps = rp.getSitemaps();
    blocksAll = rp.isDisallowed(origin + "/", "Googlebot") === true;
    aiBlocked = AI_BOTS.filter((b) => rp.isDisallowed(origin + "/", b) === true);
  }
  let sitemap = null;
  for (const u of [...new Set([...sitemaps, origin + "/sitemap.xml", origin + "/sitemap_index.xml", origin + "/wp-sitemap.xml"])].slice(0, 4)) {
    const s = await get(u, 10000, 3_000_000);
    if (s.ok && /<(urlset|sitemapindex)/i.test(s.text)) {
      const mods = [...s.text.matchAll(/<lastmod>\s*(\d{4}-\d{2}-\d{2})/gi)].map((m) => m[1]).sort();
      sitemap = { url: s.url, entries: (s.text.match(/<loc>/gi) || []).length, index: /<sitemapindex/i.test(s.text), lastmod: mods.at(-1) || null };
      break;
    }
  }
  return {
    domain, ok: true, status: home.status, finalUrl, https: finalUrl.startsWith("https:"), httpsOk,
    offDomain: !new URL(finalUrl).hostname.endsWith(domain.replace(/^www\./, "")),
    certError: home.certError || null, ttfbMs: home.ms, htmlBytes: home.bytes, server: home.headers.server || "", poweredBy: home.headers["x-powered-by"] || "",
    hsts: !!home.headers["strict-transport-security"], ...facts,
    robotsTxt: robotsOk, blocksAll, aiBlocked, llmsTxt: llms.ok && llms.text.length > 40 && !/<html/i.test(llms.text.slice(0, 500)), sitemap,
  };
}

let n = 0;
const started = Date.now();
const tick = setInterval(() => console.log(`${new Date().toLocaleTimeString()} ${n}/${todo.length} (${(n / ((Date.now() - started) / 60000)).toFixed(0)}/min)`), 30000);
let i = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < todo.length) {
    const d = todo[i++];
    let rec;
    try { rec = await scanOne(d); } catch (e) { rec = { domain: d, ok: false, error: String(e.message).slice(0, 140) }; }
    out.write(JSON.stringify({ ...rec, scannedAt: new Date().toISOString() }) + "\n");
    n++;
  }
}));
clearInterval(tick);
out.end();
console.log(`done: ${n}`);
