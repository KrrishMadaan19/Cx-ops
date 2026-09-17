import { Hono } from 'hono';
import { all } from '../db.js';
import { resolveWindow } from '../timeWindow.js';
import { resolveChannel, resolveOwner } from '../filters.js';

const app = new Hono();
function csvEscape(value) {
  if (value == null) return "";
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
app.get("/export/conversations", async (c) => {
  const query = c.req.query();
  const { start, end } = resolveWindow(query);
  const channel = resolveChannel(query.channel);
  const owner = resolveOwner(query.view);
  const params = { start, end };
  let clauses = "conversations.started_at >= @start AND conversations.started_at < @end";
  if (channel) {
    clauses += " AND conversations.channel = @channel";
    params.channel = channel;
  }
  if (owner) {
    clauses += " AND conversations.owner_type = @owner";
    params.owner = owner;
  }
  const rows = await all(c.env, `
    SELECT
      conversations.id, customer_name, order_id, channel, flow, started_at, ended_at,
      status, owner_type, owner_agent_id, resolved_by, first_response_seconds,
      resolution_seconds, intent, bot_confidence, sentiment_final, fcr,
      csat.score AS csat_score, csat.feedback_text AS csat_feedback
    FROM conversations
    LEFT JOIN csat ON csat.conversation_id = conversations.id
    WHERE ${clauses}
    ORDER BY started_at DESC
  `, params);
  const headers = [
    "Ticket ID",
    "Customer",
    "Order",
    "Channel",
    "Flow",
    "Started At",
    "Ended At",
    "Status",
    "Owner Type",
    "Agent",
    "Resolved By",
    "First Response (s)",
    "Resolution (s)",
    "Intent",
    "Bot Confidence",
    "Sentiment",
    "FCR",
    "CSAT Score",
    "CSAT Feedback"
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([
      r.id,
      r.customer_name,
      r.order_id,
      r.channel,
      r.flow,
      r.started_at,
      r.ended_at,
      r.status,
      r.owner_type,
      r.owner_agent_id,
      r.resolved_by,
      r.first_response_seconds,
      r.resolution_seconds,
      r.intent,
      r.bot_confidence,
      r.sentiment_final,
      r.fcr,
      r.csat_score,
      r.csat_feedback
    ].map(csvEscape).join(","));
  }
  const safeDatePart = (v, fallback) => {
    const cleaned = String(v || "").replace(/[^0-9-]/g, "");
    return cleaned || fallback;
  };
  const rangeLabel = `${safeDatePart(query.from, "range")}_to_${safeDatePart(query.to, "now")}`;
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="cx-ops-conversations-${rangeLabel}.csv"`);
  return c.body(lines.join("\n"));
});
export default app;