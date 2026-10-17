# WEB BETTER DEAL FLOW

Ranks every company from the lead exports by how invisible its website is on Google (SEO) and in AI answers (GEO), adds Google reviews and buyer fit, and forecasts what a sales call to each one is worth.

## Run

```bash
python -P pipeline/ingest.py data/leads.json <lead files…>   # merge all exports on domain
node src/scan-http.mjs                                        # crawler view: HTML, robots, sitemap, llms.txt
node src/scan.mjs                                             # Chromium phone render
curl http://localhost:6300/api/order > data/order.json        # current ranking, best first
node src/maps.mjs --from data/order.json                      # Google reviews, best leads first
node src/server.mjs                                           # dashboard on http://localhost:6300
```

Every scan step writes JSONL into `data/`, skips domains it has already done, and can be stopped and resumed. The dashboard reads whatever is there, so you can refresh it while scans run.

## Scoring

The model is in `public/score.js` and is shared by the server and the dashboard. The method is explained on the "Forecast assumptions & method" tab. Visibility is a rule-based estimate from what is on the site. It is not a measured Google ranking position.

`data/` holds personal contact data from the lead files. It is gitignored: keep it local.

## Hosted version (Vercel)

The dashboard on Vercel is a static page (`public/`) plus one API function (`api/handler.js`) that reads a Neon
Postgres database. Every data request needs a login. The scanners keep running on this machine, and
`npm run sync` pushes their results up. It only sends leads that changed, plus resized screenshots for Vercel Blob.

One-time setup:

1. Vercel: **Add New → Project**, import `Cysure/leads`, keep the defaults (`vercel.json` configures everything), deploy.
2. In the project, open **Storage**: create a **Neon** Postgres database and a **Blob** store, and connect both to the project.
   This sets `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` on Vercel.
3. **Settings → Environment Variables**: add `DEALFLOW_SECRET`, a random string of at least 32 characters, e.g. from
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Then redeploy.
4. On this machine, copy `.env.example` to `.env` and fill in the Neon connection string and the Blob token from the
   Storage tab.
5. `npm run adduser <name>` for each salesperson (the password is typed in, never stored in plain text), then `npm run sync`.

`pipeline/enrich-loop.sh` runs the sync automatically after every round once `.env` exists.

Local testing of the hosted mode: `node src/dev-hosted.mjs --env .env.test` against any Postgres.
