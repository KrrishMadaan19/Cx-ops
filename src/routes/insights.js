import { Hono } from 'hono';
import { resolveWindow } from '../timeWindow.js';
import { resolveChannel } from '../filters.js';
import { computeInsights } from '../insightsEngine.js';

const app = new Hono();
app.get("/insights", async (c) => {
  const query = c.req.query();
  const { start, end } = resolveWindow(query);
  const channel = resolveChannel(query.channel);
  return c.json(await computeInsights(c.env, { start, end, channel: channel }));
});
export default app;