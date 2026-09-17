const BASE_URL = "https://api.flowcall.co/apis/task-runs/tickets/export";
const POLL_INTERVAL_MS = 4e3;
const POLL_TIMEOUT_MS = 3 * 60 * 1e3;
function authHeaders(env) {
  const token = env.FLOWCALL_ACCESS_TOKEN;
  if (!token) throw new Error("FLOWCALL_ACCESS_TOKEN is not set (wrangler secret).");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
async function requestExport(env, { startDate, endDate, timestampKey = "updatedAt", statuses } = {}) {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: authHeaders(env),
    body: JSON.stringify({ startDate, endDate, timestampKey, timestampFormat: "iso", ...statuses ? { statuses } : {} })
  });
  if (res.status !== 202) throw new Error(`FlowCall export request failed (${res.status}): ${await res.text()}`);
  const body = await res.json();
  if (!body.jobId) throw new Error(`FlowCall export response had no jobId: ${JSON.stringify(body)}`);
  return body.jobId;
}
async function pollExport(env, jobId, timeoutMs = POLL_TIMEOUT_MS) {
  const statusUrl = `${BASE_URL}/${jobId}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(statusUrl, { headers: authHeaders(env) });
    if (!res.ok) throw new Error(`FlowCall export status check failed (${res.status})`);
    const body = await res.json();
    const job = body.job || {};
    if (job.status === "succeeded") return body.downloadUrl;
    if (job.status === "failed") throw new Error(`FlowCall export job failed: ${JSON.stringify(body)}`);
    console.log(`[flowcall] export ${jobId}: ${job.status}${job.total ? ` (${job.processed || 0}/${job.total})` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`FlowCall export job ${jobId} did not finish within ${timeoutMs}ms`);
}
async function fetchTicketsCsv(env, filters, timeoutMs) {
  const jobId = await requestExport(env, filters);
  console.log(`[flowcall] export job started: ${jobId}`);
  const downloadUrl = await pollExport(env, jobId, timeoutMs);
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Failed to download FlowCall export CSV (${res.status})`);
  return res.text();
}

export { fetchTicketsCsv };
