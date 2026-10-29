// Sharing in real browsers: a view-only link to a collection (with and without notes), a collection
// turned into a shared space, a person added by email who edits it, two people saving at once, a
// view-only person who joins through an invite link, a view-only link to the space, and stopping sharing.
// Run by hand (needs Playwright):  node tests/sharing.mjs   (screenshots go to $SHOTS or /tmp)
import { createRequire } from 'node:module';
import { memoryD1, startSite } from './site.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.env.SHOTS || '/tmp';
const env = { DB: memoryD1() };
const { server, base } = await startSite(env);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  -> ' + detail : ''}`); };
const browser = await chromium.launch();
const errors = [];
async function person(width = 1280, height = 900) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  return page;
}
const waitFor = async (page, fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };
const api = (page, path, init = {}) => page.evaluate(async ([path, init]) => { const r = await fetch('/api/' + path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...init }); return { status: r.status, json: await r.json() }; }, [path, init]);
async function signUp(page, name, email, url = base) {
  await page.goto(url);
  await page.click('#authToggle');
  await page.fill('#authDisplay', name); await page.fill('#authEmail', email); await page.fill('#authPassword', 'a-long-enough-password');
  await page.click('#authSubmit');
}
const poll = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const saved = page => waitFor(page, async () => /^Saved/.test(await page.textContent('#saveStatus')));

// Ann's library: a Taiwan collection (two TikToks and a note with her own notes), a Japan clip, and an
// itinerary with a stop from each.
const ann = await person();
await signUp(ann, 'Ann', 'ann@example.com');
await ann.waitForSelector('#starterDialog[open]');
await ann.click('[data-starter="travel"]');
await ann.waitForTimeout(500);
const lib = await api(ann, 'library');
await ann.evaluate(async ({ state, revision }) => {
  const C = window.ClipAtlasCore, v = n => `https://www.tiktok.com/@a/video/73456789012345678${n}`;
  const night = C.createRecord({ url: v(10), title: 'Night markets', category: 'Food', collections: 'Taiwan', notes: 'Ann private tip',
    places: [{ name: 'Raohe Night Market', type: 'food', city: 'Taipei', country: 'Taiwan', note: 'pepper buns' }] });
  night.auto = { status: 'understood', summary: 'The best night markets in Taipei.', transcript: 'secret words said in the clip' };
  const day = C.createRecord({ url: v(11), title: 'Taipei in a day', collections: 'Taiwan', places: [{ name: 'Taipei 101', type: 'sightseeing', city: 'Taipei', country: 'Taiwan' }] });
  const note = C.createRecord({ kind: 'note', title: 'From Mei', body: 'Try the oyster omelet at Ningxia.', collections: 'Taiwan' });
  const tokyo = C.createRecord({ url: v(12), title: 'Tokyo ramen', collections: 'Japan', places: [{ name: 'Ichiran', type: 'food', city: 'Tokyo', country: 'Japan' }] });
  state.records = [night, day, note, tokyo];
  state.plan = [{ id: 's1', recordId: night.id, placeId: night.places[0].id, day: 1, note: 'dinner' }, { id: 's2', recordId: tokyo.id, placeId: tokyo.places[0].id, day: 4, note: '' }];
  state.tripTitle = 'Spring trip'; state.dayCount = 5; state.dayCities = { 1: ['Taipei'] };
  await fetch('/api/library', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, revision }) });
}, lib.json);
await ann.reload();
await ann.waitForSelector('#appShell:not([hidden])');
check('no Share button until a collection is open', await ann.isHidden('#shareBtn'));
check('no shared spaces yet: the section is hidden', await ann.isHidden('#spaceNav') && await ann.isHidden('#spaceSwitch'));

// 1. A view-only link to a collection.
await ann.click('#collectionNav [data-collection="Taiwan"]');
await ann.click('#shareBtn');
await ann.waitForSelector('#shareDialog[open] [data-share="link-make"]');
check('Share opens on the collection, with a view-only link and working together', /Share “Taiwan”/.test(await ann.textContent('#shareHeading')) &&
  /3 items/.test(await ann.textContent('#shareBody')) && await ann.isVisible('[data-share="to-space"]') && /2 stops|1 stop/.test(await ann.textContent('#shareBody')),
  (await ann.textContent('#shareBody')).slice(0, 300));
await ann.locator('#shareDialog').screenshot({ path: SHOTS + '/share-collection.png' });
await ann.click('[data-share="link-make"]');
await ann.waitForSelector('#shareBody .share-link input');
const viewUrl = await ann.inputValue('#shareBody .share-link input');
check('the link is a page on the site', /^http:\/\/localhost:\d+\/s\/[a-f0-9]{32}$/.test(viewUrl), viewUrl);
const visitor = await person(390, 844);
await visitor.goto(viewUrl);
await visitor.waitForSelector('.v-head h1');
const viewText = await visitor.textContent('#viewMain');
check('anyone with the link sees the collection, read-only', (await visitor.textContent('.v-head h1')) === 'Taiwan' && /Shared by Ann/.test(viewText) &&
  /3 saved items/.test(viewText) && /The best night markets in Taipei/.test(viewText) && /Try the oyster|From Mei/.test(viewText), viewText.slice(0, 300));
check('… without notes, transcripts or the note\'s text', !/Ann private tip|secret words|oyster omelet/.test(await visitor.content()));
check('… and the page title says what it is', (await visitor.title()) === 'Taiwan · shared by Ann', await visitor.title());
await visitor.screenshot({ path: SHOTS + '/view-phone.png', fullPage: true });
await visitor.click('.v-tabs [data-tab="places"]');
check('Places by city on the shared page', /Raohe Night Market/.test(await visitor.textContent('#panel-places')) && await visitor.isHidden('#panel-items'));
await ann.check('#shareBody [data-share="notes"]');
await ann.waitForTimeout(400);
await visitor.reload(); await visitor.waitForSelector('.v-head h1');
check('ticking Include my notes shows them on the same link', /Ann private tip/.test(await visitor.textContent('#viewMain')) && /oyster omelet/.test(await visitor.textContent('#viewMain')));

// 2. Working together: the collection moves into a shared space.
await ann.click('[data-share="to-space"]');
await ann.waitForSelector('#spaceBar:not([hidden])');
await ann.waitForSelector('#shareDialog[open] .share-people');
check('Share with people makes a shared space and opens it', /Taiwan/.test(await ann.textContent('#spaceBar')) && /yours/.test(await ann.textContent('#spaceBar')) &&
  /Ann \(you\)/.test(await ann.textContent('.share-people')) && (await ann.textContent('#crumbRoot')) === 'SHARED SPACE');
const annLib = (await api(ann, 'library')).json.state;
check('… taking the collection and its itinerary stop out of Ann\'s library', !annLib.collections.includes('Taiwan') && annLib.records.map(r => r.title).join() === 'Tokyo ramen' &&
  annLib.plan.map(p => p.id).join() === 's2', JSON.stringify([annLib.collections, annLib.records.map(r => r.title), annLib.plan.map(p => p.id)]));
const spaceList = (await api(ann, 'spaces')).json.spaces;
check('… into the space, with its research, items and stop', spaceList.length === 1 && spaceList[0].role === 'owner');
const spaceId = spaceList[0].id;
const ben = await person();
await signUp(ben, 'Ben', 'ben@example.com');
await ben.waitForSelector('#starterDialog[open]');
await ben.click('[data-starter="travel"]');
await ann.fill('#shareEmail', 'nobody@example.com'); await ann.click('#shareAdd [type="submit"]');
await waitFor(ann, async () => /invite link/.test(await ann.textContent('#shareError')));
check('an email with no account says to send an invite link', /No ClipAtlas account uses that email/.test(await ann.textContent('#shareError')));
await ann.fill('#shareEmail', 'ben@example.com'); await ann.selectOption('#shareRole', 'edit'); await ann.click('#shareAdd [type="submit"]');
await waitFor(ann, async () => /Ben/.test(await ann.textContent('.share-people')));
check('adding Ben by email lists him as Can edit', /Ben/.test(await ann.textContent('.share-people')) && (await ann.locator('.share-people select').inputValue()) === 'edit');
await ann.selectOption('#inviteRole', 'view'); await ann.click('[data-share="invite-make"]');
await waitFor(ann, async () => (await ann.locator('#shareBody input[aria-label="Invite link"]').count()) === 1);
const inviteUrl = await ann.inputValue('#shareBody input[aria-label="Invite link"]');
check('an invite link (Can view) is made', /\/join\/[a-f0-9]{32}$/.test(inviteUrl) && /Can view/.test(await ann.textContent('#shareBody')));
await ann.locator('#shareDialog').screenshot({ path: SHOTS + '/share-space.png' });
await visitor.reload(); await visitor.waitForSelector('.v-head h1');
check('the collection\'s view-only link keeps working, now showing the shared space', /Shared collection/.test(await visitor.textContent('.v-kicker')) &&
  (await visitor.textContent('.v-head h1')) === 'Taiwan');
await ann.click('#shareClose');

// 3. Ben opens it and edits; Ann sees it.
await ben.reload(); await ben.waitForSelector('#appShell:not([hidden])');
await ben.waitForSelector(`#spaceNav [data-space="${spaceId}"]`);
check('Ben sees the space under Shared spaces, marked new until he opens it', /Taiwan/.test(await ben.textContent('#spaceNav')) && /new/.test(await ben.textContent('#spaceNav')));
await ben.click(`#spaceNav [data-space="${spaceId}"]`);
await ben.waitForSelector('#spaceBar:not([hidden])');
check('… opens it: owner Ann, he can edit, its 3 items', /owner Ann/.test(await ben.textContent('#spaceBar')) && /you can edit/.test(await ben.textContent('#spaceBar')) &&
  (await ben.textContent('#statClips')) === '3');
await ben.click('.nav-link[data-tab="itinerary"]');
await ben.fill('#tripTitle', 'Taiwan 2027'); await ben.press('#tripTitle', 'Tab');
await saved(ben); await ben.waitForTimeout(300);
await ann.click('.nav-link[data-tab="itinerary"]');
await poll(ann);
await waitFor(ann, async () => (await ann.inputValue('#tripTitle')) === 'Taiwan 2027');
check('Ann sees Ben\'s change without reloading', (await ann.inputValue('#tripTitle')) === 'Taiwan 2027', await ann.inputValue('#tripTitle'));

// 4. Both save at once: Ben changes the days while Ann (who has not seen it yet) changes the name.
await ben.fill('#dayCount', '6'); await ben.press('#dayCount', 'Tab');
await saved(ben); await ben.waitForTimeout(300);
await ann.fill('#tripTitle', 'Taiwan in April'); await ann.press('#tripTitle', 'Tab');
await saved(ann); await ann.waitForTimeout(300);
const both = (await api(ann, 'spaces/' + spaceId)).json.state;
check('two people saving at once keep both changes', both.tripTitle === 'Taiwan in April' && both.dayCount === 6, JSON.stringify([both.tripTitle, both.dayCount]));

// 5. Cat joins with the view-only invite link.
const cat = await person(390, 844);
await cat.goto(inviteUrl);
await cat.waitForSelector('#joinNote:not([hidden])');
check('the invite link says who it is from before signing in', /Ann invited you to “Taiwan” \(you can view it\)/.test(await cat.textContent('#joinNote')), await cat.textContent('#joinNote'));
await cat.screenshot({ path: SHOTS + '/join-phone.png' });
await cat.click('#authToggle');
await cat.fill('#authDisplay', 'Cat'); await cat.fill('#authEmail', 'cat@example.com'); await cat.fill('#authPassword', 'a-long-enough-password');
await cat.click('#authSubmit');
await cat.waitForSelector('#starterDialog[open]');
await cat.click('[data-starter="travel"]');
await waitFor(cat, async () => await cat.isVisible('#spaceBar'));
check('Cat joins and lands in the space, view only', /you can view it/.test(await cat.textContent('#spaceBar')) && new URL(cat.url()).pathname === '/' &&
  await cat.evaluate(() => document.body.classList.contains('readonly')) && await cat.isHidden('#addButton'));
check('… the phone switcher shows the space', (await cat.locator('#spaceSwitch option:checked').textContent()).includes('Taiwan'));
await cat.screenshot({ path: SHOTS + '/space-phone.png' });
const catTry = await api(cat, 'spaces/' + spaceId, { method: 'PUT', body: JSON.stringify({ state: both, revision: 99 }) });
check('a view-only person cannot save', catTry.status === 403);

// 6. A view-only link to the whole space shows its itinerary.
await ann.click('#spaceBar [data-share-open]');
await ann.waitForSelector('#shareDialog[open] .share-people');
check('the owner sees everyone', /Ann \(you\)[\s\S]*Ben[\s\S]*Cat/.test(await ann.textContent('.share-people')));
check('… and earlier versions to bring back', (await ann.locator('.share-versions li').count()) >= 1 && await ann.isVisible('[data-share="restore"]'));
await ann.waitForSelector('#shareBody input[aria-label^="View-only link"]');
const spaceView = await ann.inputValue('#shareBody input[aria-label^="View-only link"]');
check('the space\'s view-only link is the collection\'s old one', spaceView === viewUrl, spaceView);
await visitor.goto(spaceView); await visitor.waitForSelector('.v-head h1');
check('the space\'s view-only page has its itinerary', await visitor.isVisible('.v-tabs [data-tab="plan"]'));
await visitor.click('.v-tabs [data-tab="plan"]');
check('… day by day', /Day 1 · Taipei/.test(await visitor.textContent('#panel-plan')) && /Raohe Night Market/.test(await visitor.textContent('#panel-plan')));
await visitor.setViewportSize({ width: 1280, height: 900 }); await visitor.screenshot({ path: SHOTS + '/view-desktop.png', fullPage: true });

// 7. Stop sharing: everything goes back to Ann's library, and Ben is told.
await ann.click('#shareBody [data-share="stop"]');
await ann.waitForSelector('#spaceBar', { state: 'hidden' });
await saved(ann);
const back = (await api(ann, 'library')).json.state;
check('stopping sharing brings Taiwan back into Ann\'s library, with the trip', back.collections.includes('Taiwan') && back.records.length === 4 && back.plan.length === 2,
  JSON.stringify([back.collections, back.records.length, back.plan.length]));
check('… and the space is gone', (await api(ann, 'spaces')).json.spaces.length === 0 && (await api(ann, 'spaces/' + spaceId)).status === 404);
await poll(ben);
await waitFor(ben, async () => await ben.isHidden('#spaceBar'));
check('Ben is moved back to his own library and told', await ben.isHidden('#spaceBar') && /no longer in it|removed/.test(await ben.textContent('#toast')), await ben.textContent('#toast'));
await visitor.goto(spaceView); await visitor.waitForSelector('.v-error');
check('the space\'s view-only link is off', /turned off/.test(await visitor.textContent('.v-error')));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close(); server.close();
const failed = results.filter(x => !x).length;
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
