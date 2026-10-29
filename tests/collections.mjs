// Collections in a real browser: what each is for, its research (places by city with how
// many sources name each, or the collection's own groups), the same place under other
// names, and Ask's examples. public/ plus the real Worker, an in-memory D1 and a fake Gemini.
// Run by hand (needs Playwright):  node tests/collections.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { memoryD1, startSite } from './site.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const gemini = { groups: [], reports: [], same: [], asks: [] };
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const answer = obj => json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }] });
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (!url.startsWith('https://generativelanguage.googleapis.com/')) return new Response('not found', { status: 404 });
  const body = JSON.parse(new TextDecoder().decode(init.body)), text = body.contents[0].parts[0].text;
  const schema = body.generationConfig.responseSchema, item = schema && schema.properties.groups && schema.properties.groups.items.properties;
  if (!schema) { gemini.asks.push(text); return answer('- Get the Sapphire Preferred [2]'); }
  if (item && item.members) {   // which names are one place
    gemini.same.push(text);
    const num = name => Number((new RegExp(`(\\d+)\\. ${name} \\(`).exec(text) || [])[1]);
    return answer({ groups: [{ name: 'Raohe Night Market', members: [num('Raohe Night Market'), num('Raohe Street Night Market')] },
      { name: 'Chiang Kai-shek Memorial Hall', members: [num('CKS memorial'), num('Chiang Kai-shek Memorial Hall')] }] });
  }
  if (item && item.hint) {   // groups for a collection
    gemini.groups.push(text);
    return answer({ groups: [{ name: 'Sign-up bonuses', hint: 'the offer and spend' }, { name: 'Transfer partners', hint: 'where points go' }, { name: 'Fees', hint: 'annual fees' }] });
  }
  if (item && item.points) {   // the research, sorted into the groups
    gemini.reports.push(text);
    return answer({ groups: [{ name: 'Transfer partners', points: [{ text: 'Chase points transfer 1:1 to Hyatt.', sources: [1, 2, 3] }, { text: 'Amex points transfer 1:1 to ANA.', sources: [3] }] },
      { name: 'Sign-up bonuses', points: [{ text: 'The Sapphire Preferred offers 75,000 points after $5,000 in 3 months.', sources: [2] }] }],
      summary: 'Hyatt through Chase comes up most.' });
  }
  return answer({});
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
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };
const library = () => page.evaluate(async () => (await (await fetch('/api/library', { credentials: 'same-origin' })).json()));

await page.goto(base);
await page.click('#authToggle');
await page.fill('#authDisplay', 'Tester'); await page.fill('#authEmail', 'collections@example.com'); await page.fill('#authPassword', 'a-long-enough-password');
await page.click('#authSubmit');
await page.waitForSelector('#starterDialog[open]');
await page.click('[data-starter="travel"]');
await page.waitForTimeout(600);

// A library to work with: a Taiwan trip (places, some under two names) and a credit-card collection (no places).
const lib = await library();
await page.evaluate(async ({ state, revision }) => {
  const C = window.ClipAtlasCore, v = n => `https://www.tiktok.com/@a/video/73456789012345678${n}`;
  state.records = [
    C.createRecord({ url: v(10), title: 'Night markets', collections: 'Taiwan', places: [{ name: 'Raohe Night Market', type: 'food', city: 'Taipei', note: 'pepper buns' }, { name: 'CKS memorial', type: 'sightseeing', city: 'Taipei' }] }),
    C.createRecord({ url: v(11), title: 'Taipei day', collections: 'Taiwan', places: [{ name: 'Raohe Street Night Market', type: 'food', city: 'Taipei' }, { name: 'Taipei 101', type: 'sightseeing', city: 'Taipei' }, { name: 'Din Tai Fung', type: 'food', city: 'Taipei' }] }),
    C.createRecord({ kind: 'link', url: 'https://guide.example/taipei', title: 'Taipei guide', body: 'x', collections: 'Taiwan', places: [{ name: 'Chiang Kai-shek Memorial Hall', type: 'sightseeing', city: 'Taipei' }, { name: 'Din Tai Fung', type: 'food', city: 'Taipei' }] }),
    C.createRecord({ kind: 'note', title: 'Amex Gold notes', body: 'Amex Gold earns 4x at restaurants; points move 1:1 to ANA.', collections: 'Credit Card Points' }),
    C.createRecord({ kind: 'link', url: 'https://cards.example/csp', title: 'Sapphire Preferred review', body: '75,000 points after $5,000; transfer to Hyatt 1:1.', collections: 'Credit Card Points' }),
    C.createRecord({ kind: 'note', title: 'Hyatt tip', body: 'Hyatt is the best Chase transfer partner.', collections: 'Credit Card Points' })];
  await fetch('/api/library', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, revision }) });
}, lib);
await page.reload();
await page.waitForSelector('#appShell:not([hidden])');

// 1. A collection not set up yet asks what it is for.
await page.click('#collectionNav [data-collection="Credit Card Points"]');
check('an unset collection asks what it is for', await page.isVisible('#collSetupBanner') && /Credit Card Points/.test(await page.textContent('#collSetupBanner')));
check('… and its research view is by topic, not by city', (await page.textContent('[data-lib-view="places"]')) === '📋 Research by topic');
const cardExamples = await page.$$eval('#askExamples .ask-example', b => b.map(x => x.textContent));
check('Ask\'s examples do not talk about places when the collection has none', !cardExamples.some(q => /place|eat|city/i.test(q)), JSON.stringify(cardExamples));
await page.click('#collSetupBanner [data-action="coll-setup"]');
await page.waitForSelector('#collectionDialog[open]');
await page.click('[data-coll-kind="cards"]');
const suggested = await page.$$eval('#collGroups .cg-name', els => els.map(e => e.value));
check('choosing what it is for suggests groups to sort into', suggested.length === 5 && suggested.includes('Transfer partners'), JSON.stringify(suggested));
await page.fill('#collAbout', 'pick my next travel card');
await page.click('#collSuggest');
await waitFor(async () => /Suggested/.test(await page.textContent('#collStatus')));
const fromAI = await page.$$eval('#collGroups .cg-name', els => els.map(e => e.value));
check('✦ Suggest with AI fills in groups that fit, from what it is for and what it holds',
  JSON.stringify(fromAI) === '["Sign-up bonuses","Transfer partners","Fees"]' && /pick my next travel card/.test(gemini.groups[0] || '') && /- Sapphire Preferred review/.test(gemini.groups[0] || ''), JSON.stringify(fromAI));
await page.locator('#collGroups .coll-group').nth(2).locator('.cg-remove').click();
await page.click('#collAddGroup'); await page.locator('#collGroups .cg-name').last().fill('Earning points');
await page.click('#collectionForm button[type="submit"]');
let info = {};
await waitFor(async () => { info = (await library()).state.collectionInfo || {}; return !!info['Credit Card Points']; });
check('the setup is saved with the collection', info['Credit Card Points']?.kind === 'cards' && JSON.stringify(info['Credit Card Points'].groups.map(g => g.name)) === '["Sign-up bonuses","Transfer partners","Earning points"]',
  JSON.stringify(info));
check('… the banner goes, and Ask\'s examples fit the purpose', !(await page.isVisible('#collSetupBanner')) &&
  (await page.$$eval('#askExamples .ask-example', b => b.map(x => x.textContent))).includes('Which card should I get next, and why?'));

// 2. Research by topic: the AI sorts what the sources say into those groups, with how many sources say each point.
check('the research view opens with the groups and a build button', await page.isVisible('#placesReport [data-action="topic-build"]') &&
  /Sign-up bonuses/.test(await page.textContent('#placesReport .report-head')));
await page.click('#placesReport [data-action="topic-build"]');
await waitFor(async () => (await page.locator('#placesReport .topic-points li').count()) > 0);
check('the AI got the groups and every source', /- Sign-up bonuses: the offer and spend\n- Transfer partners: where points go\n- Earning points\n- Other/.test(gemini.reports[0] || '') && /Hyatt is the best Chase transfer partner/.test(gemini.reports[0] || ''),
  (gemini.reports[0] || '').slice(0, 300));
const points = await page.$$eval('#placesReport .topic-group', els => els.map(g => [g.querySelector('h3').firstChild.textContent.trim(), [...g.querySelectorAll('li')].map(li => li.querySelector('.report-count').textContent)]));
check('points sit under the person\'s groups, in their order, each saying how many sources say it',
  JSON.stringify(points) === '[["Sign-up bonuses",["1 source"]],["Transfer partners",["3 sources","1 source"]]]', JSON.stringify(points));
check('… with the summary and the sources by name', /Hyatt through Chase comes up most/.test(await page.textContent('#placesReport')) &&
  /From Hyatt tip, Sapphire Preferred review ↗, Amex Gold notes|From Amex Gold notes/.test(await page.textContent('#placesReport .topic-group:nth-of-type(2)')));
const [md] = await Promise.all([page.waitForEvent('download'), page.click('#placesReport [data-action="report-download"]')]);
const mdText = fs.readFileSync(await md.path(), 'utf8');
check('Download gives the research as Markdown, with the count by each point', md.suggestedFilename() === 'credit-card-points-research.md' &&
  /- Chase points transfer 1:1 to Hyatt\. — 3 sources\n/.test(mdText), md.suggestedFilename() + ' ' + mdText.slice(0, 200));
await waitFor(async () => !!((await library()).state.reports || {})['Credit Card Points']);
await page.reload();
await page.waitForSelector('#appShell:not([hidden])');
await page.click('#collectionNav [data-collection="Credit Card Points"]');
await waitFor(async () => await page.isVisible('#topicStatus'));
check('the research is kept with the collection', /Built .* from 3 items/.test(await page.textContent('#topicStatus')) && (await page.locator('#placesReport .topic-points li').count()) === 3,
  await page.textContent('#placesReport').catch(() => 'no report'));

// 3. A trip: places by city, every place with its count, the most mentioned, and the same place under two names.
await page.click('#collectionNav [data-collection="Taiwan"]');
check('a collection with places is by city', (await page.textContent('[data-lib-view="places"]')) === '📍 Places by city');
const counts = await page.$$eval('#placesReport .report-place', els => els.map(li => [li.querySelector('strong').textContent, li.querySelector('.report-count').textContent]));
check('every place says how many sources name it', counts.length === 6 && counts.every(([, c]) => /^\d+ sources?$/.test(c)) && counts.find(([n]) => n === 'Din Tai Fung')[1] === '2 sources', JSON.stringify(counts));
check('the most-mentioned places are shown first', /Most mentioned\s*Din Tai Fung 2/.test(await page.textContent('#placesReport .report-top')));
await page.click('#placesReport [data-action="same-places"]');
await waitFor(async () => await page.isVisible('#sameBox'));
check('✦ Find the same places shows what it would merge first', /Raohe Night Market[\s\S]*Raohe Night Market · Raohe Street Night Market/.test(await page.textContent('#sameBox')) &&
  /Chiang Kai-shek Memorial Hall/.test(await page.textContent('#sameBox')) && (await page.locator('#placesReport .report-place').count()) === 6);
await page.click('[data-same="1"]');   // not this one
await page.click('[data-action="same-merge"]');
const after = await page.$$eval('#placesReport .report-place', els => els.map(li => [li.querySelector('strong').textContent, li.querySelector('.report-count').textContent]));
check('merging the ticked ones counts each as one place, with all its sources', after.length === 5 && JSON.stringify(after.find(([n]) => n === 'Raohe Night Market')) === '["Raohe Night Market","2 sources"]',
  JSON.stringify(after));
const raohe = page.locator('#placesReport .report-place', { has: page.locator('strong', { hasText: 'Raohe Night Market' }) });
check('… it says what else it was called, and can be separated again', /Also called: Raohe Street Night Market/.test(await raohe.textContent()));
check('the merge is saved', await waitFor(async () => Object.values((await library()).state.placeAliases || {}).includes('Raohe Night Market')));
await raohe.locator('[data-action="separate-place"]').click();
check('Separate lists them apart again', (await page.locator('#placesReport .report-place').count()) === 6);

// 4. A new collection is set up as soon as it is made; Ask's border can be seen.
page.removeAllListeners('dialog');
page.once('dialog', d => d.accept('Japan trip'));
await page.click('#newCollection');
await page.waitForSelector('#collectionDialog[open]');
check('a new collection asks what it is for right away', /Japan trip/.test(await page.textContent('#collHeading')));
await page.click('[data-coll-kind="trip"]');
check('a trip needs no groups: by city, then kind of place', await page.isVisible('#collPlacesNote') && !(await page.isVisible('#collGroupsWrap')));
await page.click('#collectionForm button[type="submit"]');
check('… and saves', await waitFor(async () => (await library()).state.collectionInfo?.['Japan trip']?.kind === 'trip'));
page.on('dialog', d => d.accept());
const border = await page.$eval('#askPanel', el => getComputedStyle(el).borderTopColor + ' ' + getComputedStyle(el).borderTopWidth);
check('Ask\'s box has a border you can see', /rgb\((1[0-9]{2}|[0-9]{1,2}), (1[0-9]{2}|[0-9]{1,2}), (1[0-9]{2}|[0-9]{1,2})\) 2px/.test(border), border);
await page.click('#collectionNav [data-collection="Credit Card Points"]');
await page.screenshot({ path: (process.env.SHOT || '/tmp/clipatlas.png').replace(/\.png$/, '-topics.png'), fullPage: true });
await page.click('#collectionNav [data-collection="Credit Card Points"]');
await page.click('[data-action="coll-setup"]');
await page.waitForSelector('#collectionDialog[open]');
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: (process.env.SHOT || '/tmp/clipatlas.png').replace(/\.png$/, '-collection-phone.png') });
const sideways = await page.evaluate(() => document.querySelector('#collectionDialog').scrollWidth > document.querySelector('#collectionDialog').clientWidth);
check('the collection dialog fits a phone screen', !sideways);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.close();
console.log(results.every(Boolean) ? 'all checks passed' : 'SOME CHECKS FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
