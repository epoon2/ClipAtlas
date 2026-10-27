// The site for the browser tests: public/ plus the real Worker, with an
// in-memory stand-in for D1. Used by tests/browser.mjs and tests/autoreview.mjs.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

// ---- a small in-memory D1 that understands the Worker's statements
export function memoryD1() {
  const users = new Map(), sessions = new Map(), libraries = new Map(), limits = new Map();
  const run = (sql, a) => {
    if (sql.startsWith('INSERT INTO users')) {
      if ([...users.values()].some(u => u.email === a[1])) throw new Error('UNIQUE');
      users.set(a[0], { id: a[0], email: a[1], display_name: a[2], password_salt: a[3], password_hash: a[4] });
      return { changes: 1 };
    }
    if (sql.startsWith('INSERT INTO sessions')) { sessions.set(a[0], { user_id: a[1], expires_at: a[2] }); return { changes: 1 }; }
    if (sql.startsWith('DELETE FROM sessions')) { sessions.delete(a[0]); return { changes: 1 }; }
    if (sql.startsWith('INSERT INTO libraries')) {
      const [userId, json, now, revision] = a; const row = libraries.get(userId);
      if (!row) { libraries.set(userId, { json, revision: 1 }); return { changes: 1 }; }
      if (row.revision !== revision) return { changes: 0 };
      libraries.set(userId, { json, revision: row.revision + 1 }); return { changes: 1 };
    }
    if (sql.startsWith('INSERT INTO rate_limits')) { const r = limits.get(a[0]) || { count: 0, reset_at: a[1] }; limits.set(a[0], { ...r, count: r.count + 1 }); return { changes: 1 }; }
    throw new Error('unexpected SQL ' + sql.slice(0, 40));
  };
  const first = (sql, a) => {
    if (sql.includes('FROM sessions s JOIN users')) { const s = sessions.get(a[0]); const u = s && users.get(s.user_id); return u ? { ...u, expires_at: s.expires_at } : null; }
    if (sql.startsWith('SELECT * FROM users')) return [...users.values()].find(u => u.email === a[0]) || null;
    if (sql.startsWith('SELECT json,revision FROM libraries')) return libraries.get(a[0]) || null;
    if (sql.startsWith('SELECT count,reset_at FROM rate_limits')) return limits.get(a[0]) || null;
    throw new Error('unexpected SQL ' + sql.slice(0, 40));
  };
  return { prepare: sql => ({ bind: (...a) => ({ first: async () => first(sql, a), run: async () => ({ meta: run(sql, a) }) }) }) };
}


/** Serve public/ and the Worker on a free port; returns {server, base}. */
export async function startSite(env) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${server.address().port}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const answer = await worker.fetch(new Request(url, { method: req.method, headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
      const headers = Object.fromEntries(answer.headers);
      res.writeHead(answer.status, headers); res.end(Buffer.from(await answer.arrayBuffer())); return;
    }
    const file = join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(0, r));
  return { server, base: `http://localhost:${server.address().port}/` };
}
