# CX-OPS

Analytics dashboard for a WhatsApp bot + human-agent support operation. Shows
traffic, containment and handoff rates, CSAT, SLA breaches, agent performance
and a live "needs a response now" queue — all computed from ticket data pulled
from FlowCall.

Runs as a single Cloudflare Worker that serves both the dashboard and its JSON
API, backed by D1.

## Layout

```
public/          dashboard frontend (no build step — plain HTML/CSS/JS)
src/
  index.js       Hono app: routes, cron handler
  db.js          D1 wrapper
  responseCache.js
  schema.sql     table + index definitions
  routes/        one module per API endpoint group
  ingest/        FlowCall export -> D1
  *Engine.js     metric and insight computation
wrangler.toml
```

## Running locally

```bash
npm install
npx wrangler d1 execute cx-ops-db --local --file=src/schema.sql
npx wrangler dev
```

That uses a local SQLite database, so it costs no quota and touches nothing in
production. Seed it with a few `INSERT`s to see the dashboard populated.

## Deploying

```bash
npx wrangler deploy
```

Secrets live in Cloudflare, not in this repo, and persist across deploys:

| Secret | Purpose |
| --- | --- |
| `FLOWCALL_ACCESS_TOKEN` | auth for the FlowCall ticket export API |

Set one with `npx wrangler secret put NAME`.

Schema changes go out with `npm run schema` (applies `src/schema.sql` to the
remote D1 database; every statement is `IF NOT EXISTS`, so it is safe to re-run).

## How data gets in

`wrangler.toml`'s `[triggers] crons` fires `scheduled()` in `src/index.js`, which
runs the FlowCall ingest. Each run asks FlowCall for tickets updated since
`sync_state.last_synced_at`, then upserts them.

`POST /api/sync-now` triggers the same ingest by hand. Note it runs the whole
import inside one request, so a wide window can exceed the Worker's limits — the
cron path is the reliable one.

## Watch the quota

The free tier is the binding constraint, and it is easy to blow through:

- **D1 reads: 5M rows/day.** The dashboard polls several endpoints on a timer,
  so unindexed queries get expensive fast. An earlier version full-scanned
  `qa_audits` (20k rows) twice per refresh and exhausted a full day's quota in
  under ten minutes.
- **D1 writes: 100k rows/day.** Ingest writes ~6 rows per ticket, so sync
  frequency drives this directly. That is why the cron is every 5 minutes rather
  than every 2.
- **Worker CPU: 10ms per invocation.** Large ingest batches and big bundles hit
  this.

Before adding a query, check it can use an index. Before adding a poll, check
what it costs per day.
