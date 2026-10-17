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
