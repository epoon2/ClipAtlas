/* ClipAtlas: pure import and library helpers. No network requests or dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ClipAtlasCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com',
    'vt.tiktok.com', 'tiktokv.com', 'www.tiktokv.com']);
  const isoNow = () => new Date().toISOString();
  const safeString = (v) => typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
  const splitList = (v) => Array.isArray(v) ? v.map(safeString).filter(Boolean) : safeString(v).split(/[|;,]/).map(s => s.trim()).filter(Boolean);
  const uniq = values => [...new Set(values.filter(Boolean))];
  const normalizeField = value => safeString(value).toLowerCase().replace(/[^a-z0-9]/g, '');

  // Invisible characters and wrappers that ride along with copied links.
  const INVISIBLE = /[\u00a0\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;
  const INVISIBLE_ENCODED = /%C2%A0|%E2%80%(?:8[B-F]|A[8-E])|%E2%81%A[0-4]|%EF%BB%BF/gi;
  function cleanLink(input) {
    let s = safeString(input).replace(INVISIBLE, '').replace(INVISIBLE_ENCODED, '').trim();
    return s.replace(/^[<"'(\[]+/, '').replace(/[>"')\].,;:!?]+$/, '').trim();
  }
  // /@creator/video/ID, /share/video/ID (TikTok's export), /video/ID, /v/ID.html,
  // /embed/v2/ID, and the same for /photo/ posts.
  const VIDEO_PATHS = [
    /^\/@[\w.-]{1,64}\/(?:video|photo)\/(\d{8,25})\/?$/i,
    /^\/(?:share\/)?(?:video|photo)\/(\d{8,25})\/?$/i,
    /^\/v\/(\d{8,25})(?:\.html)?\/?$/i,
    /^\/embed(?:\/v2)?\/(\d{8,25})\/?$/i
  ];
  function parseTikTokURL(input) {
    const raw = cleanLink(input);
    if (!raw) return null;
    let u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw); }
    catch (_) { return null; }
    if (!['http:', 'https:'].includes(u.protocol) || !HOSTS.has(u.hostname.toLowerCase()) || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/{2,}/g, '/');
    for (const re of VIDEO_PATHS) {
      const match = path.match(re);
      if (match) return { url: 'https://' + host + (path.replace(/\/+$/, '') || '/'), key: 'tiktok:' + match[1], videoId: match[1], originalUrl: raw };
    }
    // Short links cannot be linked to their long video IDs without resolving redirects.
    // Preserve the short path; never guess a matching video or make a network request.
    const short = path.replace(/\/+$/, '') || '/';
    const normalized = 'https://' + host + short;
    if (short === '/') return null;
    return { url: normalized, key: 'link:' + normalized.toLowerCase(), videoId: '', originalUrl: raw };
  }
  // What the last metadata lookup found, in one word. Older records only have
  // enrichmentStatus ('metadata' was also set when TikTok returned nothing).
  const ANALYSIS_LABELS = {
    enriched: 'Filled in', empty: 'No useful details', unavailable: 'Not public or removed',
    failed: 'Lookup failed (will retry)', rejected: 'Link not accepted', not_analyzed: 'Not analyzed yet'
  };
  function analysisState(r) {
    const status = r && r.enrichment && r.enrichment.status;
    if (status && ANALYSIS_LABELS[status]) return status;
    if (r && r.enrichmentStatus === 'metadata') return (r.title || r.creator) ? 'enriched' : 'empty';
    if (r && r.enrichmentStatus === 'unavailable') return 'unavailable';
    return 'not_analyzed';
  }
  // Worth looking up (again)? Never-analyzed links, failures, refused links (the
  // rules may have changed) and old empty results; "not public" and "no useful
  // details" are tried again only after a week.
  function needsAnalysis(r, now = Date.now()) {
    if (!r || r.status === 'reviewed' || !r.url) return false;
    const state = analysisState(r);
    if (state === 'enriched') return false;
    if (state === 'unavailable' || state === 'empty') {
      const at = Date.parse((r.enrichment && r.enrichment.at) || r.enrichedAt || '');
      const legacyEmpty = !r.enrichment && state === 'empty';
      return legacyEmpty || !(at > now - 7 * 86400000);
    }
    return true;
  }
  function cleanEnrichment(e) {
    if (!e || typeof e !== 'object' || !ANALYSIS_LABELS[e.status] || e.status === 'not_analyzed') return undefined;
    return { status: e.status, reason: safeString(e.reason).slice(0, 40), retryable: !!e.retryable,
      at: safeString(e.at).slice(0, 40) };
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
    const category = categoryName(getter('category')) || 'Unsorted';
    return {
      id: safeString(source.id) || 'clip-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9),
      key: parsed.key, url: parsed.url, originalUrl: parsed.originalUrl,
      videoId: parsed.videoId, title, creator: safeString(getter('creator', 'username')),
      caption, notes, category,
      collections: uniq(splitList(getter('collections', 'collection'))),
      tags: uniq(splitList(getter('tags'))), place: safeString(getter('place', 'venue')),
      city: safeString(getter('city')), country: safeString(getter('country')),
      savedAt: toDate(getter('savedAt', 'Date', 'saveddate')),
      status: safeString(getter('status')) === 'reviewed' ? 'reviewed' : 'unreviewed',
      enrichment: cleanEnrichment(source.enrichment),
      enrichmentStatus: ['metadata', 'unavailable'].includes(source.enrichmentStatus) ? source.enrichmentStatus : undefined,
      enrichedAt: safeString(source.enrichedAt) || undefined,
      autoSorted: cleanAutoSorted(source.autoSorted),
      auto: cleanAuto(source.auto), autoReviewed: source.autoReviewed === true || undefined,
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
  /* ---- Categories each account makes for itself ------------------------------
     A category is {id, name, emoji, words}. Clips refer to it by name ("Unsorted"
     is built in and never stored). "words" are sort words: a clip whose title,
     caption, notes or tags contain them is suggested for that category. A word
     with "+" needs every part, so "taipei+food" matches "Taipei street food". */
  const CATEGORY_MAX = 100;
  const splitWords = v => Array.isArray(v) ? v : safeString(v).split(/[,\n，、]/);
  function categoryName(value) {
    const name = safeString(value).replace(/\s+/g, ' ').slice(0, 40);
    const renamed = LEGACY_RENAMES[name] || name;
    return renamed.toLowerCase() === 'unsorted' ? '' : renamed;
  }
  function cleanWord(word) {
    return safeString(word).toLowerCase().replace(/\s+/g, ' ').replace(/\s*\+\s*/g, '+')
      .replace(/^\++|\++$/g, '').slice(0, 40);
  }
  function newId() { return 'cat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function normalizeCategories(list) {
    const out = [], seen = new Set();
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c !== 'object') continue;
      const name = categoryName(c.name);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ id: safeString(c.id).slice(0, 40) || newId(), name, emoji: safeString(c.emoji).slice(0, 8) || '🔖',
        words: uniq(splitWords(c.words).map(cleanWord)).slice(0, 40) });
      if (out.length >= CATEGORY_MAX) break;
    }
    return out;
  }
  const fromSpec = rows => rows.map(([name, emoji, words]) => ({ name, emoji, words }));

  // Starter sets offered when an account is new (and in Settings later).
  const STARTERS = {
    travel: { label: 'Travel planning', blurb: 'Food, shops, sights and trip days', hero: 'All the places you saved.', tabs: { itinerary: true }, categories: [
      ['Food', '🍜', 'restaurant, food, eat, cafe, brunch, dessert, night market, street food, boba'],
      ['Shopping', '🛍️', 'shopping, shop, store, mall, haul, souvenir'],
      ['Things to do', '🏞️', 'things to do, hike, museum, attraction, beach, park, temple, viewpoint'],
      ['Stays', '🏨', 'hotel, hostel, airbnb, resort, where to stay'],
      ['Travel tips', '🧳', 'itinerary, packing, travel tips, visa, flight, airport'],
      ['Points & miles', '✈️', 'points, miles, transfer partner, transfer bonus, credit card, amex, chase sapphire, award flight']] },
    research: { label: 'Research', blurb: 'Explainers, studies and how-tos on a topic', hero: 'All the things you learned.', tabs: { itinerary: false }, categories: [
      ['Explainers', '💡', 'explained, what is, why do, how does, history of, breakdown'],
      ['Studies & data', '📊', 'study, studies, research, data, statistics, survey, percent, according to'],
      ['How-to', '🛠️', 'how to, tutorial, step by step, guide, tips'],
      ['Opinions', '💬', 'opinion, hot take, unpopular opinion, debate, review'],
      ['Resources', '📚', 'book, podcast, website, app, tool, course']] },
    recipes: { label: 'Recipes & cooking', blurb: 'Dinners, baking and quick meals', hero: 'All the recipes you saved.', tabs: { itinerary: false }, categories: [
      ['Dinners', '🍲', 'dinner, pasta, chicken, beef, noodles, rice, curry, stir fry'],
      ['Baking', '🧁', 'bake, baking, cake, cookie, bread, muffin, pastry'],
      ['Quick & easy', '⏱️', 'quick, easy, 15 minute, 10 minute, air fryer, one pot, meal prep'],
      ['Healthy', '🥗', 'healthy, salad, high protein, low carb, vegan, vegetarian'],
      ['Drinks', '🍹', 'drink, smoothie, coffee, tea, cocktail, mocktail']] },
    shopping: { label: 'Shopping & finds', blurb: 'Clothes, beauty, home and gifts', hero: 'All the finds you saved.', tabs: { itinerary: false }, categories: [
      ['Clothes', '👗', 'outfit, clothes, dress, jeans, jacket, shoes, haul'],
      ['Beauty', '💄', 'skincare, makeup, serum, sunscreen, hair, beauty'],
      ['Home', '🏠', 'home, decor, kitchen, organization, cleaning, furniture'],
      ['Tech', '🎧', 'tech, gadget, phone, laptop, headphones, charger'],
      ['Gifts', '🎁', 'gift, gift ideas, present, birthday']] },
    empty: { label: 'Start empty', blurb: 'No categories yet: make your own', hero: 'All the videos you saved.', tabs: { itinerary: false }, categories: [] }
  };
  // The first version's fixed list. Accounts from before custom categories keep
  // it (with sort words that need Taiwan and the topic together).
  const LEGACY = [
    ['Taiwan · Food', '🍜', 'taiwan+food, taipei+food, taiwan+restaurant, taipei+restaurant, taipei+cafe, night market, 夜市, 小吃, 美食, 珍珠奶茶'],
    ['Taiwan · Shopping', '🛍️', 'taiwan+shopping, taipei+shopping, taiwan+shop, taipei+shop, 逛街, 購物, 伴手禮'],
    ['Taiwan · Activities', '🏮', 'taiwan+things to do, taipei+things to do, taiwan+itinerary, taipei+attractions, 九份, 十分, 景點'],
    ['Dates & restaurants', '🌷', 'date night, date idea, romantic, anniversary, couples, 約會'],
    ['Travel ideas', '🧳', 'travel, vacation, itinerary, things to do, trip, hotel'],
    ['Points & miles', '✈️', 'points, miles, transfer partner, transfer bonus, amex, chase sapphire, capital one, bilt, award flight'],
    ['Other', '🔖', '']
  ];
  // Names the first version's analysis wrote by mistake.
  const LEGACY_RENAMES = { 'Taiwan Food': 'Taiwan · Food', 'Taiwan Shopping': 'Taiwan · Shopping',
    'Taiwan Activities': 'Taiwan · Activities', 'Date Ideas': 'Dates & restaurants',
    'Credit Card Points': 'Points & miles', 'Travel': 'Travel ideas', 'Uncategorized': 'Unsorted' };
  const TABS = ['itinerary'];

  function cleanSettings(x) {
    const purpose = x && (STARTERS[x.purpose] || x.purpose === 'custom') ? x.purpose : 'custom';
    const tabs = x && x.tabs && typeof x.tabs === 'object' ? x.tabs : {};
    return { purpose, tabs: Object.fromEntries(TABS.map(t => [t, tabs[t] !== false])) };
  }
  /** {state, migrated, needsChoice}: a library with categories and settings.
      A brand-new account (nothing saved yet) needs to pick a starter set. */
  function ensureSetup(input) {
    const state = { ...input };
    if (Array.isArray(state.categories)) {
      state.categories = normalizeCategories(state.categories);
      state.settings = cleanSettings(state.settings || { purpose: 'custom' });
      return { state, migrated: false, needsChoice: false };
    }
    const records = Array.isArray(state.records) ? state.records : [];
    const used = records.length || (state.plan || []).length || (state.collections || []).length;
    if (!used) return { state, migrated: false, needsChoice: true };
    state.records = records.map(r => {
      const name = categoryName(r.category);
      return name === r.category ? r : { ...r, category: name || 'Unsorted' };
    });
    const list = fromSpec(LEGACY);
    for (const r of state.records) {
      const name = categoryName(r.category);
      if (name && !list.some(c => c.name.toLowerCase() === name.toLowerCase())) list.push({ name, emoji: '🔖', words: [] });
    }
    state.categories = normalizeCategories(list);
    state.settings = cleanSettings(state.settings || { purpose: 'travel', tabs: { itinerary: true } });
    return { state, migrated: true, needsChoice: false };
  }
  /** Add a starter set's categories (keeping the account's own) and, unless
      {keepTabs:true}, switch to its tabs. */
  function applyStarter(state, key, { keepTabs = false } = {}) {
    const starter = STARTERS[key];
    if (!starter) return state;
    const categories = normalizeCategories([...(state.categories || []), ...fromSpec(starter.categories)]);
    const settings = keepTabs ? cleanSettings(state.settings) : cleanSettings({ purpose: key, tabs: starter.tabs });
    return { ...state, categories, settings };
  }

  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function hasWord(text, part) {
    // Phrases, long words and non-Latin words match anywhere (so "food" is
    // found in #taiwanfood); short Latin words only as whole words.
    if (/[^ -~]/.test(part) || part.length >= 4 || part.includes(' ')) return text.includes(part);
    return new RegExp('(^|[^a-z0-9])' + escapeRe(part) + 's?($|[^a-z0-9])').test(text);
  }
  /** The best category for a text, or null: {name, words}. The category with
      the most matching sort words wins ("a+b" counts as two); a tie goes to the
      one higher in the list. */
  function suggestCategory(text, categories) {
    const t = ' ' + safeString(text).toLowerCase().replace(/\s+/g, ' ') + ' ';
    if (!t.trim()) return null;
    let best = null;
    for (const c of categories || []) {
      let score = 0; const words = [];
      for (const w of c.words || []) {
        const parts = w.split('+').filter(Boolean);
        if (parts.length && parts.every(p => hasWord(t, p))) { score += parts.length; words.push(w); }
      }
      if (score > (best ? best.score : 0)) best = { name: c.name, words, score };
    }
    return best ? { name: best.name, words: best.words } : null;
  }
  function clipText(r) {
    return [r.title, r.caption, r.notes, (r.tags || []).join(' ')].filter(Boolean).join(' ');
  }
  /** Sort Unsorted clips into categories by their text. Changes the clips in
      place (r.category, and r.autoSorted saying why); returns how many moved. */
  function sortUnsorted(records, categories, now = isoNow()) {
    let moved = 0;
    for (const r of records) {
      if (r.category && r.category !== 'Unsorted') continue;
      const hit = suggestCategory(clipText(r), categories);
      if (!hit) continue;
      r.category = hit.name;
      r.autoSorted = { name: hit.name, words: hit.words.slice(0, 6), at: now };
      moved++;
    }
    return moved;
  }
  const AUTO_STATUSES = ['understood', 'empty', 'unavailable', 'failed'];
  function cleanAuto(a) {
    if (!a || typeof a !== 'object' || !AUTO_STATUSES.includes(a.status)) return undefined;
    return { status: a.status, reason: safeString(a.reason).slice(0, 40), at: safeString(a.at).slice(0, 40),
      heard: !!a.heard, seen: !!a.seen, transcript: safeString(a.transcript).slice(0, 1200),
      onScreen: safeString(a.onScreen).slice(0, 600), summary: safeString(a.summary).slice(0, 240) };
  }
  function cleanAutoSorted(a) {
    if (!a || typeof a !== 'object' || !safeString(a.name)) return undefined;
    return { name: safeString(a.name).slice(0, 40), words: (Array.isArray(a.words) ? a.words : []).map(cleanWord).filter(Boolean).slice(0, 6),
      at: safeString(a.at).slice(0, 40) };
  }
  /** {state} with the category renamed everywhere, or {error}. */
  function renameCategory(state, from, to) {
    const name = categoryName(to);
    if (!name) return { error: 'Give the category a name (not "Unsorted").' };
    const list = state.categories || [];
    if (list.some(c => c.name !== from && c.name.toLowerCase() === name.toLowerCase())) return { error: 'You already have a category called "' + name + '".' };
    return { state: { ...state,
      categories: list.map(c => c.name === from ? { ...c, name } : c),
      records: (state.records || []).map(r => r.category === from ? { ...r, category: name,
        autoSorted: r.autoSorted && r.autoSorted.name === from ? { ...r.autoSorted, name } : r.autoSorted } : r) } };
  }
  /** Remove a category; its clips move to ``moveTo`` (default Unsorted). */
  function deleteCategory(state, name, moveTo = 'Unsorted') {
    const target = moveTo && (state.categories || []).some(c => c.name === moveTo && c.name !== name) ? moveTo : 'Unsorted';
    return { ...state,
      categories: (state.categories || []).filter(c => c.name !== name),
      records: (state.records || []).map(r => r.category === name ? { ...r, category: target, autoSorted: undefined } : r) };
  }
  /** Make sure every category a clip uses is in the list (CSV imports, restores). */
  function addMissingCategories(state) {
    const list = [...(state.categories || [])];
    for (const r of state.records || []) {
      const name = categoryName(r.category);
      if (name && !list.some(c => c.name.toLowerCase() === name.toLowerCase())) list.push({ name, emoji: '🔖', words: [] });
    }
    return list.length === (state.categories || []).length ? state : { ...state, categories: normalizeCategories(list) };
  }

  /* ---- Review mode ------------------------------------------------------------
     TikTok's official embedded player plays a video by its ID in the viewer's
     own browser: no lookup, no rate limit. */
  function playerUrl(r, { auto = false } = {}) {
    const id = r && safeString(r.videoId);
    if (!/^\d{8,25}$/.test(id)) return '';
    // Auto-review hides the controls so they do not cover the text on the video.
    return `https://www.tiktok.com/player/v1/${id}?description=1&music_info=1&autoplay=1&rel=0` +
      (auto ? '&controls=0&closed_caption=0' : '');
  }

  /* ---- Auto-review ------------------------------------------------------------
     The page plays each clip in TikTok's player, records the tab's sound and
     takes screenshots of the player; the Worker turns those into the details
     below. These helpers are the parts that need no browser. */
  const AUTO_LABELS = { understood: 'Auto-reviewed', empty: 'Nothing heard or seen', unavailable: 'Would not play',
    failed: 'Auto-review failed' };
  /** Clips for an auto-review run: the scope's clips that can play and have
      not been tried yet (failed ones are tried again), or all with ``redo``. */
  function autoQueue(records, scope, { redo = false } = {}) {
    const byId = new Map((records || []).map(r => [r.id, r]));
    return reviewQueue(records, scope).filter(id => {
      const r = byId.get(id);
      return playerUrl(r) && (redo || !r.auto || r.auto.status === 'failed');
    });
  }
  /** One clip after auto-review: empty fields filled in, an Unsorted clip
      sorted, tags added, and what was heard and seen kept (searchable). What
      the person wrote is never replaced. */
  function applyUnderstanding(record, result, { markReviewed = true, now = isoNow() } = {}) {
    const res = result || {};
    const next = { ...record, tags: [...(record.tags || [])] };
    next.auto = cleanAuto({ ...res, status: AUTO_STATUSES.includes(res.status) ? res.status : 'failed', at: now });
    next.updatedAt = now;
    if (next.auto.status !== 'understood') return next;
    const fill = (key, value, n) => { if (!safeString(next[key]) && safeString(value)) next[key] = safeString(value).slice(0, n); };
    fill('title', res.title, 300); fill('place', res.place, 200); fill('city', res.city, 120); fill('country', res.country, 120);
    fill('caption', res.onScreen, 2000);
    const category = categoryName(res.category);
    if ((!next.category || next.category === 'Unsorted') && category && category !== 'Unsorted') {
      next.category = category; next.autoSorted = undefined;
    }
    next.tags = uniq([...next.tags, ...(Array.isArray(res.tags) ? res.tags.map(safeString) : [])]).slice(0, 20);
    if (markReviewed && next.status !== 'reviewed') { next.status = 'reviewed'; next.autoReviewed = true; }
    return next;
  }
  /** 16-bit mono WAV of ``samples`` (numbers from -1 to 1). */
  function wavBytes(samples, rate) {
    const n = samples.length, out = new Uint8Array(44 + n * 2), v = new DataView(out.buffer);
    const text = (at, s) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
    text(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data');
    v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, samples[i] || 0)); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return out;
  }
  /** Average ``samples`` from ``from`` Hz down to ``to`` Hz. */
  function downsample(samples, from, to) {
    if (to >= from) return Float32Array.from(samples);
    const ratio = from / to, n = Math.floor(samples.length / ratio), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio), b = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0; for (let j = a; j < b; j++) sum += samples[j];
      out[i] = b > a ? sum / (b - a) : 0;
    }
    return out;
  }
  function loudness(samples) {
    let sum = 0; for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return samples.length ? Math.sqrt(sum / samples.length) : 0;
  }
  /** The seconds at which to take the screenshots, for a clip listened to for ``limit`` seconds. */
  function shotTimes(limit) {
    const want = [1.2, limit * 0.45, limit * 0.8].filter(t => t < limit);
    return want.filter((t, i) => i === 0 || t - want[i - 1] >= 1);
  }
  const REVIEW_SCOPES = { review: 'Needs review', unsorted: 'Unsorted', all: 'All clips' };
  /** Clip ids to go through, newest saved first (the library's default order).
      scope: 'review' | 'unsorted' | 'all' | 'collection:<name>'. */
  function reviewQueue(records, scope) {
    const pick = scope === 'review' ? r => r.status !== 'reviewed'
      : scope === 'unsorted' ? r => !r.category || r.category === 'Unsorted'
        : String(scope || '').startsWith('collection:') ? r => (r.collections || []).includes(String(scope).slice(11))
          : () => true;
    return (records || []).filter(pick)
      .sort((a, b) => String(b.savedAt || b.createdAt || '').localeCompare(String(a.savedAt || a.createdAt || '')))
      .map(r => r.id);
  }
  /** One clip after a Review-mode save. ``fields`` holds what the form shows
      (title, category, place, city, country, tags, collections, notes, caption);
      ``reviewed`` is the checkbox; ``suggested`` the live suggestion, if the
      category came from it. The link, creator, dates and lookup results stay. */
  function reviewEdit(record, fields, { reviewed = true, suggested = null, now = isoNow() } = {}) {
    const next = createRecord({ ...record, ...fields, status: reviewed ? 'reviewed' : 'unreviewed' });
    if (!next) return null;
    next.id = record.id; next.originalUrl = record.originalUrl || next.originalUrl;
    next.autoReviewed = undefined;  // a person has looked at it now
    if (next.category === record.category) next.autoSorted = cleanAutoSorted(record.autoSorted);
    else if (suggested && suggested.name === next.category) next.autoSorted = { name: suggested.name, words: (suggested.words || []).slice(0, 6), at: now };
    else next.autoSorted = undefined;
    return next;
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
  return { playerUrl, REVIEW_SCOPES, reviewQueue, reviewEdit, clipText, AUTO_LABELS, autoQueue, applyUnderstanding, wavBytes, downsample, loudness, shotTimes, STARTERS, LEGACY, ensureSetup, applyStarter, normalizeCategories, suggestCategory, sortUnsorted, renameCategory, deleteCategory, addMissingCategories, categoryName, ANALYSIS_LABELS, cleanLink, analysisState, needsAnalysis, parseTikTokURL, parseCSV, csvTemplate, recordsToCSV, extractTikTokFavorites, createRecord, mergeRecords, planMarkdown };
});
