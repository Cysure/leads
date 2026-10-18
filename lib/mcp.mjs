// MCP server (Streamable HTTP, stateless, JSON responses) so Claude can work with the leads: search and filter
// the ranking, read one lead's full audit and talking points, update sales status and notes, see the pipeline.
// Also exposes the same functions to the REST routes in api/handler.js.
import { assess, finalize, DEFAULTS } from "../public/score.js";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const STATUSES = ["new", "emailed", "called", "meeting", "won", "lost"];
const TIERS = ["A", "B", "C", "V", "X"];

const SITE = process.env.DEALFLOW_PUBLIC_URL || "https://leads-jet-tau.vercel.app";
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

export const TOOLS = [
  {
    name: "search_leads",
    title: "Search and rank leads",
    description:
      "Search Web Better's sales leads (Swiss and German companies whose websites were scanned for SEO, GEO/AI-search visibility, " +
      "Google reviews and conversion). Results are ranked best opportunity first. Tiers: A = call first, B = call second, " +
      "C = email only, V = website already visible (skip), X = no working website. Visibility, SEO, GEO and conversion are 0-100 " +
      "(lower = bigger problem = better lead). p_close is the estimated chance to sell a CHF 5,000 website.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match in company, domain, industry, city or contact name" },
        tier: { type: "array", items: { type: "string", enum: TIERS }, description: "Only these tiers, e.g. [\"A\",\"B\"]" },
        status: { type: "array", items: { type: "string", enum: STATUSES }, description: "Only these sales statuses" },
        country: { type: "string", description: "Switzerland, Germany, ..." },
        city: { type: "string", description: "City or canton/region, partial match" },
        industry: { type: "string", description: "Industry, partial match" },
        max_visibility: { type: "integer", minimum: 0, maximum: 100, description: "Only leads at or below this visibility score" },
        has_phone: { type: "boolean", description: "Only leads with a phone number" },
        hiring: { type: "boolean", description: "Only companies with current job ads" },
        needs_relaunch: { type: "boolean", description: "Only sites that need a full rebuild" },
        owner: { type: "string", description: "Only leads assigned to this salesperson" },
        sort: { type: "string", enum: ["rank", "p_close", "visibility", "revenue", "reviews"], description: "Default: rank" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20" },
        offset: { type: "integer", minimum: 0, description: "For paging" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_lead",
    title: "Full lead audit",
    description:
      "Everything about one lead by domain: contacts, SEO and GEO issues with plain-language explanations, conversion/CTA problems " +
      "with fixes, opening lines for a sales call, Google reviews, revenue estimate, close forecast, sales status and notes, " +
      "and screenshot links.",
    inputSchema: { type: "object", properties: { domain: { type: "string", description: "e.g. aksa.ch" } }, required: ["domain"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "update_lead",
    title: "Update sales status or notes",
    description: "Set a lead's sales status, owner, or notes. append_note adds a dated line to the existing notes instead of replacing them.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        status: { type: "string", enum: STATUSES },
        owner: { type: "string", description: "Salesperson responsible" },
        notes: { type: "string", description: "Replaces all notes" },
        append_note: { type: "string", description: "Adds a dated line to the notes" },
      },
      required: ["domain"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "pipeline_summary",
    title: "Pipeline summary",
    description: "Totals across all leads: count per tier and per sales status, scan progress, and the predicted number of websites sold and revenue.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

const SORTS = {
  rank: "l.live desc, l.deal_score desc, l.domain",
  p_close: "l.p_close desc, l.deal_score desc",
  visibility: "l.live desc, l.visibility asc nulls last, l.deal_score desc",
  revenue: "(l.summary->'revenue'->>'chf')::float8 desc nulls last",
  reviews: "coalesce((l.summary->'maps'->>'reviews')::int, 0) desc",
};

function compact(r) {
  const s = r.summary, c = s.lead.contacts?.[0] || {};
  return {
    rank: r.rank ?? null, tier: r.tier, company: r.company, domain: r.domain, website: s.http?.finalUrl || `https://${r.domain}`,
    industry: r.industry || null, city: r.city || null, country: r.country || null,
    contact: { name: [c.first, c.last].filter(Boolean).join(" ") || null, title: c.title || null, email: c.email || null, phone: c.phone || null },
    company_phone: s.lead.phone || s.maps?.mapsPhone || null,
    visibility: r.visibility, seo: s.audit?.seoScore ?? null, geo: s.audit?.geoScore ?? null, conversion: s.conversion?.score ?? null,
    top_issues: s.audit?.top?.slice(0, 3) || [], no_website: s.live ? null : s.noSite || "no working website",
    google: s.maps?.matched ? { rating: s.maps.rating, reviews: s.maps.reviews } : null,
    revenue_chf_est: s.revenue?.chf ?? null, revenue_basis: s.revenue?.basis ?? null,
    hiring: !!s.lead.hiring, needs_relaunch: !!s.audit?.relaunch,
    deal_score: r.deal_score, p_close_pct: round(r.p_close * 100, 2), expected_chf: r.ev_chf,
    status: r.status || "new", owner: r.owner || null,
  };
}

async function searchLeads(db, a = {}) {
  const where = [], args = [];
  const p = (v) => { args.push(v); return `$${args.length}`; };
  if (a.query) {
    const q = p(`%${a.query}%`);
    where.push(`(l.company ilike ${q} or l.domain ilike ${q} or l.industry ilike ${q} or l.city ilike ${q}
      or (l.summary->'lead'->'contacts'->0->>'first') || ' ' || (l.summary->'lead'->'contacts'->0->>'last') ilike ${q})`);
  }
  if (a.tier?.length) where.push(`l.tier = any(${p(a.tier)}::text[])`);
  if (a.status?.length) where.push(`coalesce(c.status, 'new') = any(${p(a.status)}::text[])`);
  if (a.country) where.push(`l.country ilike ${p(a.country)}`);
  if (a.city) where.push(`l.city ilike ${p(`%${a.city}%`)}`);
  if (a.industry) where.push(`l.industry ilike ${p(`%${a.industry}%`)}`);
  if (a.max_visibility != null) where.push(`l.visibility <= ${p(a.max_visibility)}`);
  if (a.has_phone) where.push(`(coalesce(l.summary->'fit'->>'phone', '') <> '')`);
  if (a.hiring) where.push(`(l.summary->'lead'->>'hiring')::int = 1`);
  if (a.needs_relaunch) where.push(`(l.summary->'audit'->>'relaunch')::boolean`);
  if (a.owner) where.push(`c.owner ilike ${p(a.owner)}`);
  const limit = Math.min(100, Math.max(1, a.limit || 20)), offset = Math.max(0, a.offset || 0);
  const sql = `
    with ranks as (select domain, row_number() over (order by deal_score desc, domain) as rank from leads where live)
    select l.domain, l.summary, l.tier, l.deal_score, l.visibility, l.p_close, l.ev_chf, l.company, l.country, l.industry, l.city,
           k.rank, c.status, c.owner, count(*) over () as total
    from leads l left join ranks k using (domain) left join crm c using (domain)
    ${where.length ? "where " + where.join(" and ") : ""}
    order by ${SORTS[a.sort] || SORTS.rank}
    limit ${limit} offset ${offset}`;
  const { rows } = await db.query(sql, args);
  return { total_matches: Number(rows[0]?.total || 0), offset, returned: rows.length, leads: rows.map(compact),
    dashboard: SITE };
}

async function getLead(db, a = {}) {
  const domain = String(a.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const { rows } = await db.query(
    `select l.detail, l.shot_m, l.shot_d, l.tier, l.deal_score, c.status, c.owner, c.notes, c.updated_by, c.updated_at,
            (select value from meta where key = 'info') as info,
            (select count(*) + 1 from leads x where x.live and x.deal_score > l.deal_score) as rank
     from leads l left join crm c using (domain) where l.domain = $1`, [domain]);
  if (!rows[0]) throw new Error(`No lead with domain ${domain}. Use search_leads to find the right domain.`);
  const r = rows[0], d = r.detail;
  const x = finalize(assess(d.lead, d.http, d.render, d.maps, r.info?.bench), DEFAULTS);
  const f = x.forecast, m = d.maps;
  return {
    company: d.lead.company, domain, website: d.http?.finalUrl || `https://${domain}`, rank: x.live ? Number(r.rank) : null, tier: x.tier,
    industry: d.lead.industry || null, location: [d.lead.city, d.lead.region, d.lead.country].filter(Boolean).join(", ") || null,
    staff: d.lead.employees ?? d.lead.employees_band ?? null,
    revenue: { chf_est: x.revenue.chf, range: [x.revenue.low, x.revenue.high], basis: x.revenue.basis, confidence: x.revenue.confidence },
    contacts: d.lead.contacts.map((c) => ({ name: [c.first, c.last].filter(Boolean).join(" ") || null, title: c.title || null, email: c.email || null, phone: c.phone || null, linkedin: c.linkedin || null })),
    company_phone: d.lead.phone || m?.mapsPhone || null,
    hiring: d.lead.jobAds?.length ? d.lead.jobAds : d.lead.hiring ? [d.lead.hiring] : [],
    website_status: x.live ? "live" : x.noSite || "no working website",
    scores: x.live ? { deal: x.dealScore, visibility: x.audit.visibility, seo: x.audit.seoScore, geo: x.audit.geoScore, conversion: x.conversion?.score ?? null, fit: x.fit.score } : { fit: x.fit.score },
    opening_lines: x.talk || [],
    seo_issues: x.audit?.seo.sort((p, q) => q.pts - p.pts).map((i) => ({ issue: i.label, points_lost: i.pts, explanation: i.say })) || [],
    geo_issues: x.audit?.geo.sort((p, q) => q.pts - p.pts).map((i) => ({ issue: i.label, points_lost: i.pts, explanation: i.say })) || [],
    conversion_issues: x.conversion?.issues.map((i) => ({ issue: i.label, explanation: i.say, fix: i.fix, screen: i.where === "m" ? "phone" : "desktop" })) || [],
    cms: x.audit?.cms || null, needs_relaunch: !!x.audit?.relaunch,
    google: m?.matched ? { name: m.name, rating: m.rating, reviews: m.reviews, category: m.category, maps_url: m.mapsUrl } : m ? "not found on Google Maps" : "not checked yet",
    forecast: { offer: f.offer || "New website", deal_chf: f.dealChf, p_close_pct: round(f.pClose * 100, 2), expected_chf: f.evChf,
      channel: f.called ? "email, then calls" : "email only", p_email_reply_pct: round(f.pReply * 100, 2),
      ...(f.called ? { p_reach_by_phone_pct: round(f.pReach * 100, 1), p_meeting_if_reached_pct: round(f.pMeetIfReached * 100, 1) } : {}),
      note: "Planning estimates at default rates, not measured results." },
    sales: { status: r.status || "new", owner: r.owner || null, notes: r.notes || null, updated_by: r.updated_by || null, updated_at: r.updated_at || null },
    screenshots: { phone: r.shot_m, desktop: r.shot_d },
    dashboard: SITE,
  };
}

async function updateLead(db, a = {}, user) {
  const domain = String(a.domain || "").trim().toLowerCase();
  if (a.status && !STATUSES.includes(a.status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  const exists = await db.query("select 1 from leads where domain = $1", [domain]);
  if (!exists.rowCount) throw new Error(`No lead with domain ${domain}.`);
  const cur = (await db.query("select status, owner, notes from crm where domain = $1", [domain])).rows[0] || { status: "new", owner: "", notes: "" };
  let notes = a.notes != null ? String(a.notes) : cur.notes;
  if (a.append_note) notes = `${notes ? notes + "\n" : ""}${new Date().toISOString().slice(0, 10)} ${user}: ${a.append_note}`;
  const { rows } = await db.query(
    `insert into crm (domain, status, owner, notes, updated_by, updated_at) values ($1, $2, $3, $4, $5, now())
     on conflict (domain) do update set status = excluded.status, owner = excluded.owner, notes = excluded.notes, updated_by = excluded.updated_by, updated_at = now()
     returning status, owner, notes, updated_by, updated_at`,
    [domain, a.status || cur.status, (a.owner ?? cur.owner ?? "").slice(0, 80), notes.slice(0, 5000), `${user} (API)`]);
  return { domain, ...rows[0] };
}

async function pipelineSummary(db) {
  const [tiers, statuses, info] = await Promise.all([
    db.query(`select tier, count(*)::int as leads, round(sum(p_close)::numeric, 1)::float8 as expected_sales, sum(ev_chf)::int as expected_chf
              from leads group by tier order by tier`),
    db.query(`select coalesce(c.status, 'new') as status, count(*)::int as leads from leads l left join crm c using (domain) group by 1 order by 2 desc`),
    db.query(`select value from meta where key = 'info'`),
  ]);
  const t = tiers.rows;
  return {
    leads_total: t.reduce((s, r) => s + r.leads, 0),
    by_tier: Object.fromEntries(t.map((r) => [r.tier, { leads: r.leads, expected_websites_sold: r.expected_sales, expected_chf: r.expected_chf }])),
    by_status: Object.fromEntries(statuses.rows.map((r) => [r.status, r.leads])),
    predicted: { websites_sold: round(t.reduce((s, r) => s + r.expected_sales, 0), 1), revenue_chf: t.reduce((s, r) => s + r.expected_chf, 0),
      assumptions: "CHF 5,000 average website; email to everyone, calls to tiers A and B; planning rates, not measured results" },
    scan_progress: info.rows[0]?.value?.progress || null, last_sync: info.rows[0]?.value?.syncedAt || null,
    tier_meaning: { A: "call first", B: "call second", C: "email only", V: "already visible, skip", X: "no working website" },
  };
}

export async function callTool(db, name, args, user) {
  if (name === "search_leads") return searchLeads(db, args);
  if (name === "get_lead") return getLead(db, args);
  if (name === "update_lead") return updateLead(db, args, user);
  if (name === "pipeline_summary") return pipelineSummary(db);
  throw new Error(`Unknown tool ${name}`);
}

/** Handles one MCP JSON-RPC message; returns the response object, or null for notifications. */
async function handleMessage(db, msg, user) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return fail(-32600, "Invalid Request");
  if (id === undefined) return null; // notifications (initialized, cancelled, ...) need no answer
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "webbetter-dealflow", title: "WEB BETTER DEAL FLOW", version: "1.0.0" },
        instructions:
          "Sales leads for Web Better (websites, SEO and GEO/AI-search for Swiss and German SMEs). Start with pipeline_summary or " +
          "search_leads (tier A and B are the call list). Use get_lead before drafting an email or call script: its opening_lines, " +
          "seo_issues, geo_issues and conversion_issues are the facts to use. Scores are rule-based estimates from each homepage, not " +
          "measured Google rankings; say so if asked. Record outcomes with update_lead (append_note keeps history).",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        const data = await callTool(db, tool.name, params.arguments || {}, user);
        return ok({ content: [{ type: "text", text: JSON.stringify(data, null, 1) }], structuredContent: data, isError: false });
      } catch (e) {
        return ok({ content: [{ type: "text", text: String(e.message || e) }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

/** HTTP entry for POST /api/mcp: a single message or a batch. */
export async function mcpHttp(db, body, user) {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMessage(db, m, user)))).filter(Boolean);
    return out.length ? out : null;
  }
  return handleMessage(db, body, user);
}
