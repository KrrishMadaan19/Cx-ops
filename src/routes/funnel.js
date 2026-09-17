import { Hono } from 'hono';
import { get } from '../db.js';
import { resolveWindow } from '../timeWindow.js';
import { resolveChannel, resolveOwner } from '../filters.js';

const app = new Hono();
app.get("/funnel", async (c) => {
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
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress
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
  const total = Number(totals?.total ?? 0);
  const humanResolved = Number(totals?.human_resolved ?? 0);
  const pct2 = (n) => total ? Math.round(n / total * 100) : 0;
  return c.json([
    { label: "Conversations started", count: total, pctOfTotal: 100 },
    { label: "Resolved by bot", count: Number(totals?.bot_resolved ?? 0), pctOfTotal: pct2(Number(totals?.bot_resolved ?? 0)) },
    { label: "Handed off to a human", count: handoffCount, pctOfTotal: pct2(handoffCount), branch: "human" },
    {
      label: "Resolved by human",
      count: humanResolved,
      pctOfTotal: pct2(humanResolved),
      branch: "human",
      dropPct: handoffCount ? Math.round((handoffCount - humanResolved) / handoffCount * 100) : 0
    },
    { label: "Still in progress", count: Number(totals?.in_progress ?? 0), pctOfTotal: pct2(Number(totals?.in_progress ?? 0)) }
  ]);
});
export default app;