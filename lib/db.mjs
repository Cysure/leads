// Postgres access for the hosted dashboard (Neon on Vercel) and the local sync script.
// Locally only DEALFLOW_DATABASE_URL is read: this machine has an unrelated machine-wide DATABASE_URL.
// On Vercel, the Neon integration injects DATABASE_URL / POSTGRES_URL, which are accepted there.
import pg from "pg";

export function databaseUrl() {
  if (process.env.DEALFLOW_DATABASE_URL) return process.env.DEALFLOW_DATABASE_URL;
  if (process.env.VERCEL) return process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  return "";
}

let pool = null;
export function db() {
  if (pool) return pool;
  const url = databaseUrl();
  if (!url) throw new Error("No database configured: set DEALFLOW_DATABASE_URL");
  const local = /localhost|127\.0\.0\.1/.test(url);
  // TLS is configured below; drop sslmode/channel_binding from the URL so pg does not warn about their future meaning.
  const clean = url.replace(/([?&])(sslmode|channel_binding)=[^&]*&?/g, "$1").replace(/[?&]$/, "");
  pool = new pg.Pool({ connectionString: clean, max: process.env.VERCEL ? 1 : 4, ssl: local ? false : { rejectUnauthorized: false }, idleTimeoutMillis: 10000 });
  return pool;
}

export const SCHEMA = `
create table if not exists leads (
  domain text primary key,
  summary jsonb not null,       -- slim(): what the list, filters and forecast need
  detail jsonb not null,        -- lead + http + render + maps, for the drawer
  shot_m text, shot_d text,     -- screenshot URLs (Vercel Blob)
  hash text not null,
  updated_at timestamptz not null default now()
);
create table if not exists crm (
  domain text primary key,
  status text not null default 'new',
  owner text not null default '',
  notes text not null default '',
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);
create table if not exists users (
  username text primary key,
  pass_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists meta (
  key text primary key,
  value jsonb not null
);
`;

export async function ensureSchema() {
  await db().query(SCHEMA);
}
