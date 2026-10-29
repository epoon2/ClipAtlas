/* The view-only page for a shared collection, itinerary or shared space (/s/<token>). Read only:
   it asks the Worker for what the link shares and draws it with the same helpers as the downloads. */
(() => {
  'use strict';
  const C = window.ClipAtlasCore, main = document.getElementById('viewMain');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const token = (/^\/s\/([a-f0-9]{32})\/?$/.exec(location.pathname) || [])[1];
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const dateText = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); };
  const KIND_WORD = { tiktok: 'TikTok', link: 'web page', note: 'note' };

  function fail(title, text) {
    main.removeAttribute('aria-busy');
    main.innerHTML = `<div class="v-error"><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Go to ClipAtlas</a></p></div>`;
  }
  // Table cells say what they are on a phone, where the table becomes a list.
  function label(root) {
    for (const table of root.querySelectorAll('table')) {
      const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
      for (const row of table.querySelectorAll('tbody tr')) [...row.children].forEach((td, i) => { if (heads[i] && heads[i] !== '#') td.dataset.label = heads[i]; });
    }
  }
  function card(r, emoji) {
    const where = [r.place, [r.city, r.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    const open = r.url ? `<a class="v-open" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open the ${KIND_WORD[r.kind] || 'link'} ↗</a>` : '';
    return `<article class="v-card"><div class="v-cat">${esc(emoji(r.category))} ${esc(r.category)}</div><h3>${esc(r.title || (r.kind === 'note' ? 'Note' : 'Saved ' + (KIND_WORD[r.kind] || 'item')))}</h3>`
      + (r.creator ? `<p class="v-where">by ${esc(r.creator)}</p>` : '') + (where ? `<p class="v-where">📍 ${esc(where)}</p>` : '')
      + (r.summary ? `<p>${esc(r.summary)}</p>` : '')
      + (r.places.length ? `<ul class="v-places" aria-label="Places">${r.places.map(p => `<li>${esc(C.PLACE_EMOJI[p.type] || '📍')} ${esc(p.name)}${p.note ? ' – ' + esc(p.note) : ''}</li>`).join('')}</ul>` : '')
      + (r.body ? `<div class="v-note">${esc(r.body)}</div>` : '') + (r.notes ? `<div class="v-note"><strong>Notes:</strong> ${esc(r.notes)}</div>` : '') + open + '</article>';
  }

  function draw(v) {
    document.title = v.title + ' · shared by ' + (v.owner || 'someone');
    const cats = new Map((v.categories || []).map(c => [c.name, c.emoji]));
    const emoji = name => cats.get(name) || (name === 'Unsorted' ? '✦' : '🔖');
    const records = v.records || [], name = (v.collections || [])[0] || '';
    const info = (v.collectionInfo || {})[name], report = (v.reports || {})[name];
    const tabs = [];
    if (v.kind === 'itinerary' && v.plan.length) tabs.push(['plan', 'Itinerary']);
    tabs.push(['items', 'Saved items (' + records.length + ')']);
    const layout = v.kind === 'itinerary' ? 'places' : C.collectionLayout(info, records);
    if (layout === 'topics' && report && report.groups.length) tabs.push(['research', 'Research']);
    else {
      const places = C.placeReport(records, { aliases: v.placeAliases });
      if (places.places) tabs.push(['places', 'Places by city', places]);
    }
    if (v.kind === 'space' && v.plan.length) tabs.push(['plan', 'Itinerary']);
    const kicker = v.kind === 'itinerary' ? 'Trip itinerary' : v.kind === 'space' ? 'Shared collection' : 'Collection';
    let out = `<section class="v-head"><div class="v-kicker">${kicker}</div><h1>${esc(v.title)}</h1>`
      + `<p class="v-meta">Shared by ${esc(v.owner || 'a ClipAtlas user')}${v.updatedAt ? ' · updated ' + esc(dateText(v.updatedAt)) : ''} · ${plural(records.length, 'saved item', 'saved items')}</p>`
      + (info && info.about ? `<p class="v-about">${esc(info.about)}</p>` : '') + '</section>';
    if (tabs.length > 1) out += `<div class="v-tabs" role="tablist">${tabs.map(([id, text], i) => `<button type="button" role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${i === 0}" data-tab="${id}">${esc(text)}</button>`).join('')}</div>`;
    for (const [i, [id, , extra]] of tabs.entries()) {
      let body = '';
      if (id === 'items') body = records.length ? `<div class="v-grid">${records.map(r => card(r, emoji)).join('')}</div>` : '<p class="v-empty">Nothing saved here yet.</p>';
      else if (id === 'places') body = C.reportBody(extra);
      else if (id === 'research') body = C.topicBody(report, records);
      else if (id === 'plan') body = C.planBody(v.plan, records, v.dayCities) + '<p><small>Places, opening hours and travel times are as saved; check them before you go.</small></p>';
      out += `<section class="v-panel" id="panel-${id}" role="tabpanel" aria-labelledby="tab-${id}"${i ? ' hidden' : ''}>${body}</section>`;
    }
    main.innerHTML = out;
    main.removeAttribute('aria-busy');
    label(main);
    for (const a of main.querySelectorAll('.v-panel a[href^="http"]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    main.querySelector('.v-tabs')?.addEventListener('click', e => {
      const b = e.target.closest('[data-tab]'); if (!b) return;
      for (const t of main.querySelectorAll('[role="tab"]')) t.setAttribute('aria-selected', String(t === b));
      for (const p of main.querySelectorAll('.v-panel')) p.hidden = p.id !== 'panel-' + b.dataset.tab;
    });
  }

  if (!token) { fail('This link isn’t complete', 'Check that the whole link was copied.'); return; }
  fetch('/api/view/' + token, { credentials: 'omit', cache: 'no-store' })
    .then(async res => { const json = await res.json().catch(() => ({})); if (!res.ok) throw Object.assign(new Error(json.error || 'Could not load this page.'), { status: res.status }); return json.view; })
    .then(draw)
    .catch(err => fail(err.status === 404 ? 'This link was turned off' : 'Could not load this page', err.status === 404 ? 'Whoever shared it may have turned the link off, or it was copied wrong.' : err.message));
})();
