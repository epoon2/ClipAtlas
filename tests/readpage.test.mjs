// src/readpage.js and /api/readpage, with the web replaced by a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPageRequest, pageTextFallback, readPage, PAGE_TEXT_MAX } from '../src/readpage.js';
import worker from '../src/worker.js';

const GUIDE = `<!doctype html><html><head><title>Best food &amp; drink in Taipei</title>
<meta name="description" content="Where to eat in Taipei."><script>var x = "<p>not text</p>";</script><style>p{color:red}</style></head>
<body><nav><a href="/">Home</a> <a href="/menu">Menu</a></nav><header>Site header</header>
<article><h1>Taipei eats</h1><p>Start at <b>Fuhang Soy Milk</b> for breakfast.</p><ul><li>Raohe Night Market</li><li>Din Tai Fung&#39;s xiao long bao</li></ul></article>
<form><button>Subscribe</button></form><footer>© 2026 Footer text</footer></body></html>`;

test('which links may be read: public web pages only', () => {
  assert.deepEqual(readPageRequest({ url: ' https://example.com/guide?x=1 ' }), { ok: true, url: 'https://example.com/guide?x=1' });
  assert.equal(readPageRequest({ url: 'http://blog.example.co.uk/a' }).ok, true);
  for (const [url, reason] of [['javascript:alert(1)', 'BAD_LINK'], ['ftp://example.com/a', 'BAD_LINK'], ['not a link', 'BAD_LINK'],
    ['https://user:pw@example.com/', 'BAD_LINK'], ['https://www.tiktok.com/@a/video/1', 'TIKTOK'], ['https://vm.tiktok.com/abc/', 'TIKTOK'],
    ['http://localhost:8787/', 'PRIVATE'], ['http://intranet/', 'PRIVATE'], ['http://printer.local/', 'PRIVATE'], ['http://192.168.1.1/', 'PRIVATE'],
    ['http://127.0.0.1/', 'PRIVATE'], ['http://[::1]/', 'PRIVATE'], ['https://example.com:8443/', 'PRIVATE'], ['http://metadata.internal/', 'PRIVATE']])
    assert.equal(readPageRequest({ url }).reason, reason, url);
  assert.equal(readPageRequest(null).reason, 'BAD_LINK');
});

test('the text of a page: title, description and the words, without menus, scripts or footers', () => {
  const p = pageTextFallback(GUIDE);
  assert.equal(p.title, 'Best food & drink in Taipei');
  assert.equal(p.description, 'Where to eat in Taipei.');
  assert.match(p.text, /Taipei eats\n+Start at Fuhang Soy Milk for breakfast\./);
  assert.match(p.text, /Raohe Night Market\n+Din Tai Fung's xiao long bao/);
  for (const gone of ['not text', 'color:red', 'Home', 'Site header', 'Subscribe', 'Footer text']) assert.ok(!p.text.includes(gone), gone);
  assert.ok(pageTextFallback('<p>' + 'word '.repeat(10000) + '</p>').text.length <= PAGE_TEXT_MAX);
});

const page = (body, init = {}) => async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
test('reading a page: its text; a refusal, a missing page, a file, an empty page each said as such', async () => {
  const ok = await readPage('https://example.com/guide', page(GUIDE));
  assert.equal(ok.status, 'ok'); assert.equal(ok.title, 'Best food & drink in Taipei'); assert.match(ok.text, /Fuhang Soy Milk/);
  const sent = []; await readPage('https://example.com/x', async (url, init) => { sent.push([url, init]); return new Response(GUIDE, { headers: { 'content-type': 'text/html' } }); });
  assert.equal(sent[0][0], 'https://example.com/x'); assert.match(sent[0][1].headers['user-agent'], /ClipAtlas/); assert.ok(sent[0][1].signal, 'it can time out');
  assert.equal((await readPage('https://www.reddit.com/r/a', page('no', { status: 403 }))).reason, 'BLOCKED');
  assert.equal((await readPage('https://example.com/a', page('slow down', { status: 429 }))).reason, 'BLOCKED');
  assert.equal((await readPage('https://example.com/gone', page('missing', { status: 404 }))).reason, 'NOT_FOUND');
  assert.equal((await readPage('https://example.com/a.pdf', page('%PDF', { headers: { 'content-type': 'application/pdf' } }))).reason, 'NOT_A_PAGE');
  assert.equal((await readPage('https://example.com/app', page('<html><body><div id="root"></div><script>app()</script></body></html>'))).reason, 'NO_TEXT');
  const plain = await readPage('https://example.com/a.txt', page('Line one\n\n\n\nLine two', { headers: { 'content-type': 'text/plain' } }));
  assert.deepEqual([plain.status, plain.text], ['ok', 'Line one\n\nLine two']);
  const down = await readPage('https://example.com/', async () => { throw new TypeError('fetch failed'); });
  assert.deepEqual([down.status, down.reason], ['failed', 'NOT_FOUND']);
  const slow = await readPage('https://example.com/', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  assert.equal(slow.reason, 'TIMEOUT');
});

test('a huge page: only the first 1.5 MB is read', async () => {
  let pulled = 0;
  const big = new ReadableStream({ pull(ctl) { pulled += 65536; ctl.enqueue(new TextEncoder().encode('<p>' + 'x'.repeat(65529) + '</p>')); if (pulled > 50e6) ctl.close(); } });
  const r = await readPage('https://example.com/big', async () => new Response(big, { headers: { 'content-type': 'text/html' } }));
  assert.equal(r.status, 'ok'); assert.ok(pulled < 3e6, 'stopped reading early');
  assert.equal((await readPage('https://example.com/big', page('x', { headers: { 'content-type': 'text/html', 'content-length': String(50e6) } }))).reason, 'TOO_BIG');
});

// ---- the route, through the real Worker (the web faked through the global fetch)
const TOKEN = 'c'.repeat(64);
function env() {
  const limits = new Map();
  const DB = { prepare(sql) { return { bind(...args) { return {
    async first() {
      if (sql.includes('FROM sessions')) return { id: 'u1', email: 'a@b.co', display_name: 'A', expires_at: Date.now() + 1e6 };
      if (sql.includes('FROM rate_limits')) return limits.get(args[0]) || null;
      return null;
    },
    async run() {
      if (sql.startsWith('INSERT INTO rate_limits')) { const r = limits.get(args[0]) || { count: 0, reset_at: args[1] }; limits.set(args[0], { count: r.count + 1, reset_at: r.reset_at }); }
      return { meta: { changes: 1 } };
    } }; } }; } };
  return { DB, AI: {}, ASSETS: { fetch: () => new Response('asset') } };
}
const call = (e, body, headers = {}) => worker.fetch(new Request('https://clipatlas.example/api/readpage', { method: 'POST', body: JSON.stringify(body),
  headers: { origin: 'https://clipatlas.example', cookie: `clipatlas_session=${TOKEN}`, 'content-type': 'application/json', ...headers } }), e);

test('/api/readpage: signed in only; the page read; bad links refused before anything is fetched; 100 a day', async () => {
  const realFetch = globalThis.fetch, asked = [];
  globalThis.fetch = async (url, init) => { asked.push(String(url)); return new Response(GUIDE, { headers: { 'content-type': 'text/html' } }); };
  try {
    const e = env();
    const out = await call(e, { url: 'https://example.com/guide' });
    const data = await out.json();
    assert.deepEqual([out.status, data.status, data.title], [200, 'ok', 'Best food & drink in Taipei']);
    const bad = await call(e, { url: 'http://169.254.169.254/latest/meta-data/' });
    assert.deepEqual([bad.status, (await bad.json()).reason], [400, 'PRIVATE']);
    assert.equal((await (await call(e, { url: 'https://www.tiktok.com/@a/video/1' })).json()).reason, 'TIKTOK');
    assert.deepEqual(asked, ['https://example.com/guide'], 'only the good link was fetched');
    const out2 = await worker.fetch(new Request('https://clipatlas.example/api/readpage', { method: 'POST', body: '{"url":"https://example.com/"}',
      headers: { origin: 'https://clipatlas.example', 'content-type': 'application/json' } }), e);
    assert.equal(out2.status, 401);
    for (let i = 0; i < 99; i++) await call(e, { url: 'https://example.com/guide' });
    const capped = await call(e, { url: 'https://example.com/guide' });
    assert.deepEqual([capped.status, (await capped.json()).reason], [429, 'CLIPATLAS_LIMIT']);
  } finally { globalThis.fetch = realFetch; }
});
