import { parse } from 'csv-parse/sync';
import { get, run, batch } from '../db.js';
import { fetchTicketsCsv } from './flowcallClient.js';

const ROWS_PER_BATCH = 40;
const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const FIELD_ALIASES = {
  ticket_id: ["ticket_id", "ticket number"],
  customer_id: ["customer_id", "customer id"],
  source: ["source", "channel"],
  customer_name: ["customer_name", "customer name"],
  customer_phone: ["customer_phone", "customer phone"],
  order_id: ["order_id", "order name"],
  flow: ["flow", "subcategory", "category"],
  started_at: ["started_at", "created at"],
  ended_at: ["ended_at", "resolved at"],
  status: ["status"],
  assigned_to: ["assigned_to", "assigned to"],
  assigned_at: ["assigned_at", "assigned at"],
  has_agent_actioned: ["has_agent_actioned", "has agent actioned"],
  resolved_by_raw: ["resolved_by", "resolved by"],
  first_response_minutes: ["first response time (minutes)"],
  resolution_minutes: ["resolution time (minutes)"],
  first_response_seconds: ["first_response_seconds"],
  resolution_seconds: ["resolution_seconds"],
  intent: ["intent", "objective: service_request_intent"],
  bot_confidence: ["bot_confidence", "confidence"],
  csat_score: ["csat_score", "csat rating"],
  feedback_text: ["feedback_text", "csat comment"],
  sentiment_final: ["sentiment_final", "sentiments"],
  handoff_reason: ["handoff_reason", "subcategory"],
  fcr: ["fcr"]
};
const PLACEHOLDER_VALUES = new Set(["unassigned", "n/a", "none", "-", ""]);
const isRealValue = (v) => v != null && !PLACEHOLDER_VALUES.has(String(v).trim().toLowerCase());
function parseFlowCallDate(value) {
  if (!isRealValue(value)) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).toISOString();
  const m = /^(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (m) {
    const [, dd, mm, yy, hh, min, ss] = m;
    return `20${yy}-${mm}-${dd}T${hh}:${min}:${ss}.000Z`;
  }
  console.warn("[ingest] unrecognized date format, dropping value:", value);
  return null;
}
function interpretStatus(rawStatus, assignedTo, resolvedByRaw) {
  const s = (rawStatus || "").toLowerCase();
  const hasAgent = isRealValue(assignedTo);
  if (s === "resolved by ai") return { status: "responded", resolvedBy: "bot", ownerType: "bot" };
  if (s === "resolved by agent") return { status: "responded", resolvedBy: "human", ownerType: "human" };
  if (s === "closed") return { status: "responded", resolvedBy: hasAgent ? "human" : "bot", ownerType: hasAgent ? "human" : "bot" };
  if (["in progress", "queued", "assigned"].includes(s)) {
    return { status: "in_progress", resolvedBy: null, ownerType: hasAgent ? "human" : "bot" };
  }
  if (["blocked", "stale", "stale (auto)"].includes(s)) {
    return { status: "missed", resolvedBy: null, ownerType: hasAgent ? "human" : "bot" };
  }
  if (s === "responded") {
    const resolvedBy = resolvedByRaw === "bot" || resolvedByRaw === "human" ? resolvedByRaw : hasAgent ? "human" : "bot";
    return { status: "responded", resolvedBy, ownerType: hasAgent ? "human" : "bot" };
  }
  if (s === "in_progress") return { status: "in_progress", resolvedBy: null, ownerType: hasAgent ? "human" : "bot" };
  if (s === "missed") return { status: "missed", resolvedBy: null, ownerType: hasAgent ? "human" : "bot" };
  return { status: s || null, resolvedBy: null, ownerType: hasAgent ? "human" : "bot" };
}
const AUDIT_WORTHY_SUBCATEGORIES = new Set([
  "refund follow up",
  "replacement follow up",
  "repair follow up",
  "spare /accessory follow up",
  "installation follow up",
  "customer inactive / dropped",
  "out of warranty \u2013 service denied"
]);
const EXPECTED_UNMAPPED = new Set(["first_response_seconds", "resolution_seconds", "bot_confidence"]);
const SEVERITY_BY_REASON = { sla_breach: "High", fallback_loop: "High", low_confidence: "Medium", sentiment_miss: "Medium", policy_exception: "Low" };
const CATEGORY_BY_REASON = { sla_breach: "sla", fallback_loop: "bot", low_confidence: "human", sentiment_miss: "bot", policy_exception: "human" };
function buildFieldMap(headerKeys) {
  const normalizedHeaders = headerKeys.map((h) => ({ raw: h, norm: normalize(h) }));
  const map = {};
  const unmapped = [];
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    let hit = null;
    for (const alias of aliases) {
      const aliasNorm = normalize(alias);
      hit = normalizedHeaders.find((h) => h.norm === aliasNorm);
      if (hit) break;
    }
    if (hit) map[field] = hit.raw;
    else if (!EXPECTED_UNMAPPED.has(field)) unmapped.push(field);
  }
  return { map, unmapped };
}
function readField(row, map, field) {
  const key = map[field];
  return key ? row[key] : void 0;
}
async function getCsvText(env) {
  const lastSynced = await get(env, "SELECT value FROM sync_state WHERE key = ?", ["last_synced_at"]);
  const startDate = lastSynced ? lastSynced.value : new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString();
  const endDate = (new Date()).toISOString();
  console.log(`[ingest] pulling FlowCall tickets updated between ${startDate} and ${endDate}`);
  const csv = await fetchTicketsCsv(env, { startDate, endDate, timestampKey: "updatedAt" });
  await run(env, `
    INSERT INTO sync_state (key, value) VALUES ('last_synced_at', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [endDate]);
  return csv;
}
async function ingestCsvText(env, raw) {
  const rows = parse(raw, { columns: true, skip_empty_lines: true, bom: true });
  if (rows.length === 0) {
    console.log("[ingest] 0 rows returned -- nothing to do this cycle");
    return 0;
  }
  const { map, unmapped } = buildFieldMap(Object.keys(rows[0]));
  console.log("[ingest] columns received from source:", Object.keys(rows[0]));
  console.log("[ingest] resolved field map:", map);
  if (unmapped.length) {
    console.warn("[ingest] WARNING -- no matching column found for:", unmapped.join(", "));
  }
  let statements = [];
  let processedRows = 0;
  async function flush() {
    if (!statements.length) return;
    await batch(env, statements);
    statements = [];
  }
  for (const row of rows) {
    const rawTicketId = readField(row, map, "ticket_id");
    const customerId = readField(row, map, "customer_id");
    const startedAtRaw = readField(row, map, "started_at");
    const ticketId = isRealValue(rawTicketId) ? rawTicketId : customerId && startedAtRaw ? `noid-${customerId}-${startedAtRaw}` : null;
    if (!ticketId) continue;
    const assignedToRaw = readField(row, map, "assigned_to");
    const assignedTo = isRealValue(assignedToRaw) ? assignedToRaw : null;
    const rawStatus = readField(row, map, "status");
    const resolvedByRaw = readField(row, map, "resolved_by_raw");
    const { status, resolvedBy, ownerType } = interpretStatus(rawStatus, assignedTo, resolvedByRaw);
    if (assignedTo) {
      statements.push({ sql: "INSERT INTO agents (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING", args: [assignedTo, assignedTo] });
    }
    const frMinutes = readField(row, map, "first_response_minutes");
    const resMinutes = readField(row, map, "resolution_minutes");
    const firstResponseSeconds = isRealValue(frMinutes) ? Math.round(Number(frMinutes) * 60) : Number(readField(row, map, "first_response_seconds")) || null;
    const resolutionSeconds = isRealValue(resMinutes) ? Math.round(Number(resMinutes) * 60) : Number(readField(row, map, "resolution_seconds")) || null;
    const flow = readField(row, map, "flow");
    const botConfidenceRaw = readField(row, map, "bot_confidence");
    const sourceRaw = readField(row, map, "source");
    const channel = isRealValue(sourceRaw) ? String(sourceRaw).toLowerCase() : "whatsapp";
    const flowValue = isRealValue(flow) && !String(flow).includes(",") ? flow : null;
    const customerPhoneRaw = readField(row, map, "customer_phone");
    const assignedAtRaw = readField(row, map, "assigned_at");
    const hasAgentActionedRaw = readField(row, map, "has_agent_actioned");
    statements.push({
      sql: `
      INSERT INTO conversations (
        id, customer_name, customer_phone, order_id, channel, flow, started_at, ended_at, status,
        owner_type, owner_agent_id, assigned_at, has_agent_actioned, resolved_by, first_response_seconds,
        resolution_seconds, intent, bot_confidence, sentiment_final, fcr, source_updated_at
      ) VALUES (
        @id, @customer_name, @customer_phone, @order_id, @channel, @flow, @started_at, @ended_at, @status,
        @owner_type, @owner_agent_id, @assigned_at, @has_agent_actioned, @resolved_by, @first_response_seconds,
        @resolution_seconds, @intent, @bot_confidence, @sentiment_final, @fcr, @source_updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        customer_name = excluded.customer_name, customer_phone = excluded.customer_phone,
        order_id = excluded.order_id, channel = excluded.channel, flow = excluded.flow,
        started_at = excluded.started_at, ended_at = excluded.ended_at, status = excluded.status,
        owner_type = excluded.owner_type, owner_agent_id = excluded.owner_agent_id,
        assigned_at = excluded.assigned_at, has_agent_actioned = excluded.has_agent_actioned,
        resolved_by = excluded.resolved_by, first_response_seconds = excluded.first_response_seconds,
        resolution_seconds = excluded.resolution_seconds, intent = excluded.intent,
        bot_confidence = excluded.bot_confidence, sentiment_final = excluded.sentiment_final,
        fcr = excluded.fcr, source_updated_at = excluded.source_updated_at
    `,
      args: {
        id: ticketId,
        customer_name: readField(row, map, "customer_name") || null,
        customer_phone: isRealValue(customerPhoneRaw) ? String(customerPhoneRaw) : null,
        order_id: readField(row, map, "order_id") || null,
        channel: channel,
        flow: flowValue,
        started_at: parseFlowCallDate(readField(row, map, "started_at")) || (new Date()).toISOString(),
        ended_at: parseFlowCallDate(readField(row, map, "ended_at")),
        status,
        owner_type: ownerType,
        owner_agent_id: assignedTo,
        assigned_at: parseFlowCallDate(assignedAtRaw),
        has_agent_actioned: isRealValue(hasAgentActionedRaw) ? String(hasAgentActionedRaw).toLowerCase() === "yes" ? 1 : 0 : null,
        resolved_by: resolvedBy,
        first_response_seconds: firstResponseSeconds,
        resolution_seconds: resolutionSeconds,
        intent: readField(row, map, "intent") || null,
        bot_confidence: isRealValue(botConfidenceRaw) ? Number(botConfidenceRaw) : null,
        sentiment_final: readField(row, map, "sentiment_final") || null,
        fcr: readField(row, map, "fcr") || null,
        source_updated_at: (new Date()).toISOString()
      }
    });
    const csatScore = readField(row, map, "csat_score");
    if (isRealValue(csatScore)) {
      statements.push({
        sql: `
        INSERT INTO csat (conversation_id, score, feedback_text) VALUES (@conversation_id, @score, @feedback_text)
        ON CONFLICT(conversation_id) DO UPDATE SET score = excluded.score, feedback_text = excluded.feedback_text
      `,
        args: {
          conversation_id: ticketId,
          score: Number(csatScore),
          feedback_text: readField(row, map, "feedback_text") || null
        }
      });
    }
    statements.push({ sql: "DELETE FROM handoffs WHERE conversation_id = ?", args: [ticketId] });
    statements.push({ sql: "DELETE FROM qa_audits WHERE conversation_id = ? AND status = 'open'", args: [ticketId] });
    const handoffReasonRaw = readField(row, map, "handoff_reason");
    const handoffReason = isRealValue(handoffReasonRaw) ? handoffReasonRaw : null;
    if (ownerType === "human" || resolvedBy === "human") {
      statements.push({
        sql: "INSERT INTO handoffs (conversation_id, reason, accepting_agent_id, outcome) VALUES (?, ?, ?, ?)",
        args: [ticketId, handoffReason, assignedTo, status]
      });
    }
    const csatNum = isRealValue(csatScore) ? Number(csatScore) : null;
    const reasonNorm = (handoffReason || "").trim().toLowerCase();
    if (csatNum && csatNum <= 2) {
      statements.push({
        sql: "INSERT INTO qa_audits (conversation_id, issue_category, severity, finding, status) VALUES (?, ?, ?, ?, 'open')",
        args: [ticketId, ownerType === "bot" ? "bot" : "human", csatNum === 1 ? "High" : "Medium", `Low CSAT rating (${csatNum}/5).`]
      });
    } else if (SEVERITY_BY_REASON[reasonNorm] || AUDIT_WORTHY_SUBCATEGORIES.has(reasonNorm)) {
      statements.push({
        sql: "INSERT INTO qa_audits (conversation_id, issue_category, severity, finding, status) VALUES (?, ?, ?, ?, 'open')",
        args: [
          ticketId,
          CATEGORY_BY_REASON[reasonNorm] || (ownerType === "bot" ? "bot" : "human"),
          SEVERITY_BY_REASON[reasonNorm] || "Medium",
          `Flagged: ${handoffReason}.`
        ]
      });
    }
    processedRows += 1;
    if (processedRows % ROWS_PER_BATCH === 0) {
      await flush();
      console.log(`[ingest] ...${processedRows}/${rows.length} tickets written`);
    }
  }
  await flush();
  console.log(`[ingest] processed ${rows.length} tickets`);
  return rows.length;
}
async function runIngest(env) {
  const raw = await getCsvText(env);
  return ingestCsvText(env, raw);
}

export { runIngest };
