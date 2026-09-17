const IST_OFFSET_MS = 5.5 * 60 * 60 * 1e3;
const KNOWN_WINDOW_DAYS = { "7d": 7, "30d": 30, "24h": 1 };
const DATE_STRING_RE = /^\d{4}-\d{2}-\d{2}$/;
function istDateStringToUtcMidnight(dateStr) {
  if (!DATE_STRING_RE.test(dateStr)) {
    throw new Error(`Invalid date "${dateStr}" -- expected YYYY-MM-DD`);
  }
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);
}
function todayIstStartUtc() {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const istMidnightUtc = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate());
  return new Date(istMidnightUtc - IST_OFFSET_MS);
}
function resolveWindow(query = {}) {
  const { from, to, window: windowParam } = query;
  if (from || to) {
    const fromDate = from || to;
    const toDate = to || from;
    const start = istDateStringToUtcMidnight(fromDate);
    const end = new Date(istDateStringToUtcMidnight(toDate).getTime() + 24 * 60 * 60 * 1e3);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (windowParam && KNOWN_WINDOW_DAYS[windowParam]) {
    const d = new Date();
    d.setDate(d.getDate() - KNOWN_WINDOW_DAYS[windowParam]);
    return { start: d.toISOString(), end: (new Date()).toISOString() };
  }
  return { start: todayIstStartUtc().toISOString(), end: (new Date()).toISOString() };
}

export { resolveWindow, todayIstStartUtc };
