// Web pages and typed notes in a collection, in a real browser: public/ plus the
// real Worker, with an in-memory D1, a fake web and a fake Gemini. Run by hand
// (needs Playwright):  node tests/notes.mjs
// Checks: add a web link and read its page, a site that refuses (pasting the text
// instead), a typed note, a TikTok pasted as a web link, the AI listing the places
// in each, the cards, Ask using them, planning their places, and a reload.
import { createRequire } from 'node:module';
import { memoryD1, startSite } from './site.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const GUIDE = `<!doctype html><html><head><title>48 hours in Taipei</title><meta name="description" content="A short guide."></head>
<body><nav>Home · Guides</nav><article><h1>48 hours in Taipei</h1><p>Breakfast at Fuhang Soy Milk.</p><p>Evening at Raohe Night Market, then Taipei 101.</p></article><footer>© Guide site</footer></body></html>`;
const pagesAsked = [];
const gemini = { calls: [], asks: [], plans: [] };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = obj => json(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120 } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    const body = JSON.parse(new TextDecoder().decode(init.body)), text = body.contents[0].parts[0].text;
    if (body.generationConfig.responseSchema && body.generationConfig.responseSchema.properties.days) {   // Plan with AI
      gemini.plans.push(text);
      const num = name => Number((new RegExp(`(\\d+)\\. ${name} \\(`).exec(text) || [])[1]);
      return answer({ days: [{ day: 1, stops: [{ place: num('Raohe Night Market'), time: 'night', why: 'a night market at night' }, { place: num('Fuhang Soy Milk'), time: 'breakfast', why: 'soy milk to start' }] }],
        missing: ['no saved noodle shop'], summary: 'Breakfast and a night market on day 1.' });
    }
    if (!body.generationConfig.responseSchema) { gemini.asks.push(text); return answer('## Breakfast\n\n- **Fuhang Soy Milk** [1]\n- Jiufen tea [3]'); }
    gemini.calls.push({ text, parts: body.contents[0].parts.length, keys: Object.keys(body.generationConfig.responseSchema.properties) });
    const places = [];
    if (/Fuhang/.test(text)) places.push({ name: 'Fuhang Soy Milk', type: 'food', city: 'Taipei', country: 'Taiwan', note: 'egg crepe and soy milk' });
    if (/Raohe/.test(text)) places.push({ name: 'Raohe Night Market', type: 'food', city: 'Taipei', country: 'Taiwan', note: '' });
    if (/Taipei 101/.test(text)) places.push({ name: 'Taipei 101', type: 'sightseeing', city: 'Taipei', country: 'Taiwan', note: 'go at sunset' });
    if (/A-Mei/.test(text)) places.push({ name: 'A-Mei Tea House', type: 'food', city: 'Jiufen', country: 'Taiwan', note: 'tea with a view' });
    if (/Ximending/.test(text)) places.push({ name: 'Ximending', type: 'shopping', city: 'Taipei', country: 'Taiwan', note: 'sneakers' });
    return answer({ title: /A-Mei/.test(text) ? 'Jiufen tea' : 'Taipei food and sights', summary: 'Places to go.', place: '', city: places[0]?.city || '', country: 'Taiwan',
      category: 'Food', tags: ['taipei'], places });
  }
  if (url === 'https://guide.example/taipei-48-hours') { pagesAsked.push(url); return new Response(GUIDE, { headers: { 'content-type': 'text/html; charset=utf-8' } }); }
  if (url.startsWith('https://www.reddit.com/')) { pagesAsked.push(url); return new Response('Blocked', { status: 403, headers: { 'content-type': 'text/html' } }); }
  return new Response('not found', { status: 404 });
};

const env = { DB: memoryD1(), GEMINI_API_KEY: 'test-key', ASSETS: { fetch: async () => new Response('not used') } };
const { server, base } = await startSite(env);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  -> ' + detail : ''}`); };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
await page.goto(base);
await page.click('#authToggle');
await page.fill('#authDisplay', 'Tester');
await page.fill('#authEmail', 'notes@example.com');
await page.fill('#authPassword', 'a-long-enough-password');
await page.click('#authSubmit');
await page.waitForSelector('#starterDialog[open]');
await page.click('[data-starter="travel"]');

const card = text => page.locator('#clipGrid .clip-card', { hasText: text });
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };
const records = () => page.evaluate(async () => (await (await fetch('/api/library', { credentials: 'same-origin' })).json()).state?.records || []);

// 1. A web link: the page is read into the box, then saved and read by the AI.
await page.click('#addButton');
check('the Add dialog asks what is being added', await page.isVisible('#kindPick') && await page.isVisible('#urlField') && !(await page.isVisible('#bodyField')));
await page.click('#kindPick [data-kind="link"]');
check('a web link shows the page text box and the Read button, not the TikTok-only fields',
  await page.isVisible('#bodyField') && await page.isVisible('#readPageBtn') && !(await page.isVisible('#editForm [name="creator"]')) && !(await page.isVisible('#editForm [name="status"]'))
  && (await page.textContent('#urlLabel')) === 'WEB LINK *');
await page.fill('#editForm [name="url"]', 'https://guide.example/taipei-48-hours?utm_source=newsletter');
await page.click('#readPageBtn');
await waitFor(async () => /Read \d/.test(await page.textContent('#readPageStatus')));
const box = await page.inputValue('#editForm [name="body"]');
check('Read the page fills in its text, without the menu and footer', /Fuhang Soy Milk/.test(box) && !/Home · Guides|© Guide site/.test(box), box.slice(0, 80));
check('… and the title, when it is empty', (await page.inputValue('#editForm [name="title"]')) === '48 hours in Taipei');
check('the page was fetched without its tracking part', pagesAsked[0] === 'https://guide.example/taipei-48-hours', pagesAsked.join(', '));
await page.fill('#editForm [name="collections"]', 'Taiwan');
await page.click('#editForm button[type="submit"]');
check('saving lets the AI read it: the places on the page are found', await waitFor(async () => /Found 3 places/.test(await page.textContent('#toast'))), await page.textContent('#toast'));
const g1 = gemini.calls[0] || {};
check('Gemini got the page text only: no sound, no pictures, no video-only answer keys',
  g1.parts === 1 && /web page someone saved/.test(g1.text) && /Fuhang/.test(g1.text) && !g1.keys.includes('transcript') && g1.keys.includes('places'), JSON.stringify(g1.keys));
const guide = card('48 hours in Taipei');
check('the card says it is a web page, read by the AI, with its site and places',
  /WEB PAGE/.test(await guide.textContent()) && /✦ Read/.test(await guide.textContent()) && /guide\.example/.test(await guide.textContent())
  && /3 places: Fuhang Soy Milk · Raohe Night Market · Taipei 101/.test(await guide.textContent()), (await guide.textContent()).slice(0, 200));
check('… with Open (the page) instead of Watch',
  (await guide.locator('a', { hasText: 'Open' }).getAttribute('href')) === 'https://guide.example/taipei-48-hours' && (await guide.locator('[data-action="watch"]').count()) === 0);

// 2. A site that refuses: saved anyway; the person pastes the text, and it is read from that.
await page.click('#addButton');
await page.click('#kindPick [data-kind="link"]');
await page.fill('#editForm [name="url"]', 'https://www.reddit.com/r/taiwan/comments/abc/where_to_shop/');
await page.fill('#editForm [name="title"]', 'Reddit: where to shop');
await page.click('#editForm button[type="submit"]');
check('a site that refuses is said as such, with what to do', await waitFor(async () => /would not let ClipAtlas read it.*paste/i.test(await page.textContent('#toast'))), await page.textContent('#toast'));
check('… and the link is still saved', await card('Reddit: where to shop').count() === 1);
await card('Reddit: where to shop').locator('[data-action="edit"]').click();
check('editing it shows the same fields and no kind picker', !(await page.isVisible('#kindPick')) && await page.isVisible('#bodyField') && (await page.textContent('#modalTitle')) === 'Edit web link');
await page.fill('#editForm [name="body"]', 'Top comment: go to Ximending for sneakers.');
await page.click('#editForm button[type="submit"]');
check('pasted text is read: its place found', await waitFor(async () => /Found 1 place in “Reddit: where to shop”/.test(await page.textContent('#toast'))), await page.textContent('#toast'));

// 3. A typed note, added inside the open collection.
await page.click('#collectionNav [data-collection="Taiwan"]');
await page.click('#addButton');
await page.click('#kindPick [data-kind="note"]');
check('a note has no link field and a NOTE box', !(await page.isVisible('#urlField')) && (await page.textContent('#bodyLabel')) === 'NOTE *' && !(await page.isVisible('#readPageBtn')));
check('… and goes into the open collection', (await page.inputValue('#editForm [name="collections"]')) === 'Taiwan');
await page.click('#editForm button[type="submit"]');
check('an empty note is not saved', /Type the note/.test(await page.textContent('#modalError')));
await page.fill('#editForm [name="body"]', 'From Amy: A-Mei Tea House in Jiufen, go on a weekday. Raohe Night Market too.');
await page.click('#editForm button[type="submit"]');
check('the note is read too', await waitFor(async () => /Found 2 places/.test(await page.textContent('#toast'))), await page.textContent('#toast'));
const note = card('Jiufen tea');
check('the note card says NOTE, with its text and no Open link', /NOTE/.test(await note.textContent()) && /From Amy/.test(await note.textContent()) && (await note.locator('a').count()) === 0);

// 4. A TikTok pasted as a web link is saved as a TikTok.
await page.click('#addButton');
await page.click('#kindPick [data-kind="link"]');
await page.fill('#editForm [name="url"]', 'https://www.tiktok.com/@food/video/7345678901234567890');
await page.locator('#editForm [name="url"]').blur();
check('a pasted TikTok switches the dialog to TikTok', (await page.getAttribute('#kindPick [data-kind="tiktok"]', 'aria-pressed')) === 'true');
await page.click('#editForm button[type="submit"]');
await page.waitForTimeout(300);
let saved = await records();
const tiktok = saved.find(r => r.key === 'tiktok:7345678901234567890');
check('… and saved as one', tiktok && !tiktok.kind, JSON.stringify(saved.map(r => [r.kind, r.key])));
check('only the TikTok counts as needing review', (await page.textContent('#statReview')).trim() === '1', await page.textContent('#statReview'));
check('the library counts items, not clips, once it holds pages and notes', /items/.test(await page.textContent('#filteredCount')), await page.textContent('#filteredCount'));
check('search finds words in a page’s text', await (async () => { await page.fill('#search', 'evening at'); await page.waitForTimeout(100);
  const n = await page.locator('#clipGrid .clip-card').count(); await page.fill('#search', ''); return n === 1; })());

// 5. Ask uses the pages and the note.
const examples = await page.$$eval('#askExamples .ask-example', b => b.map(x => x.textContent));
check('Ask is open above the cards, with example questions for this collection',
  await page.$eval('#askPanel', d => d.open) && await page.isVisible('#askInput') && /Ask AI about Taiwan/.test(await page.textContent('#askPanel summary')) &&
  examples.includes('What should I eat in Taipei?') && examples.includes('Which places do several sources recommend?'), JSON.stringify(examples));
await page.locator('#askExamples .ask-example', { hasText: 'several sources recommend' }).click();
await waitFor(async () => (await page.locator('#askAnswers .ask-item').count()) > 0);
const asked = gemini.asks[0] || '';
check('an example is asked with one click', /Which places do several sources recommend\?/.test(asked) && /several sources recommend/.test(await page.textContent('#askAnswers .ask-q')));
check('Ask is given the pages and the note as sources', /Web page: "48 hours in Taipei"/.test(asked) && /Note: "Jiufen tea"/.test(asked) && /A-Mei Tea House/.test(asked), asked.slice(0, 300));

// 5b. The collection as research: every place by city, then by kind, each once with the clips that name it.
await page.click('[data-lib-view="places"]');
await page.screenshot({ path: (process.env.SHOT || '/tmp/clipatlas.png').replace(/\.png$/, '-report.png'), fullPage: true });
const report = await page.$$eval('#placesReport .report-city', els => els.map(c => [c.querySelector('h3').textContent, [...c.querySelectorAll('.report-place strong')].map(s => s.textContent)]));
check('Places by city lists the collection\'s places by city and kind, the most-recommended first',
  JSON.stringify(report) === JSON.stringify([['📍 Taipei Taiwan · 3 places', ['Raohe Night Market', 'Fuhang Soy Milk', 'Taipei 101']], ['📍 Jiufen Taiwan · 1 place', ['A-Mei Tea House']]])
  && !(await page.isVisible('#clipGrid')), JSON.stringify(report));
check('… and says how many places, cities and items it is from', /^4 places in 2 cities, from 3 items \(1 names no place\)/.test(await page.textContent('#placesReport .report-head p')),
  await page.textContent('#placesReport .report-head p'));
const raohe = page.locator('#placesReport .report-place', { has: page.locator('strong', { hasText: 'Raohe Night Market' }) });
check('a place two items name says so, and lists both', (await raohe.locator('.report-count').textContent()) === '2 sources' && /^From (Jiufen tea, 48 hours in Taipei ↗|48 hours in Taipei ↗, Jiufen tea)$/.test(await raohe.locator('.report-from').textContent()),
  await raohe.textContent());
const fuhang = page.locator('#placesReport .report-place', { has: page.locator('strong', { hasText: 'Fuhang Soy Milk' }) });
check('each place has its notes and a Google Maps pin', /egg crepe and soy milk/.test(await fuhang.textContent()) &&
  (await fuhang.locator('a.map-link').getAttribute('href')) === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Fuhang Soy Milk, Taipei, Taiwan'));
await raohe.locator('.report-from button', { hasText: 'Jiufen tea' }).click();
check('the name of a clip it is from opens that clip in Edit, at the place', await page.isVisible('#editDialog[open]') &&
  await page.evaluate(() => document.activeElement.closest('.place-row')?.querySelector('.pl-name').value) === 'Raohe Night Market');
await page.click('#cancelEdit');
const [reportFile] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="report-download"]')]);
const reportMd = (await import('node:fs')).readFileSync(await reportFile.path(), 'utf8');
check('Download gives the research as a Markdown file', reportFile.suggestedFilename() === 'taiwan-places-by-city.md' && /^# Taiwan: places by city\n/.test(reportMd) &&
  /- \*\*Raohe Night Market\*\* — 2 sources/.test(reportMd), reportFile.suggestedFilename() + ' ' + reportMd.slice(0, 200));
await page.click('[data-lib-view="cards"]');

// 6. Planning: a page's places become stops that link back to the page; a note's say where they came from.
await page.click('[data-tab="library"]');
await page.click('#collectionNav [data-collection="Taiwan"]').catch(() => {});
await card('48 hours in Taipei').locator('[data-action="plan"]').click();
await card('Jiufen tea').locator('[data-action="plan"]').click();
await page.click('.nav-link[data-tab="itinerary"]');
await page.click('[data-itinerary-view="days"]');
const days = await page.textContent('#itineraryDays');
check('the page’s three places and the note’s place are stops', ['Fuhang Soy Milk', 'Raohe Night Market', 'Taipei 101', 'A-Mei Tea House'].every(n => days.includes(n)), days.slice(0, 300));
check('a page’s stop links to the page', (await page.locator('#itineraryDays a', { hasText: 'From “48 hours in Taipei”' }).first().getAttribute('href')) === 'https://guide.example/taipei-48-hours');
check('a note’s stop says it is from the note', /From your note “Jiufen tea”/.test(days));
await page.click('[data-itinerary-view="cities"]');
check('By city lists the note’s place under Jiufen', /Jiufen[\s\S]*A-Mei Tea House/.test(await page.textContent('#itineraryCities')));

// 6a. Plan with AI: say what you want; it arranges the saved places, shows the plan, and changes the days only when asked.
check('Plan with AI is open on the itinerary, with examples', await page.$eval('#planAI', d => d.open) && await page.isVisible('#planAIInput') &&
  (await page.locator('#planAIExamples .ask-example').count()) >= 4);
await page.click('[data-action="plan-ai-example"][data-q="A night market every night"]');
await page.locator('#planAIInput').press('End'); await page.keyboard.type('; noodles for lunch');
await page.click('#planAIButton');
await waitFor(async () => await page.isVisible('#planAIResult'));
const preview = await page.textContent('#planAIResult');
await page.locator('#planAI').screenshot({ path: (process.env.SHOT || '/tmp/clipatlas.png').replace(/\.png$/, '-planai.png') });
check('the AI got the request, the saved places by number and the days as they are', /<<<\nA night market every night; noodles for lunch\n>>>/.test(gemini.plans[0] || '') &&
  /\d+\. Fuhang Soy Milk \(food, Taipei\)/.test(gemini.plans[0] || '') && /The days as they are now[^\n]*\nDay 1: \d/.test(gemini.plans[0] || ''), (gemini.plans[0] || '').slice(0, 400));
check('the plan is shown first: when, what and why, what is missing, and what it takes off',
  /Breakfast and a night market on day 1\./.test(preview) && /🍳 BreakfastFuhang Soy Milk Taipeisoy milk to start🌙 NightRaohe Night Market Taipeia night market at night/.test(preview.replace(/\s*\n\s*/g, '')) &&
  /Not in your saved places:no saved noodle shop/.test(preview.replace(/\s*\n\s*/g, '')) && /takes off Taipei 101, A-Mei Tea House \(still in By city\)/.test(preview), preview);
check('… and the days are not changed yet', /Taipei 101/.test(await page.textContent('#itineraryDays')));
await page.click('[data-action="plan-ai-use"]');
const aiDay1 = await page.$$eval('#itineraryDays .day-panel:first-child .stop', els => els.map(e => [e.querySelector('h4').textContent, e.querySelector('[data-plan-note]').value]));
check('Use this plan: the days follow it, each stop noting when and why',
  JSON.stringify(aiDay1) === JSON.stringify([['Fuhang Soy Milk', 'Breakfast — soy milk to start'], ['Raohe Night Market', 'Night — a night market at night']]) && !/Taipei 101/.test(await page.textContent('#itineraryDays')),
  JSON.stringify(aiDay1));
await page.click('#toast .toast-action');
check('… and Undo puts the days back', /Taipei 101/.test(await page.textContent('#itineraryDays')) && /A-Mei Tea House/.test(await page.textContent('#itineraryDays')));

// 6b. A plan made before the places were listed: when the site opens, each clip's stop becomes its places' stops.
await page.waitForTimeout(500);
const lib = await page.evaluate(async () => (await fetch('/api/library', { credentials: 'same-origin' })).json());
const guideRec = lib.state.records.find(r => r.title === '48 hours in Taipei');
lib.state.plan = [...lib.state.plan.filter(p => p.recordId !== guideRec.id), { id: 'old-stop', recordId: guideRec.id, day: 2, note: 'old plan' }];
await page.evaluate(async body => { await fetch('/api/library', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); },
  { state: lib.state, revision: lib.revision });
await page.reload();
await page.waitForSelector('#appShell:not([hidden])');
check('an old whole-clip stop is split into its places when the site opens, and it says so', await waitFor(async () => /now has a stop for each place/.test(await page.textContent('#toast'))),
  await page.textContent('#toast'));
await page.waitForTimeout(600);
const splitPlan = (await page.evaluate(async () => (await (await fetch('/api/library', { credentials: 'same-origin' })).json()).state.plan)).filter(p => p.recordId === guideRec.id);
check('… one stop per place, on the same day, the old note kept on the first, and saved', JSON.stringify(splitPlan.map(p => [!!p.placeId, p.day, p.note])) === JSON.stringify([[true, 2, 'old plan'], [true, 2, ''], [true, 2, '']]),
  JSON.stringify(splitPlan));

// 7. Everything survives a reload.
await page.waitForTimeout(500);
await page.reload();
await page.waitForSelector('#appShell:not([hidden])');
saved = await records();
const kinds = saved.map(r => r.kind || 'tiktok').sort().join(',');
check('after a reload: two pages, a note and a TikTok', kinds === 'link,link,note,tiktok', kinds);
check('… the page text and places kept', /Fuhang/.test(saved.find(r => r.title === '48 hours in Taipei')?.body || '') && saved.find(r => r.title === '48 hours in Taipei')?.places?.length === 3);
await page.setViewportSize({ width: 390, height: 844 });
await page.click('#addButton');
await page.click('#kindPick [data-kind="note"]');
await page.screenshot({ path: (process.env.SHOT || '/tmp/clipatlas.png').replace(/\.png$/, '-note-phone.png') });
const sideways = await page.evaluate(() => document.querySelector('#editDialog').scrollWidth > document.querySelector('#editDialog').clientWidth);
check('the Add dialog fits a phone screen', !sideways);
await page.click('#cancelEdit');
await page.setViewportSize({ width: 1280, height: 900 });
await page.click('[data-tab="library"]');
await page.screenshot({ path: (process.env.SHOT || '/tmp/clipatlas.png').replace(/\.png$/, '-notes.png'), fullPage: true });

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.close();
console.log(results.every(Boolean) ? 'all checks passed' : 'SOME CHECKS FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
