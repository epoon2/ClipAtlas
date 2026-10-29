// The site for the browser tests: public/ plus the real Worker, with an
// in-memory stand-in for D1. Used by tests/browser.mjs and tests/autoreview.mjs.
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

// ---- D1 for the tests: a real SQLite database in memory (node:sqlite), with the real migrations, so the
// Worker's SQL is run as written.
export function memoryD1() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const exec = (sql, a) => {
    const st = db.prepare(sql);
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a) };
    const r = st.run(...a); return { meta: { changes: Number(r.changes) }, results: [] };
  };
  const statement = (sql, a = []) => ({ sql, a,
    bind: (...args) => { if (args.some(x => x === undefined)) throw new Error('D1_TYPE_ERROR: undefined bound'); return statement(sql, args); },
    first: async () => db.prepare(sql).get(...a) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...a) }),
    run: async () => exec(sql, a) });
  return { prepare: sql => statement(sql), batch: async list => { db.exec('BEGIN'); try { const out = list.map(x => exec(x.sql, x.a)); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    exec: async sql => db.exec(sql), raw: db };
}

const assets = { fetch: async req => {
  const path = new URL(req.url).pathname, file = join(ROOT, 'public', path === '/' ? 'index.html' : path);
  if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file)) return new Response('Not found', { status: 404 });
  return new Response(readFileSync(file), { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } });
} };

/** Serve public/ and the Worker on a free port; returns {server, base}. */
export async function startSite(env) {
  env.ASSETS = assets;   // the Worker serves view.html and the app for /s/ and /join/ links
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${server.address().port}`);
    if (url.pathname.startsWith('/api/') || /^\/(s|join)\//.test(url.pathname)) {
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
