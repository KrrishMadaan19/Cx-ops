// Thin wrapper over the D1 binding (env.DB).
//
// Queries across this codebase use SQLite named parameters (@name) with a plain
// object of args. D1's bind() is positional only, so named queries are rewritten
// to `?` placeholders here. The rewrite is cached per SQL string: the same
// handful of statements run once per ingested ticket, and doing the regex on
// every row measurably ate into the Worker CPU budget.

const rewriteCache = new Map();

function toPositional(sql, args) {
  if (Array.isArray(args) || args == null) return { sql, values: args ?? [] };

  let entry = rewriteCache.get(sql);
  if (!entry) {
    const names = [];
    const rewritten = sql.replace(/[:@$]([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      names.push(name);
      return '?';
    });
    entry = { sql: rewritten, names };
    rewriteCache.set(sql, entry);
  }

  return { sql: entry.sql, values: entry.names.map((n) => args[n] ?? null) };
}

async function all(env, sql, params) {
  const { sql: text, values } = toPositional(sql, params);
  const res = await env.DB.prepare(text).bind(...values).all();
  return res.results;
}

async function get(env, sql, params) {
  const rows = await all(env, sql, params);
  return rows[0] ?? null;
}

async function run(env, sql, params) {
  const { sql: text, values } = toPositional(sql, params);
  return env.DB.prepare(text).bind(...values).run();
}

async function batch(env, statements) {
  if (!statements.length) return;
  return env.DB.batch(
    statements.map((s) => {
      const { sql: text, values } = toPositional(s.sql, s.args);
      return env.DB.prepare(text).bind(...values);
    }),
  );
}

async function execSchema(env, schemaSql) {
  const statements = schemaSql.split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await env.DB.prepare(stmt).run();
  }
}

export { all, get, run, batch, execSchema };
