import { all, get } from './db.js';
import { FIRST_RESPONSE_TARGET_SECONDS } from './slaConfig.js';

const MIN_FLOW_SAMPLE = 8;
const MIN_INTENT_SAMPLE = 5;
const MIN_AGENT_SAMPLE = 5;
function pct(n, d) {
  return d ? n / d * 100 : 0;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function severityFromGap(gap, mediumAt, highAt) {
  if (gap >= highAt) return "High";
  if (gap >= mediumAt) return "Medium";
  return "Low";
}
const num = (v) => Number(v ?? 0);
async function computeInsights(env, { start, end, channel: channel }) {
  const params = { start, end };
  const channelClause = channel ? "AND conversations.channel = @channel" : "";
  if (channel) params.channel = channel;
  const signals = [];
  const flowRows = await all(env, `
    SELECT
      conversations.flow AS flow,
      COUNT(*) AS total,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM handoffs WHERE handoffs.conversation_id = conversations.id) THEN 1 ELSE 0 END) AS handoffs,
      AVG(csat.score) AS avg_csat,
      COUNT(csat.score) AS csat_n,
      SUM(CASE WHEN conversations.sentiment_final LIKE '%highlyFrustratedUser%' OR conversations.sentiment_final LIKE '%highlyAggressiveUser%' THEN 1 ELSE 0 END) AS neg_sentiment,
      SUM(CASE WHEN conversations.sentiment_final IS NOT NULL THEN 1 ELSE 0 END) AS sentiment_n
    FROM conversations
    LEFT JOIN csat ON csat.conversation_id = conversations.id
    WHERE conversations.flow IS NOT NULL AND conversations.started_at >= @start AND conversations.started_at < @end ${channelClause}
    GROUP BY conversations.flow
  `, params);
  const totalConvos = flowRows.reduce((s, r) => s + num(r.total), 0);
  const totalHandoffs = flowRows.reduce((s, r) => s + num(r.handoffs), 0);
  const overallHandoffRate = pct(totalHandoffs, totalConvos);
  const csatWeightedSum = flowRows.reduce((s, r) => s + (Number(r.avg_csat) || 0) * num(r.csat_n), 0);
  const csatN = flowRows.reduce((s, r) => s + num(r.csat_n), 0);
  const overallCsat = csatN ? csatWeightedSum / csatN : null;
  const negSum = flowRows.reduce((s, r) => s + num(r.neg_sentiment), 0);
  const sentN = flowRows.reduce((s, r) => s + num(r.sentiment_n), 0);
  const overallNegRate = pct(negSum, sentN);
  for (const r of flowRows) {
    const total = num(r.total);
    const handoffs = num(r.handoffs);
    const csatNRow = num(r.csat_n);
    const sentimentN = num(r.sentiment_n);
    const avgCsat = r.avg_csat != null ? Number(r.avg_csat) : null;
    if (total < MIN_FLOW_SAMPLE) continue;
    const handoffRate = pct(handoffs, total);
    const handoffGap = handoffRate - overallHandoffRate;
    if (handoffGap >= 12) {
      signals.push({
        id: `flow-handoff-${r.flow}`,
        category: "flow",
        severity: severityFromGap(handoffGap, 12, 25),
        title: `${r.flow}: high handoff rate`,
        detail: `${round1(handoffRate)}% of "${r.flow}" conversations are handed off to a human, vs ${round1(overallHandoffRate)}% average across all flows (${total} conversations).`,
        suggestion: `Review "${r.flow}"'s bot script for the step customers keep abandoning it at.`,
        impact: handoffs
      });
    }
    if (csatNRow >= 5 && overallCsat != null && avgCsat != null) {
      const csatGap = overallCsat - avgCsat;
      if (csatGap >= 0.4 || avgCsat <= 3.2) {
        signals.push({
          id: `flow-csat-${r.flow}`,
          category: "flow",
          severity: avgCsat <= 2.8 ? "High" : "Medium",
          title: `${r.flow}: below-average CSAT`,
          detail: `"${r.flow}" averages ${avgCsat.toFixed(2)}/5 CSAT vs ${overallCsat.toFixed(2)}/5 overall, from ${csatNRow} ratings.`,
          suggestion: `Pull the lowest-rated "${r.flow}" transcripts for a coaching/flow-content review.`,
          impact: csatNRow
        });
      }
    }
    if (sentimentN >= MIN_FLOW_SAMPLE && sentN) {
      const negRate = pct(num(r.neg_sentiment), sentimentN);
      const negGap = negRate - overallNegRate;
      if (negGap >= 15) {
        signals.push({
          id: `flow-sentiment-${r.flow}`,
          category: "flow",
          severity: severityFromGap(negGap, 15, 30),
          title: `${r.flow}: frustration spike`,
          detail: `${round1(negRate)}% of "${r.flow}" conversations end frustrated/angry vs ${round1(overallNegRate)}% average (${sentimentN} rated).`,
          suggestion: `Add a sentiment-triggered handoff step to "${r.flow}" before the customer disengages.`,
          impact: sentimentN
        });
      }
    }
  }
  const rtParams = { ...params, sla: FIRST_RESPONSE_TARGET_SECONDS };
  const rtRow = await get(env, `
    SELECT COUNT(*) AS n, SUM(CASE WHEN first_response_seconds > @sla THEN 1 ELSE 0 END) AS breaches
    FROM conversations
    WHERE first_response_seconds IS NOT NULL AND started_at >= @start AND started_at < @end ${channel ? "AND channel = @channel" : ""}
  `, rtParams);
  const rtN = num(rtRow?.n);
  const rtBreaches = num(rtRow?.breaches);
  if (rtN >= 10) {
    const breachPct = pct(rtBreaches, rtN);
    if (breachPct >= 15) {
      signals.push({
        id: "response-sla",
        category: "sla",
        severity: severityFromGap(breachPct - 15, 0, 20),
        title: "First-response target missed",
        detail: `${rtBreaches} of ${rtN} conversations (${round1(breachPct)}%) took longer than 5 minutes for a first response.`,
        suggestion: "Auto-escalate queued conversations that pass 5 minutes without a first response.",
        impact: rtBreaches
      });
    }
  }
  const agentRows = await all(env, `
    SELECT
      agents.id AS id, agents.name AS name,
      COUNT(conversations.id) AS n,
      SUM(CASE WHEN conversations.fcr = 'Yes' THEN 1 ELSE 0 END) AS fcr_yes,
      SUM(CASE WHEN conversations.fcr IN ('Yes','No') THEN 1 ELSE 0 END) AS fcr_n
    FROM agents
    JOIN conversations ON conversations.owner_agent_id = agents.id
      AND conversations.started_at >= @start AND conversations.started_at < @end ${channelClause}
    GROUP BY agents.id
  `, params);
  const teamFcrYes = agentRows.reduce((s, r) => s + num(r.fcr_yes), 0);
  const teamFcrN = agentRows.reduce((s, r) => s + num(r.fcr_n), 0);
  const teamFcrRate = pct(teamFcrYes, teamFcrN);
  for (const r of agentRows) {
    const fcrN = num(r.fcr_n);
    const fcrYes = num(r.fcr_yes);
    if (fcrN >= MIN_AGENT_SAMPLE && teamFcrN) {
      const agentFcr = pct(fcrYes, fcrN);
      const gap = teamFcrRate - agentFcr;
      if (gap >= 15) {
        signals.push({
          id: `agent-fcr-${r.id}`,
          category: "agent",
          severity: severityFromGap(gap, 15, 30),
          title: `${r.name}: low first-contact resolution`,
          detail: `${round1(agentFcr)}% FCR vs ${round1(teamFcrRate)}% team average, from ${fcrN} rated tickets.`,
          suggestion: `Flag ${r.name}'s recent repeat-contact tickets for a coaching review.`,
          impact: fcrN
        });
      }
    }
  }
  signals.sort((a, b) => {
    const order2 = { High: 0, Medium: 1, Low: 2 };
    if (order2[a.severity] !== order2[b.severity]) return order2[a.severity] - order2[b.severity];
    return (b.impact || 0) - (a.impact || 0);
  });
  const intentRows = await all(env, `
    SELECT
      conversations.intent AS intent,
      COUNT(*) AS occurrences,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM handoffs WHERE handoffs.conversation_id = conversations.id) THEN 1 ELSE 0 END) AS handoffs,
      AVG(conversations.bot_confidence) AS avg_confidence
    FROM conversations
    WHERE conversations.intent IS NOT NULL AND conversations.started_at >= @start AND conversations.started_at < @end ${channelClause}
    GROUP BY conversations.intent
  `, params);
  const failingIntents = intentRows.map((r) => ({ ...r, occurrences: num(r.occurrences), handoffs: num(r.handoffs) })).filter((r) => r.occurrences >= MIN_INTENT_SAMPLE).map((r) => ({
    intent: r.intent,
    occurrences: r.occurrences,
    handoffRate: round1(pct(r.handoffs, r.occurrences)),
    avgConfidence: r.avg_confidence != null ? Number(Number(r.avg_confidence).toFixed(2)) : null
  })).filter((r) => r.handoffRate >= 40).sort((a, b) => b.handoffRate - a.handoffRate || b.occurrences - a.occurrences).slice(0, 5).map((r) => ({
    ...r,
    suggestion: r.avgConfidence != null && r.avgConfidence < 0.6 ? `Add training examples for "${r.intent}" -- confidence averages ${r.avgConfidence}.` : `Review "${r.intent}"'s flow branch -- confidence is fine but it still hands off ${r.handoffRate}% of the time.`
  }));
  const TAG_LABELS = {
    None: "No flags raised",
    "AI Disabled": "Bot disabled / handed off",
    askingForAgent: "Asked for a human",
    immediatelyAskingForAgent: "Asked for a human immediately",
    highlyFrustratedUser: "Highly frustrated",
    highlyAggressiveUser: "Highly aggressive",
    unableToResolve: "Bot couldn't resolve"
  };
  const sentimentRows = await all(env, `
    SELECT conversations.sentiment_final AS sentiment, COUNT(*) AS n
    FROM conversations
    WHERE conversations.sentiment_final IS NOT NULL AND conversations.started_at >= @start AND conversations.started_at < @end ${channelClause}
    GROUP BY conversations.sentiment_final
  `, params);
  const sentimentTotal = sentimentRows.reduce((s, r) => s + num(r.n), 0);
  const tagCounts = {};
  for (const row of sentimentRows) {
    for (const tag of String(row.sentiment).split(",").map((t) => t.trim()).filter(Boolean)) {
      tagCounts[tag] = (tagCounts[tag] || 0) + num(row.n);
    }
  }
  const sentimentBreakdown = Object.entries(tagCounts).map(([tag, count]) => ({ sentiment: tag, label: TAG_LABELS[tag] || tag, count: count, pct: round1(pct(count, sentimentTotal)) })).sort((a, b) => b.count - a.count);
  const dsatReasonRows = await all(env, `
    SELECT handoffs.reason AS reason, COUNT(*) AS n
    FROM handoffs
    JOIN conversations ON conversations.id = handoffs.conversation_id
    JOIN csat ON csat.conversation_id = conversations.id
    WHERE csat.score <= 2 AND handoffs.reason IS NOT NULL
      AND conversations.started_at >= @start AND conversations.started_at < @end ${channelClause}
    GROUP BY handoffs.reason
    ORDER BY n DESC
    LIMIT 5
  `, params);
  const dsatTotal = dsatReasonRows.reduce((s, r) => s + num(r.n), 0);
  const dsatReasons = dsatReasonRows.map((r) => ({
    reason: String(r.reason).replace(/_/g, " "),
    count: num(r.n),
    pct: round1(pct(num(r.n), dsatTotal))
  }));
  return {
    signals: signals.slice(0, 6),
    failingIntents,
    sentimentBreakdown,
    sentimentSampleSize: sentimentTotal,
    dsatReasons
  };
}

export { computeInsights };
