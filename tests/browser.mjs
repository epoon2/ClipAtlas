// The whole site in a real browser: public/ plus the real Worker, with an
// in-memory stand-in for D1 and a fake TikTok. Run by hand (needs Playwright):
//   node tests/browser.mjs
// Checks: sign up, paste TikTok-export share links, analyze, the counts, the
// "View filled-in clips" button, the badges, Review mode (with a stand-in for
// TikTok's player), and that it all survives a reload.
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

// TikTok's player is replaced by a stub page; the site's own CSP must let it load.
const playerLoads = [];
const stubTikTok = async target => target.route('https://www.tiktok.com/**', route => {
  playerLoads.push(route.request().url());
  return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>stub</title><p id="stub">stub player</p>' });
});
const watchCsp = target => target.addInitScript(() => { window.__csp = [];
  document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
await stubTikTok(page); await watchCsp(page);
await page.goto(base);
await page.click('#authToggle');
await page.fill('#authDisplay', 'Tester');
await page.fill('#authEmail', 'tester@example.com');
await page.fill('#authPassword', 'a-long-enough-password');
await page.click('#authSubmit');
await page.waitForSelector('#appShell:not([hidden])');
check('signs up and opens the library', true);
await page.waitForSelector('#starterDialog[open]');
check('a new account is asked what it is for', (await page.$$('#starterChoices [data-starter]')).length === 5);
await page.click('[data-starter="travel"]');
check('the Travel starter keeps the Itinerary tab', await page.isVisible('.nav-link[data-tab="itinerary"]'));

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

await page.click('.lookup-extra summary');
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
const sorted = await page.$$eval('#clipGrid .clip-card', els => els.map(e => [e.querySelector('.category').textContent, e.querySelector('.sorted-why')?.textContent || '']));
check('clips are sorted into the account\'s categories, with the reason shown',
  sorted.some(([c, why]) => c === 'Food' && /food|night market/.test(why)) && sorted.some(([c]) => c === 'Shopping'), JSON.stringify(sorted));

await page.selectOption('#analysisFilter', 'all');
const badges = await page.$$eval('#clipGrid .analysis-badge', els => els.map(e => e.textContent).sort());
check('every clip shows what happened', JSON.stringify(badges) === JSON.stringify(['Filled in', 'Filled in', 'No useful details', 'Not public or removed']), badges.join(', '));

await page.waitForFunction(() => /Saved to your account/.test(document.getElementById('saveStatus').textContent));
await page.reload();
await page.waitForSelector('#appShell:not([hidden])');
await page.selectOption('#analysisFilter', 'enriched');
check('results survive a reload', (await page.$$('#clipGrid .clip-card')).length === 2);
check('nothing is waiting right after the run', /Every unreviewed link has been looked up/.test(await page.textContent('#analysisWaiting')));

// ---- Review mode
check('the review panel counts what needs review', /4 clips need review/.test(await page.textContent('#reviewCount')));
await page.click('#startReview');
await page.waitForSelector('#reviewDialog[open]');
check('Review opens on the clips that need review', (await page.textContent('#reviewTotal')) === '4');
const frameSrc = () => page.$eval('#reviewFrame iframe', f => f.src).catch(() => '');
check('the clip plays in TikTok\'s own player', /^https:\/\/www\.tiktok\.com\/player\/v1\/7000000000000000\d{3}\?/.test(await frameSrc()), await frameSrc());
await page.waitForTimeout(300);
check('the player frame loads (CSP allows it)', playerLoads.length >= 1 && (await page.evaluate(() => window.__csp)).length === 0,
  JSON.stringify(await page.evaluate(() => window.__csp)));
await page.selectOption('#reviewScope', 'unsorted');
check('switching to Unsorted shows the two unsorted clips', (await page.textContent('#reviewTotal')) === '2' && (await page.textContent('#reviewPos')) === '1');
const firstId = (await frameSrc()).match(/v1\/(\d+)/)[1];
await page.fill('#reviewForm [name="title"]', 'Beef noodle stall at the night market');
check('a category is picked from the sort words while typing', (await page.inputValue('#reviewCategory')) === 'Food',
  await page.textContent('#reviewSuggest'));
check('and it says why', /Picked .*Food because of .*night market/.test(await page.textContent('#reviewSuggest')), await page.textContent('#reviewSuggest'));
await page.fill('#reviewForm [name="city"]', 'Taipei');
await page.press('#reviewForm [name="city"]', 'Enter');
check('Enter saves and moves to the next clip', (await page.textContent('#reviewPos')) === '2' && !(await frameSrc()).includes(firstId));
check('the next clip starts empty', (await page.inputValue('#reviewForm [name="title"]')) === '' && (await page.inputValue('#reviewCategory')) === 'Unsorted');
await page.fill('#reviewForm [name="notes"]', 'not sure yet');
page.once('dialog', d => d.dismiss());
await page.keyboard.press('Control+ArrowLeft');
check('unsaved changes are not thrown away without asking', (await page.textContent('#reviewPos')) === '2' && (await page.inputValue('#reviewForm [name="notes"]')) === 'not sure yet');
page.once('dialog', d => d.accept());
await page.keyboard.press('Control+ArrowLeft');
check('Ctrl+Left goes back, with the saved details', (await page.textContent('#reviewPos')) === '1'
  && (await page.inputValue('#reviewForm [name="title"]')) === 'Beef noodle stall at the night market' && (await frameSrc()).includes(firstId));
await page.keyboard.press('Control+ArrowRight'); await page.keyboard.press('Control+ArrowRight');
check('at the end it says what happened', await page.isVisible('#reviewDone') && /1 saved, 2 skipped/.test(await page.textContent('#reviewDoneLine')),
  await page.textContent('#reviewDoneLine'));
check('the player stops at the end', (await page.$$('#reviewFrame iframe')).length === 0);
await page.click('#reviewFinish');
check('Close closes it', !(await page.isVisible('#reviewDialog')));
await page.selectOption('#analysisFilter', 'all');
const saved = await page.$$eval('#clipGrid .clip-card', els => els.map(e => ({ title: e.querySelector('h3').textContent,
  category: e.querySelector('.category').textContent, status: e.querySelector('.status').textContent, why: e.querySelector('.sorted-why')?.textContent || '' }))
  .find(c => c.title === 'Beef noodle stall at the night market'));
check('the saved clip is reviewed, in Food, with its reason', saved && saved.category === 'Food' && /Reviewed/.test(saved.status) && /night market/.test(saved.why), JSON.stringify(saved));
check('the review count went down', /3 clips need review/.test(await page.textContent('#reviewCount')));
const cardIds = await page.$$eval('#clipGrid [data-action="watch"]', els => els.map(e => e.dataset.id));
await page.click(`#clipGrid [data-action="watch"][data-id="${cardIds[2]}"]`);
await page.waitForSelector('#reviewDialog[open]');
check('Watch opens that clip among the clips on screen', (await page.textContent('#reviewPos')) === '3' && (await page.textContent('#reviewTotal')) === String(cardIds.length)
  && (await page.inputValue('#reviewScope')) === 'shown');
await page.screenshot({ path: (process.env.SHOT || '/tmp/clipatlas.png').replace(/\.png$/, '-review.png') });
await page.fill('#reviewForm [name="notes"]', 'line one');
await page.press('#reviewForm [name="notes"]', 'Control+Enter');
check('Ctrl+Enter in the notes saves once and moves on once', (await page.textContent('#reviewPos')) === '4');
await page.keyboard.press('Escape');
check('Esc closes it and the player', !(await page.isVisible('#reviewDialog')) && (await page.$$('#reviewFrame iframe')).length === 0);
check('no CSP problems', (await page.evaluate(() => window.__csp)).length === 0, JSON.stringify(await page.evaluate(() => window.__csp)));

// ---- Settings: rename, delete, add, turn the Itinerary off
await page.click('.nav-link[data-tab="settings"]');
const rowFor = name => page.locator('.cat-row', { has: page.locator(`input.cat-name[value="${name}"]`) });
await rowFor('Food').locator('input.cat-name').fill('Eats');
await rowFor('Food').locator('input.cat-name').press('Tab');
page.once('dialog', d => d.accept());
await rowFor('Stays').locator('[data-cat-delete]').click();
await page.fill('#newCatName', 'Hikes'); await page.fill('#newCatWords', 'hike, trail'); await page.click('#addCategory');
const names = await page.$$eval('#categoryRows input.cat-name', els => els.map(e => e.value));
check('rename, delete and add work', names.includes('Eats') && !names.includes('Stays') && names.at(-1) === 'Hikes', names.join(', '));
await page.uncheck('#tabItinerary');
check('the Itinerary tab can be turned off', !(await page.isVisible('.nav-link[data-tab="itinerary"]')));
await page.click('.nav-link[data-tab="library"]');
await page.selectOption('#analysisFilter', 'all');
check('renamed category follows its clips', (await page.$$eval('#clipGrid .category', els => els.map(e => e.textContent))).includes('Eats'));
check('no "+ Plan" buttons without the Itinerary', (await page.$$('[data-action="plan"]')).length === 0);
check('the category filter lists the account\'s categories', (await page.$$eval('#categoryFilter option', els => els.map(e => e.value))).includes('Hikes'));
await page.waitForTimeout(600);
await page.waitForFunction(() => /Saved to your account/.test(document.getElementById('saveStatus').textContent));
await page.reload(); await page.waitForSelector('#appShell:not([hidden])');
console.log('     after reload: itinerary visible=' + await page.isVisible('.nav-link[data-tab="itinerary"]') + ', starter open=' + await page.isVisible('#starterDialog'));
check('settings survive a reload, and the starter question is not asked again',
  !(await page.isVisible('.nav-link[data-tab="itinerary"]')) && !(await page.isVisible('#starterDialog')));

await page.screenshot({ path: process.env.SHOT || '/tmp/clipatlas.png', fullPage: true });
await page.click('.nav-link[data-tab="settings"]');
await page.screenshot({ path: (process.env.SHOT || '/tmp/clipatlas.png').replace(/\.png$/, '-settings.png'), fullPage: true });

// ---- an account from before categories keeps its list and its Itinerary
async function api(path, method, body, cookie) {
  const res = await worker.fetch(new Request(base + 'api/' + path, { method, body: body && JSON.stringify(body),
    headers: { origin: base.replace(/\/$/, ''), 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }), env);
  return res;
}
const reg = await api('register', 'POST', { email: 'old@example.com', password: 'a-long-enough-password', displayName: 'Old' });
const cookie = reg.headers.get('set-cookie').split(';')[0];
await api('library', 'PUT', { revision: 0, state: { version: 1, collections: [], plan: [], tripTitle: 'Taiwan', dayCount: 7,
  records: [{ id: 'r1', key: 'tiktok:7000000000000000009', url: 'https://www.tiktok.com/share/video/7000000000000000009', title: 'Taipei food crawl',
    category: 'Taiwan · Food', collections: [], tags: [], status: 'unreviewed', createdAt: '2026-10-01', updatedAt: '2026-10-01' }] } }, cookie);
const old = await (await browser.newContext()).newPage();
await old.goto(base); await old.fill('#authEmail', 'old@example.com'); await old.fill('#authPassword', 'a-long-enough-password');
await old.click('#authSubmit'); await old.waitForSelector('#appShell:not([hidden])');
await old.waitForTimeout(300);
check('an existing account is not asked to choose', !(await old.isVisible('#starterDialog')));
check('it keeps the Itinerary', await old.isVisible('.nav-link[data-tab="itinerary"]'));
await old.click('.nav-link[data-tab="settings"]');
const oldNames = await old.$$eval('#categoryRows input.cat-name', els => els.map(e => e.value));
check('it keeps the first version\'s categories', oldNames[0] === 'Taiwan · Food' && oldNames.includes('Points & miles'), oldNames.join(', '));

// ---- a research account has no Itinerary
const res = await (await browser.newContext()).newPage();
await res.goto(base); await res.click('#authToggle');
await res.fill('#authDisplay', 'R'); await res.fill('#authEmail', 'r@example.com'); await res.fill('#authPassword', 'a-long-enough-password');
await res.click('#authSubmit'); await res.waitForSelector('#starterDialog[open]');
await res.screenshot({ path: (process.env.SHOT || '/tmp/clipatlas.png').replace(/\.png$/, '-starter.png') });
await res.click('[data-starter="research"]');
check('Research: no Itinerary tab', !(await res.isVisible('.nav-link[data-tab="itinerary"]')));
check('Research: its own heading', (await res.textContent('#heroTitle')) === 'All the things you learned.');
await res.click('[data-tab="import"]'); await res.fill('#bulkLinks', 'https://vm.tiktok.com/ZMabc123/'); await res.click('#bulkImport');
await res.click('.nav-link[data-tab="library"]'); await res.click('#clipGrid [data-action="watch"]');
check('a short link without a video number says so instead of a broken player',
  (await res.$$('#reviewFrame iframe')).length === 0 && /cannot play here/.test(await res.textContent('#reviewFrame')));
await res.setViewportSize({ width: 390, height: 844 });
await res.screenshot({ path: (process.env.SHOT || '/tmp/clipatlas.png').replace(/\.png$/, '-review-phone.png') });
const sideways = await res.evaluate(() => document.querySelector('#reviewDialog').scrollWidth > document.querySelector('#reviewDialog').clientWidth);
check('Review fits a phone screen', !sideways);

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(results.every(Boolean) ? 'all checks passed' : 'SOME CHECKS FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
