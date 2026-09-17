import { Hono } from 'hono';
import { resolveWindow } from '../timeWindow.js';
import { resolveChannel } from '../filters.js';
import { computePeriodMetrics } from '../metricsEngine.js';

const app = new Hono();
app.get("/compare", async (c) => {
  const query = c.req.query();
  const { date } = query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "date is required, as YYYY-MM-DD" }, 400);
  }
  const { start, end } = resolveWindow(query);
  const channel = resolveChannel(query.channel);
  const { start: cStart, end: cEnd } = resolveWindow({ from: date, to: date });
  const [current, compare] = await Promise.all([
    computePeriodMetrics(c.env, { start, end, channel: channel }),
    computePeriodMetrics(c.env, { start: cStart, end: cEnd, channel: channel })
  ]);
  return c.json({ current, compare: { date, ...compare } });
});
export default app;