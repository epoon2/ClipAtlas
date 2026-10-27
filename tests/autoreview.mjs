// Auto-review in a real browser: the page shares its own tab, plays each clip
// in a stand-in for TikTok's player (it makes a sound and shows text), records
// the sound, takes screenshots and sends them to /api/understand, where Workers
// AI is replaced by a fake that checks what it was sent.
//
// Tab sharing needs a headed browser, so run it under a virtual screen:
//   xvfb-run -a node tests/autoreview.mjs
// (needs Playwright and Chromium; not part of npm test).
import { createRequire } from 'node:module';
import { memoryD1, startSite } from './site.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const IDS = { noodles: '7000000000000000001', market: '7000000000000000002', gone: '7000000000000000004', slides: '7000000000000000005' };

// ---- a fake Workers AI that checks the sound and the screenshots it gets
const asked = [];
function loud(wav) {
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') return -1;
  let sum = 0, n = 0;
  for (let i = 44; i + 1 < wav.length; i += 2) { const x = wav.readInt16LE(i) / 32768; sum += x * x; n++; }
  return n ? Math.sqrt(sum / n) : 0;
}
const AI = { broken: false, async run(model, input) {
  if (model.includes('whisper')) {
    if (AI.broken) throw new Error('5006: audio not valid');
    const wav = Buffer.from(input.audio, 'base64');
    asked.push({ model, rate: wav.readUInt32LE(24), seconds: (wav.length - 44) / 2 / wav.readUInt32LE(24), loudness: loud(wav) });
    return { text: loud(wav) > 0.01 ? 'the best beef noodles in taipei' : '' };
  }
  if (/scout|vision|mistral-small/.test(model)) {   // look: plain words about one sheet of screenshots
    const image = typeof input.image === 'string' && !input.image.startsWith('data:') ? 'data:image/jpeg;base64,' + input.image : input.image;
    asked.push({ model, image, prompt: input.prompt || input.messages?.[0]?.content || '' });
    return { response: 'SHOWS: A bowl of noodles.\nTEXT: BEST BEEF NOODLES TAIPEI' };
  }
  const prompt = input.messages?.[0]?.content || '';   // decide: JSON
  asked.push({ model, decide: true, prompt, json: !!input.response_format });
  const said = !/\(nothing said\)/.test(prompt);
  return { response: JSON.stringify({ title: said ? 'Beef noodles in Taipei' : 'Taipei food slides', summary: 'A noodle shop worth the line.',
    category: 'Food', place: '', city: 'Taipei', country: 'Taiwan', tags: ['noodles', 'beef'] }) };
} };

// ---- a stand-in for TikTok's embedded player: red, with text, a tone, and the documented messages
const PLAYER = `<!doctype html><body style="margin:0;background:rgb(220,30,30);color:#fff;font:bold 30px sans-serif">
<div style="padding:60px 12px">BEST BEEF NOODLES TAIPEI</div><script>
const id = location.pathname.split('/').pop();
const post = (type, value) => parent.postMessage({ type, value, 'x-tiktok-player': true }, '*');
if (id.endsWith('4')) { post('onPlayerReady'); setTimeout(() => post('onPlayerError', { errorCode: 1001, errorType: 'INVALID_VIDEO' }), 300); }
else if (id.endsWith('5')) {
  // A slideshow of four slides, each its own color; it moves only when asked (navigateTo), as the documents describe.
  const colors = ['rgb(30,60,220)', 'rgb(30,170,60)', 'rgb(240,150,20)', 'rgb(150,40,190)'];
  const show = i => { document.body.style.background = colors[i]; document.querySelector('div').textContent = 'SLIDE ' + (i + 1); };
  show(0);
  addEventListener('message', e => {
    const d = e.data; if (!d || d['x-tiktok-player'] !== true || d.type !== 'navigateTo') return;
    const i = Number(d.value); if (!(i >= 0 && i < colors.length)) return;
    show(i); post('onImageChange', i);
  });
  post('onPlayerReady');
}
else {
  let t = 0, timer = null, osc = null; const duration = 3;
  addEventListener('message', e => {
    const d = e.data; if (!d || d['x-tiktok-player'] !== true) return;
    if (d.type === 'play' && !timer) {
      const ctx = new AudioContext(); osc = ctx.createOscillator(); osc.frequency.value = 330; osc.connect(ctx.destination); osc.start();
      post('onStateChange', 1);
      timer = setInterval(() => { t += 0.25; post('onCurrentTime', { currentTime: t, duration });
        if (t >= duration) { clearInterval(timer); osc.stop(); post('onStateChange', 0); } }, 250);
    }
    if (d.type === 'pause') { clearInterval(timer); try { osc && osc.stop(); } catch (_) {} }
  });
  post('onPlayerReady');
}
</script>`;

const env = { DB: memoryD1(), AI, ASSETS: { fetch: async () => new Response('not used') } };
const { server, base } = await startSite(env);
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  -> ' + detail : ''}`); };

const browser = await chromium.launch({ channel: 'chromium', headless: false,
  args: ['--auto-accept-this-tab-capture', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('https://www.tiktok.com/**', route => route.fulfill({ contentType: 'text/html', body: PLAYER }));
await page.addInitScript(() => { window.__csp = [];
  document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });

await page.goto(base);
await page.click('#authToggle');
await page.fill('#authDisplay', 'Tester'); await page.fill('#authEmail', 'auto@example.com'); await page.fill('#authPassword', 'a-long-enough-password');
await page.click('#authSubmit');
await page.waitForSelector('#starterDialog[open]');
await page.click('[data-starter="travel"]');
await page.click('[data-tab="import"]');
await page.fill('#bulkLinks', [`https://www.tiktokv.com/share/video/${IDS.noodles}/`, `https://www.tiktok.com/@someone/video/${IDS.market}`,
  `https://www.tiktokv.com/share/video/${IDS.gone}/`, `https://www.tiktok.com/@someone/photo/${IDS.slides}`, 'https://vm.tiktok.com/ZMabc123/'].join('\n'));
await page.click('#bulkImport');
await page.click('.nav-link[data-tab="library"]');

await page.click('#startAuto');
await page.waitForSelector('#autoDialog[open]');
const estimate = await page.textContent('#autoEstimate');
check('the setup says how many clips and leaves out the short link', /^4 clips/.test(estimate) && /1 short link \(vm\.tiktok\.com\) cannot play here and is left out/.test(estimate), estimate);
await page.screenshot({ path: (process.env.SHOT || '/tmp/clipatlas-auto.png').replace(/\.png$/, '-setup.png') });

// The setup check: each step once, with the service's own error when one fails.
await page.click('#aiCheckBtn');
await page.waitForFunction(() => !document.getElementById('aiCheckBtn').disabled && /Listen/.test(document.getElementById('aiCheckOut').textContent));
const good = await page.$$eval('#aiCheckOut li', els => els.map(e => e.textContent));
check('Check the AI setup passes every step', good.length === 3 && good.every(t => t.startsWith('✓')), good.join(' | '));
AI.broken = true;
await page.click('#aiCheckBtn');
await page.waitForFunction(() => !document.getElementById('aiCheckBtn').disabled && /Listen/.test(document.getElementById('aiCheckOut').textContent));
const bad = await page.$$eval('#aiCheckOut li', els => els.map(e => e.textContent));
check('and shows the real error of a step that fails', /^✗ Listen.*listen: 5006: audio not valid/.test(bad[0]) && bad[1].startsWith('✓'), bad.join(' | '));
AI.broken = false;
asked.length = 0;

await page.selectOption('#autoCap', '30');
await page.click('#autoStart');
await page.waitForFunction(() => /^(Done|Stopped|Auto-review stopped|Three)/.test(document.getElementById('autoNow').textContent), null, { timeout: 90000 });
const summary = await page.textContent('#autoNow');
check('the run finishes and says what happened', /^Done\. 3 filled in, 0 nothing heard or seen, 1 would not play, 0 failed\./.test(summary), summary);
await page.screenshot({ path: process.env.SHOT || '/tmp/clipatlas-auto.png' });

const heard = asked.filter(a => a.model.includes('whisper')), seen = asked.filter(a => a.image), decided = asked.filter(a => a.decide);
check('the sound of both videos was recorded and sent as 16 kHz WAV (the silent slideshow sent none)',
  heard.length === 2 && heard.every(a => a.rate === 16000 && a.seconds > 1.5 && a.loudness > 0.01),
  JSON.stringify(heard.map(a => ({ s: a.seconds.toFixed(1), l: a.loudness.toFixed(3) }))));
check('each clip was decided once, in JSON mode, from the transcript, what was seen and the categories', decided.length === 3 &&
  decided.every(a => a.json && /BEST BEEF NOODLES TAIPEI/.test(a.prompt) && /- Food:/.test(a.prompt)) &&
  decided.filter(a => /best beef noodles/.test(a.prompt)).length === 2);

// What each sheet of screenshots shows: one color per panel, read from the middle of each 360-wide panel.
const sheets = await page.evaluate(async urls => Promise.all(urls.map(url => new Promise(res => {
  const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    res({ w: img.width, h: img.height, panels: Array.from({ length: Math.round(img.width / 360) }, (_, j) => [...g.getImageData(j * 360 + 180, 600, 1, 1).data.slice(0, 3)]) }); };
  img.src = url; }))), seen.map(a => a.image));
const red = ([r, g, b]) => r > 150 && g < 90 && b < 90;
const videoSheets = sheets.filter(s => s.panels.every(red)), slideSheets = sheets.filter(s => !s.panels.some(red));
check('video screenshots show the player itself', videoSheets.length === 2 && videoSheets.every(s => s.h === 640 && s.w >= 360), JSON.stringify(videoSheets));
const slideColors = slideSheets.flatMap(s => s.panels.map(([r, g, b]) => r > 200 ? 'orange' : b > 150 && r < 90 ? 'blue' : g > 120 ? 'green' : 'purple'));
check('every slide of the slideshow was screenshotted, in order, on two sheets', slideSheets.length === 2 &&
  JSON.stringify(slideColors) === JSON.stringify(['blue', 'green', 'orange', 'purple']), JSON.stringify(slideSheets.map(s => s.panels)));

await page.click('#autoClose');
await page.selectOption('#statusFilter', 'auto');
const cards = await page.$$eval('#clipGrid .clip-card', els => els.map(e => ({ title: e.querySelector('h3').textContent,
  category: e.querySelector('.category').textContent, badge: e.querySelector('.analysis-badge')?.textContent || '',
  where: e.querySelector('.location').textContent })));
check('all three are filled in, sorted and marked Auto-reviewed', cards.length === 3 &&
  cards.every(c => c.category === 'Food' && /Auto-reviewed/.test(c.badge) && /Taipei · Taiwan/.test(c.where)) &&
  cards.filter(c => c.title === 'Beef noodles in Taipei').length === 2 && cards.some(c => c.title === 'Taipei food slides'),
  JSON.stringify(cards));
await page.selectOption('#statusFilter', 'all');
await page.fill('#search', 'noodles in taipei');  // only in what was said
check('what was said is searchable', (await page.$$('#clipGrid .clip-card')).length === 2);
await page.fill('#search', '');
const gone = await page.$$eval('#clipGrid .clip-card', els => els.map(e => e.querySelector('.analysis-badge')?.textContent || '').filter(t => /play/.test(t)));
check('the clip that would not play says so and still needs review', gone.length === 1 && (await page.textContent('#statReview')).trim() === '2',
  gone.join(',') + ' / needs review ' + (await page.textContent('#statReview')));

await page.waitForFunction(() => /Saved to your account/.test(document.getElementById('saveStatus').textContent));
await page.reload(); await page.waitForSelector('#appShell:not([hidden])');
await page.selectOption('#statusFilter', 'auto');
check('auto-review results survive a reload', (await page.$$('#clipGrid .clip-card')).length === 3);

// Checking one in Review mode takes its Auto-reviewed badge off.
const id = await page.locator('#clipGrid .clip-card', { has: page.locator('h3', { hasText: 'Beef noodles in Taipei' }) }).first()
  .locator('[data-action="watch"]').getAttribute('data-id');
await page.click(`#clipGrid [data-action="watch"][data-id="${id}"]`);
await page.waitForSelector('#reviewDialog[open]');
check('Review shows what was said and the text on the video', await page.isVisible('#reviewHeard')
  && (await page.textContent('#reviewTranscript')) === 'the best beef noodles in taipei'
  && (await page.textContent('#reviewSeen')) === 'BEST BEEF NOODLES TAIPEI', await page.textContent('#reviewHeard'));
await page.press('#reviewForm [name="title"]', 'Enter');
await page.click('#reviewClose');
check('a clip checked in Review mode loses the Auto-reviewed badge', (await page.$$('#clipGrid .clip-card')).length === 2);

// Starting again offers only what is left.
await page.click('#startAuto');
check('a second run offers no clip twice', /^No clips to auto-review/.test(await page.textContent('#autoEstimate')) || /^1 clip/.test(await page.textContent('#autoEstimate')),
  await page.textContent('#autoEstimate'));

// Transcript only, redoing everything: sound only, no screenshots read, details kept.
const visionBefore = asked.filter(a => a.image).length, heardBefore = asked.filter(a => a.model.includes('whisper')).length;
await page.selectOption('#autoMode', 'transcript');
check('transcript only hides "mark reviewed"', !(await page.isVisible('#autoMarkWrap')));
await page.check('#autoRedo');
await page.selectOption('#autoScope', 'all');
await page.selectOption('#autoCap', '180');
await page.click('#autoStart');
await page.waitForFunction(() => /^(Done|Stopped|Auto-review stopped|Three)/.test(document.getElementById('autoNow').textContent), null, { timeout: 90000 });
const second = await page.textContent('#autoNow');
check('a transcript-only run transcribes and reads no screenshots', /^Done\. 0 filled in, 2 transcribed, 1 nothing heard or seen, 1 would not play/.test(second)
  && asked.filter(a => a.image).length === visionBefore && asked.filter(a => a.model.includes('whisper')).length === heardBefore + 2, second);
await page.click('#autoClose');
await page.selectOption('#statusFilter', 'all');
check('details found earlier are kept', (await page.$$eval('#clipGrid h3', els => els.filter(e => /^(Beef noodles in Taipei|Taipei food slides)$/.test(e.textContent)).length)) === 3);
await page.fill('#search', 'Taipei food slides');
check('a slideshow that had nothing to hear keeps its earlier auto-review', /Auto-reviewed/.test(await page.textContent('#clipGrid .analysis-badge')));
await page.fill('#search', '');
check('no CSP problems and no page errors', (await page.evaluate(() => window.__csp)).length === 0 && errors.length === 0,
  JSON.stringify(await page.evaluate(() => window.__csp)) + ' ' + errors.join(' | '));

await browser.close();
server.close();
console.log(results.every(Boolean) ? 'all checks passed' : 'SOME CHECKS FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
