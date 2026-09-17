import { get } from './db.js';
import { FIRST_RESPONSE_TARGET_SECONDS } from './slaConfig.js';

function fmtSeconds(totalSeconds) {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return null;
  const sign = totalSeconds < 0 ? "-" : "";
  const abs = Math.abs(totalSeconds);
  const m = Math.floor(abs / 60);
  const s = Math.round(abs % 60);
  return `${sign}${m}m ${String(s).padStart(2, "0")}s`;
}
async function computePeriodMetrics(env, { start, end, channel: channel, owner }) {
  const params = { start, end };
  const channelClause = channel ? "AND channel = @channel" : "";
  const channelClausePrefixed = channel ? "AND conversations.channel = @channel" : "";
  if (channel) params.channel = channel;
  const ownerClause = owner ? "AND owner_type = @owner" : "";
  const ownerClausePrefixed = owner ? "AND conversations.owner_type = @owner" : "";
  if (owner) params.owner = owner;
  const totalsParams = { ...params, target: FIRST_RESPONSE_TARGET_SECONDS };
  const totals = await get(env, `
    SELECT
      COUNT(*) AS traffic,
      SUM(CASE WHEN status = 'responded' THEN 1 ELSE 0 END) AS handled,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) AS missed,
      SUM(CASE WHEN resolved_by = 'bot' THEN 1 ELSE 0 END) AS ai_resolved,
      SUM(CASE WHEN resolved_by = 'human' THEN 1 ELSE 0 END) AS human_resolved,
      AVG(first_response_seconds) AS avg_frt,
      AVG(resolution_seconds) AS avg_resolution,
      SUM(CASE WHEN first_response_seconds IS NOT NULL THEN 1 ELSE 0 END) AS frt_n,
      SUM(CASE WHEN first_response_seconds IS NOT NULL AND first_response_seconds <= @target THEN 1 ELSE 0 END) AS frt_within,
      AVG(CASE WHEN resolved_by = 'human' THEN resolution_seconds END) AS avg_handle_seconds,
      SUM(CASE WHEN fcr = 'Yes' THEN 1 ELSE 0 END) AS fcr_yes,
      SUM(CASE WHEN fcr IN ('Yes','No') THEN 1 ELSE 0 END) AS fcr_n
    FROM conversations
    WHERE started_at >= @start AND started_at < @end ${channelClause} ${ownerClause}
  `, totalsParams);
  const csatRow = await get(env, `
    SELECT AVG(score) AS avg_score, COUNT(*) AS n
    FROM csat
    JOIN conversations ON conversations.id = csat.conversation_id
    WHERE conversations.started_at >= @start AND conversations.started_at < @end ${channelClausePrefixed} ${ownerClausePrefixed}
  `, params);
  const handoffRow = await get(env, `
    SELECT COUNT(*) AS n
    FROM conversations
    WHERE started_at >= @start AND started_at < @end ${channelClause} ${ownerClause}
      AND EXISTS (SELECT 1 FROM handoffs WHERE handoffs.conversation_id = conversations.id)
  `, params);
  const handoffCount = Number(handoffRow?.n ?? 0);
  const traffic = Number(totals?.traffic ?? 0);
  return {
    traffic,
    handled: Number(totals?.handled ?? 0),
    inProgress: Number(totals?.in_progress ?? 0),
    missed: Number(totals?.missed ?? 0),
    handledPct: traffic ? Number((Number(totals.handled ?? 0) / traffic * 100).toFixed(1)) : 0,
    missedPct: traffic ? Number((Number(totals.missed ?? 0) / traffic * 100).toFixed(1)) : 0,
    aiResolvedCount: Number(totals?.ai_resolved ?? 0),
    humanResolvedCount: Number(totals?.human_resolved ?? 0),
    containmentRate: traffic ? Number((Number(totals.ai_resolved ?? 0) / traffic * 100).toFixed(1)) : 0,
    handoffCount,
    handoffRate: traffic ? Number((handoffCount / traffic * 100).toFixed(1)) : 0,
    csat: csatRow?.avg_score != null ? Number(Number(csatRow.avg_score).toFixed(2)) : null,
    csatResponses: Number(csatRow?.n ?? 0),
    avgFrtSeconds: totals?.avg_frt ?? null,
    avgResolutionSeconds: totals?.avg_resolution ?? null,
    frt: fmtSeconds(totals?.avg_frt),
    resolutionTime: fmtSeconds(totals?.avg_resolution),
    slaWithinPct: totals?.frt_n ? Number((Number(totals.frt_within) / Number(totals.frt_n) * 100).toFixed(1)) : null,
    slaSampleSize: Number(totals?.frt_n ?? 0),
    fcrRate: totals?.fcr_n ? Number((Number(totals.fcr_yes) / Number(totals.fcr_n) * 100).toFixed(1)) : null,
    fcrSampleSize: Number(totals?.fcr_n ?? 0),
    avgHandleSeconds: totals?.avg_handle_seconds ?? null,
    avgHandleTime: fmtSeconds(totals?.avg_handle_seconds)
  };
}

export { computePeriodMetrics, fmtSeconds };
