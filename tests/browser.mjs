// The whole site in a real browser: public/ plus the real Worker, with an
// in-memory stand-in for D1 and a fake TikTok. Run by hand (needs Playwright):
//   node tests/browser.mjs
// Checks: sign up, paste TikTok-export share links, analyze, the counts, the
// "View filled-in clips" button, the badges, and that it all survives a reload.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import worker from '../src/worker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)('playwright');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

// ---- a small in-memory D1 that understands the Worker's statements
function memoryD1() {
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

// ---- a fake TikTok: two public videos (one only via its redirect), one empty, one private
const IDS = { pub: '7000000000000000001', redirected: '7000000000000000002', empty: '7000000000000000003', gone: '7000000000000000004' };
const oembedCalls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://www.tiktok.com/oembed?url=')) {
    const asked = decodeURIComponent(url.split('url=')[1]);
    oembedCalls.push(asked);
    const id = (asked.match(/(\d{19})/) || [])[1];
    if (id === IDS.pub) return Response.json({ provider_name: 'TikTok', title: 'Best night market in Taipei #taiwanfood', author_name: 'Food Fan', author_unique_id: 'foodfan' });
    if (id === IDS.redirected && asked.includes('/@shopper/')) return Response.json({ provider_name: 'TikTok', title: 'Taipei shopping haul', author_name: 'Shopper', author_unique_id: 'shopper' });
    if (id === IDS.empty) return Response.json({ provider_name: 'TikTok', title: '', author_name: '' });
    return new Response('{}', { status: 400 });
  }
  if (init.redirect === 'manual' && url.includes(IDS.redirected)) {
    return new Response('', { status: 302, headers: { location: `https://www.tiktok.com/@shopper/video/${IDS.redirected}?_r=1` } });
  }
  return new Response('<html></html>', { status: 200 });
};

const env = { DB: memoryD1(), ASSETS: { fetch: async () => new Response('not used') } };
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
const base = `http://localhost:${server.address().port}/`;

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  -> ' + detail : ''}`); };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.goto(base);
await page.click('#authToggle');
await page.fill('#authDisplay', 'Tester');
await page.fill('#authEmail', 'tester@example.com');
await page.fill('#authPassword', 'a-long-enough-password');
await page.click('#authSubmit');
await page.waitForSelector('#appShell:not([hidden])');
check('signs up and opens the library', true);

const zw = String.fromCharCode(0x200b);
await page.click('[data-tab="import"]');
await page.fill('#bulkLinks', [
  `https://www.tiktokv.com/share/video/${IDS.pub}/`,
  `${zw}https://www.tiktok.com/share/video/${IDS.redirected}`,
  `https://www.tiktokv.com/share/video/${IDS.empty}/`,
  `https://www.tiktokv.com/share/video/${IDS.gone}/`,
].join('\n'));
await page.click('#bulkImport');
await page.click('[data-tab="library"]');
check('four links imported', (await page.textContent('#statClips')).trim() === '4');
check('the panel says what is waiting', /4 links waiting/.test(await page.textContent('#analysisWaiting')));

await page.click('#analyzeLinks');
await page.waitForFunction(() => /Done:/.test(document.getElementById('analyzeProgress').textContent), null, { timeout: 20000 });
const progress = await page.textContent('#analyzeProgress');
check('counts only real details as filled in', /2 filled in · 1 no details · 1 not public · 0 not accepted · 0 failed/.test(progress), progress);
check('says why the others were not filled in', /no title or creator 1/.test(progress) && /private or removed 1/.test(progress));
check('no share link was refused', !/not accepted · [1-9]/.test(progress));
check('the share link was followed to its full address first',
  oembedCalls.includes(`https://www.tiktok.com/@shopper/video/${IDS.redirected}`));

await page.click('#viewEnriched');
const cards = await page.$$eval('#clipGrid .clip-card', els => els.map(e => ({
  title: e.querySelector('h3').textContent, badge: e.querySelector('.analysis-badge')?.textContent,
  href: e.querySelector('.clip-actions a').getAttribute('href') })));
check('"View filled-in clips" shows exactly the two', cards.length === 2, JSON.stringify(cards.map(c => c.title)));
check('their badge says Filled in', cards.every(c => c.badge === 'Filled in'));
check('their links now use the full TikTok address', cards.every(c => /tiktok\.com\/@\w+\/video\/\d+$/.test(c.href)), cards.map(c => c.href).join(' '));
check('a suggested category was applied', (await page.$$eval('#clipGrid .category', els => els.map(e => e.textContent))).includes('Taiwan · Food'));

await page.selectOption('#analysisFilter', 'all');
const badges = await page.$$eval('#clipGrid .analysis-badge', els => els.map(e => e.textContent).sort());
check('every clip shows what happened', JSON.stringify(badges) === JSON.stringify(['Filled in', 'Filled in', 'No useful details', 'Not public or removed']), badges.join(', '));

await page.waitForFunction(() => /Saved to your account/.test(document.getElementById('saveStatus').textContent));
await page.reload();
await page.waitForSelector('#appShell:not([hidden])');
await page.selectOption('#analysisFilter', 'enriched');
check('results survive a reload', (await page.$$('#clipGrid .clip-card')).length === 2);
check('nothing is waiting right after the run', /Every unreviewed link has been looked up/.test(await page.textContent('#analysisWaiting')));
await page.screenshot({ path: process.env.SHOT || '/tmp/clipatlas.png', fullPage: true });
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(results.every(Boolean) ? 'all checks passed' : 'SOME CHECKS FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
