// The Itinerary in a real browser: how many days, the city or cities of each
// day, "+ Plan" going to the day set to the clip's city, and the By city view
// (every saved clip by city, then by category, with a day picker on each).
// Run by hand (needs Playwright and Chromium):  node tests/itinerary.mjs
import fs from 'node:fs';
import { createRequire } from 'node:module';
import worker from '../src/worker.js';
import { memoryD1, startSite } from './site.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const env = { DB: memoryD1(), ASSETS: { fetch: async () => new Response('not used') } };
const { server, base } = await startSite(env);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  -> ' + detail : ''}`); };

async function api(path, method, body, cookie) {
  return worker.fetch(new Request(base + 'api/' + path, { method, body: body && JSON.stringify(body),
    headers: { origin: base.replace(/\/$/, ''), 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }), env);
}
const reg = await api('register', 'POST', { email: 'trip@example.com', password: 'a-long-enough-password', displayName: 'Trip' });
const cookie = reg.headers.get('set-cookie').split(';')[0];
let n = 10;
const clip = (title, category, city, extra = {}) => {
  const id = String(7000000000000000000n + BigInt(n++));
  return { id: 'r' + n, key: 'tiktok:' + id, url: `https://www.tiktok.com/@a/video/${id}`, videoId: id, title, category, city,
    country: city ? 'Taiwan' : '', place: '', collections: [], tags: [], status: 'reviewed', savedAt: `2026-10-${String(n).padStart(2, '0')}`,
    createdAt: '2026-10-01', updatedAt: '2026-10-01', ...extra };
};
const records = [
  clip('Beef noodles at Lin Dong Fang', 'Taiwan · Food', 'Taipei', { place: 'Lin Dong Fang' }),
  clip('Raohe night market', 'Taiwan · Food', 'Taipei'),
  clip('Ximending shopping street', 'Taiwan · Shopping', 'Taipei'),
  clip('Taipei 101 at sunset', 'Taiwan · Activities', 'Taipei'),
  clip('Din Tai Fung original', 'Taiwan · Food', 'taipei '),        // the same city, written differently
  clip('Tainan breakfast crawl', 'Taiwan · Food', 'Tainan'),
  clip('Anping old fort', 'Taiwan · Activities', 'Tainan'),
  clip('Airport tips', 'Travel tips', '', { country: 'Taiwan' }),   // in Taiwan, no city
];
const categories = [
  { id: 'c1', name: 'Taiwan · Food', emoji: '🍜', words: [] }, { id: 'c2', name: 'Taiwan · Shopping', emoji: '🛍️', words: [] },
  { id: 'c3', name: 'Taiwan · Activities', emoji: '🏮', words: [] }, { id: 'c4', name: 'Travel tips', emoji: '🧳', words: [] }];
await api('library', 'PUT', { revision: 0, state: { version: 1, collections: [], tripTitle: 'Taiwan', dayCount: 7, records, categories,
  settings: { purpose: 'travel', tabs: { itinerary: true } }, plan: [{ id: 'stop-old', recordId: records[3].id, day: 1, note: '' }] } }, cookie);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
await page.addInitScript(() => { window.__csp = [];
  document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
await page.goto(base);
await page.fill('#authEmail', 'trip@example.com'); await page.fill('#authPassword', 'a-long-enough-password');
await page.click('#authSubmit'); await page.waitForSelector('#appShell:not([hidden])');
await page.click('.nav-link[data-tab="itinerary"]');

// How many days: any number from 1 to 30.
await page.fill('#dayCount', '3'); await page.press('#dayCount', 'Tab');
check('the number of days can be typed in', (await page.$$('#itineraryDays .day-panel')).length === 3);
await page.fill('#dayCount', '45'); await page.press('#dayCount', 'Tab');
check('at most 30 days', (await page.$$('#itineraryDays .day-panel')).length === 30 && await page.inputValue('#dayCount') === '30');
await page.fill('#dayCount', '3'); await page.press('#dayCount', 'Tab');

// A city or several for each day: picked from the cities of the saved clips, or typed.
const options = await page.$$eval('#cityOptions option', els => els.map(o => o.value));
check('the city list comes from the saved clips, most first, one entry per city', JSON.stringify(options) === '["Taipei","Tainan"]', JSON.stringify(options));
const addCity = async (day, name) => { await page.fill(`[data-day-city="${day}"]`, name); await page.press(`[data-day-city="${day}"]`, 'Enter'); };
await addCity(1, 'Taipei'); await addCity(2, 'Tainan'); await addCity(3, 'Taipei'); await addCity(3, 'Jiufen'); await addCity(3, 'taipei');
const chips = await page.$$eval('#itineraryDays .day-panel', els => els.map(e => [...e.querySelectorAll('.city-chip')].map(c => c.firstChild.textContent)));
check('each day shows its cities (a day can have several, each once)', JSON.stringify(chips) === '[["Taipei"],["Tainan"],["Taipei","Jiufen"]]', JSON.stringify(chips));
const waiting = await page.textContent('#itineraryDays .day-panel:first-child .day-more');
check('a day says how many saved clips in its city are not planned yet', /^4 saved in Taipei not planned yet/.test(waiting), waiting);
await page.click('#itineraryDays .day-panel:nth-child(3) [data-action="day-city-remove"][data-city="Jiufen"]');
check('a city can be taken off a day', JSON.stringify(await page.$$eval('#itineraryDays .day-panel:nth-child(3) .city-chip', els => els.map(c => c.firstChild.textContent))) === '["Taipei"]');

// By city: everything saved, by city, then by category, separate from the days.
await page.click('#itineraryDays .day-panel:first-child [data-action="show-city"]');
check('"Show them" opens By city', await page.isVisible('#itineraryCities') && !(await page.isVisible('#itineraryDays')));
const board = await page.$$eval('#itineraryCities .city-panel', els => els.map(p => ({ city: p.querySelector('.city-name').textContent, about: p.querySelector('summary small').textContent,
  groups: [...p.querySelectorAll('.city-group')].map(g => [g.querySelector('h4').textContent.replace(/\s+/g, ' ').trim(), [...g.querySelectorAll('.city-item strong')].map(s => s.textContent)]) })));
check('cities with the most clips first, the clips with no city last', JSON.stringify(board.map(b => b.city)) === '["📍 Taipei","📍 Tainan","City not known yet"]', JSON.stringify(board.map(b => b.city)));
check('a city says its country, how many are saved and planned, and its days', board[0].about === 'Taiwan · 5 saved · 1 planned · Day 1, 3', board[0].about);
check('inside a city: food, then shops, then activities (the category order), each clip once',
  JSON.stringify(board[0].groups) === JSON.stringify([['🍜 Taiwan · Food 3', ['Din Tai Fung original', 'Raohe night market', 'Beef noodles at Lin Dong Fang']],
    ['🛍️ Taiwan · Shopping 1', ['Ximending shopping street']], ['🏮 Taiwan · Activities 1', ['Taipei 101 at sunset']]]), JSON.stringify(board[0].groups));
check('the clips with no city say how to place them', await page.isVisible('.city-unknown') && !(await page.$eval('.city-unknown', d => d.open)));
const planned = await page.$eval(`[data-city-plan="${records[3].id}"]`, s => s.selectedOptions[0].textContent);
check('a planned clip shows its day', planned === 'Day 1 · Taipei', planned);
await page.selectOption(`[data-city-plan="${records[0].id}"]`, '3');
await page.selectOption(`[data-city-plan="${records[5].id}"]`, '2');
await page.selectOption(`[data-city-plan="${records[3].id}"]`, '0');
await page.click('[data-itinerary-view="days"]');
const stops = await page.$$eval('#itineraryDays .day-panel', els => els.map(e => [...e.querySelectorAll('.stop h4')].map(h => h.textContent)));
check('picking a day in By city plans it there; "Not planned" takes it off', JSON.stringify(stops) === JSON.stringify([[], ['Tainan breakfast crawl'], ['Beef noodles at Lin Dong Fang']]), JSON.stringify(stops));

// "+ Plan" in Discoveries goes to the first day set to the clip's city.
await page.click('.nav-link[data-tab="library"]');
const card = page.locator('#clipGrid .clip-card', { has: page.locator('h3', { hasText: 'Anping old fort' }) });
await card.locator('[data-action="plan"]').click();
check('"+ Plan" puts a Tainan clip on the Tainan day', /^Added to Day 2 · Tainan/.test(await page.textContent('#toast')), await page.textContent('#toast'));
const other = page.locator('#clipGrid .clip-card', { has: page.locator('h3', { hasText: 'Airport tips' }) });
await other.locator('[data-action="plan"]').click();
check('a clip with no city still goes to day 1', /^Added to Day 1 · Taipei/.test(await page.textContent('#toast')), await page.textContent('#toast'));
await page.click('.nav-link[data-tab="itinerary"]');

// The export names each day's cities.
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportPlan')]);
const md = fs.readFileSync(await download.path(), 'utf8');
check('the exported plan names each day\'s cities', /## Day 1 · Taipei\n\n1\. \*\*Airport tips\*\*/.test(md) && /## Day 2 · Tainan\n/.test(md) && /## Day 3 · Taipei\n/.test(md), md.slice(0, 300));

// Fewer days: later stops move to the last day, later cities are cleared (after a confirm).
await page.fill('#dayCount', '2'); await page.press('#dayCount', 'Tab');
const after = await page.$$eval('#itineraryDays .day-panel', els => els.map(e => [[...e.querySelectorAll('.city-chip')].map(c => c.firstChild.textContent), e.querySelectorAll('.stop').length]));
check('going down to 2 days keeps every stop and clears day 3\'s city', JSON.stringify(after) === '[[["Taipei"],1],[["Tainan"],3]]', JSON.stringify(after));
const away = await page.$$eval('#itineraryDays .stop-away', els => els.map(e => e.closest('.stop').querySelector('h4').textContent + ': ' + e.textContent));
check('a stop in another city than its day\'s says so', JSON.stringify(away) === '["Beef noodles at Lin Dong Fang: not in Tainan"]', JSON.stringify(away));

// Overview: what the Taiwan clips add up to, days per city, and Fill the days (with Undo).
await page.click('[data-itinerary-view="overview"]');
const sum = await page.textContent('.overview-sum');
check('the overview sums up the country\'s clips', /^8 clips in 2 cities/.test(sum) && /🍜 4 Food · 🛍️ 1 Shopping · 🏮 2 Activities · 🧳 1 Travel tips/.test(sum), sum);
check('it names the country and says what has no city yet', /Taiwan \(8\)/.test(await page.textContent('#tripCountry')) &&
  /^1 clip has no city yet/.test(await page.textContent('.overview-note')), await page.textContent('.overview-note'));
const cityRows = () => page.$$eval('.trip-city', els => els.map(e => [e.querySelector('h3').firstChild.textContent.trim(), e.querySelector('[data-trip-days]').value]));
check('each city with its days, taken from the days already set', JSON.stringify(await cityRows()) === '[["📍 Taipei","1"],["📍 Tainan","1"]]', JSON.stringify(await cityRows()));
const places = await page.$$eval('.trip-city:first-child .trip-places .chip', els => els.map(e => e.textContent));
check('a city lists its named places', JSON.stringify(places) === '["Lin Dong Fang"]', JSON.stringify(places));
await page.uncheck('[data-trip-include="Travel tips"]');
await page.click('.trip-city:nth-child(2) [data-action="trip-move"][data-step="-1"]');
await page.fill('[data-trip-days="Taipei"]', '2'); await page.press('[data-trip-days="Taipei"]', 'Tab');
check('days and order can be changed, and it says what the trip becomes', JSON.stringify(await cityRows()) === '[["📍 Tainan","1"],["📍 Taipei","2"]]' &&
  /3 days · Tainan 1 → Taipei 2The trip becomes 3 days\./.test(await page.textContent('.overview-foot')), await page.textContent('.overview-foot'));
const before = await page.$$eval('#itineraryDays .day-panel', els => els.map(e => e.querySelectorAll('.stop').length));
await page.click('[data-action="trip-fill"]');
await page.waitForSelector('#itineraryDays:not([hidden])');
const filled = await page.$$eval('#itineraryDays .day-panel', els => els.map(e => [[...e.querySelectorAll('.city-chip')].map(c => c.firstChild.textContent).join(),
  [...e.querySelectorAll('.stop h4')].map(h => h.textContent)]));
check('Fill the days: each city on its days, its clips spread with a mix, named places first', JSON.stringify(filled) === JSON.stringify([
  ['Tainan', ['Tainan breakfast crawl', 'Anping old fort']],
  ['Taipei', ['Beef noodles at Lin Dong Fang', 'Taipei 101 at sunset', 'Raohe night market']],
  ['Taipei', ['Ximending shopping street', 'Din Tai Fung original']]]), JSON.stringify(filled));
check('it says what it did and offers Undo', /^Filled 3 days with 7 stops\./.test(await page.textContent('#toast')) && await page.isVisible('#toast .toast-action'),
  await page.textContent('#toast'));
await page.click('#toast .toast-action');
const undone = await page.$$eval('#itineraryDays .day-panel', els => els.map(e => e.querySelectorAll('.stop').length));
check('Undo puts the days back as they were', JSON.stringify(undone) === JSON.stringify(before) && await page.inputValue('#dayCount') === '2', JSON.stringify([before, undone]));
await page.click('[data-itinerary-view="overview"]');
await page.screenshot({ path: '/tmp/clipatlas-itinerary-overview.png', fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
const wideOverview = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('the overview fits a phone screen', !wideOverview);
await page.screenshot({ path: '/tmp/clipatlas-itinerary-overview-phone.png', fullPage: true });
await page.setViewportSize({ width: 1280, height: 900 });
await page.click('[data-itinerary-view="days"]');

// Saved to the account: the cities are still there after a reload.
await page.waitForTimeout(500);   // the save starts a moment after a change
await page.waitForFunction(() => /Saved to your account/.test(document.getElementById('saveStatus').textContent));
await page.reload(); await page.waitForSelector('#appShell:not([hidden])');
await page.click('.nav-link[data-tab="itinerary"]');
const kept = [await page.inputValue('#dayCount'), await page.$$eval('#itineraryDays .city-chip', els => els.map(c => c.firstChild.textContent))];
check('days and their cities survive a reload', JSON.stringify(kept) === '["2",["Taipei","Tainan"]]', JSON.stringify(kept));
await page.screenshot({ path: '/tmp/clipatlas-itinerary-days.png', fullPage: true });
await page.click('[data-itinerary-view="cities"]');
await page.screenshot({ path: '/tmp/clipatlas-itinerary-cities.png', fullPage: true });

// A phone: nothing wider than the screen, in either view.
await page.setViewportSize({ width: 390, height: 844 });
const wide = async () => page.evaluate(() => { if (document.documentElement.scrollWidth <= window.innerWidth + 1) return false;
  const over = [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && e.offsetParent)
    .slice(0, 6).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right));
  return document.documentElement.scrollWidth + ' ' + over.join(', '); });
const wideCities = await wide(); check('By city fits a phone screen', !wideCities, String(wideCities));
await page.screenshot({ path: '/tmp/clipatlas-itinerary-cities-phone.png', fullPage: true });
await page.click('[data-itinerary-view="days"]');
const wideDays = await wide(); check('Days fit a phone screen', !wideDays, String(wideDays));
await page.screenshot({ path: '/tmp/clipatlas-itinerary-days-phone.png', fullPage: true });
check('no CSP problems and no page errors', (await page.evaluate(() => window.__csp)).length === 0 && errors.length === 0,
  JSON.stringify(await page.evaluate(() => window.__csp)) + ' ' + errors.join(' | '));

await browser.close();
server.close();
console.log(results.every(Boolean) ? 'all checks passed' : 'SOME CHECKS FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
