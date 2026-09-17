// In-isolate GET response cache.
//
// The Cache API is not functional on *.workers.dev, so this is a plain Map held
// for the life of the isolate. Its real job is collapsing concurrent viewers:
// without it, every open dashboard tab multiplies D1 row reads, and the free
// tier allows only 5M rows/day.
//
// Ingest runs every 5 minutes, so a 60s TTL never serves data that is more than
// one sync behind. Writes clear the cache so user actions show up immediately.

const MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 60_000;
// The channel list is derived from a full scan of conversations and effectively
// never changes, so it gets a much longer TTL.
const TTL_BY_PATH = { '/api/channels': 600_000 };

const store = new Map();

function ttlFor(path) {
  return TTL_BY_PATH[path] ?? DEFAULT_TTL_MS;
}

function prune(now) {
  for (const [key, entry] of store) {
    if (entry.expires <= now) store.delete(key);
  }
  while (store.size >= MAX_ENTRIES) {
    store.delete(store.keys().next().value);
  }
}

function responseCache() {
  return async (c, next) => {
    if (c.req.method !== 'GET') {
      await next();
      if (c.res.ok) store.clear();
      return;
    }

    const key = c.req.url;
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expires > now) {
      return c.body(hit.body, 200, { 'content-type': hit.contentType, 'x-cache': 'hit' });
    }

    await next();
    if (c.res.status !== 200) return;

    const body = await c.res.clone().text();
    prune(now);
    store.set(key, {
      body,
      contentType: c.res.headers.get('content-type') ?? 'application/json',
      expires: now + ttlFor(new URL(c.req.url).pathname),
    });
  };
}

export { responseCache };
