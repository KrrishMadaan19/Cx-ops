import { Hono } from 'hono';
import { get } from '../db.js';
import { resolveWindow } from '../timeWindow.js';
import { resolveChannel, resolveOwner } from '../filters.js';
import { fmtSeconds } from '../metricsEngine.js';

const app = new Hono();
app.get("/health", async (c) => {
  const query = c.req.query();
  const { start, end } = resolveWindow(query);
  const channel = resolveChannel(query.channel);
  const owner = resolveOwner(query.view);
  const params = { start, end };
  const channelClause = channel ? "AND channel = @channel" : "";
  if (channel) params.channel = channel;
  const ownerClause = owner ? "AND owner_type = @owner" : "";
  if (owner) params.owner = owner;
  const totals = await get(c.env, `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN resolved_by = 'bot' THEN 1 ELSE 0 END) AS bot_resolved,
      SUM(CASE WHEN resolved_by = 'human' THEN 1 ELSE 0 END) AS human_resolved,
      AVG(CASE WHEN resolved_by = 'human' THEN resolution_seconds END) AS avg_human_handle_seconds
    FROM conversations
    WHERE started_at >= @start AND started_at < @end ${channelClause} ${ownerClause}
  `, params);
  const handoffRow = await get(c.env, `
    SELECT COUNT(*) AS n
    FROM conversations
    WHERE started_at >= @start AND started_at < @end ${channelClause} ${ownerClause}
      AND EXISTS (SELECT 1 FROM handoffs WHERE handoffs.conversation_id = conversations.id)
  `, params);
  const handoffCount = Number(handoffRow?.n ?? 0);
  const fcrRow = await get(c.env, `
    SELECT
      SUM(CASE WHEN fcr = 'Yes' THEN 1 ELSE 0 END) AS yes_count,
      SUM(CASE WHEN fcr IN ('Yes','No') THEN 1 ELSE 0 END) AS sample_size
    FROM conversations
    WHERE started_at >= @start AND started_at < @end ${channelClause} ${ownerClause}
  `, params);
  const total = Number(totals?.total ?? 0);
  return c.json({
    bot: {
      containmentRate: total ? Number((Number(totals.bot_resolved ?? 0) / total * 100).toFixed(1)) : 0,
      handoffRate: total ? Number((handoffCount / total * 100).toFixed(1)) : 0
    },
    human: {
      ticketsResolved: Number(totals?.human_resolved ?? 0),
      acceptedCount: handoffCount,
      fcrRate: fcrRow?.sample_size ? Number((Number(fcrRow.yes_count) / Number(fcrRow.sample_size) * 100).toFixed(1)) : null,
      fcrSampleSize: Number(fcrRow?.sample_size ?? 0),
      avgHandleTime: fmtSeconds(totals?.avg_human_handle_seconds)
    }
  });
});
export default app;