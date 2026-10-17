import { rankLead, predictCloses, fmtChf, DEFAULTS } from "./score.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const chf = (n) => "CHF " + Math.round(n).toLocaleString("de-CH");
const pct = (p) => (p * 100).toFixed(p < 0.1 ? 1 : 0) + "%";
const PAGE = 100;

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let data = null, crm = {}, ranked = [], view = [], page = 0, prediction = null;
let A = { ...DEFAULTS, ...store.get("wbdf.assump", {}) };
const ui = { tier: "AB", sort: "deal", dir: -1, q: "", country: "", status: "", hasPhone: false, relaunch: false, ...store.get("wbdf.ui", {}) };

async function load() {
  const [d, c] = await Promise.all([fetch("/api/data").then((r) => r.json()), fetch("/api/crm").then((r) => r.json())]);
  data = d; crm = c;
  rank();
  fillCountries();
  renderProgress(d.progress);
  render();
}

function rank() {
  ranked = data.rows.map((x) => {
    const r = rankLead(x.lead, x.http, x.render, x.maps, A, data.bench);
    return { ...x, ...r, status: crm[x.lead.domain]?.status || "new" };
  });
  const live = ranked.filter((x) => x.live).sort((a, b) => b.dealScore - a.dealScore);
  live.forEach((x, i) => (x.rank = i + 1));
  // Prediction counts only leads whose website has been checked, so pending scans do not inflate it.
  prediction = predictCloses(ranked.filter((x) => x.scanned));
}

function fillCountries() {
  const sel = $("#country");
  if (sel.options.length > 1) return;
  const counts = {};
  for (const x of ranked) { const c = x.lead.country || (x.lead.domain.endsWith(".de") ? "Germany" : x.lead.domain.endsWith(".ch") ? "Switzerland" : "Unknown"); x.country = c; counts[c] = (counts[c] || 0) + 1; }
  for (const [c, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) sel.add(new Option(`${c} (${n})`, c));
  sel.value = ui.country;
}

function renderProgress(p) {
  const bar = (label, n) => `<div class="p">${label} <span class="bar"><i style="width:${(100 * n / p.total).toFixed(1)}%"></i></span> ${n.toLocaleString()}/${p.total.toLocaleString()}</div>`;
  $("#progress").innerHTML = bar("Sites read", p.http) + bar("Rendered", p.render) + bar("Google reviews", p.maps);
}

function filtered() {
  const q = ui.q.trim().toLowerCase();
  return ranked.filter((x) => {
    if (!x.live) return false;
    if (ui.tier === "AB" && !(x.tier === "A" || x.tier === "B")) return false;
    if (["A", "B", "C", "V"].includes(ui.tier) && x.tier !== ui.tier) return false;
    if (ui.tier === "inv" && !x.invisible) return false;
    if (ui.country && x.country !== ui.country) return false;
    if (ui.status && x.status !== ui.status) return false;
    if (ui.hasPhone && !x.fit.phone) return false;
    if (ui.relaunch && !x.audit.relaunch) return false;
    if (q) {
      const c = x.lead.contacts?.[0] || {};
      const hay = `${x.lead.company} ${x.lead.domain} ${x.lead.industry || ""} ${c.first} ${c.last} ${c.title} ${x.lead.city || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const SORTS = {
  rank: (x) => -x.rank, deal: (x) => x.dealScore, visibility: (x) => -x.audit.visibility, fit: (x) => x.fit.score,
  reviews: (x) => (x.maps?.reviews || 0) + (x.maps?.rating || 0) / 10, ev: (x) => x.forecast.pClose, revenue: (x) => x.revenue.chf,
  conversion: (x) => -(x.conversion?.score ?? 101), tier: (x) => -"ABCV".indexOf(x.tier),
  company: (x) => x.lead.company.toLowerCase(),
};

function render() {
  if (!data) return;
  store.set("wbdf.ui", ui);
  view = filtered();
  const key = SORTS[ui.sort] || SORTS.deal;
  view.sort((a, b) => { const ka = key(a), kb = key(b); return (ka < kb ? -1 : ka > kb ? 1 : 0) * ui.dir; });
  page = Math.min(page, Math.max(0, Math.ceil(view.length / PAGE) - 1));
  renderKpis();
  for (const b of document.querySelectorAll("#tiers button")) b.classList.toggle("on", b.dataset.t === ui.tier);
  for (const th of document.querySelectorAll("th[data-s]")) th.classList.toggle("sorted", th.dataset.s === ui.sort);
  const rows = view.slice(page * PAGE, page * PAGE + PAGE);
  $("#table tbody").innerHTML = rows.length ? rows.map(row).join("") : `<tr><td colspan="12" class="empty">${data.progress.http ? "No leads match these filters." : "Scans are still starting. Refresh in a minute."}</td></tr>`;
  $("#pager").innerHTML = `<span>${view.length.toLocaleString()} leads · page ${page + 1} of ${Math.max(1, Math.ceil(view.length / PAGE))}</span>
    <span><button data-p="-1" ${page === 0 ? "disabled" : ""}>← Prev</button> <button data-p="1" ${(page + 1) * PAGE >= view.length ? "disabled" : ""}>Next →</button></span>`;
  renderDead();
}

function renderKpis() {
  const live = ranked.filter((x) => x.live);
  const inv = live.filter((x) => x.invisible);
  const P = prediction.all;
  const k = (v, l, hl) => `<div class="kpi${hl ? " hl" : ""}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  $("#kpis").innerHTML =
    k(data.rows.length.toLocaleString(), `unique companies from ${Object.keys(data.rowsPerSource || {}).length} files`) +
    k(live.length.toLocaleString(), `live websites scored (${data.progress.http.toLocaleString()} of ${data.progress.total.toLocaleString()} read)`) +
    k(inv.length.toLocaleString(), `not visible (score under ${A.invisibleBelow})`) +
    k(`${live.filter((x) => x.tier === "A").length} / ${live.filter((x) => x.tier === "B").length}`, `Tier A / B to call · ${Math.round(P.meetings)} meetings expected`) +
    k(`${Math.round(P.closes)} <small>(${Math.round(P.low)}–${Math.round(P.high)})</small>`, `websites we can close from ${P.leads.toLocaleString()} checked leads (email all + call A/B)`) +
    k(chf(P.chf), `predicted sales at ${chf(A.websiteChf)} average · range ${fmtChf(P.chfLow)}–${fmtChf(P.chfHigh)}`, true);
  renderPrediction();
  $("#deadCount").textContent = `(${ranked.filter((x) => x.scanned && !x.live).length})`;
}

function meter(v) {
  const c = v < 40 ? "var(--bad)" : v < 60 ? "var(--warn)" : "var(--good)";
  return `<span class="meter"><i style="width:${v}%;background:${c}"></i></span>`;
}
function stars(m) {
  if (!m) return `<span class="sub">pending</span>`;
  if (!m.matched) return m.error ? `<span class="sub">lookup failed</span>` : `<span class="tag bad">not on Maps</span>`;
  if (!m.rating) return `<span class="tag warn">listed, 0 reviews</span>`;
  return `<span class="stars">★ ${m.rating.toFixed(1)}</span> <span class="sub">(${m.reviews})</span>`;
}

function row(x) {
  const l = x.lead, c = l.contacts?.[0] || {}, a = x.audit, f = x.forecast;
  const tags = [a.relaunch && `<span class="tag bad">relaunch</span>`, l.hiring && `<span class="tag good">hiring</span>`, a.cms && `<span class="tag">${esc(a.cms)}</span>`].filter(Boolean).join("");
  return `<tr data-d="${esc(l.domain)}">
    <td class="sub">${x.rank}</td>
    <td><span class="tier ${x.tier}">${x.tier}</span></td>
    <td class="co"><b>${esc(l.company)}</b><a href="${esc(x.http?.finalUrl || "https://" + l.domain)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(l.domain)}</a>
      <div class="sub">${esc([l.industry, l.city || l.region].filter(Boolean).join(" · ").slice(0, 70))}</div>${tags}</td>
    <td><b>${esc([c.first, c.last].filter(Boolean).join(" ") || "—")}</b><div class="sub">${esc((c.title || "").slice(0, 40))}</div><div class="sub">${esc(c.phone || x.fit.phone || "no phone")}</div></td>
    <td class="vis"><div class="big">${a.visibility}</div>
      <div class="row">SEO ${meter(a.seoScore)} ${a.seoScore}</div><div class="row">GEO ${meter(a.geoScore)} ${a.geoScore}</div></td>
    <td>${stars(x.maps)}<div class="sub">${esc(x.reviews.label)}</div></td>
    <td>${x.conversion ? `<div class="big">${x.conversion.score}</div><div class="sub">${esc(x.conversion.issues[0]?.label || "no issues")}</div>` : `<span class="sub">pending render</span>`}</td>
    <td><b>${fmtChf(x.revenue.chf)}</b><div class="sub" title="${esc(x.revenue.basis)}">${x.revenue.confidence === "high" ? "D&amp;B" : x.revenue.confidence === "medium" ? "estimate" : "rough guess"}</div></td>
    <td><b>${x.fit.score}</b><div class="sub">${esc(x.fit.why.slice(0, 2).join(", "))}</div></td>
    <td><div class="big">${x.dealScore}</div></td>
    <td class="fc"><b>${pct(f.pClose)}</b> close<span class="sub">${f.called ? "email + call" : "email only"} · ${pct(f.pMeeting)} meeting</span><span class="sub">${chf(f.evChf)} expected of ${chf(f.dealChf)}</span></td>
    <td><span class="status-pill ${x.status}">${x.status}</span></td>
  </tr>`;
}

function renderDead() {
  const dead = ranked.filter((x) => x.scanned && !x.live);
  $("#deadTable tbody").innerHTML = dead.slice(0, 1500).map((x) => {
    const c = x.lead.contacts?.[0] || {};
    return `<tr data-d="${esc(x.lead.domain)}"><td><b>${esc(x.lead.company)}</b></td><td>${esc(x.lead.domain)}</td>
      <td>${esc([c.first, c.last].join(" "))}<div class="sub">${esc(c.email)}</div></td><td>${esc(c.phone || x.lead.phone || "")}</td>
      <td class="sub">${esc(x.noSite || x.http?.error || x.render?.error || "")}</td><td>${fmtChf(x.revenue.chf)}</td><td>${pct(x.forecast.pClose)}</td></tr>`;
  }).join("");
}

function renderPrediction() {
  const P = prediction;
  const row = (k, label) => { const g = P[k]; return g.leads ? `<tr><td>${label}</td><td>${g.leads.toLocaleString()}</td><td>${g.called.toLocaleString()}</td><td>${g.meetings.toFixed(0)}</td><td><b>${g.closes.toFixed(1)}</b> <span class="sub">(${g.low.toFixed(0)}–${g.high.toFixed(0)})</span></td><td><b>${chf(g.chf)}</b></td></tr>` : ""; };
  const pending = data.progress.total - ranked.filter((x) => x.scanned).length;
  $("#prediction").innerHTML = `<div class="card">
    <div class="pred-head"><h3>What we can close</h3>
    <span class="sub">Every lead gets the email; tiers A and B also get up to ${A.callAttempts} calls. Average website ${chf(A.websiteChf)}.
    Ranges are 90 % bands, widened for uncertainty in the planning rates.${pending > 0 ? ` ${pending.toLocaleString()} leads are still being scanned and are not counted yet.` : ""}</span></div>
    <table class="pred"><thead><tr><th>Group</th><th>Leads</th><th>Called</th><th>Meetings</th><th>Websites sold</th><th>Sales</th></tr></thead><tbody>
    ${row("A", "Tier A · call first")}${row("B", "Tier B · call second")}${row("C", "Tier C · email only")}${row("V", "Visible · email only")}${row("X", "No working website · email")}
    <tr class="tot"><td>Total</td><td>${P.all.leads.toLocaleString()}</td><td>${P.all.called.toLocaleString()}</td><td>${P.all.meetings.toFixed(0)}</td><td><b>${P.all.closes.toFixed(1)}</b> <span class="sub">(${P.all.low.toFixed(0)}–${P.all.high.toFixed(0)})</span></td><td><b>${chf(P.all.chf)}</b> <span class="sub">(${fmtChf(P.all.chfLow)}–${fmtChf(P.all.chfHigh)})</span></td></tr>
    </tbody></table></div>`;
}

const SHOT_W = { m: 390, d: 1366 };
function shotView(x, which) {
  const r = x.render || {};
  if (!r.shots?.[which]) return `<div class="noshot">${r.v === 2 ? "Screenshot failed for this site." : "Screenshot pending: the browser pass has not reached this site yet."}</div>`;
  const cta = which === "m" ? r.ctaMobile : r.ctaDesktop;
  const W = SHOT_W[which], H = Math.min(which === "m" ? 1600 : 2200, cta?.pageHeight || 99999);
  const boxes = (cta?.ctas || []).filter((c) => c.y < H && c.x < W - 4 && c.x + c.w > 4).map((c) => {
    const cls = c.button && !c.vague && (!c.contrast || c.contrast >= 3) ? "ok" : "weak";
    return `<i class="cta ${cls}" title="${esc(c.text)} · ${c.kind}${c.button ? " · button" : " · text link"}${c.contrast ? " · contrast " + c.contrast + ":1" : ""}" style="left:${(100 * c.x / W).toFixed(2)}%;top:${(100 * c.y / H).toFixed(2)}%;width:${(100 * c.w / W).toFixed(2)}%;height:${(100 * c.h / H).toFixed(2)}%"></i>`;
  }).join("");
  const fold = cta?.vh ? `<b class="fold" style="top:${(100 * cta.vh / H).toFixed(2)}%">first screen ends</b>` : "";
  return `<div class="shot ${which}"><img src="/shots/${encodeURIComponent(x.lead.domain)}-${which}.jpg" alt="Screenshot of ${esc(x.lead.domain)}" loading="lazy">${boxes}${fold}</div>`;
}

function openLead(domain) {
  const x = ranked.find((r) => r.lead.domain === domain);
  if (!x) return;
  const l = x.lead, a = x.audit, f = x.forecast, m = x.maps, h = x.http || {}, rd = x.render || {}, cv = x.conversion, rev = x.revenue;
  const st = crm[domain] || {};
  const site = h.finalUrl || rd.finalUrl || "https://" + domain;
  const issues = (list) => list.length ? `<ul class="issues">${[...list].sort((p, q) => q.pts - p.pts).map((i) => `<li><span class="pts">−${i.pts}</span><div><b>${esc(i.label)}</b><small>${esc(i.say)}</small>${i.fix ? `<small class="fix">Fix: ${esc(i.fix)}</small>` : ""}</div></li>`).join("")}</ul>` : `<p class="sub">No issues found.</p>`;
  const facts = a ? [
    ["CMS", a.cms || "unknown"], ["Words (rendered / raw)", `${rd.words ?? "–"} / ${h.words ?? "–"}`], ["Sitemap URLs", h.sitemap?.entries ?? "none"],
    ["Sitemap last update", h.sitemap?.lastmod || "–"], ["Schema types", [...(rd.jsonLd || h.jsonLd || [])].slice(0, 5).join(", ") || "none"],
    ["AI bots blocked", h.aiBlocked?.length ? h.aiBlocked.join(", ") : "none"], ["llms.txt", h.llmsTxt ? "yes" : "no"],
    ["Server response", h.ttfbMs ? `${(h.ttfbMs / 1000).toFixed(1)} s` : "–"], ["Mobile load", rd.loadMs ? `${(rd.loadMs / 1000).toFixed(1)} s` : "–"],
    ["Copyright year", rd.copyrightYear || h.copyrightYear || "–"],
  ] : [];
  const ctaList = (c) => c ? `${c.ctas.filter((t) => t.fold).map((t) => `<span class="tag ${t.button ? "good" : "warn"}">${esc(t.text)}</span>`).join("") || `<span class="tag bad">none on first screen</span>`}` : "";
  $("#drawerBody").innerHTML = `
    <span class="tier ${x.tier}">${x.tier}</span>
    <h2>${esc(l.company)}</h2>
    <div class="sub">${esc([l.industry, l.city, l.region, l.country].filter(Boolean).join(" · "))}</div>
    <div class="links" style="margin-top:8px">
      <a href="${esc(site)}" target="_blank" rel="noopener">Open website ↗</a>
      ${m?.mapsUrl ? `<a href="${esc(m.mapsUrl)}" target="_blank" rel="noopener">Google Maps ↗</a>` : ""}
      ${l.job_ad ? `<a href="${esc(l.job_ad)}" target="_blank" rel="noopener">Job ad ↗</a>` : ""}
    </div>
    ${x.live ? `
    <div class="scores">
      <div><b>${x.dealScore}</b><span>Deal score</span></div>
      <div><b>${a.visibility}</b><span>Visibility</span></div>
      <div><b>${a.seoScore}</b><span>SEO</span></div>
      <div><b>${a.geoScore}</b><span>GEO</span></div>
      <div><b>${cv ? cv.score : "–"}</b><span>Conversion</span></div>
    </div>
    <h4>Website preview</h4>
    <div class="shot-tabs"><button data-v="d" class="on">Desktop</button><button data-v="m">Phone</button><button data-v="live">Live</button>
      <span class="legend"><i class="cta ok"></i> strong CTA <i class="cta weak"></i> weak CTA</span></div>
    <div class="shot-wrap" id="shotWrap">${shotView(x, "d")}</div>
    <h4>Opening lines for the call</h4>
    <ul class="talk">${x.talk.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    <h4>Conversion &amp; CTAs ${cv ? `(${cv.issues.length} to improve)` : ""}</h4>
    ${cv ? `<div class="facts" style="margin-bottom:8px"><span>Phone first screen</span><b>${ctaList(rd.ctaMobile)}</b><span>Desktop first screen</span><b>${ctaList(rd.ctaDesktop)}</b>
      <span>Tap-to-call links</span><b>${rd.ctaMobile.telLinks}</b><span>Enquiry forms</span><b>${rd.ctaDesktop.forms}${rd.ctaDesktop.formFields ? ` (${rd.ctaDesktop.formFields} fields)` : ""}</b>
      <span>Booking / chat / WhatsApp</span><b>${[rd.ctaMobile.booking && "booking", rd.ctaMobile.chat && "chat", rd.ctaMobile.whatsapp && "WhatsApp"].filter(Boolean).join(", ") || "none"}</b></div>${issues(cv.issues)}`
      : `<p class="sub">Waiting for the browser pass to reach this site.</p>`}
    ` : `<p class="note">No working website: ${esc(x.noSite || h.error || rd.error || "unknown")}. Pitch: a new website.</p>`}
    <h4>Close forecast</h4>
    <div class="fcgrid">
      <span>Channel</span><b>${f.called ? `Email, then up to ${f.attempts} calls` : "Email only"}</b>
      <span>Positive reply to email</span><b>${pct(f.pReply)}</b>
      ${f.called ? `<span>Reach decision-maker</span><b>${pct(f.pConnect)} per call · ${pct(f.pReach)} in ${f.attempts} tries</b><span>Meeting if reached</span><b>${pct(f.pMeetIfReached)}</b>` : ""}
      <span>Win per meeting</span><b>${pct(f.pWin)}</b>
      <span>Chance we sell a website</span><b>${pct(f.pClose)}</b>
      ${f.offer ? `<span>Likely offer</span><b>${esc(f.offer)}</b>` : ""}
      <span>Deal size</span><b>${chf(f.dealChf)}</b>
      <span>Expected value</span><b>${chf(f.evChf)}</b>
      ${f.called ? `<span>Best call window</span><b>Tue–Thu, 08:30–10:30 or 14:00–16:00, 2–3 days after the email</b>` : ""}
    </div>
    <h4>Company size</h4>
    <div class="fcgrid">
      <span>Revenue estimate</span><b>${fmtChf(rev.chf)} <span class="sub">(${fmtChf(rev.low)}–${fmtChf(rev.high)})</span></b>
      <span>Based on</span><b>${esc(rev.basis)} · ${rev.confidence} confidence</b>
      <span>Staff</span><b>${l.employees ? Math.round(l.employees) : esc(l.employees_band || "unknown")}</b>
    </div>
    ${x.live ? `
    <h4>Google reviews</h4>
    <div>${stars(m)} ${m?.matched ? `<span class="sub">· ${esc(m.name)} · ${esc(m.category || "")} · matched by ${esc(m.matchBy)}</span>` : ""}</div>
    <h4>SEO issues (${a.seo.length})</h4>${issues(a.seo)}
    <h4>GEO / AI-search issues (${a.geo.length})</h4>${issues(a.geo)}
    <h4>Scan facts</h4><div class="facts">${facts.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join("")}</div>` : ""}
    <h4>Contacts (${l.contacts.length})</h4>
    <div class="contacts">${l.contacts.map((c) => `<div class="c"><b>${esc([c.first, c.last].join(" "))}</b> <span class="sub">${esc(c.title)}</span><br>
      ${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ""}${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ""}${c.linkedin ? `<a href="${esc(c.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : ""}</div>`).join("")}
      ${l.phone || m?.mapsPhone ? `<div class="c"><span class="sub">Company phone</span> <a href="tel:${esc(l.phone || m.mapsPhone)}">${esc(l.phone || m.mapsPhone)}</a></div>` : ""}
    </div>
    ${l.hiring ? `<h4>Hiring signal</h4><p class="sub">${esc(l.hiring)}</p>` : ""}
    <h4>Sales status</h4>
    <div class="crm">
      <select id="crmStatus">${["new", "emailed", "called", "meeting", "won", "lost"].map((s) => `<option ${st.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <input id="crmOwner" placeholder="Owner (salesperson)" value="${esc(st.owner || "")}">
      <textarea id="crmNotes" placeholder="Call notes">${esc(st.notes || "")}</textarea>
      <button class="primary" id="crmSave">Save</button> <span class="sub" id="crmMsg">${st.updatedAt ? "Last saved " + new Date(st.updatedAt).toLocaleString() : ""}</span>
    </div>
    <h4>Sources</h4><p class="sub">${l.sources.map(esc).join("<br>")}</p>`;
  const tabs = $("#drawerBody .shot-tabs");
  if (tabs) tabs.onclick = (e) => {
    const v = e.target.closest("button")?.dataset.v; if (!v) return;
    for (const b of tabs.querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === v);
    $("#shotWrap").innerHTML = v === "live"
      ? `<iframe class="live" src="${esc(site)}" sandbox="allow-scripts allow-same-origin allow-popups" referrerpolicy="no-referrer" loading="lazy"></iframe>
         <p class="sub">Live view of the site. If it stays blank, the site forbids embedding: use "Open website".</p>`
      : shotView(x, v);
  };
  $("#crmSave").onclick = async () => {
    const body = { domain, status: $("#crmStatus").value, owner: $("#crmOwner").value, notes: $("#crmNotes").value };
    const r = await fetch("/api/crm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    crm[domain] = await r.json();
    x.status = crm[domain].status;
    $("#crmMsg").textContent = "Saved";
    render();
  };
  $("#drawer").hidden = $("#scrim").hidden = false;
}
const closeDrawer = () => ($("#drawer").hidden = $("#scrim").hidden = true);

function exportCsv() {
  const cols = ["Rank", "Tier", "Deal score", "Company", "Domain", "Website", "Industry", "City", "Country", "Contact", "Title", "Email", "Direct phone", "Company phone",
    "Visibility", "SEO", "GEO", "Conversion", "Top CTA fixes", "Google rating", "Google reviews", "Revenue CHF (est.)", "Revenue basis", "Fit", "Offer", "Deal CHF",
    "Channel", "P(meeting)", "P(close)", "Expected CHF", "Top SEO/GEO issues", "Opening lines", "Status", "Owner", "Notes"];
  const lines = [cols];
  for (const x of view) {
    const l = x.lead, c = l.contacts?.[0] || {}, st = crm[l.domain] || {}, f = x.forecast;
    lines.push([x.rank, x.tier, x.dealScore, l.company, l.domain, x.http?.finalUrl || "", l.industry || "", l.city || l.region || "", x.country || "",
      [c.first, c.last].join(" "), c.title, c.email, c.phone, l.phone || x.maps?.mapsPhone || "", x.audit.visibility, x.audit.seoScore, x.audit.geoScore,
      x.conversion?.score ?? "", (x.conversion?.issues || []).slice(0, 3).map((i) => `${i.label}: ${i.fix}`).join(" | "),
      x.maps?.rating ?? "", x.maps?.reviews ?? "", x.revenue.chf, `${x.revenue.basis} (${x.revenue.confidence})`, x.fit.score, f.offer, f.dealChf,
      f.called ? "email + call" : "email", (f.pMeeting * 100).toFixed(1) + "%", (f.pClose * 100).toFixed(2) + "%", f.evChf,
      [...x.audit.seo, ...x.audit.geo].sort((p, q) => q.pts - p.pts).slice(0, 5).map((i) => i.label).join("; "), x.talk.join(" | "), x.status, st.owner || "", st.notes || ""]);
  }
  const csv = "﻿" + lines.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `webbetter-dealflow-${ui.tier}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

function renderAssumptions() {
  const LABELS = {
    invisibleBelow: "“Not visible” below score", websiteChf: "Average website (CHF)", scaleBySize: "Price by company size (1 = on)",
    emailReplyBase: "Positive email reply rate", meetingPerReply: "Meetings per reply",
    pConnectDirect: "Reach rate per call, direct line", pConnectSwitch: "Reach rate per call, company number", callAttempts: "Call attempts per lead",
    pMeetingBase: "Meeting rate per conversation", emailWarmUplift: "Uplift from prior email (×)", pWinBase: "Win rate per meeting",
    usdChf: "USD → CHF (D&B revenue)", eurChf: "EUR → CHF",
  };
  $("#assump").innerHTML = Object.entries(LABELS).map(([k, l]) => `<label for="a_${k}">${l}</label><input id="a_${k}" data-k="${k}" type="number" step="any" value="${A[k]}">`).join("");
}

// events
$("#q").value = ui.q;
$("#hasPhone").checked = ui.hasPhone; $("#relaunchOnly").checked = ui.relaunch; $("#status").value = ui.status;
$("#q").oninput = (e) => { ui.q = e.target.value; page = 0; render(); };
$("#tiers").onclick = (e) => { const t = e.target.dataset?.t; if (t) { ui.tier = t; page = 0; render(); } };
$("#country").onchange = (e) => { ui.country = e.target.value; page = 0; render(); };
$("#status").onchange = (e) => { ui.status = e.target.value; page = 0; render(); };
$("#hasPhone").onchange = (e) => { ui.hasPhone = e.target.checked; page = 0; render(); };
$("#relaunchOnly").onchange = (e) => { ui.relaunch = e.target.checked; page = 0; render(); };
document.querySelector("#table thead").onclick = (e) => {
  const s = e.target.closest("th")?.dataset.s; if (!s) return;
  ui.dir = ui.sort === s ? -ui.dir : s === "rank" || s === "company" ? 1 : -1; ui.sort = s; render();
};
$("#table tbody").onclick = (e) => { const d = e.target.closest("tr")?.dataset.d; if (d) openLead(d); };
$("#deadTable tbody").onclick = (e) => { const d = e.target.closest("tr")?.dataset.d; if (d) openLead(d); };
$("#pager").onclick = (e) => { const p = e.target.dataset?.p; if (p) { page += Number(p); render(); window.scrollTo({ top: 0 }); } };
$("#closeDrawer").onclick = closeDrawer; $("#scrim").onclick = closeDrawer;
document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());
$("#export").onclick = exportCsv;
$("#reload").onclick = load;
document.querySelector(".tabs").onclick = (e) => {
  const t = e.target.closest("button")?.dataset.tab; if (!t) return;
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === t);
  for (const id of ["ranked", "dead", "method"]) $(`#tab-${id}`).hidden = id !== t;
};
$("#assump").oninput = (e) => {
  const k = e.target.dataset.k; if (!k) return;
  const v = Number(e.target.value); if (!Number.isFinite(v)) return;
  A[k] = v; store.set("wbdf.assump", A); rank(); render();
};
$("#resetAssump").onclick = () => { A = { ...DEFAULTS }; store.set("wbdf.assump", {}); renderAssumptions(); rank(); render(); };
renderAssumptions();
setInterval(async () => { try { renderProgress(await fetch("/api/progress").then((r) => r.json())); } catch {} }, 20000);
load();
