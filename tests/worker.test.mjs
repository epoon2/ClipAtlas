// /api/enrich through the real Worker, with a fake D1 and a fake TikTok.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const ID = '7662085125500407061';
const TOKEN = 'a'.repeat(64);

function fakeEnv() {
  const limits = new Map();
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('FROM sessions')) return { id: 'u1', email: 'a@b.co', display_name: 'A', expires_at: Date.now() + 1e6 };
              if (sql.includes('FROM rate_limits')) return limits.get(args[0]) || null;
              return null;
            },
            async run() {
              if (sql.startsWith('INSERT INTO rate_limits')) {
                const r = limits.get(args[0]) || { count: 0, reset_at: args[1] };
                limits.set(args[0], { count: r.count + 1, reset_at: r.reset_at });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { DB, ASSETS: { fetch: () => new Response('asset') } };
}

function enrich(url) {
  return worker.fetch(new Request('https://clipatlas.example/api/enrich', {
    method: 'POST', body: JSON.stringify({ url }),
    headers: { origin: 'https://clipatlas.example', cookie: `clipatlas_session=${TOKEN}`, 'content-type': 'application/json' },
  }), fakeEnv());
}

test('a tiktokv.com share link from the TikTok export is looked up, not refused', async (t) => {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(String(url));
    if (String(url).startsWith('https://www.tiktok.com/oembed')) {
      return new Response(JSON.stringify({ provider_name: 'TikTok', title: 'Taipei eats', author_name: 'C' }), { status: 200 });
    }
    return new Response('', { status: 200 });
  });
  const res = await enrich(`https://www.tiktokv.com/share/video/${ID}/`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'enriched');
  assert.equal(body.title, 'Taipei eats');
  assert.ok(asked.every(u => u.startsWith('https://www.tiktok.com/')), 'only TikTok is contacted');
});

test('a refused link says why, and costs no lookup', async (t) => {
  const spy = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const res = await enrich('https://example.com/video/1');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.reason, 'NOT_TIKTOK_LINK');
  assert.equal(body.status, 'rejected');
  assert.equal(spy.mock.callCount(), 0);
});

test('a library with categories and settings saves; a broken one does not', async () => {
  const save = state => worker.fetch(new Request('https://clipatlas.example/api/library', {
    method: 'PUT', body: JSON.stringify({ state, revision: 0 }),
    headers: { origin: 'https://clipatlas.example', cookie: `clipatlas_session=${TOKEN}`, 'content-type': 'application/json' },
  }), fakeEnv());
  const base = { version: 1, records: [], collections: [], plan: [] };
  assert.equal((await save({ ...base, categories: [{ name: 'Food', emoji: 'x', words: [] }], settings: { purpose: 'travel', tabs: { itinerary: true } } })).status, 200);
  assert.equal((await save(base)).status, 200, 'libraries from before still save');
  assert.equal((await save({ ...base, categories: 'Food' })).status, 400);
  assert.equal((await save({ ...base, categories: Array(101).fill({ name: 'x' }) })).status, 400);
  assert.equal((await save({ ...base, settings: [] })).status, 400);
});
