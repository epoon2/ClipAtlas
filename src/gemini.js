// Auto-review through Google's Gemini API (its free tier), relayed by the Worker.
//
// The page builds the whole request (prompt, the clip's sound, its screenshot
// sheets, the JSON shape of the answer) and the Worker passes it on unread:
// parsing and re-writing a few megabytes of base64 would cost more CPU than the
// Workers Free plan allows (10 ms a request). The Worker adds the API key, kept
// as a Cloudflare secret (GEMINI_API_KEY) and never sent to the browser, picks
// the model, and reads only Google's small answer. Who may use it: signed-in
// accounts, only the ones in GEMINI_USERS when that secret is set, with a daily
// cap and a size cap.
//
// Free-tier limits are Google's and differ by model and project (AI Studio shows
// them); requests per day start again at midnight Pacific. A 429 is sorted into
// "slow down" (per minute: wait and try again), "used up for today" (per day: the
// page moves on to Cloudflare) and "not on the free tier" (limit 0: try the next
// model).

// Each model has its own free daily limit. On a free key in October 2026 the Flash-Lite
// models allowed 500 requests a day each and the full Flash models 20, so clips go to
// Flash-Lite first (about 1,000 clips a day in all), and questions about a collection,
// where reasoning counts more, to Flash first.
export const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash'];
export const GEMINI_ASK_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
export const GEMINI_MAX = 19 * 1024 * 1024;   // Google takes at most 20 MB inline in one request
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';

const working = {};          // purpose -> the model that answered last
const skip = new Map();      // model -> {until (ms), why: 'day'|'missing'} after it refused

/** For tests: forget what was learned, as a fresh Worker instance would. */
export function resetGeminiForTests() { for (const k of Object.keys(working)) delete working[k]; skip.clear(); }

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The models to try, in order: for clips (GEMINI_MODELS) or for questions (GEMINI_ASK_MODELS). */
export function modelList(env, purpose = 'clip') {
  const own = String(env && (purpose === 'ask' ? env.GEMINI_ASK_MODELS : env.GEMINI_MODELS) || '').split(',').map(s => s.trim()).filter(s => /^[a-z0-9.-]{3,60}$/.test(s));
  return own.length ? own : purpose === 'ask' ? GEMINI_ASK_MODELS : GEMINI_MODELS;
}

/** May this account use Gemini? Everyone signed in, or only the addresses in GEMINI_USERS. */
export function geminiAllowed(env, email) {
  if (!env || !env.GEMINI_API_KEY) return false;
  const list = String(env.GEMINI_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return !list.length || list.includes(String(email || '').toLowerCase());
}

/** Seconds from a RetryInfo delay like "35s" or "1.5s". */
function seconds(v) { const m = /^(\d+(?:\.\d+)?)s$/.exec(String(v || '')); return m ? Math.ceil(Number(m[1])) : 0; }

/** What a refusal from Google means: {kind: 'minute'|'day'|'not_free'|'key'|'region'|'model'|'other', retryAfter, detail}. */
export function readGeminiError(status, body) {
  const err = body && body.error || {};
  const message = clip(err.message, 400);
  const details = Array.isArray(err.details) ? err.details : [];
  const violations = details.flatMap(d => Array.isArray(d && d.violations) ? d.violations : []);
  const retry = details.find(d => /RetryInfo/.test(d && d['@type'] || ''));
  const retryAfter = seconds(retry && retry.retryDelay) || (/retry in (\d+(?:\.\d+)?)s/i.exec(message) ? Math.ceil(Number(/retry in (\d+(?:\.\d+)?)s/i.exec(message)[1])) : 0);
  const reasons = details.map(d => d && d.reason).filter(Boolean).join(' ');
  if (status === 429 || err.status === 'RESOURCE_EXHAUSTED') {
    if (violations.some(v => String(v.quotaValue) === '0') || /limit:\s*0\b/.test(message)) return { kind: 'not_free', retryAfter, detail: message };
    if (violations.some(v => /PerDay/i.test(v.quotaId || '')) || /per day|daily/i.test(message)) return { kind: 'day', retryAfter, detail: message };
    return { kind: 'minute', retryAfter: retryAfter || 30, detail: message };
  }
  if (/API_KEY_INVALID|API_KEY/.test(reasons) || /api key not valid|api key/i.test(message) || status === 401) return { kind: 'key', retryAfter: 0, detail: message };
  if (/location is not supported|not available in your country/i.test(message)) return { kind: 'region', retryAfter: 0, detail: message };
  if (status === 404 || /is not found|not supported for generateContent|no longer available|deprecated/i.test(message)) return { kind: 'model', retryAfter: 0, detail: message };
  if (status === 403) return { kind: 'key', retryAfter: 0, detail: message };
  return { kind: 'other', retryAfter: status >= 500 ? 5 : 0, detail: message || `HTTP ${status}` };
}

const REASONS = { minute: 'GEMINI_BUSY', day: 'GEMINI_DAILY_LIMIT', key: 'GEMINI_KEY', region: 'GEMINI_REGION', model: 'GEMINI_NO_MODEL', not_free: 'GEMINI_NO_MODEL', other: 'GEMINI_FAILED' };

/** The text of Google's answer, how it ended and how many tokens it used. */
export function readGeminiReply(body) {
  const cand = body && Array.isArray(body.candidates) ? body.candidates[0] : null;
  const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
  const text = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
  const u = body && body.usageMetadata || {};
  return { text, finish: cand ? String(cand.finishReason || '') : '', blocked: body && body.promptFeedback && body.promptFeedback.blockReason || '',
    usage: { prompt: Number(u.promptTokenCount) || 0, output: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0) } };
}

/**
 * Send one request body (bytes, as the page built it) to the first model that
 * takes it. Never throws. {status: 'ok', model, text, finish, usage} or
 * {status: 'failed', reason, detail, retryAfter, model} with ``http`` for the page.
 */
export async function relayGemini(body, env, fetcher = fetch, purpose = 'clip') {
  const now = Date.now();
  const all = modelList(env, purpose), last_ = working[purpose];
  const order = [...(last_ && all.includes(last_) ? [last_] : []), ...all.filter(m => m !== last_)]
    .filter(m => !(skip.get(m) && skip.get(m).until > now));
  if (!order.length) {
    if (all.some(m => skip.get(m) && skip.get(m).why === 'day'))
      return { status: 'failed', reason: 'GEMINI_DAILY_LIMIT', http: 429, detail: 'gemini: the free requests are used up for today' };
    return { status: 'failed', reason: 'GEMINI_NO_MODEL', http: 503,
      detail: `none of ${all.join(', ')} is available on this key right now; set GEMINI_MODELS to one AI Studio lists` };
  }
  let last = null, day = null;
  for (const model of order) {
    let res, data;
    try {
      res = await fetcher(API + encodeURIComponent(model) + ':generateContent', { method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY } });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      return { status: 'failed', reason: 'GEMINI_FAILED', http: 502, retryAfter: 5, model, detail: clip(`gemini: ${err && err.message || err}`, 300) };
    }
    if (res.ok) {
      working[purpose] = model;
      const reply = readGeminiReply(data);
      if (reply.blocked) return { status: 'failed', reason: 'GEMINI_BLOCKED', http: 200, model, detail: `gemini (${model}): blocked (${reply.blocked})` };
      return { status: 'ok', model, ...reply };
    }
    const e = readGeminiError(res.status, data);
    last = { status: 'failed', reason: REASONS[e.kind], http: e.kind === 'minute' || e.kind === 'day' ? 429 : 502,
      retryAfter: e.retryAfter, model, detail: clip(`gemini (${model}): ${e.detail}`, 300) };
    // A missing model, or one with no free requests, is skipped for an hour; the next one is tried.
    if (e.kind === 'model' || e.kind === 'not_free') { skip.set(model, { until: now + 3600_000, why: 'missing' }); if (working[purpose] === model) delete working[purpose]; continue; }
    // Used up for today on this model: another model may still have requests left today.
    if (e.kind === 'day') { skip.set(model, { until: now + 3600_000, why: 'day' }); if (working[purpose] === model) delete working[purpose]; day = last; continue; }
    // Google busy or down for this model (503 "overloaded", 500): the next model may answer; it is not skipped later.
    if (e.kind === 'other' && res.status >= 500) continue;
    return last;
  }
  // Every model refused: "used up for today" says more than "no such model".
  return day || last;
}
