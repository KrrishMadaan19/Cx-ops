import { Hono } from 'hono';
import { resolveWindow } from '../timeWindow.js';
import { resolveChannel, resolveOwner } from '../filters.js';
import { computePeriodMetrics } from '../metricsEngine.js';
import { FIRST_RESPONSE_TARGET_SECONDS } from '../slaConfig.js';

const app = new Hono();
function secondsTrend(currentSeconds, prevSeconds) {
  if (currentSeconds == null || prevSeconds == null) return null;
  const diff = Math.round(currentSeconds - prevSeconds);
  if (diff === 0) return null;
  const abs = Math.abs(diff);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  const text = `${m ? `${m}m ` : ""}${s}s`;
  return diff < 0 ? { direction: "good", text: `\u2193 ${text} faster` } : { direction: "bad", text: `\u2191 ${text} slower` };
}
app.get("/summary", async (c) => {
  const query = c.req.query();
  const { start, end } = resolveWindow(query);
  const owner = resolveOwner(query.view);
  const channel = resolveChannel(query.channel);
  const current = await computePeriodMetrics(c.env, { start, end, channel: channel, owner });
  const span = new Date(end).getTime() - new Date(start).getTime();
  const prevStart = new Date(new Date(start).getTime() - span).toISOString();
  const prev = await computePeriodMetrics(c.env, { start: prevStart, end: start, channel: channel, owner });
  const traffic = current.traffic;
  const pct2 = (n) => traffic ? Math.round(n / traffic * 100) : 0;
  return c.json({
    traffic,
    handled: current.handled,
    responded: current.handled,
    progress: current.inProgress,
    missed: current.missed,
    csat: current.csat != null ? current.csat.toFixed(2) : null,
    csatResponses: current.csatResponses,
    csatResponsesLabel: `${current.csatResponses} responses`,
    handledPct: current.handledPct,
    handledPctLabel: `${current.handledPct}% of traffic`,
    missedPct: current.missedPct,
    missedPctLabel: `${current.missedPct}% of traffic`,
    resolution: `${Math.round(current.containmentRate)}%`,
    aiResolved: `${current.aiResolvedCount} conversations`,
    humanResolved: `${current.humanResolvedCount} conversations`,
    aiResolvedPct: `${pct2(current.aiResolvedCount)}%`,
    humanResolvedPct: `${pct2(current.humanResolvedCount)}%`,
    handoffCount: `${current.handoffCount} conversations`,
    handoffRatePct: `${current.handoffRate}%`,
    containmentRate: current.containmentRate,
    handoffRate: current.handoffRate,
    frt: current.frt,
    resolutionTime: current.resolutionTime,
    frtTrend: secondsTrend(current.avgFrtSeconds, prev.avgFrtSeconds),
    resolutionTrend: secondsTrend(current.avgResolutionSeconds, prev.avgResolutionSeconds),
    slaTargetSeconds: FIRST_RESPONSE_TARGET_SECONDS,
    slaWithinPct: current.slaWithinPct,
    slaSampleSize: current.slaSampleSize,
    trend: null
  });
});
export default app;