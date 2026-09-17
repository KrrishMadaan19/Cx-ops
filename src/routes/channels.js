import { Hono } from 'hono';
import { all } from '../db.js';

const app = new Hono();
app.get("/channels", async (c) => {
  const rows = await all(c.env, `
    SELECT channel, COUNT(*) AS n
    FROM conversations
    WHERE channel IS NOT NULL
    GROUP BY channel
    ORDER BY n DESC
  `);
  return c.json(rows.map((r) => ({ channel: r.channel, count: Number(r.n) })));
});
export default app;