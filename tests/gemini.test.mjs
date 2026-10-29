// src/gemini.js and /api/gemini, /api/ai-config, with Google's API replaced by a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { relayGemini, readGeminiError, readGeminiReply, geminiAllowed, modelList, resetGeminiForTests, GEMINI_MODELS, GEMINI_ASK_MODELS } from '../src/gemini.js';
import worker from '../src/worker.js';

test.beforeEach(() => resetGeminiForTests());

const quota = (quotaId, value = '250', delay = '') => ({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
  message: `You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: ${value}`,
  details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue: value }] },
    ...(delay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] : [])] } });
const ANSWER = { candidates: [{ content: { parts: [{ text: '{"title":"Noodles"}' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 2100, candidatesTokenCount: 140, thoughtsTokenCount: 60 } };

// A fake Google: per model, a list of [status, body] answers (the last one repeats).
function fakeGoogle(plan) {
  const calls = [];
  const fetcher = async (url, init) => {
    const model = decodeURIComponent(/models\/([^:]+):generateContent/.exec(url)[1]);
    calls.push({ model, key: init.headers['x-goog-api-key'], body: init.body });
    const list = plan[model] || [[404, { error: { code: 404, message: `models/${model} is not found for API version v1beta` } }]];
    const [status, body] = list.length > 1 ? list.shift() : list[0];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetcher };
}
const ENV = { GEMINI_API_KEY: 'k-123' };
const BODY = new TextEncoder().encode('{"contents":[]}').buffer;

test('a refusal is sorted: slow down, used up for today, not on the free tier, key, model', () => {
  assert.deepEqual(readGeminiError(429, quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '10', '34.5s')).kind, 'minute');
  assert.equal(readGeminiError(429, quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '10', '34.5s')).retryAfter, 35);
  assert.equal(readGeminiError(429, quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '250')).kind, 'day');
  assert.equal(readGeminiError(429, quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '0')).kind, 'not_free', 'limit 0: not on the free tier');
  assert.equal(readGeminiError(429, { error: { message: 'Resource exhausted. Please retry in 12s.' } }).retryAfter, 12);
  assert.equal(readGeminiError(400, { error: { message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }).kind, 'key');
  assert.equal(readGeminiError(400, { error: { message: 'User location is not supported for the API use.' } }).kind, 'region');
  assert.equal(readGeminiError(404, { error: { message: 'models/x is not found' } }).kind, 'model');
  assert.equal(readGeminiError(503, { error: { message: 'The model is overloaded.' } }).kind, 'other');
});

test('the answer: its text (not its thinking), how it ended, tokens used', () => {
  const r = readGeminiReply({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"a":1}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 } });
  assert.deepEqual(r, { text: '{"a":1}', finish: 'STOP', blocked: '', usage: { prompt: 10, output: 12 } });
});

test('the request goes on unread, with the key, to the first model that has free requests', async () => {
  const g = fakeGoogle({ [GEMINI_MODELS[0]]: [[429, quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '0')]], [GEMINI_MODELS[1]]: [[200, ANSWER]] });
  const r = await relayGemini(BODY, ENV, g.fetcher);
  assert.deepEqual([r.status, r.model, r.text, r.usage.output], ['ok', GEMINI_MODELS[1], '{"title":"Noodles"}', 200]);
  assert.ok(g.calls.every(c => c.key === 'k-123' && c.body === BODY), 'the same bytes, the key added');
  const again = await relayGemini(BODY, ENV, g.fetcher);
  assert.equal(again.status, 'ok');
  assert.deepEqual(g.calls.map(c => c.model), [GEMINI_MODELS[0], GEMINI_MODELS[1], GEMINI_MODELS[1]], 'the working model is used straight away');
});

test('slow down: said at once, with how long to wait; used up on every model: said as such', async () => {
  const busy = fakeGoogle({ [GEMINI_MODELS[0]]: [[429, quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '10', '20s')]] });
  const r = await relayGemini(BODY, ENV, busy.fetcher);
  assert.deepEqual([r.status, r.reason, r.retryAfter, r.http, busy.calls.length], ['failed', 'GEMINI_BUSY', 20, 429, 1]);
  resetGeminiForTests();
  const day = quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '250');
  const spent = fakeGoogle({ [GEMINI_MODELS[0]]: [[429, day]], [GEMINI_MODELS[1]]: [[429, day]] });   // the others do not exist
  const d = await relayGemini(BODY, ENV, spent.fetcher);
  assert.deepEqual([d.reason, d.http], ['GEMINI_DAILY_LIMIT', 429], 'used up beats "no such model"');
  assert.equal(spent.calls.length, GEMINI_MODELS.length, 'each model tried once');
  const later = await relayGemini(BODY, ENV, spent.fetcher);
  assert.equal(later.reason, 'GEMINI_DAILY_LIMIT', 'then not asked again for a while, and still said as "used up"');
  assert.equal(spent.calls.length, GEMINI_MODELS.length);
});

test('a model that is overloaded (503): the next one is asked, and the first is not skipped next time', async () => {
  const g = fakeGoogle({ [GEMINI_MODELS[0]]: [[503, { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.' } }], [200, ANSWER]], [GEMINI_MODELS[1]]: [[200, ANSWER]] });
  const r = await relayGemini(BODY, ENV, g.fetcher);
  assert.deepEqual([r.status, r.model], ['ok', GEMINI_MODELS[1]]);
  resetGeminiForTests();
  const again = await relayGemini(BODY, ENV, g.fetcher);
  assert.deepEqual([again.status, again.model], ['ok', GEMINI_MODELS[0]], 'the first model is still tried first');
  const down = fakeGoogle(Object.fromEntries(GEMINI_MODELS.map(m => [m, [[503, { error: { message: 'overloaded' } }]]])));
  resetGeminiForTests();
  const none = await relayGemini(BODY, ENV, down.fetcher);
  assert.deepEqual([none.reason, down.calls.length], ['GEMINI_FAILED', GEMINI_MODELS.length], 'all overloaded: said as a failure after asking each once');
});

test('a wrong key is not retried on other models; a model list can be set', async () => {
  const g = fakeGoogle({ [GEMINI_MODELS[0]]: [[400, { error: { message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }]] });
  const r = await relayGemini(BODY, ENV, g.fetcher);
  assert.deepEqual([r.reason, g.calls.length], ['GEMINI_KEY', 1]);
  assert.deepEqual(modelList({ GEMINI_MODELS: ' gemini-x-flash , bad model!, gemini-y ' }), ['gemini-x-flash', 'gemini-y']);
  assert.deepEqual(modelList({}), GEMINI_MODELS);
  assert.equal(GEMINI_MODELS[0], 'gemini-3.5-flash-lite', 'clips: the 500-a-day models first');
  assert.equal(modelList({}, 'ask')[0], 'gemini-3.8-flash', 'questions: the stronger model first');
  assert.deepEqual(modelList({ GEMINI_ASK_MODELS: 'gemini-z' }, 'ask'), ['gemini-z']);
});

test('who may use it: needs the key; GEMINI_USERS limits it to those accounts', () => {
  assert.equal(geminiAllowed({}, 'a@b.co'), false);
  assert.equal(geminiAllowed({ GEMINI_API_KEY: 'k' }, 'a@b.co'), true);
  assert.equal(geminiAllowed({ GEMINI_API_KEY: 'k', GEMINI_USERS: 'Me@Example.com, other@x.co' }, 'me@example.com'), true);
  assert.equal(geminiAllowed({ GEMINI_API_KEY: 'k', GEMINI_USERS: 'other@x.co' }, 'a@b.co'), false);
});

// ---- the routes, through the real Worker (Google faked through the global fetch)
const TOKEN = 'b'.repeat(64);
function env(extra = {}) {
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
  return { DB, AI: {}, ASSETS: { fetch: () => new Response('asset') }, ...extra };
}
const call = (path, e, init = {}) => worker.fetch(new Request('https://clipatlas.example/api/' + path, { ...init,
  headers: { origin: 'https://clipatlas.example', cookie: `clipatlas_session=${TOKEN}`, 'content-type': 'application/json', ...(init.headers || {}) } }), e);

test('/api/ai-config and /api/gemini', async () => {
  const realFetch = globalThis.fetch;
  const g = fakeGoogle({ [GEMINI_MODELS[0]]: [[200, ANSWER]], [GEMINI_ASK_MODELS[0]]: [[200, ANSWER]] });
  globalThis.fetch = (url, init) => String(url).startsWith('https://generativelanguage.googleapis.com/') ? g.fetcher(String(url), init) : realFetch(url, init);
  try {
    assert.deepEqual(await (await call('ai-config', env())).json(), { gemini: false, cloudflare: true });
    assert.deepEqual(await (await call('ai-config', env({ GEMINI_API_KEY: 'k' }))).json(), { gemini: true, cloudflare: true });
    const off = await call('gemini', env(), { method: 'POST', body: '{}' });
    assert.deepEqual([off.status, (await off.json()).reason], [503, 'GEMINI_NOT_SET_UP']);
    const ok = await call('gemini', env({ GEMINI_API_KEY: 'k' }), { method: 'POST', body: '{"contents":[{"parts":[{"text":"hi"}]}]}' });
    const data = await ok.json();
    assert.deepEqual([ok.status, data.status, data.text, data.http], [200, 'ok', '{"title":"Noodles"}', undefined]);
    assert.equal(new TextDecoder().decode(g.calls.at(-1).body), '{"contents":[{"parts":[{"text":"hi"}]}]}', 'passed on as sent');
    const asked = await (await call('gemini?for=ask', env({ GEMINI_API_KEY: 'k' }), { method: 'POST', body: '{}' })).json();
    assert.equal(asked.model, GEMINI_ASK_MODELS[0], 'a question goes to the stronger model');
    const big = await call('gemini', env({ GEMINI_API_KEY: 'k' }), { method: 'POST', body: 'x'.repeat(20 * 1024 * 1024) });
    assert.equal(big.status, 413);
    const capped = env({ GEMINI_API_KEY: 'k', AUTO_REVIEW_DAILY_LIMIT: '1' });
    for (let i = 0; i < 2; i++) assert.equal((await call('gemini', capped, { method: 'POST', body: '{}' })).status, 200, 'two requests a clip');
    const third = await call('gemini', capped, { method: 'POST', body: '{}' });
    assert.deepEqual([third.status, (await third.json()).reason], [429, 'CLIPATLAS_LIMIT']);
    const other = await call('gemini', env({ GEMINI_API_KEY: 'k', GEMINI_USERS: 'someone@else.co' }), { method: 'POST', body: '{}' });
    assert.equal(other.status, 503, 'not on the list');
  } finally { globalThis.fetch = realFetch; }
});
