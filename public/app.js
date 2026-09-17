const API_BASE = ''; // same-origin: the worker serves this file as a static asset
// Ingest only runs every 5 minutes, so polling faster than this just burns D1's
// free-tier read quota (5M rows/day) without showing anything new.
const POLL_MS = 60000;

// IST has no DST, so this fixed offset is safe -- matches server/src/timeWindow.js.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDateString(offsetDays = 0) {
  return new Date(Date.now() + IST_OFFSET_MS + offsetDays * 86400000).toISOString().slice(0, 10);
}

// The currently-selected range, sent as `from`/`to` (IST calendar dates) on every
// API call. Defaults to today; the range picker in the topbar changes this and
// triggers a full reload -- see the wiring at the bottom of this file.
let currentRange = { from: istDateString(0), to: istDateString(0), label: 'Today' };

let currentChannel = 'whatsapp';

function queryParams(extra = {}) {
  const params = new URLSearchParams(extra);
  params.set('from', currentRange.from);
  params.set('to', currentRange.to);
  if (currentChannel !== 'all') params.set('channel', currentChannel);
  return params;
}

function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

let activeView = 'all';

let lastTraffic = 0;

function applySummary(values) {
  lastTraffic = values.traffic || 0;
  document.querySelectorAll('[data-metric]').forEach((el) => {
    const key = el.dataset.metric;
    if (values[key] != null) el.textContent = values[key];
  });
  const aiPct = values.containmentRate || 0;
  document.getElementById('donut').style.background =
    `conic-gradient(var(--teal) 0 ${aiPct}%, var(--violet) ${aiPct}% 100%)`;
  const csatPct = values.csat ? (Number(values.csat) / 5) * 100 : 0;
  document.getElementById('csatRing').style.background =
    `conic-gradient(var(--teal) 0 ${csatPct}%, #e5f1ef ${csatPct}%)`;

  
  
  document.getElementById('handledBar').style.width = `${values.handledPct || 0}%`;
  document.getElementById('missedBar').style.width = `${values.missedPct || 0}%`;

  
  const score = Number(values.csat) || 0;
  const fullStars = Math.floor(score);
  const hasHalf = score - fullStars >= 0.5;
  document.querySelectorAll('#ratingStars i').forEach((star, i) => {
    star.className = i < fullStars ? '' : (i === fullStars && hasHalf ? 'half' : 'empty');
  });

  
  
  function applyTrend(elId, trend) {
    const el = document.getElementById(elId);
    if (!trend) { el.textContent = ''; el.className = 'trend'; return; }
    el.textContent = trend.text;
    el.className = `trend ${trend.direction}`;
  }
  applyTrend('frtTrend', values.frtTrend);
  applyTrend('resolutionTrend', values.resolutionTrend);

  
  
  
  const slaBox = document.getElementById('slaBoxText');
  const targetLabel = values.slaTargetSeconds ? `${Math.round(values.slaTargetSeconds / 60)}-min` : '5-min';
  slaBox.innerHTML = values.slaSampleSize
    ? `<b>${values.slaWithinPct}%</b> within our ${targetLabel} first-response target <small>(${values.slaSampleSize} tickets with a recorded first response)</small>`
    : `No tickets with a recorded first response in this range yet.`;
}

async function loadSummary() {
  try {
    const values = await fetchJson(`/api/summary?${queryParams({ view: activeView })}`);
    applySummary(values);
  } catch (err) {
    console.error('Failed to load summary', err);
    showToast('Could not refresh dashboard data');
  }
}

document.querySelectorAll('.window-button').forEach((button) => button.addEventListener('click', () => {
  document.querySelector('.window-button.active').classList.remove('active');
  button.classList.add('active');
  activeView = button.dataset.view;
  
  
  
  
  loadSummary();
  loadFlows();
  loadHealth();
  loadAgents();
  loadIntentFailures();
  loadFunnel();
  loadAuditQueue();
  loadAuditCounts();
}));

let currentAgents = [];
const AGENT_PALETTE = ['#e07868', '#6d8cc6', '#a56cc7', '#48a998', '#d9a15c', '#6bb3a0'];

function renderAgentRows(agents) {
  document.getElementById('agentRows').innerHTML = agents.map((a, i) => {
    const initials = a.name.split(/[\s-]/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
    return `<tr>
      <td><div class="agent-name"><span class="agent-avatar" style="background:${AGENT_PALETTE[i % AGENT_PALETTE.length]}">${escapeHtml(initials)}</span>${escapeHtml(a.name)}</div></td>
      <td>${a.conversations}</td>
      <td>${escapeHtml(a.resolution)}</td>
      <td>${escapeHtml(a.avgResponse)}</td>
      <td>★ ${escapeHtml(a.csat)}</td>
      <td><div class="quality"><i style="--quality:${a.qualityScore}%"></i><b>${a.qualityScore}</b></div></td>
      <td>⋮</td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="no-results">No agents were active in this range.</td></tr>`;
}

function applyAgentSelection() {
  const selected = document.getElementById('agentSelect').value;
  renderAgentRows(selected === 'all' ? currentAgents : currentAgents.filter((a) => a.id === selected));
}

async function loadAgents() {
  try {
    currentAgents = await fetchJson(`/api/agents?${queryParams({ view: activeView })}`);

    
    
    const select = document.getElementById('agentSelect');
    const previousValue = select.value;
    select.innerHTML = '<option value="all">All active agents</option>' + currentAgents
      .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('');
    select.value = currentAgents.some((a) => a.id === previousValue) ? previousValue : 'all';

    applyAgentSelection();
    loadAgentCompareIfSet(); 
  } catch (err) {
    console.error('Failed to load agents', err);
    showToast('Could not load agent performance');
  }
}
document.getElementById('agentSelect').addEventListener('change', () => {
  applyAgentSelection();
  loadAgentCompareIfSet(); 
});

const AGENT_COMPARE_METRICS = [
  { key: 'conversations', label: 'Conversations', better: null, fmt: (v) => (v ?? 0).toLocaleString() },
  { key: 'resolutionPct', label: 'Resolution rate', better: 'higher', fmt: (v) => (v != null ? `${v}%` : '--') },
  { key: 'avgResponseSeconds', label: 'Avg. response time', better: 'lower', raw: true },
  { key: 'csatValue', label: 'CSAT', better: 'higher', fmt: (v) => (v != null ? Number(v).toFixed(2) : '--') },
  { key: 'qualityScore', label: 'Quality score', better: 'higher', fmt: (v) => (v ?? '--') },
];

function renderAgentCompare(curAgent, cmpAgent, date) {
  const box = document.getElementById('agentCompareResult');
  document.getElementById('agentCompareCurrentHead').textContent = currentRange.label.toUpperCase();
  document.getElementById('agentCompareDayHead').textContent = date;
  document.getElementById('agentCompareSubtitle').textContent = cmpAgent
    ? `${curAgent.name}: ${currentRange.label} vs ${date}`
    : `${curAgent.name} had no conversations on ${date}.`;
  document.getElementById('agentCompareRows').innerHTML = AGENT_COMPARE_METRICS
    .map((m) => compareMetricRowHtml(m.label, curAgent[m.key], cmpAgent ? cmpAgent[m.key] : null, m)).join('');
  box.hidden = false;
}

async function loadAgentCompare() {
  const date = document.getElementById('agentCompareDate').value;
  if (!date) return;
  const selectedId = document.getElementById('agentSelect').value;
  if (selectedId === 'all') {
    showToast('Pick a specific agent above first, then a day to compare');
    return;
  }
  const curAgent = currentAgents.find((a) => a.id === selectedId);
  if (!curAgent) return;

  try {
    const dayParams = new URLSearchParams({ from: date, to: date });
    if (currentChannel !== 'all') dayParams.set('channel', currentChannel);
    const dayAgents = await fetchJson(`/api/agents?${dayParams}`);
    const cmpAgent = dayAgents.find((a) => a.id === selectedId) || null;
    renderAgentCompare(curAgent, cmpAgent, date);
  } catch (err) {
    console.error('Failed to load agent comparison', err);
    showToast('Could not load that comparison');
  }
}

function loadAgentCompareIfSet() {
  if (document.getElementById('agentCompareDate').value) loadAgentCompare();
  else document.getElementById('agentCompareResult').hidden = true;
}

document.getElementById('agentCompareDate').addEventListener('change', loadAgentCompare);
document.getElementById('agentCompareDate').max = istDateString(0);

async function loadFlows() {
  try {
    const flows = await fetchJson(`/api/flows?${queryParams({ view: activeView })}`);

    if (!flows.length) {
      
      
      
      
      const hint = activeView === 'ai'
        ? 'Bot-only conversations are the least likely to be tagged yet (FlowCall tags Subcategory with a delay, and mostly on tickets a human has already touched) -- try Last 7/30 days, or switch to All/Human window.'
        : 'Try a wider date range or a different channel/window.';
      document.getElementById('flowRows').innerHTML = `<p class="accuracy-note">No tagged flow data for this range yet. ${hint}</p>`;
      return;
    }

    const maxTotal = Math.max(1, ...flows.map((f) => f.total));
    document.getElementById('flowRows').innerHTML = flows.map((f) => `
      <div class="flow-row">
        <span class="flow-name">${escapeHtml(f.flow)}</span>
        <span class="flow-bar"><i style="width:${(f.total / maxTotal) * 100}%"></i></span>
        <b class="flow-score ${Number(f.csat) < 4 ? 'low' : ''}">★ ${escapeHtml(f.csat)}</b>
        <span class="flow-responses">${f.total} responses</span>
      </div>`).join('');
  } catch (err) {
    console.error('Failed to load flows', err);
    showToast('Could not load CSAT by flow');
  }
}

async function loadIntentFailures() {
  try {
    const { intents, taggedTotal } = await fetchJson(`/api/intents?${queryParams({ view: activeView })}`);

    document.getElementById('intentFailureRows').innerHTML = intents.map((i) => {
      const rate = parseFloat(i.failureRate) || 0;
      const statusClass = rate >= 50 ? 'bad-status' : rate >= 25 ? 'warn-status' : 'good-status';
      return `<tr><td>${escapeHtml(i.intent)}</td><td>${i.total}</td><td>${i.botResolved}</td><td>${i.handoffs}</td><td><span class="status ${statusClass}">${escapeHtml(i.failureRate)}</span></td><td>${escapeHtml(i.csat)}</td><td>${i.dsat}</td></tr>`;
    }).join('') || `<tr><td colspan="7" class="no-results">No intent data yet.</td></tr>`;

    // `intent` coverage is real but partial (FlowCall doesn't tag every ticket) --
    
    
    const note = document.getElementById('intentCoverageNote');
    note.textContent = lastTraffic
      ? `Covers ${taggedTotal.toLocaleString()} of ${lastTraffic.toLocaleString()} conversations in this range (${((taggedTotal / lastTraffic) * 100).toFixed(0)}%) -- conversations FlowCall didn't tag with an intent aren't counted here. Unlike Subcategory, this coverage is roughly even between bot and human conversations, so the rates above aren't skewed by who resolved the ticket.`
      : '';
  } catch (err) {
    console.error('Failed to load intent failure analysis', err);
    showToast('Could not load bot failure analysis');
  }
}

const SEVERITY_ICON = { High: '!', Medium: '△', Low: '○' };
const SEVERITY_CLASS = { High: 'red', Medium: 'amber', Low: 'purple' };
const SENTIMENT_CLASS = { highlyFrustratedUser: 'amber-text', unableToResolve: 'amber-text', highlyAggressiveUser: 'risk' };

function applyRangeLabels() {
  document.getElementById('healthRangeLabel').textContent = currentRange.label;
  document.getElementById('auditSignalsRangeNote').textContent = `Issues detected · ${currentRange.label}.`;
}

async function loadInsights() {
  let data;
  try {
    data = await fetchJson(`/api/insights?${queryParams()}`);
  } catch (err) {
    console.error('Failed to load insights', err);
    showToast('Could not load insights');
    return;
  }

  document.getElementById('auditSignalsList').innerHTML = data.signals.length ? data.signals.map((s) => `
    <div><div class="audit-icon ${SEVERITY_CLASS[s.severity] || 'purple'}">${SEVERITY_ICON[s.severity] || '○'}</div><div><b>${escapeHtml(s.title)}</b><span>${escapeHtml(s.detail)}</span><div class="suggestion"><button class="suggestion-toggle" type="button" aria-pressed="false" aria-label="Accept suggestion">\u{1F4A1}</button><span class="suggestion-text">${escapeHtml(s.suggestion)}</span></div></div><button class="audit-jump">Review</button></div>`).join('')
    : `<p class="accuracy-note">No systemic issues clear the threshold for this range -- check back as more data comes in.</p>`;

  document.getElementById('failingIntentsList').innerHTML = data.failingIntents.length ? data.failingIntents.map((q) => `
    <div><div class="query-main"><b>${escapeHtml(q.intent)}</b><span>${q.occurrences} occurrences · ${q.handoffRate}% handoff${q.avgConfidence != null ? ` · confidence ${q.avgConfidence}` : ''}</span><div class="suggestion"><button class="suggestion-toggle" type="button" aria-pressed="false" aria-label="Accept suggestion">\u{1F4A1}</button><span class="suggestion-text">${escapeHtml(q.suggestion)}</span></div></div><em class="status ${q.handoffRate >= 70 ? 'bad-status' : 'warn-status'}">${q.handoffRate >= 70 ? 'No training data' : 'Needs review'}</em></div>`).join('')
    : `<p class="accuracy-note">No intents are failing badly enough to flag for this range.</p>`;

  const maxDsat = Math.max(1, ...data.dsatReasons.map((r) => r.count));
  document.getElementById('dsatReasonsList').innerHTML = data.dsatReasons.length ? data.dsatReasons.map((r) => `
    <div class="reason"><span>${escapeHtml(r.reason)}</span><i><em style="width:${(r.count / maxDsat) * 100}%"></em></i><strong>${r.count}</strong></div>`).join('')
    : `<p class="accuracy-note">No low-CSAT conversations with a recorded handoff reason yet.</p>`;

  // Real sentiment_final is a set of independent tags per conversation (see
  // insightsEngine.js) -- a conversation can carry more than one, so these
  // percentages are each "of total conversations", not a 100%-summing split.
  document.getElementById('sentimentSummary').innerHTML = data.sentimentBreakdown.slice(0, 6).map((s) => `
    <div><span>${escapeHtml(s.label)}</span><b class="${SENTIMENT_CLASS[s.sentiment] || ''}">${s.pct}%</b></div>`).join('');
  document.getElementById('sentimentNote').innerHTML = data.sentimentSampleSize
    ? `Based on <b>${data.sentimentSampleSize}</b> conversations with a signal reported in this range. Tags aren't exclusive, so these don't sum to 100%.`
    : 'No sentiment/behaviour signal reported by FlowCall for this range yet.';
}

async function loadHealth() {
  try {
    const h = await fetchJson(`/api/health?${queryParams({ view: activeView })}`);
    document.getElementById('hcContainment').textContent = `${h.bot.containmentRate}%`;
    document.getElementById('hcHandoff').textContent = `${h.bot.handoffRate}%`;
    document.getElementById('hcResolved').textContent = h.human.ticketsResolved.toLocaleString();
    document.getElementById('hcAccepted').textContent = `of ${h.human.acceptedCount.toLocaleString()} accepted`;
    document.getElementById('hcFcr').textContent = h.human.fcrRate != null ? `${h.human.fcrRate}%` : '--';
    document.getElementById('hcFcrNote').textContent = h.human.fcrRate != null
      ? `based on ${h.human.fcrSampleSize} rated tickets` : 'not reported by FlowCall yet';
    document.getElementById('hcHandleTime').textContent = h.human.avgHandleTime || '--';
  } catch (err) {
    console.error('Failed to load health grid', err);
    showToast('Could not load the health grid');
  }
}

async function loadFunnel() {
  try {
    const stages = await fetchJson(`/api/funnel?${queryParams({ view: activeView })}`);
    document.getElementById('funnelRows').innerHTML = stages.map((s) => `
      <div>
        <span>${escapeHtml(s.label)}</span>
        <i class="${s.branch === 'human' ? 'human-funnel' : ''}"><em style="width:${s.pctOfTotal}%"></em></i>
        <b>${s.count.toLocaleString()}${s.dropPct != null ? ` <small>−${s.dropPct}%</small>` : ''}</b>
      </div>`).join('');
  } catch (err) {
    console.error('Failed to load funnel', err);
    showToast('Could not load the handoff funnel');
  }
}

async function loadLiveWatch() {
  try {
    const params = new URLSearchParams();
    if (currentChannel !== 'all') params.set('channel', currentChannel);
    const { conversations, targetSeconds } = await fetchJson(`/api/live-watch?${params}`);

    const badge = document.getElementById('liveWatchBadge');
    badge.textContent = `${conversations.length} waiting`;
    badge.hidden = false;

    document.getElementById('liveWatchRows').innerHTML = conversations.map((c) => `
      <tr>
        <td><div class="conversation-cell"><b>${escapeHtml(c.customer || 'Unknown')}</b><small>${escapeHtml(c.id)} · ${escapeHtml(c.order || 'N/A')}</small></div></td>
        <td>${escapeHtml(c.phone || '--')}</td>
        <td>${escapeHtml(formatChannelLabel(c.channel))}</td>
        <td>${escapeHtml(c.flow || '--')}</td>
        <td><span class="status bad-status">${escapeHtml(c.waitingFor)}</span></td>
        <td>${escapeHtml(c.owner)}</td>
      </tr>`).join('') || `<tr><td colspan="6" class="no-results">No assigned ticket has gone ${Math.round(targetSeconds / 60)} minutes without agent action right now.</td></tr>`;

    document.getElementById('liveWatchNote').textContent =
      `Target: agent acts within ${Math.round(targetSeconds / 60)} minutes of a ticket being assigned to them. Measured from the actual handoff moment (FlowCall's Assigned At), not from when the conversation started. Only today's handoffs (resets at midnight IST) -- older ones belong in the historical "SLA breach" audit tab, not here.`;
  } catch (err) {
    console.error('Failed to load live SLA watch', err);
    showToast('Could not load the live SLA watch queue');
  }
}

const auditRows = document.getElementById('auditRows');
const auditLayout = document.querySelector('.audit-queue-layout');
let activeAuditFilter = 'all';
let activeAuditId = null;
let currentAuditCases = []; 

function riskClass(risk) { return risk.toLowerCase(); }
function chipClass(type) { return type === 'sla' ? 'chip-sla' : type === 'bot' ? 'chip-bot' : 'chip-human'; }

const SUGGESTION_BY_TYPE = {
  sla: 'Auto-escalate this conversation before the SLA window lapses next time.',
  bot: 'Add a handoff trigger so the bot doesn’t retry the same failed reply.',
  human: 'Flag this transcript for the agent’s next coaching review.',
};
function suggestionHtml(type) {
  const text = SUGGESTION_BY_TYPE[type] || SUGGESTION_BY_TYPE.human;
  return `<div class="suggestion"><button class="suggestion-toggle" type="button" aria-pressed="false" aria-label="Accept suggestion">\u{1F4A1}</button><span class="suggestion-text">Suggested fix: ${escapeHtml(text)}</span></div>`;
}

async function loadSlaByAgent() {
  const wrap = document.getElementById('slaAgentWrap');
  if (activeAuditFilter !== 'sla') { wrap.hidden = true; return; }
  try {
    const agents = await fetchJson(`/api/audit-cases/sla-by-agent?${queryParams({ view: activeView })}`);
    document.getElementById('slaAgentRows').innerHTML = agents.map((a) => `
      <tr class="sla-agent-row" data-agent="${escapeHtml(a.agent)}" style="cursor:pointer">
        <td>${escapeHtml(a.agent)}</td>
        <td>${a.breaches.toLocaleString()}</td>
        <td>${escapeHtml(a.avgDelay || '--')}</td>
        <td>${escapeHtml(a.worstDelay || '--')}</td>
      </tr>`).join('') || `<tr><td colspan="4" class="no-results">No SLA breaches in this range.</td></tr>`;
    document.querySelectorAll('.sla-agent-row').forEach((row) => row.addEventListener('click', () => {
      document.getElementById('auditSearch').value = row.dataset.agent;
      loadAuditQueue();
    }));
    wrap.hidden = false;
  } catch (err) {
    console.error('Failed to load SLA breaches by agent', err);
    showToast('Could not load SLA breaches by agent');
  }
}

async function loadAuditQueue() {
  const query = document.getElementById('auditSearch').value.trim();
  try {
    const params = queryParams({ filter: activeAuditFilter, q: query, view: activeView });
    currentAuditCases = await fetchJson(`/api/audit-cases?${params}`);
  } catch (err) {
    console.error('Failed to load audit queue', err);
    showToast('Could not load audit queue');
    return;
  }
  loadSlaByAgent();

  const badge = document.getElementById('auditCountBadge');
  badge.textContent = `${currentAuditCases.length} open`;
  badge.hidden = false;

  auditRows.innerHTML = currentAuditCases.map((item) => `
    <tr class="audit-row ${item.id === activeAuditId ? 'selected' : ''}" data-case-id="${escapeHtml(item.id)}">
      <td><input type="checkbox" class="case-check" aria-label="Select ${escapeHtml(item.id)}" /></td>
      <td><div class="conversation-cell"><b>${escapeHtml(item.customer)}</b><small>${escapeHtml(item.id)} · ${escapeHtml(item.order)}</small></div></td>
      <td><span class="signal-chip ${chipClass(item.type)}">${escapeHtml(item.signal)}</span></td>
      <td>${escapeHtml(item.owner)}</td>
      <td>${escapeHtml(item.flow)}</td>
      <td><span class="audit-risk ${riskClass(item.risk)}">${escapeHtml(item.risk)}</span></td>
      <td>›</td>
    </tr>`).join('') || `<tr><td colspan="7" class="no-results">No conversations match this view.</td></tr>`;

  auditRows.querySelectorAll('.audit-row').forEach((row) => row.addEventListener('click', (event) => {
    if (event.target.type !== 'checkbox') openAuditCase(row.dataset.caseId);
  }));
}

function openAuditCase(id) {
  const item = currentAuditCases.find((a) => a.id === id);
  if (!item) return;
  activeAuditId = id;
  auditLayout.classList.add('has-selection');
  loadAuditQueue();

  const transcript = item.messages.length
    ? item.messages.map(([role, text], index) => `<div class="message ${role}"><b>${role === 'bot' ? 'Lifelong bot' : role === 'agent' ? escapeHtml(item.owner) : escapeHtml(item.customer)}</b><br>${escapeHtml(text)}<small>${index + 1}:0${index + 2} PM</small></div>`).join('')
    : `<p class="accuracy-note">Transcript not available yet -- needs message-level data from FlowCall (the current export is one row per ticket).</p>`;

  document.getElementById('drawerContent').innerHTML = `
    <div class="drawer-kicker">${escapeHtml(item.id)} · ${escapeHtml((item.flow || '').toUpperCase())}</div>
    <h2 class="drawer-title">${escapeHtml(item.customer)}</h2>
    <div class="drawer-meta">${escapeHtml(item.order)} · ${escapeHtml(item.owner)}</div>
    <div class="audit-status-box"><strong>${escapeHtml(item.signal)} · ${escapeHtml(item.risk)} priority</strong><p>${escapeHtml(item.finding)}</p>${suggestionHtml(item.type)}</div>
    <h3 class="transcript-title">Conversation excerpt</h3>${transcript}
    <div class="drawer-actions"><button id="reassignCase">Reassign</button><button id="resolveCase">Mark audited</button></div>`;
  document.getElementById('auditDrawer').classList.add('open');
  document.getElementById('drawerBackdrop').classList.add('open');

  document.getElementById('resolveCase').addEventListener('click', () => reviewCase(item.id));
  document.getElementById('reassignCase').addEventListener('click', () => showToast(`${item.id} assigned to QA review`));
}

async function patchAuditCase(id, action, note) {
  const res = await fetch(`${API_BASE}/api/audit-cases/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, actor: 'dashboard-user', note }),
  });
  if (!res.ok) throw new Error(`patch ${id} -> ${res.status}`);
}

async function reviewCase(id) {
  try {
    await patchAuditCase(id, 'reviewed');
    closeDrawer();
    showToast(`${id} marked as audited`);
    loadAuditQueue();
  } catch (err) {
    console.error(err);
    showToast('Could not save that action');
  }
}

function closeDrawer() {
  document.getElementById('auditDrawer').classList.remove('open');
  document.getElementById('drawerBackdrop').classList.remove('open');
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function setActiveAuditTab(filter) {
  document.querySelector('.audit-tab.active').classList.remove('active');
  document.querySelector(`.audit-tab[data-audit-filter="${filter}"]`).classList.add('active');
  activeAuditFilter = filter;
  loadAuditQueue();
}
document.querySelectorAll('.audit-tab').forEach((tab) => tab.addEventListener('click', () => setActiveAuditTab(tab.dataset.auditFilter)));
document.getElementById('auditSearch').addEventListener('input', () => loadAuditQueue());
document.getElementById('drawerClose').addEventListener('click', closeDrawer);
document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);
document.getElementById('selectAll').addEventListener('change', (event) => document.querySelectorAll('.case-check').forEach((check) => { check.checked = event.target.checked; }));

document.getElementById('seeBreaches').addEventListener('click', () => setActiveAuditTab('sla'));

async function loadAuditCounts() {
  try {
    const counts = await fetchJson(`/api/audit-cases/counts?${queryParams({ view: activeView })}`);
    document.getElementById('tabCountAll').textContent = counts.all;
    document.getElementById('tabCountSla').textContent = counts.sla;
    document.getElementById('tabCountBot').textContent = counts.bot;
    document.getElementById('tabCountHuman').textContent = counts.human;
  } catch (err) {
    console.error('Failed to load audit tab counts', err);
    showToast('Could not refresh audit tab counts');
  }
}

const auditBody = document.getElementById('auditBody');
const auditToggle = document.getElementById('auditToggle');
function setAuditExpanded(expanded) {
  auditBody.classList.toggle('is-collapsed', !expanded);
  auditToggle.setAttribute('aria-expanded', String(expanded));
  auditToggle.firstChild.textContent = expanded ? 'Hide queue ' : 'Show queue ';
}
auditToggle.addEventListener('click', () => setAuditExpanded(auditBody.classList.contains('is-collapsed')));
document.querySelector('.nav-link[href="#audit"]').addEventListener('click', () => setAuditExpanded(true));

document.addEventListener('click', (event) => {
  if (!event.target.closest('.audit-jump')) return;
  setAuditExpanded(true);
  document.getElementById('audit').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function checkedCaseIds() {
  return [...document.querySelectorAll('.audit-row')]
    .filter((row) => row.querySelector('.case-check').checked)
    .map((row) => row.dataset.caseId);
}

async function patchBatchAndReport(ids, action, note, successVerb) {
  const results = await Promise.all(ids.map((id) => patchAuditCase(id, action, note).then(() => true).catch((err) => {
    console.error(`Failed to ${action} ${id}`, err);
    return false;
  })));
  const succeeded = results.filter(Boolean).length;
  const failed = results.length - succeeded;
  showToast(failed
    ? `${succeeded} of ${ids.length} ${successVerb}, ${failed} failed -- try again`
    : `${ids.length} conversation(s) ${successVerb}`);
  loadAuditQueue();
}

document.getElementById('assignBatch').addEventListener('click', async () => {
  const ids = checkedCaseIds();
  if (!ids.length) return showToast('Select at least one conversation first');
  await patchBatchAndReport(ids, 'assigned', 'Assigned to Bot QA', 'assigned to Bot QA');
});
document.getElementById('markReviewed').addEventListener('click', async () => {
  const ids = checkedCaseIds();
  if (!ids.length) return showToast('Select at least one conversation first');
  await patchBatchAndReport(ids, 'reviewed', undefined, 'marked as reviewed');
});

document.getElementById('exportButton').addEventListener('click', () => {
  const url = `${API_BASE}/api/export/conversations?${queryParams({ view: activeView })}`;
  const link = document.createElement('a');
  link.href = url;
  link.click(); 
  showToast('Exporting conversations as CSV…');
});

document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', () => {
  document.querySelector('.nav-link.active').classList.remove('active');
  link.classList.add('active');
}));

document.addEventListener('click', (event) => {
  const button = event.target.closest('.suggestion-toggle');
  if (!button) return;
  const box = button.closest('.suggestion');
  const accepted = box.classList.toggle('is-accepted');
  button.setAttribute('aria-pressed', String(accepted));
  button.textContent = accepted ? '✓' : '💡';
});

const rangeButton = document.getElementById('rangeButton');
const rangeMenu = document.getElementById('rangeMenu');
const rangeFrom = document.getElementById('rangeFrom');
const rangeTo = document.getElementById('rangeTo');

function setRange(from, to, label) {
  currentRange = { from, to, label };
  rangeButton.firstChild.textContent = `${label} `;
  rangeMenu.hidden = true;
  rangeButton.setAttribute('aria-expanded', 'false');
  loadAll(); 
}

document.querySelectorAll('.range-preset').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.range-preset').forEach((b) => b.classList.remove('active'));
  button.classList.add('active');
  const preset = button.dataset.preset;
  if (preset === 'today') setRange(istDateString(0), istDateString(0), 'Today');
  else if (preset === 'yesterday') setRange(istDateString(-1), istDateString(-1), 'Yesterday');
  else if (preset === '7d') setRange(istDateString(-6), istDateString(0), 'Last 7 days');
  else if (preset === '30d') setRange(istDateString(-29), istDateString(0), 'Last 30 days');
}));

document.getElementById('rangeApply').addEventListener('click', () => {
  if (!rangeFrom.value || !rangeTo.value) return showToast('Pick both a start and end date');
  if (rangeFrom.value > rangeTo.value) return showToast('Start date must be before end date');
  document.querySelectorAll('.range-preset').forEach((b) => b.classList.remove('active'));
  const label = rangeFrom.value === rangeTo.value ? rangeFrom.value : `${rangeFrom.value} – ${rangeTo.value}`;
  setRange(rangeFrom.value, rangeTo.value, label);
});

rangeButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const opening = rangeMenu.hidden;
  rangeMenu.hidden = !opening;
  rangeButton.setAttribute('aria-expanded', String(opening));
  if (opening) { rangeFrom.value = currentRange.from; rangeTo.value = currentRange.to; }
});
document.addEventListener('click', (event) => {
  if (!rangeMenu.hidden && !event.target.closest('.range-picker')) {
    rangeMenu.hidden = true;
    rangeButton.setAttribute('aria-expanded', 'false');
  }
});
document.querySelector('.range-preset[data-preset="today"]').classList.add('active');

const channelButton = document.getElementById('channelButton');
const channelMenu = document.getElementById('channelMenu');

const CHANNEL_LABELS = { whatsapp: 'WhatsApp', email: 'Email', livechat: 'Live chat', manual: 'Manual' };
function formatChannelLabel(channel) {
  return CHANNEL_LABELS[channel] || (channel.charAt(0).toUpperCase() + channel.slice(1));
}

function setChannel(value, label) {
  currentChannel = value;
  channelButton.firstChild.textContent = `${label} `;
  channelMenu.hidden = true;
  channelButton.setAttribute('aria-expanded', 'false');
  document.querySelectorAll('.channel-option').forEach((b) => b.classList.toggle('active', b.dataset.channel === value));
  loadAll();
}

async function loadChannelOptions() {
  try {
    const channels = await fetchJson('/api/channels');
    const total = channels.reduce((sum, c) => sum + c.count, 0);
    const optionsHtml = [{ channel: 'all', count: total }, ...channels].map((c) => {
      const label = c.channel === 'all' ? 'All channels' : formatChannelLabel(c.channel);
      return `<button class="range-preset channel-option" type="button" data-channel="${escapeHtml(c.channel)}">${escapeHtml(label)} <small>(${c.count.toLocaleString()})</small></button>`;
    }).join('');
    channelMenu.innerHTML = optionsHtml;
    document.querySelectorAll('.channel-option').forEach((button) => {
      const channel = button.dataset.channel;
      button.classList.toggle('active', channel === currentChannel);
      button.addEventListener('click', () => setChannel(channel, channel === 'all' ? 'All channels' : formatChannelLabel(channel)));
    });
  } catch (err) {
    console.error('Failed to load channel options', err);
    showToast('Could not load channel options');
  }
}

channelButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const opening = channelMenu.hidden;
  channelMenu.hidden = !opening;
  channelButton.setAttribute('aria-expanded', String(opening));
});
document.addEventListener('click', (event) => {
  if (!channelMenu.hidden && !event.target.closest('.channel-picker')) {
    channelMenu.hidden = true;
    channelButton.setAttribute('aria-expanded', 'false');
  }
});
loadChannelOptions();

function fmtSecondsClient(totalSeconds) {
  if (totalSeconds == null) return '--';
  const sign = totalSeconds < 0 ? '-' : '';
  const abs = Math.abs(totalSeconds);
  const m = Math.floor(abs / 60);
  const s = Math.round(abs % 60);
  return `${sign}${m}m ${String(s).padStart(2, '0')}s`;
}

const COMPARE_METRICS = [
  { key: 'traffic', label: 'Traffic', better: null, fmt: (v) => (v ?? 0).toLocaleString() },
  { key: 'handledPct', label: 'Handled %', better: 'higher', fmt: (v) => `${v}%` },
  { key: 'missedPct', label: 'Missed %', better: 'lower', fmt: (v) => `${v}%` },
  { key: 'containmentRate', label: 'Containment rate', better: 'higher', fmt: (v) => `${v}%` },
  { key: 'handoffRate', label: 'Handoff rate', better: 'lower', fmt: (v) => `${v}%` },
  { key: 'csat', label: 'CSAT', better: 'higher', fmt: (v) => (v != null ? Number(v).toFixed(2) : '--') },
  { key: 'avgFrtSeconds', label: 'First response time', better: 'lower', raw: true },
  { key: 'avgResolutionSeconds', label: 'Avg. resolution time', better: 'lower', raw: true },
  { key: 'slaWithinPct', label: 'Within first-response target', better: 'higher', fmt: (v) => (v != null ? `${v}%` : '--') },
  { key: 'fcrRate', label: 'First contact resolution', better: 'higher', fmt: (v) => (v != null ? `${v}%` : '--') },
  { key: 'avgHandleSeconds', label: 'Avg. handle time (human)', better: 'lower', raw: true },
];

function compareMetricRowHtml(label, curVal, cmpVal, { better, fmt, raw } = {}) {
  const display = (v) => (raw ? fmtSecondsClient(v) : fmt(v));
  let deltaHtml = '<span class="compare-delta neutral">--</span>';
  if (curVal != null && cmpVal != null) {
    const delta = curVal - cmpVal;
    const goodDirection = better == null ? null : (better === 'higher' ? delta > 0 : delta < 0);
    const cls = delta === 0 ? 'neutral' : goodDirection == null ? 'neutral' : goodDirection ? 'good' : 'bad';
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    const deltaText = raw ? fmtSecondsClient(Math.abs(delta)) : fmt(Math.abs(delta));
    deltaHtml = `<span class="compare-delta ${cls}">${arrow} ${deltaText}</span>`;
  }
  return `<tr><td>${escapeHtml(label)}</td><td>${display(curVal)}</td><td>${display(cmpVal)}</td><td>${deltaHtml}</td></tr>`;
}

function renderCompare(data) {
  document.getElementById('compareCurrentHead').textContent = currentRange.label.toUpperCase();
  document.getElementById('compareDayHead').textContent = data.compare.date;
  document.getElementById('compareSubtitle').textContent = `${currentRange.label} vs ${data.compare.date}`;
  document.getElementById('compareRows').innerHTML = COMPARE_METRICS
    .map((m) => compareMetricRowHtml(m.label, data.current[m.key], data.compare[m.key], m)).join('');
  document.getElementById('compareResult').hidden = false;
}

async function loadCompare() {
  const date = document.getElementById('compareDate').value;
  if (!date) return showToast('Pick a day to compare against first');
  try {
    const data = await fetchJson(`/api/compare?${queryParams({ date })}`);
    renderCompare(data);
  } catch (err) {
    console.error('Failed to load comparison', err);
    showToast('Could not load that comparison');
  }
}

function loadCompareIfSet() {
  if (document.getElementById('compareDate').value) loadCompare();
}

document.getElementById('compareRun').addEventListener('click', loadCompare);

document.getElementById('compareDate').addEventListener('change', loadCompare);
document.getElementById('compareDate').max = istDateString(0);

function loadAll() {
  applyRangeLabels();
  loadSummary();
  loadHealth();
  loadAgents();
  loadFlows();
  loadIntentFailures();
  loadFunnel();
  loadLiveWatch();
  loadAuditQueue();
  loadAuditCounts();
  loadInsights();
  loadCompareIfSet();
}
loadAll();
setInterval(loadAll, POLL_MS);
