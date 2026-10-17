// Scoring + call forecast. Shared by the server (ranking on load) and the dashboard (live re-ranking when
// the forecast assumptions change). Every number here is a rule-based estimate from what the scans saw,
// not a measured ranking position: label it that way wherever it is shown.

export const DEFAULTS = {
  invisibleBelow: 60,      // visibility score under which a site counts as "not visible"
  websiteChf: 5000,        // average website deal
  scaleBySize: 0,          // 1 = price bigger companies higher (0.7× to 1.8×), 0 = flat average
  emailReplyBase: 0.025,   // positive replies to the cold email, average lead
  meetingPerReply: 0.5,    // replies that turn into a meeting
  pConnectDirect: 0.42,    // reach the decision-maker per call on their direct line
  pConnectSwitch: 0.26,    // reach them per call through the company number
  callAttempts: 3,         // calls per lead before giving up
  pMeetingBase: 0.16,      // meeting booked per conversation, average lead
  emailWarmUplift: 1.2,    // the call follows our email
  pWinBase: 0.24,          // won per meeting held
  usdChf: 0.82,            // currency for D&B revenue
  eurChf: 0.94,
};

/** Per-industry revenue per employee (CHF), calibrated on the leads that have both D&B revenue and staff counts. */
export function revenueBenchmarks(leads, A = DEFAULTS) {
  const by = {}, all = [];
  for (const l of leads) {
    if (!l.revenue_usd || !l.employees || l.employees < 1) continue;
    const v = (l.revenue_usd * A.usdChf) / l.employees;
    all.push(v);
    (by[l.industry || "?"] ||= []).push(v);
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const out = { overall: all.length ? med(all) : 180000, byIndustry: {} };
  for (const [k, v] of Object.entries(by)) if (v.length >= 8) out.byIndustry[k] = med(v);
  return out;
}

/** Annual revenue estimate in CHF with a range and where it comes from. */
export function estimateRevenue(lead, bench, A = DEFAULTS) {
  const perFte = (bench?.byIndustry?.[lead.industry] ?? bench?.overall ?? 180000);
  const r = (chf, basis, conf) => {
    const [lo, hi] = conf === "high" ? [0.8, 1.25] : conf === "medium" ? [0.6, 1.6] : [0.35, 2.5];
    return { chf: Math.round(chf), low: Math.round(chf * lo), high: Math.round(chf * hi), basis, confidence: conf };
  };
  if (lead.revenue_usd > 0) return r(lead.revenue_usd * A.usdChf, "D&B figure", "high");
  const band = (lead.revenue_eur_m_band || "").match(/(?:bis\s*(\d+))|(\d+)\s*-\s*(\d+)/i);
  if (band) {
    const lo = band[1] ? 0 : +band[2], hi = +(band[1] || band[3]);
    const fromStaff = lead.employees ? lead.employees * perFte / A.eurChf : null;
    const mid = fromStaff ? Math.min(hi * 1e6, Math.max(lo * 1e6, fromStaff)) : (lo + hi) / 2 * 1e6;
    return r(mid * A.eurChf, `Wer-zu-Wem band €${band[1] ? "0-" + hi : lo + "-" + hi}M`, "medium");
  }
  if (lead.employees > 0) return r(lead.employees * perFte, `${Math.round(lead.employees)} staff × industry median`, "medium");
  const mid = bandMid(lead.employees_band);
  if (mid) return r(mid * perFte, `${lead.employees_band.replace(/^\D*\(/, "").replace(")", "")} × industry median`, "low");
  if (lead.hiring) return r(15 * perFte, "LinkedIn 1–50 staff, assumed ~15", "low");
  return r(8 * perFte, "no size data, typical SME assumed", "low");
}
export const fmtChf = (n) => n >= 1e6 ? `CHF ${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `CHF ${Math.round(n / 1000)}k`;

const clamp = (n, a = 0, b = 100) => Math.max(a, Math.min(b, Math.round(n)));
const YEAR = new Date().getFullYear();

/** One finding: area, points lost, short label, and the sentence a salesperson can say. */
const F = (area, pts, label, say) => ({ area, pts, label, say });

export function audit(h, r, m) {
  // h = HTTP pass (what Google's first wave and AI crawlers read), r = rendered pass, m = Google Maps listing.
  const seo = [], geo = [];
  const v = { ...(h || {}), ...(r && r.ok ? pickRendered(r) : {}) };
  const rawWords = h?.ok ? h.words : 0;
  // A fixed-width viewport (width=1024) is a desktop page squeezed onto a phone.
  if (h?.ok && h.viewportContent && !/device-width/i.test(h.viewportContent)) v.viewport = false;

  if (h?.certError) seo.push(F("seo", 22, "Broken HTTPS certificate", `Browsers show a security warning before the site opens (${/EXPIRED/.test(h.certError) ? "the certificate has expired" : /ALTNAME/.test(h.certError) ? "the certificate is for another domain" : "the certificate is not trusted"}); most visitors leave and Google drops it.`));
  if (!v.https) seo.push(F("seo", 15, "No HTTPS", "The site still loads without encryption, Chrome marks it as not secure and Google ranks it lower."));
  if (!v.title) seo.push(F("seo", 15, "No page title", "The homepage has no title, so Google shows whatever it guesses in the results."));
  else if (/^(home|startseite|willkommen|accueil|index|untitled|welcome)\b/i.test(v.title.trim()) || v.title.length < 15)
    seo.push(F("seo", 7, "Generic page title", `The Google headline is just "${v.title.slice(0, 40)}", which says nothing about what they offer.`));
  else if (v.title.length > 75) seo.push(F("seo", 3, "Title too long", "The page title gets cut off in Google."));
  if (!v.description) seo.push(F("seo", 10, "No meta description", "Google has no summary to show under their link, so it picks random text."));
  if (!v.h1?.length) seo.push(F("seo", 9, "No H1 heading", "The homepage has no main heading telling Google what the business is."));
  if (/noindex/i.test(v.robotsMeta || "") || h?.blocksAll) seo.push(F("seo", 40, "Blocked from Google", "The homepage tells Google not to index it. It cannot appear in search at all."));
  if (!v.viewport) seo.push(F("seo", 14, "Not mobile-ready", "No mobile viewport: on a phone the site shows as a shrunken desktop page, and Google ranks mobile-first."));
  if (r?.ok && r.mobileOverflow) seo.push(F("seo", 7, "Breaks on mobile", "On a phone the page scrolls sideways; content is wider than the screen."));
  if (h?.ok && !h.sitemap) seo.push(F("seo", 7, "No XML sitemap", "No sitemap, so Google has to discover pages on its own."));
  if (h?.ok && !h.robotsTxt) seo.push(F("seo", 3, "No robots.txt", "No robots.txt file pointing crawlers to the sitemap."));
  if (!v.canonical) seo.push(F("seo", 3, "No canonical tag", "No canonical URL, so duplicate versions of pages compete with each other."));
  if ((v.words || 0) < 150) seo.push(F("seo", 10, "Thin homepage content", `Only about ${v.words || 0} words on the homepage, too little for Google to rank it for anything.`));
  else if (v.words < 300) seo.push(F("seo", 4, "Light homepage content", `About ${v.words} words on the homepage; competitors usually have far more.`));
  if (v.images >= 4 && v.imagesNoAlt / v.images > 0.5) seo.push(F("seo", 4, "Images without alt text", `${v.imagesNoAlt} of ${v.images} images have no description for Google Images or screen readers.`));
  if ((v.internalLinks || 0) < 5) seo.push(F("seo", 5, "Few internal links", "The homepage links to almost no other pages, so most of the site stays invisible."));
  if (!v.lang) seo.push(F("seo", 2, "No language set", "The page does not declare its language."));
  if (!v.og) seo.push(F("seo", 2, "No social preview", "Shared on LinkedIn or WhatsApp, the link shows no image or title."));
  if (h?.ttfbMs > 2500) seo.push(F("seo", 5, "Slow server", `The server needs ${(h.ttfbMs / 1000).toFixed(1)} s before it answers.`));
  if (r?.ok && r.loadMs > 7000) seo.push(F("seo", 6, "Slow page", `The homepage takes ${(r.loadMs / 1000).toFixed(1)} s to load on mobile.`));
  if (!v.blog) seo.push(F("seo", 3, "No news or blog", "Nothing new gets published, so there is no fresh content for Google to pick up."));
  const lastmod = h?.sitemap?.lastmod ? +h.sitemap.lastmod.slice(0, 4) : null;
  const stale = (v.copyrightYear && v.copyrightYear < YEAR - 2) || (lastmod && lastmod < YEAR - 2);
  if (stale) seo.push(F("seo", 5, "Not updated in years", `Last visible update ${Math.min(...[v.copyrightYear, lastmod].filter(Boolean))}.`));
  if (h?.spaShell) seo.push(F("seo", 6, "Content needs JavaScript", "The server sends an empty page shell; content appears only after scripts run."));
  if (v.flash || v.frames || (h?.tableLayout || 0) > 8) seo.push(F("seo", 12, "Outdated build", "Built with frames, tables or Flash-era techniques, a sign the site is 10+ years old."));
  if (h?.ok && h.offDomain) seo.push(F("seo", 8, "Domain redirects away", `The domain forwards to ${safeHost(h.finalUrl)}, so its own name builds no ranking.`));

  // GEO: can ChatGPT, Claude, Perplexity and Google's AI answers read, trust and cite this business?
  const types = new Set([...(v.jsonLd || []), ...(v.microdata || [])]);
  const org = [...types].some((t) => /Organization|LocalBusiness|Corporation|Store|Service|Professional|Dentist|Attorney|Accounting|Restaurant|Hotel|Medical|Contractor|Agent/i.test(t));
  if (h?.aiBlocked?.length >= 3) geo.push(F("geo", 28, "Blocks AI assistants", `robots.txt shuts out ${h.aiBlocked.slice(0, 3).join(", ")}: ChatGPT and Claude cannot read the site.`));
  else if (h?.aiBlocked?.length) geo.push(F("geo", 12, "Blocks some AI crawlers", `robots.txt blocks ${h.aiBlocked.join(", ")}.`));
  if (!types.size) geo.push(F("geo", 18, "No structured data", "No schema.org markup, so AI assistants cannot reliably tell who they are, where and what they do."));
  else if (!org) geo.push(F("geo", 9, "No business schema", "Structured data exists, but none says what kind of business this is."));
  if (h?.ok && rawWords < 150 && !(h.status === 429 || h.status === 403))
    geo.push(F("geo", 18, "Invisible without JavaScript", `AI crawlers do not run scripts; they see only ${rawWords} words on the homepage.`));
  if (!v.phone) geo.push(F("geo", 5, "No phone on homepage", "No phone number on the homepage for assistants to quote."));
  if (!v.address) geo.push(F("geo", 6, "No address on homepage", "No address on the homepage, so the business is hard to place for \"near me\" answers."));
  if (!v.aboutPage) geo.push(F("geo", 5, "No about page", "No about or team page that AI can use to describe the company."));
  if (!v.faq) geo.push(F("geo", 6, "No FAQ", "No FAQ: AI answers are built from question-and-answer content, and they have none."));
  if (!(v.social || []).length) geo.push(F("geo", 4, "No social profiles linked", "No links to LinkedIn or other profiles that confirm the company to AI systems."));
  if (!v.description) geo.push(F("geo", 4, "No summary for AI", "No meta description, the sentence AI tools most often quote."));
  if (h?.ok && !h.llmsTxt) geo.push(F("geo", 3, "No llms.txt", "No llms.txt guide for AI crawlers (early adopters have one)."));
  if (m && m.matched === false && !m.error) geo.push(F("geo", 12, "Not on Google Maps", "No Google Business Profile found, so they miss local search and AI \"near me\" answers."));
  else if (m?.matched) {
    if (!m.website) geo.push(F("geo", 5, "Maps profile has no website", "Their Google Maps listing does not link to the website."));
    if ((m.reviews || 0) < 5) geo.push(F("geo", 6, "Almost no reviews", `${m.reviews || 0} Google reviews: assistants recommend businesses with proof.`));
  }
  const seoScore = clamp(100 - seo.reduce((s, f) => s + f.pts, 0));
  const geoScore = clamp(100 - geo.reduce((s, f) => s + f.pts, 0));
  const relaunch = seoScore < 45 || !v.viewport || seo.some((f) => f.label === "Outdated build") || (stale && seoScore < 65);
  // Hard stops: a security warning or a noindex keeps people (or Google) out, whatever else the site does well.
  let visibility = clamp(0.55 * seoScore + 0.45 * geoScore);
  if (h?.certError) visibility = Math.min(visibility, 45);
  if (/noindex/i.test(v.robotsMeta || "") || h?.blocksAll) visibility = Math.min(visibility, 30);
  return { seo, geo, seoScore, geoScore, visibility, relaunch, cms: v.cms || "", stale: !!stale };
}

function pickRendered(r) {
  // Rendered values win where a browser sees more (JS-built pages), raw values stay for crawler-only checks.
  const o = {};
  for (const k of ["title", "description", "h1", "canonical", "robotsMeta", "viewport", "lang", "og", "jsonLd", "microdata", "words", "images", "imagesNoAlt", "internalLinks", "social", "phone", "address", "email", "contactPage", "aboutPage", "blog", "faq", "copyrightYear", "cms"])
    if (r[k] !== undefined && r[k] !== "" && !(Array.isArray(r[k]) && !r[k].length)) o[k] = r[k];
  if (r.finalUrl) o.https = r.finalUrl.startsWith("https:");
  return o;
}
const safeHost = (u) => { try { return new URL(u).hostname; } catch { return u; } };

export function reviewSignal(m) {
  if (!m?.matched || !m.rating) return { strength: 0, label: m?.matched ? "Listed, no reviews" : m ? "Not on Maps" : "Not checked" };
  const strength = Math.min(1, Math.log10((m.reviews || 0) + 1) / 2) * (m.rating / 5);
  const label = m.rating >= 4.5 && m.reviews >= 10 ? "Loved locally" : m.rating < 4 && m.reviews >= 5 ? "Reputation risk" : "Some reviews";
  return { strength, label };
}

export function fit(lead, m, rev) {
  const c = lead.contacts?.[0] || {};
  let s = 40;
  const why = [];
  if (c.seniority >= 90) { s += 18; why.push("decision-maker"); } else if (c.seniority >= 70) { s += 8; why.push("senior contact"); }
  if (c.email && lead.domain && c.email.toLowerCase().endsWith("@" + lead.domain) && !GENERIC.test(c.email)) s += 6;
  else if (GENERIC.test(c.email || "")) s -= 4;
  const phone = c.phone || lead.phone || m?.mapsPhone;
  if (c.phone) { s += 10; why.push("direct line"); } else if (phone) s += 5; else { s -= 12; why.push("no phone"); }
  const emp = lead.employees ?? bandMid(lead.employees_band);
  if (emp != null) {
    if (emp >= 5 && emp <= 80) { s += 10; why.push(`${Math.round(emp)} staff`); }
    else if (emp > 80 && emp <= 250) s += 5;
    else if (emp > 250) { s -= 4; why.push("large, slower cycle"); }
    else s -= 4;
  }
  // Budget: a 5k website is easy to sign off from about CHF 0.5M revenue; tiny companies hesitate.
  if (rev) { if (rev.chf >= 5e5 && rev.chf <= 5e7) s += 6; else if (rev.chf < 2.5e5) { s -= 8; why.push("small budget"); } }
  if (lead.hiring) { s += 8; why.push("hiring"); }
  if (/switzerland/i.test(lead.country || "") || /\.ch$/.test(lead.domain)) s += 4;
  s += Math.round(reviewSignal(m).strength * 10);
  return { score: clamp(s), why, phone, emp };
}
const GENERIC = /^(info|office|kontakt|contact|hello|mail|admin|sekretariat|empfang|reception)@/i;
const bandMid = (b) => { const m = (b || "").match(/(\d+)\s*-\s*(\d+)/); return m ? (Number(m[1]) + Number(m[2])) / 2 : null; };

/**
 * Close forecast for one lead. Everyone gets the email; tiers A and B also get calls. The two channels are
 * treated as independent tries: P(close) = 1 − (1 − P(close via email)) × (1 − P(close via calls)).
 */
export function forecast(lead, gap, fitR, rev, called, A = DEFAULTS, opts = {}) {
  const c = lead.contacts?.[0] || {};
  const seniorF = c.seniority >= 90 ? 1.15 : 0.85;
  const sizeF = fitR.emp == null ? 1 : fitR.emp < 3 ? 0.6 : fitR.emp <= 80 ? 1.1 : fitR.emp <= 250 ? 0.9 : 0.7;
  const budgetF = rev.chf < 2.5e5 ? 0.6 : rev.chf < 5e5 ? 0.85 : 1;
  const pWin = Math.min(0.5, A.pWinBase * sizeF * budgetF);
  // Email: a personal address reads it, info@ mostly does not; a dead domain bounces.
  const mailF = !c.email ? 0 : opts.bounce ? 0 : GENERIC.test(c.email) ? 0.55 : 1.15;
  const pReply = Math.min(0.15, A.emailReplyBase * (0.4 + 1.2 * gap) * seniorF * mailF * (lead.hiring ? 1.1 : 1));
  const pEmailClose = pReply * A.meetingPerReply * pWin;
  // Calls: reach within N attempts, then a meeting, then a win.
  const pConnect = c.phone ? A.pConnectDirect : fitR.phone ? A.pConnectSwitch : 0;
  const pReach = called ? 1 - Math.pow(1 - pConnect, A.callAttempts) : 0;
  const pMeetIfReached = Math.min(0.5, A.pMeetingBase * (0.55 + 0.9 * gap) * seniorF * (lead.hiring ? 1.1 : 1) * A.emailWarmUplift);
  const pCallClose = pReach * pMeetIfReached * pWin;
  const pClose = 1 - (1 - pEmailClose) * (1 - pCallClose);
  const sizeMult = !A.scaleBySize ? 1 : rev.chf < 5e5 ? 0.7 : rev.chf < 2e6 ? 0.9 : rev.chf < 1e7 ? 1.1 : rev.chf < 5e7 ? 1.4 : 1.8;
  const dealChf = Math.round((A.websiteChf * sizeMult) / 100) * 100;
  return {
    pConnect, pReach, pMeetIfReached, pReply, pWin, pEmailClose, pCallClose, pClose,
    pMeeting: pReply * A.meetingPerReply + pReach * pMeetIfReached,
    dealChf, evChf: Math.round(pClose * dealChf), called,
    attempts: called && pConnect ? A.callAttempts : 0,
  };
}

/**
 * Conversion: does the homepage turn a visitor into an enquiry? Read from the CTAs the browser found on the
 * phone and desktop screens. Each finding names the fix. Returns null until the site has been rendered.
 */
export function conversion(r) {
  const M = r?.ctaMobile, D = r?.ctaDesktop;
  if (!M || M.error || !D || D.error) return null;
  const out = [];
  const C = (pts, label, say, fix, where) => out.push({ area: "cta", pts, label, say, fix, where });
  const main = (x) => x.ctas.find((c) => c.fold && !c.inNav && (c.button || c.kind !== "link")) || x.ctas.find((c) => c.fold && !c.inNav) || null;
  const mM = main(M), mD = main(D);
  if (!M.foldCtas) C(20, "No call-to-action on the first phone screen", "On a phone, nothing on the first screen invites a visitor to call, book or ask for a quote.", "Add one large button in the hero (e.g. \"Offerte anfragen\" or \"Termin buchen\") and a tap-to-call icon in the header.", "m");
  else if (!M.foldButtons) C(10, "Phone CTA is only a text link", `The first phone screen only has plain text links (${M.ctas.filter((c) => c.fold).map((c) => `"${c.text}"`).slice(0, 2).join(", ")}).`, "Turn the main action into a filled button with the brand colour, at least 48 px tall.", "m");
  if (!D.foldCtas) C(12, "No call-to-action above the fold on desktop", "On desktop the first screen shows no button to contact or book.", "Put a primary button next to the headline and repeat it at the end of each section.", "d");
  else if (!D.foldButtons) C(6, "Desktop CTA is only a text link", "The desktop hero has no real button, only text links.", "Use one filled primary button plus one outlined secondary button in the hero.", "d");
  const lowC = [mM, mD].find((c) => c?.contrast && c.contrast < 3);
  if (lowC) C(8, "CTA hard to read", `"${lowC.text}" has a contrast of ${lowC.contrast}:1 (needs 4.5:1).`, "Darken the button or switch to white text so it passes WCAG contrast.", mM === lowC ? "m" : "d");
  const small = M.ctas.find((c) => c.fold && (c.button || c.kind === "call") && c.h < 40);
  if (small) C(6, "Tap target too small", `"${small.text}" is ${small.h} px tall on a phone; thumbs need 44–48 px.`, "Make buttons at least 48 px tall with padding around the text.", "m");
  if (!M.telLinks) C(8, "No tap-to-call", "The phone number is not a tap-to-call link, so mobile visitors have to copy it.", "Wrap the number in a tel: link and show a call button in the mobile header.", "m");
  const vagueMain = [mM, mD].find((c) => c?.vague);
  if (vagueMain) C(6, "Vague button text", `The main button says "${vagueMain.text}", which does not say what happens next.`, "Name the outcome: \"Kostenlose Erstberatung\", \"Offerte in 24 h\".", vagueMain === mM ? "m" : "d");
  else if (M.vagueLinks + D.vagueLinks >= 6) C(3, "Many \"Mehr erfahren\" links", `${M.vagueLinks} vague links like "Mehr erfahren" compete for clicks.`, "Replace generic links with specific next steps.", "d");
  if (!M.forms && !D.forms && !M.booking && !M.ctas.some((c) => /kontakt|contact|anfrage|offerte|termin/i.test(c.text)))
    C(6, "No enquiry path on the homepage", "No contact form, booking widget or contact button on the homepage.", "Add a short 3-field enquiry form or booking widget at the bottom of the homepage.", "d");
  else if (D.formFields > 7) C(4, "Long contact form", `The form asks for ${D.formFields} fields; every extra field loses enquiries.`, "Cut the form to name, email/phone and message.", "d");
  if (!M.stickyCta && M.pageHeight > M.vh * 3) C(3, "No sticky mobile CTA", "Once a phone visitor scrolls, there is no way to call or enquire without scrolling back up.", "Add a sticky bottom bar with \"Anrufen\" and \"Anfrage\".", "m");
  if (D.foldButtons + D.foldCtas > 7) C(4, "Too many competing CTAs", `${D.foldCtas} different calls-to-action on the first desktop screen dilute attention.`, "Keep one primary and one secondary action in the hero.", "d");
  if (M.consentCover > 0.4) C(6, "Cookie banner covers the screen", `The consent banner covers ${Math.round(M.consentCover * 100)} % of the first phone screen.`, "Use a compact bottom banner so the headline and CTA stay visible.", "m");
  if (!M.booking && !M.chat && !M.whatsapp) C(2, "No instant channel", "No booking, chat or WhatsApp option for people who do not want to call.", "Add online booking or a WhatsApp button.", "m");
  if (!M.heroH1) C(3, "No clear headline on the first screen", "The first phone screen has no headline saying what the company does.", "Lead with one sentence: what you do, for whom, where.", "m");
  const score = clamp(100 - out.reduce((s, f) => s + f.pts, 0));
  return { score, issues: out.sort((a, b) => b.pts - a.pts), mainMobile: mM, mainDesktop: mD };
}

/** Full ranking for one lead. */
export function rankLead(lead, h, r, m, A = DEFAULTS, bench = null) {
  const live = !h?.parked && !!(h?.ok || r?.ok);
  const rev = estimateRevenue(lead, bench, A);
  const fitR = fit(lead, m, rev);
  const rv = reviewSignal(m);
  if (!live) {
    // No working site: still emailed. Parked/placeholder = the biggest gap there is; a dead domain's mail bounces.
    const scanned = !!(h || r);
    const bounce = !h?.parked && /ENOTFOUND|EAI_AGAIN/.test(h?.error || "");
    const fc = forecast(lead, scanned ? 1 : 0.4, fitR, rev, false, A, { bounce });
    return { live, scanned, fit: fitR, reviews: rv, revenue: rev, forecast: fc, dealScore: 0, tier: "X", noSite: h?.parked || (bounce ? "Domain does not exist" : h?.error || "") };
  }
  const a = audit(h, r, m);
  const gap = (100 - a.visibility) / 100;
  // Rank: how big the visibility gap is, how reachable and qualified the buyer is, and proof of real demand.
  const conv = conversion(r);
  const dealScore = clamp(0.5 * (100 - a.visibility) + 0.38 * fitR.score + 12 * rv.strength + (a.relaunch ? 4 : 0) + (conv ? (60 - conv.score) * 0.06 : 0));
  const invisible = a.visibility < A.invisibleBelow;
  const hasPhone = !!fitR.phone;
  const tier = !invisible ? "V" : dealScore >= 62 && hasPhone ? "A" : dealScore >= 52 ? "B" : "C";
  const fc = forecast(lead, gap, fitR, rev, (tier === "A" || tier === "B") && hasPhone, A);
  fc.offer = a.relaunch ? "New website (relaunch)" : "Website refresh + SEO/GEO";
  const issues = [...a.seo, ...a.geo].sort((x, y) => y.pts - x.pts);
  const talk = issues.slice(0, conv?.issues.length ? 2 : 3).map((i) => i.say);
  if (conv?.issues.length) talk.push(conv.issues[0].say);
  return { live, scanned: true, audit: a, conversion: conv, fit: fitR, reviews: rv, revenue: rev, forecast: fc, dealScore, invisible, tier, talk };
}

/** Portfolio prediction: expected closes with a 90 % range (independent leads), and what they are worth. */
export function predictCloses(ranked) {
  const groups = { all: [], A: [], B: [], C: [], V: [], X: [] };
  for (const x of ranked) { if (!x.forecast) continue; groups.all.push(x); groups[x.tier]?.push(x); }
  const sum = (list) => {
    const n = list.reduce((s, x) => s + x.forecast.pClose, 0);
    const v = list.reduce((s, x) => s + x.forecast.pClose * (1 - x.forecast.pClose), 0);
    const chf = list.reduce((s, x) => s + x.forecast.evChf, 0);
    const avg = n ? chf / n : 0;
    // Rate uncertainty (our planning rates could be off) dominates sampling noise, so widen by ±35 % on top.
    const low = Math.max(0, (n - 1.645 * Math.sqrt(v)) * 0.65), high = (n + 1.645 * Math.sqrt(v)) * 1.35;
    return { leads: list.length, closes: n, low, high, chf, chfLow: low * avg, chfHigh: high * avg,
      meetings: list.reduce((s, x) => s + x.forecast.pMeeting, 0), called: list.filter((x) => x.forecast.called).length };
  };
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, sum(v)]));
}
