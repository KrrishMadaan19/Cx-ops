import { Hono } from 'hono';
import { all } from '../db.js';
import { resolveChannel } from '../filters.js';
import { todayIstStartUtc } from '../timeWindow.js';
import { fmtSeconds } from '../metricsEngine.js';
import { FIRST_RESPONSE_TARGET_SECONDS } from '../slaConfig.js';

const app = new Hono();
app.get("/live-watch", async (c) => {
  const query = c.req.query();
  const channel = resolveChannel(query.channel);
  const now = new Date();
  const todayStart = todayIstStartUtc();
  const breachThreshold = new Date(now.getTime() - FIRST_RESPONSE_TARGET_SECONDS * 1e3);
  const params = { start: todayStart.toISOString(), end: breachThreshold.toISOString() };
  const channelClause = channel ? "AND conversations.channel = @channel" : "";
  if (channel) params.channel = channel;
  const rows = await all(c.env, `
    SELECT
      conversations.id, conversations.customer_name, conversations.customer_phone,
      conversations.order_id, conversations.flow, conversations.channel,
      conversations.started_at, conversations.assigned_at, agents.name AS owner_name
    FROM conversations
    LEFT JOIN agents ON agents.id = conversations.owner_agent_id
    WHERE conversations.assigned_at IS NOT NULL
      AND conversations.ended_at IS NULL
      AND conversations.has_agent_actioned = 0
      AND conversations.assigned_at >= @start
      AND conversations.assigned_at <= @end
      ${channelClause}
    ORDER BY conversations.assigned_at ASC
  `, params);
  const conversations = rows.map((r) => ({
    id: r.id,
    customer: r.customer_name,
    phone: r.customer_phone,
    order: r.order_id,
    flow: r.flow,
    channel: r.channel,
    owner: r.owner_name || "Unassigned",
    waitingFor: fmtSeconds(Math.round((now - new Date(r.assigned_at)) / 1e3)),
    assignedAt: r.assigned_at
  }));
  return c.json({ conversations, targetSeconds: FIRST_RESPONSE_TARGET_SECONDS });
});
export default app;