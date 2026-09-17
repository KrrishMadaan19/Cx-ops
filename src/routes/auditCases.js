import { Hono } from 'hono';
import { all, get, run } from '../db.js';
import { resolveWindow } from '../timeWindow.js';
import { resolveChannel, resolveOwner } from '../filters.js';
import { fmtSeconds } from '../metricsEngine.js';
import { FIRST_RESPONSE_TARGET_SECONDS } from '../slaConfig.js';

const app = new Hono();
async function slowResponseCases(env, start, end, channel, q, owner) {
  const params = { target: FIRST_RESPONSE_TARGET_SECONDS, start, end };
  let sql = `
    SELECT
      conversations.id AS conversation_id,
      conversations.customer_name,
      conversations.order_id,
      conversations.flow,
      conversations.first_response_seconds,
      agents.name AS owner_name
    FROM conversations
    LEFT JOIN agents ON agents.id = conversations.owner_agent_id
    WHERE conversations.first_response_seconds > @target AND conversations.started_at >= @start AND conversations.started_at < @end
  `;
  if (channel) {
    sql += " AND conversations.channel = @channel";
    params.channel = channel;
  }
  if (owner) {
    sql += " AND conversations.owner_type = @owner";
    params.owner = owner;
  }
  if (q) {
    sql += " AND (conversations.customer_name LIKE @q OR conversations.order_id LIKE @q OR conversations.flow LIKE @q OR agents.name LIKE @q)";
    params.q = `%${q}%`;
  }
  sql += " ORDER BY conversations.first_response_seconds DESC";
  const rows = await all(env, sql, params);
  return rows.map((r) => ({
    id: r.conversation_id,
    auditId: null,
    customer: r.customer_name,
    order: r.order_id,
    signal: "SLA breach",
    type: "sla",
    owner: r.owner_name || "Unassigned",
    flow: r.flow,
    risk: Number(r.first_response_seconds) > FIRST_RESPONSE_TARGET_SECONDS * 4 ? "High" : "Medium",
    finding: `First response took ${fmtSeconds(Number(r.first_response_seconds))} -- our target is ${fmtSeconds(FIRST_RESPONSE_TARGET_SECONDS)}.`,
    messages: []
  }));
}
app.get("/audit-cases", async (c) => {
  const query = c.req.query();
  const { filter, q } = query;
  const { start, end } = resolveWindow(query);
  const channel = resolveChannel(query.channel);
  const owner = resolveOwner(query.view);
  if (filter === "sla") {
    return c.json(await slowResponseCases(c.env, start, end, channel, q, owner));
  }
  const params = { start, end };
  let sql = `
    SELECT
      qa_audits.id AS audit_id,
      conversations.id AS conversation_id,
      conversations.customer_name,
      conversations.order_id,
      conversations.flow,
      qa_audits.issue_category,
      qa_audits.severity,
      qa_audits.finding,
      qa_audits.status,
      agents.name AS owner_name,
      (SELECT action FROM audit_actions WHERE conversation_id = conversations.id ORDER BY id DESC LIMIT 1) AS last_action
    FROM qa_audits
    JOIN conversations ON conversations.id = qa_audits.conversation_id
    LEFT JOIN agents ON agents.id = conversations.owner_agent_id
    WHERE qa_audits.status = 'open' AND conversations.started_at >= @start AND conversations.started_at < @end
  `;
  if (channel) {
    sql += " AND conversations.channel = @channel";
    params.channel = channel;
  }
  if (owner) {
    sql += " AND conversations.owner_type = @owner";
    params.owner = owner;
  }
  if (filter && filter !== "all") {
    sql += " AND qa_audits.issue_category = @filter";
    params.filter = filter;
  }
  if (q) {
    sql += " AND (conversations.customer_name LIKE @q OR conversations.order_id LIKE @q OR conversations.flow LIKE @q)";
    params.q = `%${q}%`;
  }
  sql += " ORDER BY CASE qa_audits.severity WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END";
  const rows = await all(c.env, sql, params);
  const result = rows.map((r) => ({
    id: r.conversation_id,
    auditId: r.audit_id,
    customer: r.customer_name,
    order: r.order_id,
    signal: r.issue_category === "sla" ? "SLA breach" : r.issue_category === "bot" ? "Bot quality issue" : "Human coaching",
    type: r.issue_category,
    owner: r.last_action ? r.owner_name || "Bot QA" : r.owner_name || "Unassigned",
    flow: r.flow,
    risk: r.severity,
    finding: r.finding,
    messages: []
  }));
  return c.json(result);
});
app.get("/audit-cases/counts", async (c) => {
  const query = c.req.query();
  const { start, end } = resolveWindow(query);
  const channel = resolveChannel(query.channel);
  const owner = resolveOwner(query.view);
  const params = { start, end };
  let sql = `
    SELECT qa_audits.issue_category AS category, COUNT(*) AS n
    FROM qa_audits
    JOIN conversations ON conversations.id = qa_audits.conversation_id
    WHERE qa_audits.status = 'open' AND conversations.started_at >= @start AND conversations.started_at < @end
  `;
  if (channel) {
    sql += " AND conversations.channel = @channel";
    params.channel = channel;
  }
  if (owner) {
    sql += " AND conversations.owner_type = @owner";
    params.owner = owner;
  }
  sql += " GROUP BY qa_audits.issue_category";
  const rows = await all(c.env, sql, params);
  const bot = Number(rows.find((r) => r.category === "bot")?.n ?? 0);
  const human = Number(rows.find((r) => r.category === "human")?.n ?? 0);
  const all_ = rows.reduce((s, r) => s + Number(r.n), 0);
  const sla = (await slowResponseCases(c.env, start, end, channel, null, owner)).length;
  return c.json({ all: all_, sla, bot, human });
});
app.get("/audit-cases/sla-by-agent", async (c) => {
  const query = c.req.query();
  const { start, end } = resolveWindow(query);
  const channel = resolveChannel(query.channel);
  const params = { target: FIRST_RESPONSE_TARGET_SECONDS, start, end };
  let sql = `
    SELECT
      COALESCE(agents.name, 'Unassigned') AS agent,
      COUNT(*) AS breaches,
      AVG(conversations.first_response_seconds) AS avg_seconds,
      MAX(conversations.first_response_seconds) AS worst_seconds
    FROM conversations
    LEFT JOIN agents ON agents.id = conversations.owner_agent_id
    WHERE conversations.first_response_seconds > @target AND conversations.started_at >= @start AND conversations.started_at < @end
  `;
  if (channel) {
    sql += " AND conversations.channel = @channel";
    params.channel = channel;
  }
  sql += " GROUP BY agent ORDER BY breaches DESC";
  const rows = await all(c.env, sql, params);
  return c.json(rows.map((r) => ({
    agent: r.agent,
    breaches: Number(r.breaches),
    avgDelay: fmtSeconds(Number(r.avg_seconds)),
    worstDelay: fmtSeconds(Number(r.worst_seconds))
  })));
});
app.patch("/audit-cases/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { action, actor, note } = body;
  if (!["assigned", "reviewed", "reassigned"].includes(action)) {
    return c.json({ error: "action must be one of: assigned, reviewed, reassigned" }, 400);
  }
  const conversation = await get(c.env, "SELECT id FROM conversations WHERE id = ?", [id]);
  if (!conversation) return c.json({ error: "conversation not found" }, 404);
  await run(c.env, `
    INSERT INTO audit_actions (conversation_id, action, actor, note) VALUES (?, ?, ?, ?)
  `, [id, action, actor || "unknown", note || null]);
  if (action === "reviewed") {
    await run(c.env, `UPDATE qa_audits SET status = 'resolved' WHERE conversation_id = ?`, [id]);
  }
  return c.json({ ok: true });
});
export default app;