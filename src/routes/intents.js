import { Hono } from 'hono';
import { all } from '../db.js';
import { resolveWindow } from '../timeWindow.js';
import { resolveChannel, resolveOwner } from '../filters.js';

const app = new Hono();
app.get("/intents", async (c) => {
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
      conversations.intent,
      COUNT(*) AS total,
      SUM(CASE WHEN conversations.resolved_by = 'bot' THEN 1 ELSE 0 END) AS bot_resolved,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM handoffs WHERE handoffs.conversation_id = conversations.id) THEN 1 ELSE 0 END) AS handoffs,
      AVG(csat.score) AS avg_csat,
      SUM(CASE WHEN csat.score <= 2 THEN 1 ELSE 0 END) AS dsat_count
    FROM conversations
    LEFT JOIN csat ON csat.conversation_id = conversations.id
    WHERE conversations.intent IS NOT NULL AND conversations.started_at >= @start AND conversations.started_at < @end ${channelClausePrefixed} ${ownerClausePrefixed}
    GROUP BY conversations.intent
    ORDER BY handoffs DESC
  `, params);
  const taggedTotal = rows.reduce((s, r) => s + Number(r.total), 0);
  const intents = rows.map((r) => ({
    intent: r.intent,
    total: Number(r.total),
    botResolved: Number(r.bot_resolved),
    handoffs: Number(r.handoffs),
    failureRate: r.total ? `${(Number(r.handoffs) / Number(r.total) * 100).toFixed(1)}%` : "0%",
    csat: r.avg_csat != null ? Number(r.avg_csat).toFixed(2) : "--",
    dsat: Number(r.dsat_count ?? 0)
  }));
  return c.json({ intents, taggedTotal });
});
export default app;