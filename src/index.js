import { Hono } from 'hono';

import schemaSql from './schema.sql';
import { execSchema } from './db.js';
import { responseCache } from './responseCache.js';
import { runIngest } from './ingest/structure.js';

import summary from './routes/summary.js';
import flows from './routes/flows.js';
import intents from './routes/intents.js';
import health from './routes/health.js';
import funnel from './routes/funnel.js';
import agents from './routes/agents.js';
import liveWatch from './routes/liveWatch.js';
import channels from './routes/channels.js';
import auditCases from './routes/auditCases.js';
import insights from './routes/insights.js';
import compare from './routes/compare.js';
import exportCsv from './routes/exportCsv.js';

const app = new Hono();

app.use('/api/*', responseCache());

app.get('/health', (c) => c.json({ ok: true }));

app.post('/api/setup', async (c) => {
  await execSchema(c.env, schemaSql);
  return c.json({ ok: true, message: 'schema applied' });
});

app.post('/api/sync-now', async (c) => {
  const processed = await runIngest(c.env);
  return c.json({ ok: true, processed });
});

app.route('/api', summary);
app.route('/api', flows);
app.route('/api', intents);
app.route('/api', health);
app.route('/api', funnel);
app.route('/api', agents);
app.route('/api', liveWatch);
app.route('/api', channels);
app.route('/api', auditCases);
app.route('/api', insights);
app.route('/api', compare);
app.route('/api', exportCsv);

export default {
  fetch: app.fetch,

  // Replaces server/src/jobs/sync.js's node-cron loop -- wrangler.toml's
  // [triggers] crons fires this on a schedule instead.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runIngest(env).catch((err) => console.error('[scheduled sync] failed:', err.message)),
    );
  },
};
