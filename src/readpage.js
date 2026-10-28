// /api/readpage: the readable text of a web page someone saved in a collection
// (a travel guide, a blog post, a Reddit thread), so the AI can find its places
// and answer questions from it. One public page, read once, like a browser would:
// http(s) only, no TikTok (TikToks are saved as TikToks and only ever played in
// TikTok's own player), no addresses inside private networks, at most 10 seconds
// and 1.5 MB. A site that refuses (Reddit often refuses servers) is reported as
// such, and the person can paste the text instead; nothing is worked around.
//
// The text is pulled out with Cloudflare's streaming HTMLRewriter, which costs
// almost no CPU (the Workers Free plan allows 10 ms a request); tests running
// outside Workers use a simple fallback.

export const PAGE_MAX_BYTES = 1_500_000;
export const PAGE_TEXT_MAX = 20000;
const SKIP = 'script,style,noscript,svg,template,iframe,nav,header,footer,form,button,select,aside';
const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,br,div,tr,section,article,blockquote,pre,dt,dd,figcaption,td,th';

/** {ok, url} for a link that may be read, or {ok:false, reason}. */
export function readPageRequest(body) {
  let u;
  try { u = new URL(String(body && body.url || '').trim()); } catch { return { ok: false, reason: 'BAD_LINK' }; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return { ok: false, reason: 'BAD_LINK' };
  const host = u.hostname.toLowerCase();
  if (/(^|\.)tiktokv?\.com$/.test(host)) return { ok: false, reason: 'TIKTOK' };
  if (!host.includes('.') || /^(localhost|.*\.(local|internal|lan|home|arpa))$/.test(host)) return { ok: false, reason: 'PRIVATE' };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return { ok: false, reason: 'PRIVATE' };
  if (u.port && !['80', '443'].includes(u.port)) return { ok: false, reason: 'PRIVATE' };
  return { ok: true, url: u.toString() };
}

const tidy = t => t.replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = t => t.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m));

/** Title, description and text of an HTML page, without HTMLRewriter (tests). */
export function pageTextFallback(html) {
  const h = String(html || '');
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const meta = name => decode((new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i').exec(h) || [])[1] || '').trim();
  let body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(h) || [null, h])[1];
  for (const tag of SKIP.split(',')) body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  body = body.replace(new RegExp(`<\\/?(?:${BLOCK.replace(/,/g, '|')})\\b[^>]*>`, 'gi'), '\n').replace(/<[^>]+>/g, ' ');
  return { title: title || meta('og:title'), description: meta('description') || meta('og:description'), text: tidy(decode(body)).slice(0, PAGE_TEXT_MAX) };
}

/** The same with Cloudflare's HTMLRewriter, streaming. */
async function pageTextRewriter(res) {
  let title = '', description = '', text = '', skip = 0, inTitle = false, full = false;
  const add = t => { if (full) return; text += t; if (text.length > PAGE_TEXT_MAX * 1.5) full = true; };
  const rewriter = new HTMLRewriter()
    .on('title', { element(el) { inTitle = true; el.onEndTag(() => { inTitle = false; }); } })
    .on('meta', { element(el) {
      const name = (el.getAttribute('name') || el.getAttribute('property') || '').toLowerCase(), content = el.getAttribute('content') || '';
      if (!description && (name === 'description' || name === 'og:description')) description = content;
      if (!title && name === 'og:title') title = content;
    } })
    .onDocument({ text(chunk) {
      if (inTitle) { title += chunk.text; return; }
      if (!skip) add(chunk.text);
    } });
  // One handler per tag (selector lists are not relied on).
  for (const tag of SKIP.split(',')) rewriter.on(tag, { element(el) { skip++; el.onEndTag(() => { skip--; }); } });
  for (const tag of BLOCK.split(',')) rewriter.on(tag, { element() { if (!skip) add('\n'); } });
  await rewriter.transform(res).arrayBuffer();
  return { title: decode(title).replace(/\s+/g, ' ').trim(), description: decode(description).trim(), text: tidy(decode(text)).slice(0, PAGE_TEXT_MAX) };
}

/** Read one page. Never throws. {status: 'ok', url, title, description, text} or {status: 'failed', reason, detail}. */
export async function readPage(url, fetcher = fetch) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetcher(url, { redirect: 'follow', signal: ctl.signal, headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ClipAtlas/1.0; reading a page its owner saved)', accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' } });
    if (!res.ok) return { status: 'failed', reason: [401, 403, 429].includes(res.status) ? 'BLOCKED' : 'NOT_FOUND', detail: `the site answered ${res.status}` };
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!/text\/html|application\/xhtml|text\/plain/.test(type)) return { status: 'failed', reason: 'NOT_A_PAGE', detail: type || 'unknown type' };
    if (Number(res.headers.get('content-length') || 0) > PAGE_MAX_BYTES * 4) return { status: 'failed', reason: 'TOO_BIG', detail: 'the page is too large' };
    // At most 1.5 MB is read.
    const reader = res.body.getReader(), parts = []; let size = 0;
    while (size < PAGE_MAX_BYTES) { const { done, value } = await reader.read(); if (done) break; parts.push(value); size += value.length; }
    try { reader.cancel(); } catch { /* already done */ }
    const bytes = new Uint8Array(size); let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; }
    const finalUrl = res.url || url;
    if (type.includes('text/plain')) return { status: 'ok', url: finalUrl, title: '', description: '', text: tidy(new TextDecoder().decode(bytes)).slice(0, PAGE_TEXT_MAX) };
    const page = typeof HTMLRewriter === 'function'
      ? await pageTextRewriter(new Response(bytes, { headers: { 'content-type': type } }))
      : pageTextFallback(new TextDecoder().decode(bytes));
    if (!page.text && !page.description) return { status: 'failed', reason: 'NO_TEXT', detail: 'the page has no readable text (it may need JavaScript)' };
    return { status: 'ok', url: finalUrl, ...page };
  } catch (err) {
    return { status: 'failed', reason: err && err.name === 'AbortError' ? 'TIMEOUT' : 'NOT_FOUND', detail: String(err && err.message || err).slice(0, 200) };
  } finally { clearTimeout(timer); }
}
