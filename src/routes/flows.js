import { Hono } from 'hono';
import { all } from '../db.js';
import { resolveWindow } from '../timeWindow.js';
import { resolveChannel, resolveOwner } from '../filters.js';

const app = new Hono();
app.get("/flows", async (c) => {
  const query = c.req.query();
  const { start, end } = resolveWindow(query);
  const channel = resolveChannel(query.channel);
  const owner = resolveOwner(query.view);
  const channelClausePrefixed = channel ? "AND conversations.channel = @channel" : "";
  const ownerClausePrefixed = owner ? "AND conversations.owner_type = @owner" : "";
  const params = { start, end };
  if (channel) params.channel = channel;
  if (owner) params.owner = owner;
  const rows = await all(c.env, `
    SELECT
      conversations.flow,
      COUNT(*) AS total,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM handoffs WHERE handoffs.conversation_id = conversations.id) THEN 1 ELSE 0 END) AS handoffs,
      AVG(csat.score) AS avg_csat,
      SUM(CASE WHEN csat.score <= 2 THEN 1 ELSE 0 END) AS dsat_count
    FROM conversations
    LEFT JOIN csat ON csat.conversation_id = conversations.id
    WHERE conversations.flow IS NOT NULL AND conversations.started_at >= @start AND conversations.started_at < @end ${channelClausePrefixed} ${ownerClausePrefixed}
    GROUP BY conversations.flow
    ORDER BY total DESC
  `, params);
  const result = rows.map((r) => ({
    flow: r.flow,
    total: Number(r.total),
    handoffs: Number(r.handoffs),
    handoffRate: r.total ? `${(Number(r.handoffs) / Number(r.total) * 100).toFixed(1)}%` : "0%",
    csat: r.avg_csat != null ? Number(r.avg_csat).toFixed(2) : "--",
    dsat: Number(r.dsat_count ?? 0)
  }));
  return c.json(result);
});
export default app;