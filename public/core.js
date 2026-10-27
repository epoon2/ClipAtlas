/* ClipAtlas: pure import and library helpers. No network requests or dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ClipAtlasCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const CATEGORIES = [
    'Unsorted', 'Taiwan · Food', 'Taiwan · Shopping', 'Taiwan · Activities',
    'Dates & restaurants', 'Travel ideas', 'Points & miles', 'Other'
  ];
  const HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com',
    'vt.tiktok.com', 'tiktokv.com', 'www.tiktokv.com']);
  const isoNow = () => new Date().toISOString();
  const safeString = (v) => typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
  const splitList = (v) => Array.isArray(v) ? v.map(safeString).filter(Boolean) : safeString(v).split(/[|;,]/).map(s => s.trim()).filter(Boolean);
  const uniq = values => [...new Set(values.filter(Boolean))];
  const normalizeField = value => safeString(value).toLowerCase().replace(/[^a-z0-9]/g, '');

  function parseTikTokURL(input) {
    const raw = safeString(input);
    if (!raw) return null;
    let u;
    try { u = new URL(raw.startsWith('https://') || raw.startsWith('http://') ? raw : 'https://' + raw); }
    catch (_) { return null; }
    if (!['http:', 'https:'].includes(u.protocol) || !HOSTS.has(u.hostname.toLowerCase())) return null;
    const match = u.pathname.match(/(?:^|\/)(?:video|v)\/(\d{10,25})(?:\/|$)/i);
    if (match) {
      return { url: 'https://' + u.hostname.toLowerCase() + (u.pathname.replace(/\/+$/, '') || '/'), key: 'tiktok:' + match[1], videoId: match[1], originalUrl: raw };
    }
    // Short links cannot be linked to their long video IDs without resolving redirects.
    // Preserve the short path; never guess a matching video or make a network request.
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const host = u.hostname.toLowerCase();
    const normalized = 'https://' + host + path;
    if (path === '/') return null;
    return { url: normalized, key: 'link:' + normalized.toLowerCase(), videoId: '', originalUrl: raw };
  }
  function parseCSV(text) {
    text = String(text).replace(/^\uFEFF/, '');
    const rows = []; let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (quoted && text[i + 1] === '"') { field += '"'; i++; }
        else quoted = !quoted;
      } else if (c === ',' && !quoted) { row.push(field); field = ''; }
      else if ((c === '\n' || c === '\r') && !quoted) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(v => v.trim())) rows.push(row);
        row = [];
      } else field += c;
    }
    if (quoted) throw new Error('The CSV has an unclosed quote.');
    row.push(field); if (row.some(v => v.trim())) rows.push(row);
    if (!rows.length) return [];
    const keys = rows.shift().map(normalizeField);
    if (!keys.some(k => ['url', 'link', 'videourl', 'videolandingpagelink'].includes(k)))
      throw new Error('Your CSV needs a url or link column. Download the CSV template for an example.');
    return rows.map(cells => Object.fromEntries(keys.map((k, i) => [k, cells[i] || ''])));
  }
  function csvEscape(value) {
    const str = String(value == null ? '' : value);
    return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }
  const CSV_FIELDS = ['url', 'title', 'category', 'collection', 'tags', 'place', 'city', 'country', 'notes', 'caption', 'creator', 'savedAt', 'status'];
  function csvTemplate() { return CSV_FIELDS.join(',') + '\n'; }
  function recordsToCSV(records) {
    const rows = records.map(v => ({ ...v, collection: (v.collections || []).join(' | '), tags: (v.tags || []).join(' | ') }));
    return [CSV_FIELDS.join(','), ...rows.map(v => CSV_FIELDS.map(f => csvEscape(v[f])).join(','))].join('\r\n') + '\r\n';
  }
  function inferCategory(text) {
    const t = safeString(text).toLowerCase();
    if (!t) return '';
    if (/(points?|miles?|transfer bonus|amex|chase sapphire|bilt|award (flight|travel|space)|airline loyalty)/.test(t)) return 'Points & miles';
    if (/(taiwan|taipei|台灣|台北|taichung|tainan|kaohsiung)/.test(t)) {
      if (/(food|eat|restaurant|night market|boba|cafe|coffee|brunch|noodle|dessert|美食|夜市)/.test(t)) return 'Taiwan · Food';
      if (/(shop|store|shopping|mall|boutique|buy|purchase|逛街|購物)/.test(t)) return 'Taiwan · Shopping';
      return 'Taiwan · Activities';
    }
    if (/(date night|date idea|romantic|anniversary|couple|dinner date)/.test(t)) return 'Dates & restaurants';
    if (/(trip|itinerary|vacation|destination|travel guide|things to do)/.test(t)) return 'Travel ideas';
    return '';
  }
  function toDate(v) {
    const s = safeString(v);
    if (!s) return '';
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const d = new Date(s); return !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
  }
  function createRecord(source = {}) {
    const getter = (...keys) => { for (const k of keys) {
      const val = source[k] ?? source[normalizeField(k)]; if (val !== undefined && val !== null && String(val).trim()) return val;
    } return ''; };
    const parsed = parseTikTokURL(getter('url', 'link', 'videoUrl', 'video landing page link', 'videolandingpagelink'));
    if (!parsed) return null;
    const title = safeString(getter('title', 'name'));
    const caption = safeString(getter('caption', 'description', 'videoDescription'));
    const notes = safeString(getter('notes', 'note'));
    const specifiedCategory = safeString(getter('category'));
    const category = (specifiedCategory && specifiedCategory !== 'Unsorted' ? specifiedCategory : inferCategory([title, caption, notes].join(' ')) || specifiedCategory) || 'Unsorted';
    return {
      id: safeString(source.id) || 'clip-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9),
      key: parsed.key, url: parsed.url, originalUrl: parsed.originalUrl,
      videoId: parsed.videoId, title, creator: safeString(getter('creator', 'username')),
      caption, notes, category: CATEGORIES.includes(category) ? category : 'Other',
      collections: uniq(splitList(getter('collections', 'collection'))),
      tags: uniq(splitList(getter('tags'))), place: safeString(getter('place', 'venue')),
      city: safeString(getter('city')), country: safeString(getter('country')),
      savedAt: toDate(getter('savedAt', 'Date', 'saveddate')),
      status: safeString(getter('status')) === 'reviewed' ? 'reviewed' : 'unreviewed',
      createdAt: safeString(source.createdAt) || isoNow(), updatedAt: isoNow()
    };
  }
  function getLink(o) {
    if (!o || typeof o !== 'object') return '';
    for (const [k, v] of Object.entries(o)) {
      if (['link', 'url', 'videolandingpagelink', 'videourl'].includes(normalizeField(k)) && typeof v === 'string') return v;
    }
    return '';
  }
  function getDate(o) {
    for (const [k, v] of Object.entries(o)) if (['date', 'timestamp', 'savedat'].includes(normalizeField(k))) return v;
    return '';
  }
  function extractTikTokFavorites(obj) {
    // TikTok export schemas vary. Only traverse favorite-video branches;
    // do NOT accidentally import likes, history, profile, DMs or share history.
    const output = [];
    const seen = new Set();
    const isFavoriteVideo = key => /favou?rite.*video|video.*favou?rite/.test(normalizeField(key));
    function collect(node, active, depth) {
      if (depth > 30 || !node) return;
      if (Array.isArray(node)) {
        for (const entry of node) collect(entry, active, depth + 1);
        return;
      }
      if (typeof node !== 'object') return;
      if (active) {
        const link = getLink(node);
        const p = parseTikTokURL(link);
        if (p && !seen.has(p.key)) {
          seen.add(p.key); output.push({ url: link, savedAt: toDate(getDate(node)), source: 'tiktok-export' });
        }
      }
      for (const [key, value] of Object.entries(node)) collect(value, active || isFavoriteVideo(key), depth + 1);
    }
    collect(obj, false, 0);
    // Accept an explicitly exported array of favorites, but never assume random full-account data is favorites.
    if (!output.length && Array.isArray(obj)) {
      for (const value of obj) {
        const p = parseTikTokURL(getLink(value));
        if (p && !seen.has(p.key)) { seen.add(p.key); output.push({ url: getLink(value), savedAt: toDate(getDate(value)) }); }
      }
    }
    return output;
  }
  function mergeRecords(existing, incoming) {
    const merged = existing.map(v => ({...v})); const index = new Map(merged.map((v, i) => [v.key, i]));
    let added = 0, duplicates = 0, updated = 0, invalid = 0;
    for (const entry of incoming) {
      const rec = createRecord(entry); if (!rec) { invalid++; continue; }
      if (!index.has(rec.key)) { index.set(rec.key, merged.length); merged.push(rec); added++; continue; }
      duplicates++; const prev = merged[index.get(rec.key)]; let changed = false;
      for (const field of ['title','creator','caption','notes','place','city','country','savedAt']) {
        if (!prev[field] && rec[field]) { prev[field] = rec[field]; changed = true; }
      }
      if ((prev.category === 'Unsorted' || !prev.category) && rec.category !== 'Unsorted') { prev.category = rec.category; changed = true; }
      for (const field of ['collections','tags']) {
        const combined = uniq([...(prev[field] || []), ...(rec[field] || [])]);
        if (combined.length !== (prev[field] || []).length) { prev[field] = combined; changed = true; }
      }
      if (changed) { prev.updatedAt = isoNow(); updated++; }
    }
    return { records: merged, added, duplicates, updated, invalid };
  }
  function planMarkdown(items, records, title) {
    const byId = new Map(records.map(v => [v.id, v]));
    const groups = new Map();
    for (const entry of items) { if (!byId.has(entry.recordId)) continue;
      const key = Math.max(1, Math.min(14, Number(entry.day) || 1));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...entry, record: byId.get(entry.recordId) });
    }
    let out = '# ' + (safeString(title) || 'My saved TikTok itinerary') + '\n\n';
    for (const [day, entries] of [...groups.entries()].sort((a,b) => a[0]-b[0])) {
      out += '## Day ' + day + '\n\n';
      for (const [i, entry] of entries.entries()) {
        const r = entry.record;
        out += `${i + 1}. **${r.title || r.place || 'Saved TikTok'}**`;
        const loc = [r.place, r.city, r.country].filter(Boolean).join(', ');
        if (loc) out += ` — ${loc}`;
        out += '\n   - Source: ' + r.url + '\n';
        if (entry.note) out += '   - Plan: ' + entry.note.replace(/\s+/g,' ') + '\n';
        if (r.notes) out += '   - Notes: ' + r.notes.replace(/\s+/g,' ') + '\n';
      }
      out += '\n';
    }
    return out + '> Locations, opening hours and travel times have not been independently verified.\n';
  }
  return { CATEGORIES, parseTikTokURL, parseCSV, csvTemplate, recordsToCSV, extractTikTokFavorites, createRecord, mergeRecords, inferCategory, planMarkdown };
});
