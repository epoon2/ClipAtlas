// src/tiktok.js: link reading and the metadata lookup, with TikTok replaced by a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLink, readTikTokLink, lookupTikTok } from '../src/tiktok.js';

const ID = '7662085125500407061';
const ZW = String.fromCharCode(0x200b), NBSP = String.fromCharCode(0xa0), BOM = String.fromCharCode(0xfeff);

test('cleans invisible characters, wrappers and trailing punctuation', () => {
  assert.equal(cleanLink(`${BOM} <https://www.tiktok.com/share/video/${ID}${ZW}>.${NBSP}`),
    `https://www.tiktok.com/share/video/${ID}`);
  assert.equal(cleanLink(`https://www.tiktok.com/share/video/${ID}%E2%80%8B`), `https://www.tiktok.com/share/video/${ID}`);
});

test('reads every TikTok link form', () => {
  const cases = [
    [`https://www.tiktok.com/share/video/${ID}`, { kind: 'video', videoId: ID, handle: '' }],
    [`https://www.tiktokv.com/share/video/${ID}/`, { kind: 'video', videoId: ID, handle: '' }],
    [`http://www.tiktok.com/@some.creator/video/${ID}?is_from_webapp=1`, { kind: 'video', videoId: ID, handle: 'some.creator' }],
    [`www.tiktok.com/@a_b/photo/${ID}`, { kind: 'photo', videoId: ID, handle: 'a_b' }],
    [`https://m.tiktok.com/v/${ID}.html`, { kind: 'video', videoId: ID, handle: '' }],
    [`https://www.tiktok.com/embed/v2/${ID}`, { kind: 'video', videoId: ID, handle: '' }],
    ['https://vm.tiktok.com/ZMabc123/', { kind: 'short', videoId: '', handle: '' }],
    ['https://www.tiktok.com/t/ZTabc123/', { kind: 'short', videoId: '', handle: '' }],
  ];
  for (const [url, want] of cases) {
    const got = readTikTokLink(url);
    assert.equal(got.ok, true, url);
    for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${url} ${k}`);
    assert.match(got.url, /^https:\/\//);
  }
});

test('refuses what is not a TikTok video with a fixed reason', () => {
  const cases = [
    ['javascript:alert(1)', 'INVALID_URL'], ['', 'INVALID_URL'],
    [`https://tiktok.com.evil.tld/@a/video/${ID}`, 'NOT_TIKTOK_LINK'],
    [`https://example.com/share/video/${ID}`, 'NOT_TIKTOK_LINK'],
    [`https://user:pw@www.tiktok.com/@a/video/${ID}`, 'LINK_HAS_LOGIN'],
    [`https://www.tiktok.com:8443/@a/video/${ID}`, 'NOT_TIKTOK_LINK'],
    ['https://www.tiktok.com/@some.creator', 'NO_VIDEO_IN_LINK'],
    ['https://www.tiktok.com/' + 'a'.repeat(900), 'LINK_TOO_LONG'],
  ];
  for (const [url, reason] of cases) assert.equal(readTikTokLink(url).reason, reason, url);
});

// A fake TikTok: redirects for share links, oEmbed answers by the url it is asked about.
function fakeTikTok({ redirect = null, answers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url.startsWith('https://www.tiktok.com/oembed?url=')) {
      const asked = decodeURIComponent(url.slice('https://www.tiktok.com/oembed?url='.length));
      const a = answers[asked] ?? answers['*'] ?? { status: 400 };
      if (a.throw) throw new TypeError('network');
      return new Response(a.body ? JSON.stringify(a.body) : '{}', { status: a.status || 200 });
    }
    assert.equal(init.redirect, 'manual', 'redirects are followed one at a time');
    const to = typeof redirect === 'function' ? redirect(url) : redirect;
    return to ? new Response('', { status: 301, headers: { location: to } }) : new Response('<html>', { status: 200 });
  };
  return { calls, fetchImpl };
}
const OK = { status: 200, body: { provider_name: 'TikTok', title: 'Taipei night market #food', author_name: 'Some Creator',
  author_unique_id: 'some.creator', thumbnail_url: 'https://p16.example/x.jpg' } };

test('a share link is followed to its full address, then enriched', async () => {
  const fake = fakeTikTok({ redirect: `https://www.tiktok.com/@some.creator/video/${ID}?_r=1`,
    answers: { [`https://www.tiktok.com/@some.creator/video/${ID}`]: OK } });
  const r = await lookupTikTok(`https://www.tiktokv.com/share/video/${ID}/`, { fetchImpl: fake.fetchImpl });
  assert.equal(r.status, 'enriched');
  assert.equal(r.available, true);
  assert.equal(r.title, 'Taipei night market #food');
  assert.equal(r.canonicalUrl, `https://www.tiktok.com/@some.creator/video/${ID}`);
  assert.deepEqual(r.tries, ['redirect:found', 'oembed:ENRICHED']);
});

test('without a redirect, oEmbed is asked with the share link, never a made-up handle', async () => {
  const fake = fakeTikTok({ answers: { [`https://www.tiktok.com/share/video/${ID}`]: OK } });
  const r = await lookupTikTok(`https://www.tiktok.com/share/video/${ID}`, { fetchImpl: fake.fetchImpl });
  assert.equal(r.status, 'enriched');
  assert.equal(r.canonicalUrl, `https://www.tiktok.com/@some.creator/video/${ID}`, 'the handle comes from TikTok');
  assert.ok(fake.calls.every(u => !/%40%2Fvideo|@\/video/.test(u)));
});

test('a reply with no title and no creator is EMPTY_METADATA, not enriched', async () => {
  const fake = fakeTikTok({ answers: { '*': { status: 200, body: { provider_name: 'TikTok', title: '', author_name: '' } } } });
  const r = await lookupTikTok(`https://www.tiktok.com/@a/video/${ID}`, { fetchImpl: fake.fetchImpl });
  assert.equal(r.status, 'empty');
  assert.equal(r.reason, 'EMPTY_METADATA');
  assert.equal(r.available, false);
});

test('private or removed videos, rate limits and timeouts get their own reasons', async () => {
  const cases = [
    [{ status: 404 }, 'unavailable', 'NOT_PUBLIC', false],
    [{ status: 429 }, 'failed', 'RATE_LIMITED', true],
    [{ status: 503 }, 'failed', 'TIKTOK_ERROR', true],
    [{ throw: true }, 'failed', 'TIMEOUT', true],
    [{ status: 200, body: { provider_name: 'Elsewhere', title: 'x' } }, 'failed', 'BAD_RESPONSE', true],
  ];
  for (const [answer, status, reason, retryable] of cases) {
    const fake = fakeTikTok({ answers: { '*': answer } });
    const r = await lookupTikTok(`https://www.tiktok.com/@a/video/${ID}`, { fetchImpl: fake.fetchImpl });
    assert.deepEqual([r.status, r.reason, r.retryable], [status, reason, retryable], reason);
  }
});

test('a rate limit stops at once instead of trying the other address', async () => {
  const fake = fakeTikTok({ answers: { '*': { status: 429 } } });
  await lookupTikTok(`https://www.tiktokv.com/share/video/${ID}`, { fetchImpl: fake.fetchImpl });
  assert.equal(fake.calls.filter(u => u.includes('/oembed')).length, 1);
});

test('redirects never leave TikTok', async () => {
  const fake = fakeTikTok({ redirect: 'https://evil.example/@x/video/' + ID,
    answers: { [`https://www.tiktok.com/share/video/${ID}`]: OK } });
  const r = await lookupTikTok(`https://www.tiktok.com/share/video/${ID}`, { fetchImpl: fake.fetchImpl });
  assert.ok(!fake.calls.some(u => u.startsWith('https://evil.example')));
  assert.equal(r.status, 'enriched');
  assert.deepEqual(r.tries, ['redirect:none', 'oembed:ENRICHED']);
});

test('a short link is followed to its video', async () => {
  const fake = fakeTikTok({ redirect: `https://www.tiktok.com/@some.creator/video/${ID}`,
    answers: { [`https://www.tiktok.com/@some.creator/video/${ID}`]: OK } });
  const r = await lookupTikTok('https://vm.tiktok.com/ZMabc123/', { fetchImpl: fake.fetchImpl });
  assert.equal(r.status, 'enriched');
  assert.equal(r.videoId, ID);
});

test('a rejected link makes no request at all', async () => {
  const fake = fakeTikTok();
  const r = await lookupTikTok('https://example.com/video/1', { fetchImpl: fake.fetchImpl });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'NOT_TIKTOK_LINK');
  assert.equal(fake.calls.length, 0);
});
