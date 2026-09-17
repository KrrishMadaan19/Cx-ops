import { Hono } from 'hono';
import { all } from '../db.js';
import { resolveWindow } from '../timeWindow.js';
import { resolveChannel, resolveOwner } from '../filters.js';

const app = new Hono();
app.get("/agents", async (c) => {
  const query = c.req.query();
  const { start, end } = resolveWindow(query);
  const channel = resolveChannel(query.channel);
  const owner = resolveOwner(query.view);
  const params = { start, end };
  const channelClausePrefixed = channel ? "AND conversations.channel = @channel" : "";
  if (channel) params.channel = channel;
  const ownerClausePrefixed = owner ? "AND conversations.owner_type = @owner" : "";
  if (owner) params.owner = owner;
  const rows = await all(c.env, `
    SELECT
      agents.id,
      agents.name,
      COUNT(conversations.id) AS conversations,
      SUM(CASE WHEN conversations.status = 'responded' THEN 1 ELSE 0 END) AS responded,
      AVG(conversations.first_response_seconds) AS avg_response_seconds,
      AVG(csat.score) AS avg_csat
    FROM agents
    LEFT JOIN conversations ON conversations.owner_agent_id = agents.id AND conversations.started_at >= @start AND conversations.started_at < @end ${channelClausePrefixed} ${ownerClausePrefixed}
    LEFT JOIN csat ON csat.conversation_id = conversations.id
    GROUP BY agents.id
    HAVING conversations > 0
    ORDER BY conversations DESC
  `, params);
  const result = rows.map((r) => {
    const convCount = Number(r.conversations);
    const responded = Number(r.responded ?? 0);
    const avgResponseSeconds = r.avg_response_seconds != null ? Number(r.avg_response_seconds) : null;
    const resolutionRate = convCount ? responded / convCount * 100 : 0;
    const csat = r.avg_csat != null ? Number(r.avg_csat) : 0;
    const qualityScore = Math.round(resolutionRate * 0.5 + csat / 5 * 50);
    const m = Math.floor((avgResponseSeconds || 0) / 60);
    const s = Math.round((avgResponseSeconds || 0) % 60);
    return {
      id: r.id,
      name: r.name,
      conversations: convCount,
      resolution: `${resolutionRate.toFixed(1)}%`,
      resolutionPct: Number(resolutionRate.toFixed(1)),
      avgResponse: avgResponseSeconds ? `${m}m ${String(s).padStart(2, "0")}s` : "--",
      avgResponseSeconds,
      csat: csat ? csat.toFixed(2) : "--",
      csatValue: csat || null,
      qualityScore
    };
  });
  return c.json(result);
});
export default app;