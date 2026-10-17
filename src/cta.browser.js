// Runs inside the page (Playwright page.evaluate). Finds the calls-to-action a visitor sees and how strong they are.
// Coordinates are document pixels at the current viewport, so the dashboard can draw them on the screenshot.
() => {
  const vw = innerWidth, vh = innerHeight;
  const ACTION = /(kontakt|contact|anfrage|anfragen|offerte|angebot anfordern|termin|buchen|reserv|jetzt|gratis|kostenlos|beratung|erstgespräch|demo|quote|request|book|get started|loslegen|anmelden|registr|bestell|order|kaufen|in den warenkorb|shop now|call|anrufen|rückruf|whatsapp|devis|rendez|nous contacter|appel|preventivo|contatt|prenota|testen|try|download|bewerb|apply|jobs|karriere|newsletter|schreiben sie|write to us|let'?s talk|sprechen)/i;
  const VAGUE = /^(mehr|mehr erfahren|mehr lesen|weiterlesen|weiter|read more|learn more|more|more info|en savoir plus|plus|details|zu den details|hier|click here|hier klicken|klicken sie hier|entdecken|discover|>|»|→|›)$/i;
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return { c, el: e }; if (getComputedStyle(e).backgroundImage !== "none" && e !== el) return { c: null, el: e }; } return { c: { r: 255, g: 255, b: 255, a: 1 }, el: document.body }; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const fixed = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === "fixed" || p === "sticky") return true; } return false; };
  const visible = (el, r) => { if (r.width < 8 || r.height < 8 || r.left >= vw - 4 || r.right <= 4) return false; // off-canvas menus const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1; };

  const els = [...document.querySelectorAll("a[href], button, input[type=submit], input[type=button], [role=button]")];
  const found = [];
  let vagueCount = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const href = (el.getAttribute("href") || "").trim();
    const kind = /^tel:/i.test(href) ? "call" : /^mailto:/i.test(href) ? "email" : /wa\.me|whatsapp/i.test(href) ? "whatsapp"
      : el.closest("form") && (el.type === "submit" || el.tagName === "BUTTON") ? "form" : "link";
    if (VAGUE.test(text)) vagueCount++;
    if (!(ACTION.test(text) || kind !== "link")) continue;
    if (el.closest("nav, header") && !ACTION.test(text) && kind === "link") continue;
    const s = getComputedStyle(el);
    const own = parse(s.backgroundColor);
    const parentBg = bgOf(el.parentElement || el).c;
    const hasBg = own && own.a > 0.5 && (!parentBg || ratio(own, parentBg) > 1.25);
    const hasBorder = parseFloat(s.borderTopWidth) >= 1 && parseFloat(s.paddingLeft) >= 6;
    const fg = parse(s.color);
    const behind = hasBg ? own : bgOf(el).c;
    const contrast = fg && behind ? Math.round(ratio(fg, behind) * 10) / 10 : null;
    found.push({
      text: text || (kind === "call" ? href.replace(/^tel:/i, "") : kind), kind,
      x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height),
      fold: r.top + scrollY < vh, button: !!(hasBg || hasBorder) && r.height >= 26, contrast, font: Math.round(parseFloat(s.fontSize)),
      sticky: fixed(el), vague: VAGUE.test(text), inNav: !!el.closest("nav"),
    });
  }
  found.sort((a, b) => a.y - b.y || a.x - b.x);
  // De-duplicate the same CTA repeated (desktop + mobile menus render both).
  const seen = new Set(), ctas = [];
  for (const c of found) { const k = c.text.toLowerCase() + c.kind; if (seen.has(k) && !c.fold) continue; seen.add(k); ctas.push(c); if (ctas.length >= 14) break; }

  const html = document.documentElement.innerHTML.slice(0, 500000);
  const forms = [...document.querySelectorAll("form")].filter((f) => f.querySelectorAll("input:not([type=hidden]), textarea, select").length >= 2 && !/search|suche/i.test(f.getAttribute("role") + f.className + f.id + (f.action || "")));
  // Cookie/consent overlays: how much of the first screen do they cover?
  let consentCover = 0;
  for (const el of document.querySelectorAll("[id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i], #CybotCookiebotDialog, #usercentrics-root, #onetrust-banner-sdk")) {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    if (el === document.body || r.height > 1.5 * vh || !/cookie|datenschutz|consent|privacy/i.test(el.innerText || "")) continue;
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.1 || r.height < 40) continue;
    const cover = (Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0))) / (vw * vh);
    consentCover = Math.max(consentCover, cover);
  }
  const h1 = document.querySelector("h1");
  const h1r = h1?.getBoundingClientRect();
  return {
    vw, vh, pageHeight: document.documentElement.scrollHeight, ctas,
    foldCtas: ctas.filter((c) => c.fold && !c.inNav).length,
    foldButtons: ctas.filter((c) => c.fold && c.button).length,
    stickyCta: ctas.some((c) => c.sticky && (c.button || c.kind === "call")),
    telLinks: document.querySelectorAll('a[href^="tel:"]').length,
    mailLinks: document.querySelectorAll('a[href^="mailto:"]').length,
    forms: forms.length,
    formFields: forms.length ? Math.max(...forms.map((f) => f.querySelectorAll("input:not([type=hidden]):not([type=submit]), textarea, select").length)) : 0,
    booking: /calendly|doctolib|onedoc|simplybook|bookingkit|timify|resmio|opentable|shore\.com|termin(e)?\.online|acuityscheduling|cal\.com|hubspot.*meetings/i.test(html),
    chat: /intercom|tawk\.to|crisp\.chat|livechat|zendesk|drift\.com|hs-chat|userlike|chatbot|tidio/i.test(html),
    whatsapp: /wa\.me\/|api\.whatsapp\.com/i.test(html),
    vagueLinks: vagueCount,
    consentCover: Math.round(consentCover * 100) / 100,
    heroH1: !!(h1r && h1r.top < vh && h1r.height > 0),
  };
}
