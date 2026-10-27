// TikTok link reading and public metadata lookup for /api/enrich.
//
// TikTok's own data export lists Favorite Videos as share links such as
// https://www.tiktokv.com/share/video/7345678901234567890/ - no creator handle,
// and a host (tiktokv.com) the first version of the API refused. Links pasted
// from apps can also carry invisible characters or tracking parameters.
//
// readTikTokLink() cleans and classifies a link without any network request.
// lookupTikTok() then finds public metadata through TikTok's documented oEmbed
// endpoint. For a link without the creator's handle it first asks TikTok where
// the link leads (one plain request per redirect, TikTok hosts only, nothing
// pretending to be a browser) so oEmbed gets the full address; the handle is
// never made up. Every outcome has a fixed reason code, and a reply with no
// title and no creator is reported as EMPTY_METADATA, never as enriched.

export const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com',
  'vt.tiktok.com', 'us.tiktok.com', 'tiktokv.com', 'www.tiktokv.com']);
const SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);
const MAX_LINK = 800;
const OEMBED = 'https://www.tiktok.com/oembed?url=';

// Characters that never belong in a link but ride along with copied text.
const INVISIBLE = /[\u00a0\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;
const INVISIBLE_ENCODED = /%C2%A0|%E2%80%(?:8[B-F]|A[8-E])|%E2%81%A[0-4]|%EF%BB%BF/gi;

export const MESSAGES = {
  INVALID_URL: 'That is not a web link.',
  NOT_TIKTOK_LINK: 'Only TikTok links can be looked up.',
  LINK_TOO_LONG: 'That link is too long.',
  LINK_HAS_LOGIN: 'Links with a username or password in them are not accepted.',
  NO_VIDEO_IN_LINK: 'That TikTok link does not point to a video.',
  ENRICHED: 'Found the public title and creator.',
  EMPTY_METADATA: 'TikTok answered but gave no title or creator.',
  NOT_PUBLIC: 'TikTok has no public details for this video (private, removed, or region-locked).',
  RATE_LIMITED: 'TikTok is limiting lookups right now. Try again later.',
  TIMEOUT: 'TikTok did not answer in time. Try again later.',
  TIKTOK_ERROR: 'TikTok had an error. Try again later.',
  BAD_RESPONSE: 'TikTok sent an unexpected answer.',
};

/** Remove invisible characters, wrapping quotes or brackets and trailing punctuation. */
export function cleanLink(input) {
  let s = String(input ?? '').replace(INVISIBLE, '').replace(INVISIBLE_ENCODED, '').trim();
  s = s.replace(/^[<"'(\[]+/, '').replace(/[>"')\].,;:!?]+$/, '').trim();
  return s;
}

function videoParts(path) {
  let m = /^\/@([\w.-]{1,64})\/(video|photo)\/(\d{8,25})\/?$/i.exec(path);
  if (m) return { handle: m[1], kind: m[2].toLowerCase(), videoId: m[3] };
  m = /^\/(?:share\/)?(video|photo)\/(\d{8,25})\/?$/i.exec(path)
    || /^\/(v)\/(\d{8,25})(?:\.html)?\/?$/i.exec(path)
    || /^\/(embed)(?:\/v2)?\/(\d{8,25})\/?$/i.exec(path);
  if (m) return { handle: '', kind: m[1].toLowerCase() === 'photo' ? 'photo' : 'video', videoId: m[2] };
  return null;
}

/** {ok:true, url, host, kind, videoId, handle} or {ok:false, reason}. No network. */
export function readTikTokLink(input) {
  const raw = cleanLink(input);
  if (!raw) return { ok: false, reason: 'INVALID_URL' };
  if (raw.length > MAX_LINK) return { ok: false, reason: 'LINK_TOO_LONG' };
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw); }
  catch { return { ok: false, reason: 'INVALID_URL' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: 'INVALID_URL' };
  const host = u.hostname.toLowerCase();
  if (!TIKTOK_HOSTS.has(host)) return { ok: false, reason: 'NOT_TIKTOK_LINK' };
  if (u.username || u.password) return { ok: false, reason: 'LINK_HAS_LOGIN' };
  if (u.port) return { ok: false, reason: 'NOT_TIKTOK_LINK' };
  const path = u.pathname.replace(/\/{2,}/g, '/');
  const parts = videoParts(path);
  if (parts) {
    return { ok: true, host, ...parts, url: 'https://' + host + path.replace(/\/+$/, '') };
  }
  const short = SHORT_HOSTS.has(host) ? /^\/([A-Za-z0-9_-]{4,40})\/?$/.exec(path)
    : /^\/t\/([A-Za-z0-9_-]{4,40})\/?$/.exec(path);
  if (short) return { ok: true, host, kind: 'short', videoId: '', handle: '', url: 'https://' + host + path.replace(/\/+$/, '') + '/' };
  return { ok: false, reason: 'NO_VIDEO_IN_LINK' };
}

/** The address TikTok uses for a video page when the creator is known. */
export function pageUrl(link) {
  return `https://www.tiktok.com/@${link.handle}/${link.kind === 'photo' ? 'photo' : 'video'}/${link.videoId}`;
}

// Follow TikTok's own redirects (at most 3, TikTok hosts only) and return the
// first address that has the creator's handle, or null.
async function resolveLink(url, fetchImpl, deadline) {
  let current = url;
  for (let hop = 0; hop < 3 && Date.now() < deadline; hop++) {
    let res;
    try {
      res = await fetchImpl(current, { method: 'GET', redirect: 'manual',
        headers: { accept: 'text/html' }, signal: AbortSignal.timeout(Math.max(1000, Math.min(6000, deadline - Date.now()))) });
    } catch { return null; }
    try { await res.body?.cancel?.(); } catch { /* nothing to free */ }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return null;
    let next;
    try { next = new URL(location, current).toString(); } catch { return null; }
    const link = readTikTokLink(next);
    if (!link.ok) return null;
    if (link.handle) return link;
    current = link.url;
  }
  return null;
}

async function oembed(url, fetchImpl, deadline) {
  let res;
  try {
    res = await fetchImpl(OEMBED + encodeURIComponent(url), { headers: { accept: 'application/json' },
      redirect: 'follow', signal: AbortSignal.timeout(Math.max(1000, Math.min(8000, deadline - Date.now()))) });
  } catch { return { outcome: 'TIMEOUT' }; }
  if (res.status === 429) return { outcome: 'RATE_LIMITED' };
  if (res.status >= 500) return { outcome: 'TIKTOK_ERROR' };
  if (!res.ok) return { outcome: 'NOT_PUBLIC', status: res.status };
  const raw = await res.text();
  if (raw.length > 100000) return { outcome: 'BAD_RESPONSE' };
  let data;
  try { data = JSON.parse(raw); } catch { return { outcome: 'BAD_RESPONSE' }; }
  if (!data || data.provider_name !== 'TikTok') return { outcome: 'BAD_RESPONSE' };
  const title = String(data.title || '').trim().slice(0, 450);
  const creator = String(data.author_name || '').trim().slice(0, 160);
  const handle = /^[\w.-]{1,64}$/.test(String(data.author_unique_id || '')) ? String(data.author_unique_id) : '';
  if (!title && !creator) return { outcome: 'EMPTY_METADATA' };
  return { outcome: 'ENRICHED', title, creator, handle,
    thumbnail: /^https:\/\//.test(String(data.thumbnail_url || '')) ? String(data.thumbnail_url).slice(0, 1000) : '' };
}

const RETRYABLE = new Set(['RATE_LIMITED', 'TIMEOUT', 'TIKTOK_ERROR', 'BAD_RESPONSE']);
const STATUS_OF = { ENRICHED: 'enriched', EMPTY_METADATA: 'empty', NOT_PUBLIC: 'unavailable' };

/**
 * Look up one link. Returns
 *   {status: 'enriched'|'empty'|'unavailable'|'failed'|'rejected', reason, message,
 *    retryable, videoId, canonicalUrl, title, creator, thumbnail, available, tries}
 * ``fetchImpl`` is fetch (tests pass a fake). Never throws.
 */
export async function lookupTikTok(input, { fetchImpl = (...a) => fetch(...a), budgetMs = 20000 } = {}) {
  const deadline = Date.now() + budgetMs;
  let link = readTikTokLink(input);
  const base = { title: '', creator: '', thumbnail: '', canonicalUrl: '', tries: [] };
  if (!link.ok) {
    return { ...base, status: 'rejected', reason: link.reason, message: MESSAGES[link.reason],
      retryable: false, videoId: '', available: false };
  }
  const tries = base.tries;
  if (!link.handle) {
    const start = link.kind === 'short' ? link.url : `https://www.tiktok.com/share/${link.kind === 'photo' ? 'photo' : 'video'}/${link.videoId}`;
    const found = await resolveLink(start, fetchImpl, deadline);
    tries.push(found ? 'redirect:found' : 'redirect:none');
    if (found && (!link.videoId || found.videoId === link.videoId)) link = found;
  }
  // The addresses to ask oEmbed about, best first.
  const candidates = link.handle ? [pageUrl(link)]
    : link.videoId ? [`https://www.tiktok.com/share/${link.kind === 'photo' ? 'photo' : 'video'}/${link.videoId}`, link.url]
      : [link.url];
  let last = { outcome: 'NOT_PUBLIC' };
  for (const candidate of [...new Set(candidates)]) {
    if (Date.now() >= deadline) { last = { outcome: 'TIMEOUT' }; break; }
    const answer = await oembed(candidate, fetchImpl, deadline);
    tries.push('oembed:' + answer.outcome + (answer.status ? '_' + answer.status : ''));
    last = answer;
    if (answer.outcome === 'ENRICHED' || RETRYABLE.has(answer.outcome)) break;
  }
  const reason = last.outcome;
  const handle = link.handle || last.handle || '';
  const result = { ...base, tries, reason, message: MESSAGES[reason],
    status: STATUS_OF[reason] || 'failed', retryable: RETRYABLE.has(reason),
    videoId: link.videoId || '', available: reason === 'ENRICHED' };
  if (link.videoId && handle) result.canonicalUrl = pageUrl({ ...link, handle });
  if (reason === 'ENRICHED') Object.assign(result, { title: last.title, creator: last.creator, thumbnail: last.thumbnail });
  return result;
}
