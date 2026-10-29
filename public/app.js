/* ClipAtlas UI. Account data is saved to its own Cloudflare D1 library. */
(() => {
  'use strict';
  const C = window.ClipAtlasCore;
  const Cloud = window.ClipAtlasCloud;
  if (!C) throw new Error('Missing core.js');
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const html = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const emptyState = () => ({ version: 1, records: [], collections: [], plan: [], tripTitle: 'My saved TikTok itinerary', dayCount: 7, dayCities: {}, questions: [] });
  let state = emptyState();
  let currentTab = 'library', activeCollection = '', editingId = null, saveTimer = null;
  let selecting = false; const selected = new Set();  // choosing many clips at once
  let toastTimer = null;

  function toast(message, action) {
    const el = $('#toast'); el.textContent = message; el.classList.toggle('with-action', !!action);
    if (action) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-action'; b.textContent = action.label;
      b.onclick = () => { el.classList.remove('shown'); action.run(); };
      el.append(' ', b);
    }
    el.classList.add('shown');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('shown'), action ? 12000 : 4500);
  }
  function dbOpen() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB is unavailable'));
      const req = indexedDB.open('ClipAtlasLibrary', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('state')) req.result.createObjectStore('state'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbGet() {
    const db = await dbOpen();
    try { return await new Promise((res, rej) => { const t = db.transaction('state','readonly');
      const req = t.objectStore('state').get('library'); req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
    }); } finally { db.close(); }
  }
  async function dbSet(value) {
    const db = await dbOpen();
    try { await new Promise((res, rej) => { const t = db.transaction('state','readwrite');
      t.objectStore('state').put(value, 'library'); t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    }); } finally { db.close(); }
  }
  async function load() {
    try { const value = await dbGet(); if (value) return value; } catch (_) { /* browser file:// may restrict IndexedDB */ }
    try { return JSON.parse(localStorage.getItem('ClipAtlasLibraryBackup') || 'null'); } catch (_) { return null; }
  }
  async function write(value) {
    try { await dbSet(value); return 'IndexedDB'; }
    catch (_) {
      try { localStorage.setItem('ClipAtlasLibraryBackup', JSON.stringify(value)); return 'localStorage'; }
      catch (_) { throw new Error('Browser storage is unavailable or full. Export a JSON backup now.'); }
    }
  }
  let saveBusy = false, dirty = false, saveBlocked = false;
  async function persist() {
    dirty = true;
    if(saveBusy || saveBlocked) return;
    saveBusy = true;
    try {
      while(dirty && !saveBlocked) {
        dirty = false;
        const snapshot = JSON.parse(JSON.stringify(state));
        $('#saveStatus').textContent = 'Saving…';
        await Cloud.save(snapshot);
        $('#saveStatus').textContent = 'Saved to your account';
      }
    } catch(err) {
      saveBlocked = true;
      $('#saveStatus').textContent = 'Save failed — export backup';
      toast(err.message + ' Download a backup now.');
      $('#exportBackup').focus();
    } finally {saveBusy=false;}
  }
  const commit = () => { render(); clearTimeout(saveTimer); saveTimer = setTimeout(()=>{saveTimer=null;persist();}, 120); };
  const download = (filename, text, mime) => {
    const blob = new Blob([text], {type:mime}); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=filename; a.style.display='none';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url),1500);
  };
  // The account's own categories (Settings), and its optional tabs.
  const categoryList = () => Array.isArray(state.categories) ? state.categories : [];
  const emojiFor = name => name === 'Unsorted' ? '✦' : (categoryList().find(c => c.name === name)?.emoji || '🔖');
  const tabOn = tab => state.settings?.tabs?.[tab] !== false;
  function fillCategorySelect(select, withAll) {
    const keep = select.value;
    const names = ['Unsorted', ...categoryList().map(c => c.name)];
    select.innerHTML = (withAll ? '<option value="all">All categories</option>' : '') +
      names.map(n => `<option value="${html(n)}">${html(n === 'Unsorted' ? 'Unsorted' : emojiFor(n) + ' ' + n)}</option>`).join('');
    select.value = [...select.options].some(o => o.value === keep) ? keep : (withAll ? 'all' : 'Unsorted');
  }
  function applyTabs() {
    const on = tabOn('itinerary');
    for (const el of $$('[data-tab="itinerary"]')) el.hidden = !on;
    $('#statPlanCard').hidden = !on;
    if (!on && currentTab === 'itinerary') selectTab('library');
    const starter = C.STARTERS[state.settings?.purpose];
    $('#heroTitle').textContent = starter ? starter.hero : 'All the videos you saved.';
    $('#heroLine').textContent = on ? 'Collect the clips. Capture the details. Plan the actual trip.' : 'Collect the clips. Capture the details. Find them again.';
  }
  const listCollections = () => [...new Set([...state.collections, ...state.records.flatMap(r => r.collections || [])])].sort((a,b)=>a.localeCompare(b));
  function selectTab(tab) {
    if (!['library','itinerary','import','settings'].includes(tab) || (tab==='itinerary' && !tabOn('itinerary'))) return;
    if(tab!=='library'&&selecting){selecting=false;selected.clear();document.body.classList.remove('selecting');}
    currentTab=tab;
    $$('.page').forEach(x=>x.classList.toggle('active',x.id===tab+'Page'));
    $$('.nav-link').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
    $('#crumb').textContent=({library:'DISCOVERIES',itinerary:'ITINERARY',import:'IMPORT & BACKUP',settings:'SETTINGS'})[tab];
    if (tab==='library') renderLibrary(); else if(tab==='itinerary') renderItinerary(); else if(tab==='settings') renderSettings();
    window.scrollTo(0,0);
  }
  function renderCollections() {
    const total=state.records.length; $('#navCount').textContent=total;
    let out = `<button class="collection-link ${!activeCollection?'active':''}" data-collection=""><span>✦ All collections</span><small>${total}</small></button>`;
    for (const name of listCollections()) {
      const count=state.records.filter(r=>(r.collections||[]).includes(name)).length;
      out+=`<button class="collection-link ${activeCollection===name?'active':''}" data-collection="${html(name)}"><span>▣ ${html(name)}</span><small>${count}</small></button>`;
    }
    $('#collectionNav').innerHTML=out;
  }
  function renderStats() {
    $('#statClips').textContent=state.records.length;
    $('#statCollections').textContent=listCollections().length;
    $('#statReview').textContent=state.records.filter(x=>C.isClip(x)&&x.status!=='reviewed').length;
    $('#statPlan').textContent=state.plan.length;
  }
  /* ---- Ask about a collection: the AI answers from what the collection's clips hold ---- */
  // The items asked about: the open collection (or every clip), newest saved first.
  const scopeRecords=()=>state.records.filter(r=>!activeCollection||(r.collections||[]).includes(activeCollection))
    .sort((a,b)=>String(b.savedAt||b.createdAt||'').localeCompare(String(a.savedAt||a.createdAt||'')));
  let asking=false,aiConfigLoaded=false;
  const reading=new Set();   // web pages and notes the AI is reading right now
  const hostOf=u=>{try{return new URL(u).hostname.replace(/^www\./,'');}catch(_){return '';}};
  const askSay=t=>{$('#askStatus').textContent=t;};
  function renderAsk(){
    const panel=$('#askPanel');if(!panel)return;
    panel.hidden=!state.records.length;if(panel.hidden)return;
    const recs=scopeRecords(),scope=activeCollection||'';
    $('#askScope').textContent=scope||'all your clips';
    $('#askCount').textContent=plural(recs.length,'item','items');
    const city=(C.cityList(recs)[0]||{}).name;
    const examples=[city&&`What should I eat in ${city}?`,'Which places do several clips recommend?','List every place by city, then food, sights, shopping and activities.',
      city&&`What should I not miss in ${city}, and what can I skip?`,'Summarize the tips in these.'].filter(Boolean).slice(0,4);
    $('#askExamples').innerHTML=examples.map(q=>`<button type="button" class="chip ask-example" data-action="ask-example" data-q="${html(q)}">${html(q)}</button>`).join('');
    $('#askInput').placeholder=scope?`Ask anything about “${scope}”: where to eat in a city, which places several sources recommend, everything sorted by city and then food, sights, activities and shopping…`
      :'Ask anything about your saved clips: where to eat in a city, which places several sources recommend, everything sorted by city…';
    const byId=new Map(state.records.map(r=>[r.id,r]));
    $('#askAnswers').innerHTML=(state.questions||[]).filter(q=>q.scope===scope).map(q=>{
      const sources=q.ids.map(id=>{const r=byId.get(id);return r?{id:r.id,title:r.title||r.place||'',url:r.kind==='note'?'':r.url}:null;});
      const when=q.at?new Date(q.at).toLocaleDateString([],{month:'short',day:'numeric'}):'';
      return `<article class="ask-item"><p class="ask-q">${html(q.q)}</p><div class="ask-a">${C.renderAnswer(q.a,sources)}</div><p class="ask-meta">${html([when,`from ${plural(q.count,'item','items')}`,q.model].filter(Boolean).join(' · '))} <button type="button" class="link-inline" data-action="ask-again" data-id="${html(q.id)}">Ask again</button> <button type="button" class="link-inline" data-action="ask-delete" data-id="${html(q.id)}">Delete</button></p></article>`;
    }).join('');
  }
  // Gemini first (its stronger model; the whole collection fits); else Cloudflare with shorter sources.
  async function askNow(question,replaceId=''){
    question=String(question||'').trim();if(!question||asking)return false;
    const recs=scopeRecords(),scope=activeCollection||'';
    if(!recs.length){askSay('There is nothing in this collection yet.');return false;}
    asking=true;$('#askButton').disabled=true;$('#askPanel').open=true;
    let out=null;
    try{
      if(!aiConfigLoaded){await loadAIConfig();aiConfigLoaded=true;}
      if(aiConfig.gemini){
        const src=C.askSources(recs,{budget:400000});
        const body=JSON.stringify(C.askRequest(C.askPrompt(question,{scope,sources:src.text,count:src.count,left:src.left})));
        for(let tries=0;tries<3&&!out;tries++){
          askSay(`Reading ${plural(src.count,'item','items')} with Gemini…`);
          const res=await geminiPost(body,'ask');
          if(res.status==='ok'&&res.text){out={text:res.text,model:res.model,ids:src.ids,count:src.count};break;}
          if(res.stopRun){askSay(res.message);return false;}
          if(res.reason==='GEMINI_BUSY'){const wait=Math.min(60,Math.max(2,res.retryAfter||20));askSay(`Gemini asked to wait ${wait} seconds…`);await new Promise(ok=>setTimeout(ok,wait*1000));continue;}
          break;
        }
      }
      if(!out&&aiConfig.cloudflare){
        const src=C.askSources(recs,{budget:60000});
        askSay(`Reading ${plural(src.count,'item','items')} with Cloudflare's AI…`);
        let res;
        try{const r=await fetch('/api/ask',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
          body:JSON.stringify({prompt:C.askPrompt(question,{scope,sources:src.text,count:src.count,left:src.left})})});res=await r.json().catch(()=>({}));
          if(r.status===401)res={status:'failed',error:'Your sign-in expired. Sign in again, then ask again.'};}
        catch(_){res={status:'failed',error:'connection problem'};}
        if(res.status==='ok'&&res.text)out={text:res.text,model:res.model,ids:src.ids,count:src.count};
        else{askSay(res.reason==='AI_DAILY_LIMIT'?allowanceMessage(true):`That did not work: ${res.error||res.detail||res.message||res.reason||'no answer'}`);return false;}
      }
      if(!out){askSay('No AI is set up to answer (see the README: Gemini or Cloudflare).');return false;}
      const entry={id:'ask-'+Date.now().toString(36),scope,q:question,a:out.text,ids:out.ids,at:new Date().toISOString(),model:out.model||'',count:out.count};
      state.questions=C.cleanQuestions([entry,...(state.questions||[]).filter(q=>q.id!==replaceId)]);
      askSay('');commit();return true;
    }finally{asking=false;$('#askButton').disabled=false;}
  }
  function renderLibrary() {
    renderStats(); renderCollections(); renderAsk();
    const q=$('#search').value.toLocaleLowerCase().trim();
    const category=$('#categoryFilter').value, status=$('#statusFilter').value, analysis=$('#analysisFilter').value;
    let records=state.records.filter(r=>(!activeCollection || (r.collections||[]).includes(activeCollection))
      && (category==='all'||r.category===category)
      && (status==='all'||(status==='auto'?r.autoReviewed===true:r.status===status))
      && (analysis==='all'||C.analysisState(r)===analysis)
      && (!q || [r.title,r.url,r.creator,r.caption,r.notes,r.body,(r.places||[]).map(p=>p.name+' '+(p.note||'')).join(' '),r.category,r.place,r.city,r.country,(r.collections||[]).join(' '),(r.tags||[]).join(' '),r.auto?.transcript,r.auto?.onScreen,r.auto?.summary].join(' ').toLocaleLowerCase().includes(q)));
    const sort=$('#sortFilter').value;
    records.sort((a,b) => sort==='title'?(a.title||a.place||'').localeCompare(b.title||b.place||''):
      sort==='oldest'?(a.savedAt||a.createdAt).localeCompare(b.savedAt||b.createdAt):(b.savedAt||b.createdAt).localeCompare(a.savedAt||a.createdAt));
    shownIds=records.map(r=>r.id);
    renderBulkBar();
    $('#filteredCount').textContent=records.every(C.isClip)?records.length+' '+(records.length===1?'clip':'clips'):plural(records.length,'item','items');
    $('#libraryEmpty').hidden=records.length!==0;
    const asPlaces=libraryView==='places';
    for(const b of $$('[data-lib-view]')){const on=b.dataset.libView===libraryView;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));}
    $('#clipGrid').hidden=asPlaces;$('#placesReport').hidden=!asPlaces;
    if(asPlaces){$('#clipGrid').innerHTML='';renderReport(records);return;}
    $('#placesReport').innerHTML='';
    $('#clipGrid').innerHTML=records.map(r=>{
      const clip=C.isClip(r),host=r.kind==='link'?hostOf(r.url):'';
      const title=r.title||r.place||(clip?'Untitled saved TikTok':host||'Untitled note');
      const loc=[r.place,r.city,r.country].filter(Boolean).join(' · ');
      const chips=[...(r.collections||[]).slice(0,2),...(r.tags||[]).slice(0,1)];
      const inPlan=state.plan.some(p=>p.recordId===r.id);
      const places=r.places||[];
      const placeLine=places.length>1?`<p class="clip-places" title="${html(places.map(p=>p.name).join(', '))}">📍 ${places.length} places: ${html(places.slice(0,3).map(p=>p.name).join(' · '))}${places.length>3?' +'+(places.length-3):''}</p>`:'';
      // A TikTok shows whether it is reviewed; a web page or note shows what it is, and whether the AI has read it.
      const flags=clip?`<span class="status ${r.status==='reviewed'?'reviewed':''}">${r.status==='reviewed'?'✓ Reviewed':'Needs review'}</span>${r.auto?`<span class="analysis-badge auto-${html(r.auto.status)}" title="${html(r.auto.summary||[r.auto.reason,r.auto.detail].filter(Boolean).join(': '))}">✦ ${html(r.autoReviewed?'Auto-reviewed':C.AUTO_LABELS[r.auto.status]||'')}</span>`:C.analysisState(r)==='not_analyzed'?'':`<span class="analysis-badge ${html(C.analysisState(r))}" title="${html(r.enrichment?.reason||'')}">${html(C.ANALYSIS_LABELS[C.analysisState(r)])}</span>`}`
        :`<span class="kind-badge">${r.kind==='link'?'🔗 WEB PAGE':'📝 NOTE'}</span>${reading.has(r.id)?'<span class="analysis-badge">✦ Reading…</span>':r.auto?.status==='understood'?`<span class="analysis-badge auto-understood" title="${html(r.auto.summary||'')}">✦ Read</span>`:''}`;
      const about=clip?(r.notes||r.caption):(r.notes||String(r.body||'').replace(/\s+/g,' ').slice(0,220));
      const actions=clip?`<button data-action="watch" data-id="${html(r.id)}" title="Watch it here and fill in its details">▶ Watch</button><a href="${html(r.url)}" target="_blank" rel="noopener noreferrer" title="Open on TikTok">↗ TikTok</a>`
        :`${r.kind==='link'?`<a href="${html(r.url)}" target="_blank" rel="noopener noreferrer" title="Open the page">↗ Open</a>`:''}<button data-action="read-item" data-id="${html(r.id)}" title="Let the AI read it again and list the places in it"${reading.has(r.id)?' disabled':''}>✦ Read</button>`;
      return `<article class="clip-card${clip?'':' kind-'+html(r.kind)}${selecting?' selecting':''}${selected.has(r.id)?' picked':''}" data-card="${html(r.id)}">${selecting?`<label class="pick"><input type="checkbox" data-pick="${html(r.id)}" ${selected.has(r.id)?'checked':''} aria-label="Select ${html(title)}"></label>`:''}<div class="clip-card-head"><span class="clip-emoji">${html(emojiFor(r.category))}</span><span class="card-flags">${flags}</span></div><div class="clip-body"><div class="category">${html(r.category)}</div>${r.autoSorted&&r.autoSorted.name===r.category&&r.autoSorted.words?.length?`<p class="sorted-why" title="Sorted automatically by these sort words">Sorted by: ${html(r.autoSorted.words.join(', '))}</p>`:''}<h3>${html(title)}</h3><p class="location">${html([host,loc||(clip?'Location not yet identified':'')].filter(Boolean).join(' · ')||'No place yet')}${r.savedAt?' · Saved '+html(r.savedAt):''}</p>${placeLine}${about?`<p class="clip-notes">${html(about)}</p>`:''}<div class="chips">${chips.map(t=>`<span class="chip">${html(t)}</span>`).join('')}</div></div><div class="clip-actions">${actions}<button data-action="edit" data-id="${html(r.id)}">Edit</button>${tabOn('itinerary')?`<button data-action="plan" data-id="${html(r.id)}">${inPlan?'✓ Planned':'+ Plan'}</button>`:''}<button class="danger" data-action="delete" data-id="${html(r.id)}" aria-label="Delete ${clip?'clip':r.kind==='link'?'web page':'note'}">✕</button></div></article>`;
    }).join('');
  }
  // Places by city: what the clips shown (the open collection, filtered) add up to, as research.
  let libraryView=(()=>{try{return localStorage.getItem('ClipAtlasLibraryView')==='places'?'places':'cards';}catch(_){return 'cards';}})();
  let lastReport=null;
  function renderReport(records){
    const box=$('#placesReport'),rep=C.placeReport(records);lastReport=rep;
    if(!records.length){box.innerHTML='';return;}
    if(!rep.places){box.innerHTML='<div class="day-empty">No places found in these yet. Auto-review lists the places each clip names or shows (✦ Read does it for a web page or note).</div>';return;}
    const dayOf=C.planDays(state.plan),named=rep.cities.filter(c=>c.name);
    let s=`<div class="report-head"><p><strong>${plural(rep.places,'place','places')}</strong> in ${plural(named.length,'city','cities')}, from ${plural(records.length,'item','items')}${rep.unnamed?` (${rep.unnamed} ${rep.unnamed===1?'names':'name'} no place)`:''}. In each city: food, shopping, sights, activities, then places to stay; places named by several clips come first.</p><button type="button" class="btn-subtle" data-action="report-download">↓ Download</button></div>`;
    if(named.length>1)s+=`<nav class="city-jump" aria-label="Cities">${named.map(c=>`<button type="button" class="chip" data-action="report-jump" data-city="${html(c.name.toLowerCase())}">${html(c.name)} <small>${c.count}</small></button>`).join('')}</nav>`;
    for(const c of rep.cities){
      s+=`<section class="report-city" data-report-city="${html(c.name.toLowerCase())}"><h3>${c.name?'📍 '+html(c.name):'City not known yet'} <small>${html([c.country,plural(c.count,'place','places')].filter(Boolean).join(' · '))}</small></h3>`;
      if(!c.name)s+='<p class="hint">Open one (its clip’s name) to type its city, or type it next to it in Itinerary → By city.</p>';
      s+='<div class="report-groups">';
      for(const g of c.groups){
        s+=`<div class="report-group"><h4>${kindLabel(g.type)} <small>${g.places.length}</small></h4><ul>`;
        for(const p of g.places){
          const map=C.mapsUrl({name:p.name,address:p.address,city:c.name,country:c.country});
          const day=p.sources.map(x=>dayOf({key:x.id+'#'+(x.placeId||''),recordId:x.id})).find(Boolean);
          s+=`<li class="report-place"><div class="report-text"><strong>${html(p.name)}</strong>${p.sources.length>1?` <span class="report-count">${p.sources.length} clips</span>`:''}${day?` <span class="report-day">Day ${day}</span>`:''}${p.address?`<span class="report-address">📍 ${html(p.address)}</span>`:''}${p.notes.length?`<span class="report-notes">${html(p.notes.join(' · '))}</span>`:''}<span class="report-from">From ${p.sources.map(x=>`<button type="button" class="link-inline" data-action="edit-item" data-id="${html(x.id)}" data-place="${html(x.placeId||'')}" title="Open it in Edit">${html(x.title)}</button>${x.url?` <a href="${html(x.url)}" target="_blank" rel="noopener noreferrer" title="${x.kind==='tiktok'?'Open the TikTok':'Open the page'}" aria-label="${x.kind==='tiktok'?'Open the TikTok':'Open the page'}">↗</a>`:''}`).join(', ')}</span></div>${map?`<a class="map-link" href="${html(map)}" target="_blank" rel="noopener noreferrer" title="Open in Google Maps" aria-label="Open ${html(p.name)} in Google Maps">📍</a>`:''}</li>`;
        }
        s+='</ul></div>';
      }
      s+='</div></section>';
    }
    box.innerHTML=s;
  }
  // The Itinerary page has three views: an overview of what the clips add up to (with
  // Fill the days), the days, and every saved clip sorted by city.
  let itineraryView=null;
  // The overview's choices: which country, which categories go on days, and each city's days in trip order.
  let trip=null;
  // Where a stop came from: its TikTok, its web page, or (no link) the note it is in.
  function sourceLink(r,isPlace){
    const what=C.isClip(r)?'TikTok':r.kind==='link'?'page':'note';
    if(!r.url)return `<span class="stop-from">From your note “${html(r.title||'untitled')}”</span>`;
    return `<a class="stop-source" href="${html(r.url)}" target="_blank" rel="noopener noreferrer">${isPlace?'From “'+html(r.title||(what==='TikTok'?'a saved TikTok':hostOf(r.url)))+'” ↗':what==='TikTok'?'View original TikTok ↗':'Open the page ↗'}</a>`;
  }
  const dayCitiesOf=day=>(state.dayCities&&state.dayCities[day])||[];
  const dayLabel=day=>{const c=dayCitiesOf(day);return `Day ${day}${c.length?' · '+c.join(', '):''}`;};
  function renderItinerary() {
    $('#tripTitle').value=state.tripTitle||''; $('#dayCount').value=String(state.dayCount||7);
    if(!itineraryView)itineraryView=state.plan.length?'days':'overview';
    for(const b of $$('[data-itinerary-view]')){const on=b.dataset.itineraryView===itineraryView;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));}
    $('#itineraryOverview').hidden=itineraryView!=='overview';$('#itineraryDays').hidden=itineraryView!=='days';$('#itineraryCities').hidden=itineraryView!=='cities';
    const known=C.cityList(state.records);
    $('#cityOptions').innerHTML=known.map(c=>`<option value="${html(c.name)}">${html(c.country?c.country+' · ':'')}${c.count} saved</option>`).join('');
    renderPlanAI();
    if(itineraryView==='cities')renderCityBoard();else if(itineraryView==='overview')renderOverview();else renderDays();
  }
  const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
  const kindLabel=t=>`${C.PLACE_EMOJI[t]} ${C.PLACE_LABELS[t]}`;
  // The cities of the overview with their days: as the person set them, else the days' cities, else a suggestion.
  function tripState(){
    const countries=C.tripCountries(state.records);
    if(!trip||(trip.country&&!countries.some(c=>c.country===trip.country)))trip={country:countries[0]?.country||'',include:null,cities:null,edited:false};
    const o=C.tripOverview(state.records,trip.country),key=v=>String(v).toLowerCase();
    const known=new Map(o.cities.map(c=>[key(c.name),c]));
    if(!trip.cities||(!trip.edited&&trip.forDays!==state.dayCount)){
      const fromDays=[];
      for(let d=1;d<=state.dayCount;d++)for(const c of dayCitiesOf(d)){
        if(!known.has(key(c)))continue;
        const hit=fromDays.find(x=>key(x.name)===key(c));if(hit)hit.days++;else fromDays.push({name:known.get(key(c)).name,days:1});
      }
      trip.cities=fromDays.length?fromDays:C.suggestDays(o.cities,state.dayCount);trip.from=fromDays.length?'days':'suggested';
      trip.forDays=state.dayCount;trip.edited=false;
    }
    // Cities that came or went since: keep the order, add new ones with no days.
    trip.cities=trip.cities.filter(t=>known.has(key(t.name))).map(t=>({name:known.get(key(t.name)).name,days:t.days}));
    for(const c of o.cities)if(!trip.cities.some(t=>key(t.name)===key(c.name)))trip.cities.push({name:c.name,days:0});
    return {countries,o};
  }
  // What the saved places of a country add up to, and how many days each city gets.
  function renderOverview(){
    const box=$('#itineraryOverview');
    if(!state.records.length){box.innerHTML='<div class="day-empty">No saved clips yet. Import some, and this shows what they add up to.</div>';return;}
    const {countries,o}=tripState(),byName=new Map(o.cities.map(c=>[c.name.toLowerCase(),c]));
    const include=trip.include?new Set(trip.include):null,total=trip.cities.reduce((n,c)=>n+c.days,0);
    const everywhere=C.tripOverview(state.records,'').total;
    let s=`<div class="overview-head"><label class="field small"><span>PLACES FROM</span><select id="tripCountry">${countries.map(c=>`<option value="${html(c.country)}"${c.country===trip.country?' selected':''}>${html(c.country)} (${c.count})</option>`).join('')}<option value=""${trip.country===''?' selected':''}>Everywhere (${everywhere})</option></select></label>`+
      `<div class="overview-sum"><strong>${plural(o.total,'place','places')} in ${plural(o.cities.length,'city','cities')}</strong><span>from ${plural(o.clips,'clip','clips')} · ${o.types.map(t=>`${kindLabel(t.type)} ${t.count}`).join(' · ')}</span></div></div>`;
    if(o.noCity)s+=`<p class="overview-note">${plural(o.noCity,'place has','places have')} no city yet, so ${o.noCity===1?'it is':'they are'} not in a city below. <button type="button" class="link-inline" data-action="show-city" data-city="">See ${o.noCity===1?'it':'them'}</button> Auto-review fills in cities, or type one in Edit.</p>`;
    if(!o.cities.length){box.innerHTML=s+'<div class="day-empty">None of these places has a city yet. Run auto-review (or fill in cities in Edit), and the cities show here.</div>';return;}
    s+=`<div class="overview-include"><span>PUT ON DAYS</span>${o.types.map(t=>`<label class="toggle-chip"><input type="checkbox" data-trip-include="${t.type}"${!include||include.has(t.type)?' checked':''} /> ${kindLabel(t.type)}</label>`).join('')}</div><ol class="trip-cities">`;
    trip.cities.forEach((t,i)=>{
      const c=byName.get(t.name.toLowerCase());if(!c)return;
      const cats=c.types.map(g=>`<span>${kindLabel(g.type)} ${g.count}</span>`).join('');
      const places=c.places.slice(0,8).map(p=>`<span class="chip">${html(p)}</span>`).join('')+(c.places.length>8?`<span class="chip more">+${c.places.length-8} more</span>`:'');
      s+=`<li class="trip-city${t.days?'':' no-days'}"><div class="trip-city-main"><h3>📍 ${html(c.name)} <small>${plural(c.count,'place','places')}</small></h3><p class="trip-cats">${cats}</p>${places?`<div class="chips trip-places">${places}</div>`:''}</div>`+
        `<div class="trip-city-days"><label><span>DAYS</span><input type="number" min="0" max="30" step="1" inputmode="numeric" value="${t.days}" data-trip-days="${html(c.name)}" aria-label="Days in ${html(c.name)}" /></label><div class="trip-move"><button type="button" data-action="trip-move" data-city="${html(c.name)}" data-step="-1"${i===0?' disabled':''} aria-label="${html(c.name)} earlier in the trip">↑</button><button type="button" data-action="trip-move" data-city="${html(c.name)}" data-step="1"${i===trip.cities.length-1?' disabled':''} aria-label="${html(c.name)} later in the trip">↓</button></div></div></li>`;
    });
    const route=trip.cities.filter(t=>t.days>0).map(t=>`${html(t.name)} ${t.days}`).join(' → ');
    const fit=total>state.dayCount?`The trip becomes ${total} days.`:total<state.dayCount?`${plural(state.dayCount-total,'day stays','days stay')} free (of ${state.dayCount}).`:`All ${state.dayCount} days have a city.`;
    s+=`</ol><div class="overview-foot"><div><strong>${plural(total,'day','days')}</strong>${route?' · '+route:''}<small>${fit}${trip.from==='suggested'&&!trip.edited?' Suggested from how many places each city has; change the days or the order.':''}</small></div>`+
      `<div class="overview-actions"><button type="button" class="btn-light" data-action="trip-suggest">Suggest again</button><button type="button" class="btn-primary" data-action="trip-fill"${total?'':' disabled'}>Fill the days</button></div></div>`+
      '<p class="hint">Fill the days puts each city on its days, in this order, and spreads its places over them: a mix of food, shopping, sightseeing and activities, named places first, at most 8 stops a day. A TikTok with several places has each one on its own, and each links back to it. It replaces the days you have now (you can undo it), and then you can change anything in Days and By city.</p>';
    box.innerHTML=s;
  }
  function fillDays(){
    tripState();
    const recs=[...state.records].sort((a,b)=>String(b.savedAt||b.createdAt||'').localeCompare(String(a.savedAt||a.createdAt||'')));
    const res=C.autoFill(C.tripItemsIn(recs,trip.country),trip.cities,{include:trip.include});
    if(!res.days){toast('Give at least one city a day first.');return;}
    const had=state.plan.length,hadCities=Object.keys(state.dayCities||{}).length;
    if((had||hadCities)&&!confirm(`Fill the days? This replaces your current days (${plural(had,'stop','stops')}${hadCities?', and the cities set for '+plural(hadCities,'day','days'):''}). You can undo it right after.`))return;
    const before={plan:state.plan,dayCities:state.dayCities,dayCount:state.dayCount};
    const days=C.cleanDayCount(Math.max(state.dayCount,res.days)),stamp=Date.now().toString(36);
    state.dayCount=days;state.dayCities=C.cleanDayCities(res.dayCities,days);
    state.plan=res.stops.map((x,i)=>({id:`stop-${stamp}-${i}`,recordId:x.recordId,...(x.placeId?{placeId:x.placeId}:{}),day:x.day,note:''}));
    trip.edited=false;trip.cities=null;itineraryView='days';commit();
    const extra=Object.values(res.left).reduce((a,b)=>a+b,0);
    toast(`Filled ${plural(res.days,'day','days')} with ${plural(res.stops.length,'stop','stops')}.${extra?` ${plural(extra,'more place','more places')} did not fit (at most 8 a day) and ${extra===1?'is':'are'} still in By city.`:''}`,
      {label:'Undo',run:()=>{state.plan=before.plan;state.dayCities=before.dayCities;state.dayCount=before.dayCount;trip.cities=null;commit();toast('Your days are back as they were.');}});
  }
  /* ---- Plan with AI: what the person wants, arranged from the saved places ---- */
  let planAsking=false,planProposal=null;
  const PLAN_EXAMPLES=['A night market every night','Breakfast, lunch and dinner each day','Noodles for lunch on day 2','Sights in the morning, shopping in the afternoon','Keep each day in one area'];
  function renderPlanAI(){
    $('#planAIExamples').innerHTML=PLAN_EXAMPLES.map(q=>`<button type="button" class="chip ask-example" data-action="plan-ai-example" data-q="${html(q)}">+ ${html(q)}</button>`).join('');
    const box=$('#planAIResult');box.hidden=!planProposal;if(!planProposal)return;
    const {answer,count}=planProposal,byKey=new Map(C.tripItems(state.records).map(it=>[it.key,it]));
    // What the plan takes off, by place (the same place from another clip is the same place).
    const same=it=>it.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'')+'|'+String(it.city||'').toLowerCase();
    const next=new Set(answer.days.flatMap(d=>d.stops.map(s=>byKey.get(s.key)).filter(Boolean).map(same)));
    const off=[...new Map(state.plan.map(p=>byKey.get(p.recordId+'#'+(p.placeId||''))).filter(it=>it&&!next.has(same(it))).map(it=>[same(it),it.name])).values()];
    let s=`<div class="plan-ai-head"><p>${html(answer.summary||'Here is a plan.')}</p><small>${plural(answer.stops,'stop','stops')} over ${plural(answer.days.filter(d=>d.stops.length).length,'day','days')}, from ${plural(count,'saved place','saved places')}${off.length?` · takes off ${html(off.slice(0,6).join(', '))}${off.length>6?' and '+(off.length-6)+' more':''} (still in By city)`:''}</small></div><div class="plan-ai-days">`;
    for(const d of answer.days){if(!d.stops.length)continue;
      s+=`<div class="plan-ai-day"><h4>${html(dayLabel(d.day))}</h4><ol>${d.stops.map(st=>{const it=byKey.get(st.key);
        return `<li>${st.time?`<span class="time-badge">${html(C.PLAN_TIME_LABELS[st.time])}</span>`:''}<strong>${html(it?it.name:'?')}</strong>${it&&it.city?` <small>${html(it.city)}</small>`:''}${st.why?`<span class="plan-ai-why">${html(st.why)}</span>`:''}</li>`;}).join('')}</ol></div>`;}
    s+='</div>';
    if(answer.missing.length)s+=`<div class="plan-ai-missing"><strong>Not in your saved places:</strong><ul>${answer.missing.map(m=>`<li>${html(m)}</li>`).join('')}</ul></div>`;
    s+=`<div class="ask-actions"><button type="button" class="btn-primary" data-action="plan-ai-use">Use this plan</button><button type="button" class="btn-light" data-action="plan-ai-discard">Discard</button></div>`;
    box.innerHTML=s;
  }
  async function planWithAI(request){
    request=String(request||'').trim();const say=t=>{$('#planAIStatus').textContent=t;};
    if(!request){say('Write what you want first (or pick an example).');return;}
    if(planAsking)return;
    const items=C.tripItems(state.records);
    if(!items.length){say('Save some clips with places first (auto-review lists them).');return;}
    planAsking=true;$('#planAIButton').disabled=true;
    try{
      if(!aiConfigLoaded){await loadAIConfig();aiConfigLoaded=true;}
      const prompt=C.planAIPrompt({items,dayCount:state.dayCount,dayCities:state.dayCities,plan:state.plan,request});
      let answer=null,why='';
      if(aiConfig.gemini){
        const body=JSON.stringify(C.planAIRequest(prompt.text));
        for(let tries=0;tries<3&&!answer;tries++){
          say(`Planning with Gemini from ${plural(prompt.count,'saved place','saved places')}…`);
          const res=await geminiPost(body,'ask');
          if(res.status==='ok'){answer=C.readPlanAnswer(res.text,prompt.keys,state.dayCount);if(!answer)why='the answer had no plan in it';break;}
          if(res.stopRun){say(res.message);return;}
          why=res.detail||res.reason||'';
          if(res.reason==='GEMINI_BUSY'){const wait=Math.min(60,Math.max(2,res.retryAfter||20));say(`Gemini asked to wait ${wait} seconds…`);await new Promise(ok=>setTimeout(ok,wait*1000));continue;}
          break;
        }
      }
      if(!answer&&aiConfig.cloudflare){
        say(`Planning with Cloudflare's AI from ${plural(prompt.count,'saved place','saved places')}…`);
        try{const r=await fetch('/api/ask',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
            body:JSON.stringify({prompt:prompt.text+'\n\nReply with only the JSON object.'})});
          const res=await r.json().catch(()=>({}));
          if(res.status==='ok'){answer=C.readPlanAnswer(res.text,prompt.keys,state.dayCount);if(!answer)why='the answer had no plan in it';}
          else why=res.reason==='AI_DAILY_LIMIT'?'both free AI allowances are used up for today':(res.error||res.detail||res.reason||why);
        }catch(_){why='connection problem';}
      }
      if(!answer){say(why?`That did not work: ${why}.`:'No AI is set up to plan (see the README: Gemini or Cloudflare).');return;}
      if(!answer.stops){say(answer.missing.length?'None of your saved places fits that; see below.':'It did not place anything; try saying it another way.');}
      else say('');
      planProposal={answer,count:prompt.count,request};renderPlanAI();
      $('#planAIResult').scrollIntoView({behavior:'smooth',block:'nearest'});
    }finally{planAsking=false;$('#planAIButton').disabled=false;}
  }
  function usePlanProposal(){
    if(!planProposal)return;
    const before={plan:state.plan};
    state.plan=C.planFromAnswer(planProposal.answer,stopId);
    planProposal=null;itineraryView='days';commit();
    toast(`Your days now follow the AI's plan (${plural(state.plan.length,'stop','stops')}).`,{label:'Undo',run:()=>{state.plan=before.plan;commit();toast('Your days are back as they were.');}});
  }
  // What one stop is: a place of a clip, or a whole clip.
  function stopItem(entry,r){
    const place=entry.placeId?(r.places||[]).find(p=>p.id===entry.placeId):null;
    if(place)return {name:place.name,type:C.placeType(place.type),city:place.city||r.city||'',country:place.country||r.country||'',address:place.address||'',note:place.note||'',place:true};
    return {name:r.title||r.place||'Saved TikTok',type:'',city:r.city||'',country:r.country||'',address:'',note:'',place:false};
  }
  function renderDays() {
    const days=$('#itineraryDays'); const byId=new Map(state.records.map(r=>[r.id,r]));
    const dayOf=C.planDays(state.plan),allItems=C.tripItems(state.records);
    const choices=day=>Array.from({length:state.dayCount},(_,i)=>`<option value="${i+1}" ${day===i+1?'selected':''}>${html(dayLabel(i+1))}</option>`).join('');
    let s='';
    for(let day=1;day<=state.dayCount;day++){
      const items=state.plan.filter(p=>p.day===day&&byId.has(p.recordId)),cities=dayCitiesOf(day);
      const chips=cities.map(c=>`<span class="city-chip">${html(c)}<button type="button" data-action="day-city-remove" data-day="${day}" data-city="${html(c)}" aria-label="Take ${html(c)} off day ${day}">✕</button></span>`).join('');
      s+=`<section class="day-panel"><div class="day-head"><span class="day-num">${String(day).padStart(2,'0')}</span><div class="day-title"><h3>Day ${day}</h3><div class="day-cities">${chips}${cities.length<6?`<input list="cityOptions" data-day-city="${day}" placeholder="${cities.length?'+ another city':'+ city for this day'}" aria-label="Add a city to day ${day} (type or pick, then Enter)" autocomplete="off" />`:''}</div></div><small>${items.length} ${items.length===1?'stop':'stops'}</small></div>`;
      // What is still waiting in this day's cities.
      const waiting=cities.map(c=>[c,allItems.filter(it=>it.city&&it.city.toLowerCase()===c.toLowerCase()&&!dayOf(it)).length]).filter(([,n])=>n);
      if(waiting.length)s+=`<p class="day-more">${waiting.map(([c,n])=>`${n} saved in ${html(c)} not planned yet <button type="button" class="link-inline" data-action="show-city" data-city="${html(c)}">Show them</button>`).join(' · ')}</p>`;
      if(!items.length)s+=`<div class="day-empty">${cities.length?'Pick stops for this day in <strong>By city</strong>, or':'Add stops from Discoveries with'} the “+ Plan” button${cities.length?' in Discoveries':''}.</div>`;
      for(let j=0;j<items.length;j++){
        const entry=items[j],r=byId.get(entry.recordId),it=stopItem(entry,r);
        const away=cities.length&&it.city.trim()&&!cities.some(c=>c.toLowerCase()===it.city.trim().toLowerCase());
        const where=it.place?[kindLabel(it.type),it.city,it.note].filter(Boolean).join(' · '):[r.place,r.city,r.country].filter(Boolean).join(' · ')||r.category;
        const whole=!it.place&&(r.places||[]).length>1?`<p class="stop-places">📍 ${html(r.places.map(p=>p.name).join(' · '))} <button type="button" class="link-inline" data-action="split-stop" data-id="${html(r.id)}">Give each place its own stop</button></p>`:'';
        const map=C.mapsUrl(it.place?it:{name:r.place,city:r.city,country:r.country});
        const address=it.address||map?`<p class="stop-address">${it.address?'📍 '+html(it.address)+' ':''}${map?`<a href="${html(map)}" target="_blank" rel="noopener noreferrer">${it.address?'Map ↗':'📍 Find it on Google Maps ↗'}</a>`:''}</p>`:'';
        s+=`<div class="stop"><span class="stop-n">${j+1}</span><div><h4>${html(it.name)}</h4><p>${html(where)}${away?` <span class="stop-away">not in ${html(cities.join(' or '))}</span>`:''}</p>${address}${whole}${sourceLink(r,!!it.place)} <button type="button" class="link-inline stop-edit" data-action="edit-item" data-id="${html(r.id)}" data-place="${html(entry.placeId||'')}" title="Edit: city, places, notes…">✎ Edit</button><input value="${html(entry.note||'')}" placeholder="Plan note (time, order, reservation…)" data-plan-note="${html(entry.id)}" aria-label="Plan note" /></div><div class="stop-actions"><select data-plan-day="${html(entry.id)}" aria-label="Move stop to day">${choices(day)}</select><button data-action="up" data-id="${html(entry.id)}" ${j===0?'disabled':''} title="Move earlier">↑</button><button data-action="down" data-id="${html(entry.id)}" ${j===items.length-1?'disabled':''} title="Move later">↓</button><button data-action="remove-plan" data-id="${html(entry.id)}" title="Remove from itinerary">✕</button></div></div>`;
      }
      s+='</section>';
    }
    days.innerHTML=s;
  }
  // Every saved place, by city, then by kind (food, shopping, sightseeing, activities, stay), with a day picker on each.
  function renderCityBoard() {
    const recs=[...state.records].sort((a,b)=>String(b.savedAt||b.createdAt||'').localeCompare(String(a.savedAt||a.createdAt||'')));
    const board=C.cityBoard(recs,state.plan),box=$('#itineraryCities');
    if(!board.length){box.innerHTML='<div class="day-empty">No saved clips yet. Import some, and they show here by city.</div>';return;}
    const options=day=>`<option value="0"${day?'':' selected'}>Not planned</option>`+Array.from({length:state.dayCount},(_,i)=>`<option value="${i+1}"${day===i+1?' selected':''}>${html(dayLabel(i+1))}</option>`).join('');
    const named=board.filter(c=>c.name);
    let s=named.length>1?`<nav class="city-jump" aria-label="Cities">${named.map((c,i)=>`<button type="button" class="chip" data-action="jump-city" data-city="${html(c.name)}">${html(c.name)} <small>${c.count}</small></button>`).join('')}</nav>`:'';
    for(const c of board){
      const days=c.name?Object.keys(state.dayCities||{}).map(Number).filter(d=>d<=state.dayCount&&dayCitiesOf(d).some(x=>x.toLowerCase()===c.name.toLowerCase())):[];
      s+=`<details class="city-panel${c.name?'':' city-unknown'}" data-city-key="${html(c.name.toLowerCase())}"${c.name?' open':''}><summary><span class="city-name">${c.name?'📍 '+html(c.name):'City not known yet'}</span><small>${html([c.country,`${c.count} saved`,`${c.planned} planned`,days.length?'Day '+days.join(', '):''].filter(Boolean).join(' · '))}</small></summary>`;
      if(!c.name)s+='<p class="hint city-note">Type a city next to one and press Enter, or open it with ✎ to fix its details; it moves into that city.</p>';
      s+='<div class="city-groups">';
      for(const g of c.groups){
        s+=`<div class="city-group"><h4>${kindLabel(g.type)} <small>${g.items.length}</small></h4><ul>`;
        for(const {item:it,day} of g.items){
          const r=it.record,where=[it.note,it.placeId?'from “'+(r.title||'a saved TikTok')+'”':r.status!=='reviewed'?'needs review':''].filter(Boolean).join(' · ');
          const map=C.mapsUrl(it);
          s+=`<li class="city-item${day?' planned':''}"><div class="city-item-text"><strong>${html(it.name)}</strong>${it.address?`<span class="city-address">📍 ${html(it.address)}</span>`:''}${where?`<span>${html(where)}</span>`:''}</div><div class="city-item-actions">${map?`<a class="map-link" href="${html(map)}" target="_blank" rel="noopener noreferrer" title="Open in Google Maps" aria-label="Open ${html(it.name)} in Google Maps">📍</a>`:''}${c.name?'':`<input class="city-fill" data-city-fill="${html(it.key)}" list="cityOptions" maxlength="60" placeholder="City" aria-label="City of ${html(it.name)}" />`}<button type="button" class="city-edit" data-action="edit-item" data-id="${html(r.id)}" data-place="${html(it.placeId)}" title="Edit: city, places, notes…" aria-label="Edit ${html(it.name)}">✎</button>${r.url?`<a href="${html(r.url)}" target="_blank" rel="noopener noreferrer" title="${C.isClip(r)?'Open the TikTok it is from':'Open the page it is from'}" aria-label="${C.isClip(r)?'Open the TikTok it is from':'Open the page it is from'}">↗</a>`:`<span class="from-note" title="From your note “${html(r.title||'')}”">📝</span>`}<select data-city-plan="${html(it.key)}" aria-label="Plan ${html(it.name)} on a day">${options(day)}</select></div></li>`;
        }
        s+='</ul></div>';
      }
      s+='</div></details>';
    }
    box.innerHTML=s;
  }
  // A city typed in By city for a place (or a clip with no places listed) that had none.
  function setItemCity(key,city){
    city=String(city||'').replace(/\s+/g,' ').trim().slice(0,60);if(!city)return;
    const [recordId,placeId='']=String(key).split('#');
    const r=state.records.find(x=>x.id===recordId);if(!r)return;
    const next={...r,updatedAt:new Date().toISOString()};let name=r.place||r.title||'It';
    if(placeId){const p=(r.places||[]).find(x=>x.id===placeId);if(!p)return;name=p.name;
      // Changed by the person, so a later auto-review leaves the places as they are now.
      next.places=r.places.map(x=>x.id===placeId?{...x,city}:x);next.placesBy='person';}
    else next.city=city;
    state.records[state.records.indexOf(r)]=next;commit();toast(`${name} is in ${city} now.`);
  }
  function showCity(name){
    itineraryView='cities';renderItinerary();
    const panel=[...$$('#itineraryCities .city-panel')].find(p=>p.dataset.cityKey===String(name).toLowerCase());
    if(panel){panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'start'});}
  }
  const stopId=()=>'stop-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  // Stops follow the places: a planned clip that now lists its places gets one stop per place.
  const tidyPlan=()=>{state.plan=C.placeStops(state.plan,state.records,stopId);};
  // Plan a place (or a clip with none listed) on a day from By city; 0 takes it off. A moved stop
  // goes to the end of its new day. A whole-clip stop is first split into one stop per place.
  function planOnDay(key,day){
    const [recordId,placeId=''] =String(key).split('#');
    const r=state.records.find(x=>x.id===recordId);if(!r)return;
    if(placeId)state.plan=C.splitClipStop(state.plan,r,stopId);
    const at=state.plan.findIndex(p=>p.recordId===recordId&&(p.placeId||'')===placeId);
    if(!day){if(at>=0)state.plan.splice(at,1);commit();return;}
    const entry=at>=0?state.plan.splice(at,1)[0]:{id:stopId(),recordId,...(placeId?{placeId}:{}),note:''};
    entry.day=day;state.plan.push(entry);commit();
  }
  function addDayCity(day,name){
    const city=String(name||'').replace(/\s+/g,' ').trim();if(!city)return false;
    const next={...(state.dayCities||{})};next[day]=[...dayCitiesOf(day),city];
    state.dayCities=C.cleanDayCities(next,state.dayCount);commit();return true;
  }
  function render() {
    fillCategorySelect($('#categoryFilter'), true); fillCategorySelect($('#formCategory'), false); applyTabs();
    renderStats(); renderCollections(); renderAnalysisSummary(); renderReviewCount();
    if(currentTab==='library')renderLibrary(); else if(currentTab==='itinerary')renderItinerary(); else if(currentTab==='settings')renderSettings();
  }
  // What the Edit dialog holds: a TikTok, a web page (its link and text) or a typed note.
  let editingKind='tiktok',editorReadAt='';
  const KIND_TITLES={tiktok:'discovery',link:'web link',note:'note'};
  function setKind(kind,isNew){
    editingKind=C.ITEM_KINDS.includes(kind)?kind:'tiktok';
    const form=$('#editForm'),url=form.elements.namedItem('url'),body=form.elements.namedItem('body');
    $('#kindPick').hidden=!isNew;
    for(const b of $$('#kindPick [data-kind]'))b.setAttribute('aria-pressed',String(b.dataset.kind===editingKind));
    $('#modalTitle').textContent=(isNew?'New ':'Edit ')+KIND_TITLES[editingKind];
    $('#editDialog .modal-heading .eyebrow').textContent=editingKind==='tiktok'?'CLIP DETAILS':editingKind==='link'?'WEB PAGE':'NOTE';
    $('#urlField').hidden=editingKind==='note';url.required=editingKind!=='note';
    $('#urlLabel').textContent=editingKind==='link'?'WEB LINK *':'TIKTOK LINK *';
    url.placeholder=editingKind==='link'?'https://… (a guide, a blog post, a Reddit thread)':'https://www.tiktok.com/@…/video/…';
    $('#bodyField').hidden=editingKind==='tiktok';
    $('#bodyLabel').textContent=editingKind==='note'?'NOTE *':'PAGE TEXT';
    body.placeholder=editingKind==='note'?'Type anything: a friend’s recommendations, a list from a guide, opening hours, a booking tip…'
      :'Press “Read the page”, or paste the page’s text here (some sites, like Reddit, do not let ClipAtlas read them).';
    $('#readPageBtn').hidden=editingKind!=='link';
    for(const el of $$('#editForm .tiktok-only'))el.hidden=editingKind!=='tiktok';
    $('#placesLabel').textContent=editingKind==='tiktok'?'PLACES IN THIS CLIP':editingKind==='link'?'PLACES ON THIS PAGE':'PLACES IN THIS NOTE';
    if(editingKind!=='tiktok')$('#editHeard').hidden=true;
  }
  function openEditor(id=null,kind='tiktok',focus) {
    editingId=id; const r=state.records.find(x=>x.id===id);
    $('#modalError').textContent='';$('#readPageStatus').textContent='';editorReadAt='';
    const form=$('#editForm'); form.reset();
    if(r) for(const key of ['url','title','creator','caption','notes','category','place','city','country','status','body']) {
      const el=form.elements.namedItem(key); if(el) el.value=r[key]||'';
    }
    if(r){form.elements.namedItem('collections').value=(r.collections||[]).join(', ');form.elements.namedItem('tags').value=(r.tags||[]).join(', ');}
    // Something new added while a collection is open goes into that collection.
    else if(activeCollection)form.elements.namedItem('collections').value=activeCollection;
    $('#editPlaces').replaceChildren(...(r?.places||[]).map(placeRow));
    const said=r?.auto?.transcript||'';
    $('#editHeard').hidden=!r?.auto;
    $('#editTranscript').textContent=said||(r?.auto?'No speech was heard (music only, or nothing said).':'');
    $('#copyEditTranscript').hidden=!said;
    setKind(r?(r.kind||'tiktok'):kind,!r);
    $('#editDialog').showModal();
    if(r&&focus!==undefined){
      const row=focus&&[...$$('#editPlaces .place-row')].find(x=>x.dataset.placeId===focus);
      const el=row?row.querySelector('.pl-city'):form.elements.namedItem('city');
      if(row)row.classList.add('focus');el.focus();el.scrollIntoView({block:'center'});
    }
  }
  // One place in the Edit dialog: name, kind, city, note, address.
  function placeRow(p={}){
    const row=document.createElement('div');row.className='place-row';row.dataset.placeId=p.id||'';
    row.innerHTML=`<input class="pl-name" placeholder="Place name" aria-label="Place name" maxlength="100" /><select class="pl-type" aria-label="Kind of place">${C.PLACE_TYPES.map(t=>`<option value="${t}">${C.PLACE_EMOJI[t]} ${C.PLACE_LABELS[t]}</option>`).join('')}</select><input class="pl-city" placeholder="City" aria-label="City" maxlength="60" /><input class="pl-note" placeholder="What to get or do there" aria-label="Note" maxlength="200" /><button type="button" class="pl-remove icon-only" aria-label="Remove this place">✕</button><input class="pl-address" placeholder="Address (optional; paste it from Google Maps)" aria-label="Address" maxlength="200" />`;
    row.dataset.country=p.country||'';row.querySelector('.pl-address').value=p.address||'';
    row.querySelector('.pl-name').value=p.name||'';row.querySelector('.pl-type').value=C.placeType(p.type||'sightseeing');
    row.querySelector('.pl-city').value=p.city||'';row.querySelector('.pl-note').value=p.note||'';
    return row;
  }
  function editorPlaces(){
    return [...$$('#editPlaces .place-row')].map(row=>({id:row.dataset.placeId||undefined,name:row.querySelector('.pl-name').value,
      type:row.querySelector('.pl-type').value,city:row.querySelector('.pl-city').value,country:row.dataset.country||'',
      address:row.querySelector('.pl-address').value,note:row.querySelector('.pl-note').value}));
  }
  const LIBRARY_FULL=1_850_000;   // the library is saved as one file of at most 2 MB
  function editorSave(evt) {
    evt.preventDefault();
    const form=evt.target, err=t=>{$('#modalError').textContent=t;};
    const source=Object.fromEntries(new FormData(form).entries());
    const old=state.records.find(r=>r.id===editingId);
    let kind=old?(old.kind||'tiktok'):editingKind;
    // A TikTok pasted as a web link (or a web page pasted as a TikTok) is saved as what it is.
    if(!old&&kind==='link'&&C.parseTikTokURL(source.url))kind='tiktok';
    else if(!old&&kind==='tiktok'&&!C.parseTikTokURL(source.url)&&C.webLink(source.url))kind='link';
    let key='';
    if(kind==='tiktok'){const parsed=C.parseTikTokURL(source.url);if(!parsed){err('Enter a valid TikTok URL (including a share link).');return;}key=parsed.key;}
    else if(kind==='link'){const w=C.webLink(source.url);if(!w){err(C.parseTikTokURL(source.url)?'That is a TikTok link: save it as a TikTok.':'Enter a web link (https://…).');return;}key=w.key;}
    else if(!String(source.body||'').trim()&&!String(source.title||'').trim()){err('Type the note (or at least a title).');return;}
    const duplicate=key&&state.records.find(r=>r.key===key&&r.id!==editingId);
    if(duplicate){err(kind==='tiktok'?'This video is already saved. Edit its existing card instead.':'This page is already saved. Edit its existing card instead.');return;}
    // The places as the dialog has them; if they differ from what auto-review found, they are the person's now.
    const places=C.cleanPlaces(editorPlaces(),old?.places||[]);
    const same=(a,b)=>JSON.stringify((a||[]).map(p=>[p.name,p.type,p.city,p.address||'',p.note]))===JSON.stringify((b||[]).map(p=>[p.name,p.type,p.city,p.address||'',p.note]));
    const placesBy=same(places,old?.places)?old?.placesBy:(places.length?'person':undefined);
    // A web page or note is the person's own: it needs no review.
    const created=C.createRecord({...source,kind,status:kind==='tiktok'?source.status:'reviewed',id:old?.id,savedAt:old?.savedAt,createdAt:old?.createdAt,
      readAt:editorReadAt||old?.readAt,places,placesBy});
    if(!created){err(kind==='tiktok'?'Invalid TikTok URL.':'That could not be saved.');return;}
    if(old&&old.key===created.key){created.enrichment=old.enrichment;created.enrichedAt=old.enrichedAt;created.enrichmentStatus=old.enrichmentStatus;}
    if(old)created.auto=old.auto;  // what auto-review heard and saw; the person has checked it now
    if(old&&old.category===created.category)created.autoSorted=old.autoSorted;
    const saved=old?{...created,id:old.id}:created;
    if(saved.body&&saved.body!==old?.body&&JSON.stringify(state).length+saved.body.length>LIBRARY_FULL){
      saved.body=saved.body.slice(0,3000);toast('Your library is nearly full (2 MB), so only the first 3,000 characters of the text were kept.');}
    if(old)state.records[state.records.indexOf(old)]=saved;else state.records.push(saved);
    tidyPlan();
    $('#editDialog').close();commit();
    // A new or changed web page or note is read by the AI for its places (a new link with no text: the page is read first).
    const changed=!old||old.body!==saved.body||old.url!==saved.url;
    if(kind!=='tiktok'&&changed&&(saved.body||kind==='link'))readItem(saved.id);
    else toast(old?'Saved':'New '+KIND_TITLES[kind]+' saved');
  }
  // Ask the Worker for a web page's text (src/readpage.js).
  const PAGE_WHY={BLOCKED:'The site would not let ClipAtlas read it (Reddit and some others refuse).',NOT_FOUND:'The page could not be opened.',
    NO_TEXT:'The page has no text ClipAtlas can read (it may need JavaScript to show it).',NOT_A_PAGE:'That link is not a web page.',
    TOO_BIG:'The page is too large to read.',TIMEOUT:'The site took too long to answer.',BAD_LINK:'That is not a web link.',
    TIKTOK:'That is a TikTok: save it as a TikTok.',PRIVATE:'That address cannot be read from the internet.',
    SIGNED_OUT:'Your sign-in expired. Sign in again.',CLIPATLAS_LIMIT:'ClipAtlas has read 100 pages today, its daily limit.',NETWORK:'Connection problem.'};
  const pageWhy=p=>PAGE_WHY[p.reason]||`It did not work (${p.reason||'no answer'}).`;
  async function fetchPage(url){
    try{const res=await fetch('/api/readpage',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({url})});
      const data=await res.json().catch(()=>({}));
      if(res.status===401)return {status:'failed',reason:'SIGNED_OUT'};
      return data.status?data:{status:'failed',reason:'SERVER_'+res.status};
    }catch(_){return {status:'failed',reason:'NETWORK'};}
  }
  const pageText=p=>String(p.text||p.description||'').slice(0,20000);
  async function readPageIntoEditor(){
    const form=$('#editForm'),body=form.elements.namedItem('body'),say=t=>{$('#readPageStatus').textContent=t;};
    const w=C.webLink(form.elements.namedItem('url').value);
    if(!w){say('Enter the web link first.');return;}
    if(body.value.trim()&&!confirm('Replace the text in the box with the page’s text?'))return;
    const btn=$('#readPageBtn');btn.disabled=true;say('Reading the page…');
    try{
      const page=await fetchPage(w.url);
      if(page.status!=='ok'){say(pageWhy(page)+' You can paste the text into the box instead.');return;}
      body.value=pageText(page);editorReadAt=new Date().toISOString();
      const t=form.elements.namedItem('title');if(!t.value.trim()&&page.title)t.value=page.title.slice(0,300);
      say(`Read ${body.value.length.toLocaleString()} characters. When you save, the AI lists the places in it.`);
    }finally{btn.disabled=false;}
  }
  // The AI reads a web page or note (Gemini first, then Cloudflare) and fills in its details and places,
  // the way auto-review does for a clip. What the person wrote is kept.
  async function readItem(id){
    let r=state.records.find(x=>x.id===id);if(!r||C.isClip(r)||reading.has(id))return;
    reading.add(id);if(currentTab==='library')renderLibrary();
    const name=()=>{const x=state.records.find(y=>y.id===id)||r;return x.title||hostOf(x.url)||'the note';};
    try{
      if(r.kind==='link'&&!String(r.body||'').trim()){
        toast('Reading the page…');
        const page=await fetchPage(r.url);
        if(page.status!=='ok'){toast(`${pageWhy(page)} Open Edit and paste the page’s text, and it is read from that.`);return;}
        r=state.records.find(x=>x.id===id);if(!r)return;
        const text=pageText(page);
        r={...r,body:JSON.stringify(state).length+text.length>LIBRARY_FULL?text.slice(0,3000):text,title:r.title||String(page.title||'').slice(0,300),readAt:new Date().toISOString()};
        state.records[state.records.findIndex(x=>x.id===id)]=r;commit();
      }
      const text=[r.body,r.notes].filter(s=>String(s||'').trim()).join('\n\n');
      if(!text.trim()){toast('There is no text to read yet.');return;}
      if(!aiConfigLoaded){await loadAIConfig();aiConfigLoaded=true;}
      const categories=categoryList().map(c=>({name:c.name,words:c.words||[]}));
      let res=null,why='';
      if(aiConfig.gemini){
        const body=JSON.stringify(C.geminiTextRequest({kind:r.kind,title:r.title,url:r.url,body:text,categories}));
        for(let tries=0;tries<3;tries++){
          toast(`Reading “${name()}” with Gemini…`);
          const g=await geminiPost(body);
          if(g.status==='ok'){res=C.readGeminiAnswer(g.text,categoryList(),{audio:false,images:0});break;}
          if(g.stopRun){toast(g.message);return;}
          why=g.detail||g.reason||'';
          if(g.reason==='GEMINI_BUSY'){await new Promise(ok=>setTimeout(ok,Math.min(60,Math.max(2,g.retryAfter||20))*1000));continue;}
          break;
        }
      }
      if((!res||res.status!=='understood')&&aiConfig.cloudflare){
        const data=await autoPost('understand',{transcript:text.slice(0,4000),images:[],categories});
        if(data.stopRun){toast(data.message);return;}
        res=data;why=data.detail||data.error||data.reason||why;
      }
      if(!res){toast(why?`Could not read it: ${why}`:'No AI is set up to read it (see the README: Gemini or Cloudflare).');return;}
      if(res.status!=='understood'){toast(res.status==='empty'?`The AI found nothing to use in “${name()}”.`:`Could not read it: ${res.detail||res.reason||why||'no answer'}`);return;}
      const cur=state.records.find(x=>x.id===id);if(!cur)return;
      // Only what the text says (the Cloudflare route echoes the text back as a "transcript").
      const next=C.applyUnderstanding(cur,{...res,transcript:'',heard:false,onScreen:'',shows:''},{markReviewed:false});
      state.records[state.records.indexOf(cur)]=next;
      tidyPlan();commit();
      const n=(next.places||[]).length;
      toast(n?`Found ${plural(n,'place','places')} in “${name()}”.`:`Read “${name()}”: it names no places.`);
    }finally{reading.delete(id);if(currentTab==='library')renderLibrary();}
  }
  function addToPlan(id){
    const r=state.records.find(r=>r.id===id); if(!r)return;
    if(state.plan.some(p=>p.recordId===id)){toast('This discovery is already in your itinerary.');return;}
    // Each place goes to the first day set to its city (a clip with no places listed: the clip itself).
    const items=C.tripItems([r]),days=[];
    if(!items.length){toast(`This ${r.kind==='link'?'page':'note'} names no places yet. Press ✦ Read, or add its places in Edit.`);return;}
    for(const it of items){const day=C.dayForClip(it,state.dayCities,state.dayCount);days.push(day);
      state.plan.push({id:stopId(),recordId:id,...(it.placeId?{placeId:it.placeId}:{}),day,note:''});}
    const where=[...new Set(days)];
    commit();toast(`Added ${items.length>1?plural(items.length,'place','places')+' ':''}to ${where.length===1?dayLabel(where[0]):'days '+where.join(', ')}. Open Itinerary to organize ${items.length>1?'them':'it'}.`);
  }
  function movePlan(id,offset){
    const a=state.plan.findIndex(p=>p.id===id);if(a<0)return;
    const day=state.plan[a].day;const group=state.plan.map((p,i)=>({p,i})).filter(x=>x.p.day===day);
    const n=group.findIndex(x=>x.i===a), target=group[n+offset];if(!target)return;
    const temp=state.plan[a];state.plan[a]=state.plan[target.i];state.plan[target.i]=temp;commit();
  }
  function addCollection(){
    const name=prompt('Name your new collection (for example: Taiwan shopping):');
    if(!name||!name.trim())return;
    const clean=name.trim().slice(0,100);
    if(!state.collections.includes(clean))state.collections.push(clean);
    activeCollection=clean;commit();selectTab('library');toast('Collection created. Add clips or assign it when editing.');
  }
  function merge(imported, context='') {
    const m=C.mergeRecords(state.records, imported);
    state.records=m.records;
    if(Array.isArray(state.categories)){state=C.addMissingCategories(state);m.sorted=C.sortUnsorted(state.records,state.categories);}
    if(context)for (const r of state.records) {
      // Only assign a collection to links that were in THIS import.
      const keys=new Set(imported.map(x=>C.parseTikTokURL(x.url||x.link)?.key).filter(Boolean));
      if(keys.has(r.key)&&!r.collections.includes(context))r.collections.push(context);
    }
    commit();return m;
  }
  async function importFile(file) {
    if(!file)return;
    if(file.size>30*1024*1024){toast('File exceeds the 30 MB import limit.');return;}
    try{
      const raw=await file.text();let entries=[],isBackup=false;
      if(file.name.toLowerCase().endsWith('.csv'))entries=C.parseCSV(raw);
      else if(file.name.toLowerCase().endsWith('.json')){
        const data=JSON.parse(raw);
        if(data.kind==='clipatlas-backup'&&data.state?.records){
          isBackup=true;
          if(!confirm('Restore this ClipAtlas backup? Your current library, collections and itinerary will be replaced. Export a current backup first if needed.'))return;
          const clean=emptyState();
          clean.records=C.mergeRecords([],Array.isArray(data.state.records)?data.state.records:[]).records;
          const inputPlan=Array.isArray(data.state.plan)?data.state.plan:[];
          const ids=new Set(clean.records.map(r=>r.id));
          clean.plan=inputPlan.filter(p=>ids.has(p.recordId)&&Number(p.day)>=1&&Number(p.day)<=C.MAX_DAYS);
          clean.collections=Array.isArray(data.state.collections)?data.state.collections.filter(x=>typeof x==='string'):[];
          clean.tripTitle=String(data.state.tripTitle||clean.tripTitle);
          clean.dayCount=C.cleanDayCount(data.state.dayCount);
          clean.plan.forEach(p=>{p.day=Math.min(Number(p.day),clean.dayCount);});
          clean.dayCities=C.cleanDayCities(data.state.dayCities,clean.dayCount);
          clean.questions=C.cleanQuestions(data.state.questions);
          if(Array.isArray(data.state.categories))clean.categories=C.normalizeCategories(data.state.categories);
          if(data.state.settings)clean.settings=data.state.settings;
          state=C.ensureSetup(clean).state;if(!Array.isArray(state.categories))state=C.applyStarter(state,'empty');
          state=C.addMissingCategories(state);commit();toast('Full backup restored.');$('#importFeedback').textContent='Backup restored successfully.';return;
        }
        entries=C.extractTikTokFavorites(data);
      } else throw new Error('Use a .json or .csv file. Unzip TikTok’s download first.');
      if(!entries.length){$('#importFeedback').textContent='No favorite TikTok links found. Try the official JSON export with Favorite Videos included, or use the CSV template.';return;}
      const result=merge(entries,$('#bulkCollection').value.trim());
      $('#importFeedback').textContent=`Imported ${result.added} new links; ${result.duplicates} duplicates; ${result.updated} enriched; ${result.invalid} invalid.${result.sorted?` ${result.sorted} sorted into your categories by their text.`:''} Your existing notes and itinerary were kept.`;
      toast('Import finished: '+result.added+' new discoveries');
    }catch(err){$('#importFeedback').textContent='Import error: '+err.message;toast('Could not import this file.');}
    finally{$('#fileImport').value='';}
  }
  // Conservative suggestions from caption text only. Never invent a place or price.
  function suggestMetadata(title){
    const text=String(title||'');const lower=text.toLowerCase();
    const city = /taipei|台北|臺北/i.test(text)?'Taipei':/taichung|台中|臺中/i.test(text)?'Taichung':/tainan|台南/i.test(text)?'Tainan':/kaohsiung|高雄/i.test(text)?'Kaohsiung':'';
    const country=/taiwan|台灣|台湾|臺灣|taipei|taichung|tainan|kaohsiung|台北|臺北|台中|臺中|台南|高雄/i.test(text)?'Taiwan':'';
    const tags=[...new Set((text.match(/#[\p{L}\p{N}_]+/gu)||[]).map(h=>h.slice(1)))].slice(0,12);
    return {city,country,tags};
  }
  // Looks up the next batch of links that need it (C.needsAnalysis), one at a
  // time, saving after each. Each clip keeps what happened in r.enrichment
  // ({status, reason, retryable, at}); only real titles or creators count as
  // filled in. Stops on a rate limit or an expired sign-in.
  const BATCH=40, PAUSE_MS=700;
  const REASON_WORDS={NOT_TIKTOK_LINK:'not a TikTok link',NO_VIDEO_IN_LINK:'not a video link',INVALID_URL:'not a link',
    LINK_TOO_LONG:'link too long',LINK_HAS_LOGIN:'link has a login',EMPTY_METADATA:'no title or creator',
    NOT_PUBLIC:'private or removed',RATE_LIMITED:'TikTok limit',TIMEOUT:'timed out',TIKTOK_ERROR:'TikTok error',
    BAD_RESPONSE:'unexpected answer',NETWORK:'connection problem'};
  let stopAnalysis=false, analysisRunning=false;
  const tallyText=t=>`${t.enriched||0} filled in · ${t.empty||0} no details · ${t.unavailable||0} not public · ${t.rejected||0} not accepted · ${t.failed||0} failed`;
  function renderAnalysisSummary(){
    const counts={};for(const r of state.records){const k=C.analysisState(r);counts[k]=(counts[k]||0)+1;}
    const btn=$('#viewEnriched');if(btn){btn.textContent=`View filled-in clips (${counts.enriched||0})`;btn.disabled=!counts.enriched;}
    const waiting=state.records.filter(r=>C.needsAnalysis(r)).length;
    const note=$('#analysisWaiting');if(note)note.textContent=waiting?`${waiting} link${waiting===1?'':'s'} waiting to be looked up (${BATCH} per click).`:'Every unreviewed link has been looked up.';
  }
  function applyLookup(r,data){
    const at=new Date().toISOString();
    r.enrichment={status:data.status,reason:String(data.reason||'').slice(0,40),retryable:!!data.retryable,at};
    delete r.enrichmentStatus;r.enrichedAt=at;
    if(data.status!=='enriched')return;
    const title=String(data.title||''); const suggestion=suggestMetadata(title);
    if(!r.title&&title)r.title=title;
    if(!r.caption&&title)r.caption=title;
    if(!r.creator&&data.creator)r.creator=String(data.creator);
    r.tags=[...new Set([...(r.tags||[]),...suggestion.tags])].slice(0,20);
    C.sortUnsorted([r],categoryList());
    if(!r.city&&suggestion.city)r.city=suggestion.city;
    if(!r.country&&suggestion.country)r.country=suggestion.country;
    // TikTok told us the full address (with the creator): use it for the link.
    const full=data.canonicalUrl?C.parseTikTokURL(data.canonicalUrl):null;
    if(full){
      if(full.key===r.key)r.url=full.url;
      else if(!r.videoId&&!state.records.some(o=>o!==r&&o.key===full.key)){r.key=full.key;r.videoId=full.videoId;r.url=full.url;}
    }
  }
  async function analyzeLinks(){
    if(analysisRunning)return;
    if(saveBlocked){toast('Resolve the save conflict first.');return;}
    if(saveBusy||dirty||saveTimer){await persist();if(saveBlocked)return;}
    const records=state.records.filter(r=>C.needsAnalysis(r)).slice(0,BATCH);
    if(!records.length){$('#analyzeProgress').textContent='Nothing waiting: every unreviewed link has been looked up recently.';return;}
    analysisRunning=true;stopAnalysis=false;$('#analyzeLinks').disabled=true;$('#cancelAnalyze').hidden=false;
    const tally={},reasons={};let stopReason='';
    try{
      for(let i=0;i<records.length;i++){
        if(stopAnalysis||saveBlocked)break;
        const r=records[i];
        $('#analyzeProgress').textContent=`Looking up ${i+1} of ${records.length} · ${tallyText(tally)}`;
        let data;
        try{
          const res=await fetch('/api/enrich',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:r.originalUrl||r.url}),credentials:'same-origin'});
          data=await res.json().catch(()=>({}));
          if(res.status===401){stopReason='Your sign-in expired: sign in again, then continue.';break;}
          if(res.status===429){stopReason=(data.error||'Lookup limit reached; try again in an hour.')+' ';break;}
          if(!data.status)data={status:'failed',reason:'SERVER_'+res.status,retryable:true};
        }catch(_){data={status:'failed',reason:'NETWORK',retryable:true};}
        applyLookup(r,data);
        tally[data.status]=(tally[data.status]||0)+1;
        if(data.status!=='enriched')reasons[data.reason]=(reasons[data.reason]||0)+1;
        commit();await persist();
        if(data.reason==='RATE_LIMITED'){stopReason='TikTok is limiting lookups: wait a while, then continue. ';break;}
        if(i<records.length-1)await new Promise(resolve=>setTimeout(resolve,PAUSE_MS));
      }
    }finally{
      analysisRunning=false;$('#analyzeLinks').disabled=false;$('#cancelAnalyze').hidden=true;
      const why=Object.entries(reasons).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${REASON_WORDS[k]||k} ${n}`).join(', ');
      const left=state.records.filter(r=>C.needsAnalysis(r)).length;
      $('#analyzeProgress').textContent=`${stopReason}Done: ${tallyText(tally)}.${why?' Why: '+why+'.':''}${left?` ${left} still waiting; click Look up again for the next batch.`:''} Use Review clips to check what it filled in.`;
      render();
    }
  }
  /* ---- Review mode: TikTok's own player beside a short form, one clip at a time ---- */
  const RV_FIELDS=['title','place','city','country','notes','caption'];
  let rv={queue:[],index:0,scope:'review',shown:[],saved:0,skipped:0,touched:false,dirty:false,suggestion:null,fromUnsorted:false,src:''};
  let shownIds=[];
  const mac=/Mac|iPhone|iPad/.test(navigator.platform||'');
  function reviewScopes(){
    const out=Object.entries(C.REVIEW_SCOPES).map(([k,label])=>[k,label,C.reviewQueue(state.records,k).length]);
    if(rv.shown.length)out.push(['shown','Clips on screen',rv.shown.length]);
    for(const name of listCollections())out.push(['collection:'+name,'Collection: '+name,C.reviewQueue(state.records,'collection:'+name).length]);
    return out;
  }
  function renderReviewCount(){
    const n=C.reviewQueue(state.records,'review').length,el=$('#reviewCount');if(!el)return;
    el.textContent=state.records.length?(n?`${n} clip${n===1?'':'s'} need${n===1?'s':''} review.`:'Every clip is reviewed.'):'Import some clips first.';
    $('#startReview').disabled=!state.records.length;
  }
  function openReview(scope='review',startId=null){
    if(!state.records.length){toast('Import or add some clips first.');return;}
    rv.scope=scope;rv.saved=0;rv.skipped=0;
    rv.queue=scope==='shown'?rv.shown.slice():C.reviewQueue(state.records,scope);
    rv.index=Math.max(0,startId?rv.queue.indexOf(startId):0);
    const pick=$('#reviewScope');
    pick.innerHTML=reviewScopes().map(([k,label,n])=>`<option value="${html(k)}">${html(label)} (${n})</option>`).join('');
    pick.value=scope;
    $('#reviewKeys').textContent=`Enter: save & next · ${mac?'⌘':'Ctrl'}+→ skip · ${mac?'⌘':'Ctrl'}+← back · Esc: close`;
    const dlg=$('#reviewDialog');if(!dlg.open)dlg.showModal();
    showClip();
  }
  function setPlayer(r){
    const box=$('#reviewFrame'),src=C.playerUrl(r);
    if(src&&src===rv.src&&box.querySelector('iframe'))return;
    rv.src=src;box.replaceChildren();
    if(src){
      const f=document.createElement('iframe');
      f.src=src;f.title='TikTok video player';f.allow='autoplay; encrypted-media; fullscreen; picture-in-picture';
      f.referrerPolicy='strict-origin-when-cross-origin';f.allowFullscreen=true;box.append(f);
    }else{
      const p=document.createElement('p');p.className='player-none';
      p.textContent='This is a short share link without a video number, so it cannot play here. Open it on TikTok to watch it.';
      box.append(p);
    }
    $('#reviewOpen').href=r.url;
  }
  function stopPlayer(){$('#reviewFrame').replaceChildren();rv.src='';}
  function reviewText(){
    const f=$('#reviewForm').elements;
    return [f.title.value,f.caption.value,f.notes.value,f.tags.value].join(' ');
  }
  function updateSuggestion(){
    const box=$('#reviewSuggest'),sel=$('#reviewCategory');
    const hasWords=categoryList().some(c=>(c.words||[]).length);
    rv.suggestion=hasWords?C.suggestCategory(reviewText(),categoryList()):null;
    if(rv.fromUnsorted&&!rv.touched)sel.value=rv.suggestion?rv.suggestion.name:'Unsorted';
    box.replaceChildren();
    if(!hasWords){box.textContent='Add sort words in Settings and categories will be suggested as you type.';return;}
    if(!rv.suggestion){box.textContent='No sort words match yet.';return;}
    const words=rv.suggestion.words.slice(0,4).map(w=>'“'+w+'”').join(', '),name=`${emojiFor(rv.suggestion.name)} ${rv.suggestion.name}`;
    if(sel.value===rv.suggestion.name){box.textContent=rv.fromUnsorted&&!rv.touched?`Picked ${name} because of ${words}. Change it if that's wrong.`:`${name} matches ${words}.`;return;}
    box.append(`Suggested: ${name}, because of ${words}. `);
    const use=document.createElement('button');use.type='button';use.className='link-inline';use.id='reviewUse';use.textContent='Use it';
    box.append(use);
  }
  function showClip(){
    // Clips deleted since the queue was made are left out.
    while(rv.index<rv.queue.length&&!state.records.some(r=>r.id===rv.queue[rv.index]))rv.queue.splice(rv.index,1);
    const total=rv.queue.length,done=rv.index>=total;
    $('#reviewBody').hidden=done;$('#reviewDone').hidden=!done;
    for(const id of ['reviewPrev','reviewSkip','reviewSave'])$('#'+id).hidden=done;
    $('#reviewKeys').hidden=done;
    $('#reviewPos').textContent=String(Math.min(rv.index+1,total));$('#reviewTotal').textContent=String(total);
    $('#reviewBar').style.width=(total?Math.round(Math.min(rv.index,total)/total*100):100)+'%';
    if(done){
      stopPlayer();
      const label=$('#reviewScope').selectedOptions[0]?.textContent.replace(/\s*\(\d+\)$/,'')||'this list';
      $('#reviewDoneTitle').textContent=total?'All done':'Nothing to review here';
      $('#reviewDoneLine').textContent=total?`That's every clip in ${label}: ${rv.saved} saved, ${rv.skipped} skipped.`:`${label} has no clips right now. Pick another list above.`;
      $('#reviewFinish').focus();return;
    }
    const r=state.records.find(x=>x.id===rv.queue[rv.index]);
    const form=$('#reviewForm'),f=form.elements;
    for(const k of RV_FIELDS)f[k].value=r[k]||'';
    f.tags.value=(r.tags||[]).join(', ');f.collections.value=(r.collections||[]).join(', ');
    fillCategorySelect($('#reviewCategory'),false);$('#reviewCategory').value=r.category||'Unsorted';
    if($('#reviewCategory').value!==(r.category||'Unsorted'))$('#reviewCategory').value='Unsorted';
    f.reviewed.checked=true;
    rv.fromUnsorted=!r.category||r.category==='Unsorted';rv.touched=false;rv.dirty=false;
    const said=r.auto?.transcript||'',shown=r.auto?.onScreen||'';
    $('#reviewHeard').hidden=!said&&!shown;
    $('#reviewTranscript').textContent=said||'Nothing was said, or it has not been transcribed yet.';
    $('#copyTranscript').hidden=!said;
    $('#reviewSeenHead').hidden=$('#reviewSeen').hidden=!shown;$('#reviewSeen').textContent=shown;
    updateSuggestion();
    $('#reviewPrev').disabled=rv.index===0;
    setPlayer(r);
    if(matchMedia('(pointer:fine)').matches)f.title.focus();
  }
  function leaveClip(){
    return !rv.dirty||confirm('Leave this clip without saving your changes?');
  }
  function reviewMove(step){
    if(!leaveClip())return;
    if(step>0&&rv.index<rv.queue.length)rv.skipped++;
    rv.index=Math.max(0,Math.min(rv.queue.length,rv.index+step));showClip();
  }
  function reviewSave(evt){
    evt?.preventDefault();
    if(rv.index>=rv.queue.length)return;
    const r=state.records.find(x=>x.id===rv.queue[rv.index]);if(!r){showClip();return;}
    const f=$('#reviewForm').elements,fields={category:$('#reviewCategory').value,tags:f.tags.value,collections:f.collections.value};
    for(const k of RV_FIELDS)fields[k]=f[k].value;
    const next=C.reviewEdit(r,fields,{reviewed:f.reviewed.checked,suggested:rv.suggestion});
    if(!next){toast('This clip could not be saved.');return;}
    const same=JSON.stringify({...next,updatedAt:0})===JSON.stringify({...r,updatedAt:0});
    if(!same){state.records[state.records.indexOf(r)]=next;commit();}
    rv.saved++;rv.dirty=false;rv.index++;showClip();
  }
  function closeReview(){
    if(!leaveClip())return false;
    stopPlayer();$('#reviewDialog').close();
    if(rv.saved)toast(`Saved ${rv.saved} clip${rv.saved===1?'':'s'}.`);
    return true;
  }
  function initReview(){
    const dlg=$('#reviewDialog'),form=$('#reviewForm');
    $('#startReview').addEventListener('click',()=>{rv.shown=[];openReview('review');});
    form.addEventListener('submit',reviewSave);
    form.addEventListener('input',evt=>{
      if(evt.target.id==='reviewScope')return;
      rv.dirty=true;
      if(evt.target.id==='reviewCategory')rv.touched=true;
      if(['title','caption','notes','tags'].includes(evt.target.name))updateSuggestion();
    });
    form.addEventListener('change',evt=>{if(evt.target.id==='reviewCategory'){rv.touched=true;rv.dirty=true;updateSuggestion();}});
    $('#reviewSuggest').addEventListener('click',evt=>{
      if(evt.target.id!=='reviewUse'||!rv.suggestion)return;
      $('#reviewCategory').value=rv.suggestion.name;rv.touched=true;rv.dirty=true;updateSuggestion();
    });
    $('#reviewScope').addEventListener('change',evt=>{
      if(!leaveClip()){evt.target.value=rv.scope;return;}
      rv.dirty=false;openReview(evt.target.value);
    });
    $('#copyEditTranscript').addEventListener('click',async()=>{
      try{await navigator.clipboard.writeText($('#editTranscript').textContent);toast('Transcript copied.');}
      catch(_){toast('Copying is blocked here; select the text and copy it instead.');}
    });
    $('#copyTranscript').addEventListener('click',async()=>{
      try{await navigator.clipboard.writeText($('#reviewTranscript').textContent);toast('Transcript copied.');}
      catch(_){toast('Copying is blocked here; select the text and copy it instead.');}
    });
    $('#reviewPrev').addEventListener('click',()=>reviewMove(-1));
    $('#reviewSkip').addEventListener('click',()=>reviewMove(1));
    $('#reviewClose').addEventListener('click',closeReview);
    $('#reviewFinish').addEventListener('click',closeReview);
    $('#reviewAgain').addEventListener('click',()=>openReview(rv.scope));
    dlg.addEventListener('cancel',evt=>{evt.preventDefault();closeReview();});
    dlg.addEventListener('close',stopPlayer);
    dlg.addEventListener('keydown',evt=>{
      const mod=evt.ctrlKey||evt.metaKey;
      if(mod&&evt.key==='ArrowRight'){evt.preventDefault();reviewMove(1);}
      else if(mod&&evt.key==='ArrowLeft'){evt.preventDefault();reviewMove(-1);}
      else if(mod&&evt.key==='Enter'){evt.preventDefault();reviewSave();}
    });
  }
  /* ---- Choosing many clips: delete, move to a category, mark reviewed ---- */
  function renderBulkBar(){
    const bar=$('#bulkBar');if(!bar)return;
    for(const id of [...selected])if(!state.records.some(r=>r.id===id))selected.delete(id);
    $('#selectMode').textContent=selecting?'✓ Done selecting':'☐ Select';
    bar.hidden=!selecting;document.body.classList.toggle('selecting',selecting);if(!selecting)return;
    const n=selected.size,cat=$('#categoryFilter').value;
    $('#bulkCount').textContent=`${n} selected`;
    const all=shownIds.length&&shownIds.every(id=>selected.has(id));
    $('#bulkAll').textContent=all?'Unselect all shown':(cat!=='all'&&!activeCollection&&!$('#search').value.trim()&&$('#statusFilter').value==='all'&&$('#analysisFilter').value==='all'
      ?`Select all ${shownIds.length} in ${cat==='Unsorted'?'Unsorted':emojiFor(cat)+' '+cat}`:`Select all ${shownIds.length} shown`);
    $('#bulkAll').disabled=!shownIds.length;
    fillCategorySelect($('#bulkMove'),false);
    $('#bulkMove').insertAdjacentHTML('afterbegin','<option value="" selected>Move to category…</option>');$('#bulkMove').value='';
    // Collections: add to any (or a new one); take out of the ones the selected clips are in.
    const inThem=[...new Set(state.records.filter(r=>selected.has(r.id)).flatMap(r=>r.collections||[]))].sort((a,b)=>a.localeCompare(b));
    $('#bulkCollect').innerHTML='<option value="" selected>Add to collection…</option>'+
      `<optgroup label="Add to">${listCollections().map(c=>`<option value="add:${html(c)}">＋ ${html(c)}</option>`).join('')}<option value="new">＋ New collection…</option></optgroup>`+
      (inThem.length?`<optgroup label="Take out of">${inThem.map(c=>`<option value="drop:${html(c)}">− ${html(c)}</option>`).join('')}</optgroup>`:'');
    for(const id of ['bulkMove','bulkCollect','bulkReviewed','bulkDelete'])$('#'+id).disabled=!n;
    $('#bulkDelete').textContent=n?`Delete ${n}`:'Delete';
  }
  function setSelecting(on){selecting=on;if(!on)selected.clear();renderLibrary();}
  function bulkDelete(){
    const ids=[...selected];if(!ids.length)return;
    if(!confirm(`Delete ${ids.length} clip${ids.length===1?'':'s'}? ${ids.length===1?'It':'They'} also leave${ids.length===1?'s':''} the itinerary. You can undo this for a few seconds.`))return;
    const {state:next,removed}=C.removeRecords(state,ids);
    state=next;selected.clear();commit();
    toast(`Deleted ${ids.length} clip${ids.length===1?'':'s'}.`,{label:'Undo',run:()=>{state=C.restoreRecords(state,removed);commit();toast('Brought them back.');}});
  }
  function bulkUpdate(changes,said){
    const ids=[...selected];if(!ids.length)return;
    state=C.updateRecords(state,ids,changes);commit();toast(said(ids.length));
  }
  function initBulk(){
    $('#selectMode').addEventListener('click',()=>setSelecting(!selecting));
    $('#bulkDone').addEventListener('click',()=>setSelecting(false));
    $('#bulkClear').addEventListener('click',()=>{selected.clear();renderLibrary();});
    $('#bulkAll').addEventListener('click',()=>{
      const all=shownIds.every(id=>selected.has(id));
      for(const id of shownIds)all?selected.delete(id):selected.add(id);renderLibrary();
    });
    $('#bulkDelete').addEventListener('click',bulkDelete);
    $('#bulkReviewed').addEventListener('click',()=>bulkUpdate({status:'reviewed'},n=>`Marked ${n} clip${n===1?'':'s'} reviewed.`));
    $('#bulkMove').addEventListener('change',e=>{const to=e.target.value;if(!to)return;
      bulkUpdate({category:to},n=>`Moved ${n} clip${n===1?'':'s'} to ${to}.`);});
    $('#bulkCollect').addEventListener('change',e=>{
      const v=e.target.value;if(!v)return;
      let name=v.startsWith('add:')?v.slice(4):'';
      if(v==='new'){name=(prompt('Name of the new collection')||'').replace(/\s+/g,' ').trim().slice(0,60);if(!name){e.target.value='';return;}}
      if(name)bulkUpdate({addTo:name},n=>`Added ${n} clip${n===1?'':'s'} to ${name}.`);
      else if(v.startsWith('drop:')){const from=v.slice(5);bulkUpdate({removeFrom:from},n=>`Took ${n} clip${n===1?'':'s'} out of ${from}.`);}
    });
    // In select mode a click anywhere on a card (but its buttons and links) picks it.
    $('#clipGrid').addEventListener('click',e=>{
      if(!selecting)return;
      const card=e.target.closest('[data-card]');if(!card)return;
      if(e.target.closest('button,a'))return;
      const id=card.dataset.card;
      if(!e.target.matches('[data-pick]'))e.preventDefault();
      selected.has(id)?selected.delete(id):selected.add(id);renderLibrary();
    });
  }
  // Settings: "12 clips" next to a category selects them in Discoveries.
  function selectCategory(name){
    activeCollection='';$('#search').value='';$('#statusFilter').value='all';$('#analysisFilter').value='all';
    $('#categoryFilter').value=name;selecting=true;selected.clear();selectTab('library');
    for(const id of shownIds)selected.add(id);renderLibrary();
  }
  /* ---- Auto-review: play each clip, record the tab's sound and screenshots, let the Worker fill it in ---- */
  const AUTO_REASONS={NOTHING_TO_READ:'nothing heard or seen',NOTHING_SAID:'nothing said',NO_PLAYER:'player did not load',STALLED:'stopped playing',
    NOT_FOUND:'removed or private',PLAYBACK:'would not play',AUTOPLAY:'blocked from playing',AI_FAILED:'AI problem',
    BAD_INPUT:'could not be read',NETWORK:'connection problem'};
  let auto=null; // the run in progress
  const autoSupported=()=>!!(navigator.mediaDevices&&navigator.mediaDevices.getDisplayMedia&&window.AudioWorkletNode&&!/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent));
  function autoScopes(){
    const opts={redo:$('#autoRedo').checked,mode:$('#autoMode').value};
    const out=Object.entries(C.REVIEW_SCOPES).map(([k,label])=>[k,label,C.autoQueue(state.records,k,opts).length]);
    for(const name of listCollections())out.push(['collection:'+name,'Collection: '+name,C.autoQueue(state.records,'collection:'+name,opts).length]);
    return out;
  }
  function autoEstimate(){
    const queue=C.autoQueue(state.records,$('#autoScope').value,{redo:$('#autoRedo').checked,mode:$('#autoMode').value});
    $('#autoMarkWrap').hidden=$('#autoMode').value==='transcript';
    const speed=Number($('#autoSpeed').value)||1;
    const minutes=Math.ceil(queue.length*(5+45/speed)/60);  // most clips are under a minute; each plays to its end
    const short=state.records.filter(r=>C.isClip(r)&&!C.playerUrl(r)).length;
    $('#autoEstimate').textContent=(queue.length?`${queue.length} clip${queue.length===1?'':'s'} · up to about ${minutes<90?minutes+' minutes':Math.round(minutes/6)/10+' hours'}.`:'No clips to auto-review in this list.')+
      (short?` ${short} short link${short===1?' (vm.tiktok.com) cannot play here and is':'s (vm.tiktok.com) cannot play here and are'} left out.`:'');
    $('#autoStart').disabled=!queue.length||!autoSupported();
    if(!auto&&$('#autoStart').dataset.ran)$('#autoStart').textContent=queue.length&&!$('#autoRedo').checked?`Continue · ${queue.length} left`:'Start again';
  }
  // Which AI services this site has for this account (Gemini needs its key as a Cloudflare secret).
  let aiConfig={gemini:false,cloudflare:true};
  async function loadAIConfig(){
    try{const res=await fetch('/api/ai-config',{credentials:'same-origin'});if(res.ok)aiConfig={...aiConfig,...await res.json()};}catch(_){/* keep the last answer */}
    const pick=$('#autoAI');
    pick.querySelector('[value="gemini"]').disabled=!aiConfig.gemini;
    if(!aiConfig.gemini)pick.value='cloudflare';
    else{try{const kept=localStorage.getItem('ClipAtlasAutoAI');pick.value=kept==='cloudflare'?'cloudflare':'gemini';}catch(_){pick.value='gemini';}}
    $('#autoAIHint').textContent=aiConfig.gemini?'Gemini first; when its free requests run out for the day, Cloudflare takes over.':'Gemini is not set up on this site yet (see the README: a free key from Google AI Studio).';
  }
  function openAuto(){
    if(!state.records.length){toast('Import or add some clips first.');return;}
    loadAIConfig();
    const pick=$('#autoScope'),keep=pick.value||'review';
    pick.innerHTML=autoScopes().map(([k,label,n])=>`<option value="${html(k)}">${html(label)} (${n})</option>`).join('');
    pick.value=[...pick.options].some(o=>o.value===keep)?keep:'review';
    $('#autoSetup').hidden=false;$('#autoRun').hidden=true;$('#autoError').textContent='';
    $('#autoStart').hidden=false;$('#autoStop').hidden=true;$('#autoBar').style.width='0%';
    $('#autoHint').textContent=autoSupported()?'':'Auto-review needs Chrome or Edge on a computer.';
    autoEstimate();
    const dlg=$('#autoDialog');if(!dlg.open)dlg.showModal();
  }
  function autoSay(text){$('#autoNow').textContent=text;}
  // Things the person should know about the run (the extension is off, Gemini is used up…), shown together.
  function autoNote(text){if(!auto)return;if(!auto.notes.includes(text))auto.notes.push(text);$('#autoHint').textContent=auto.notes.join(' ');}
  function autoCounts(){
    const t=auto.tally;
    $('#autoCounts').textContent=`${auto.index>=auto.queue.length?'All '+auto.queue.length+' clips':'Clip '+(auto.index+1)+' of '+auto.queue.length} · ${auto.mode==='transcript'?(t.transcribed||0)+' transcribed':(t.understood||0)+' filled in'} · ${t.empty||0} nothing heard or seen · ${t.unavailable||0} would not play · ${t.failed||0} failed`;
    $('#autoBar').style.width=Math.round(auto.index/auto.queue.length*100)+'%';
  }
  const clock=ms=>{const s=Math.max(0,Math.round(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s/60)%60;
    return (h?h+':'+String(m).padStart(2,'0'):m)+':'+String(s%60).padStart(2,'0');};
  // How long the run has taken, and about how long is left (from the clips done so far).
  function autoTime(){
    if(!auto)return;
    const ran=Date.now()-auto.startedAt-auto.pausedMs-(auto.pausedSince?Date.now()-auto.pausedSince:0),done=auto.finished;
    const left=done?Math.round(ran/done*(auto.queue.length-done)):0;
    $('#autoTime').textContent=`Running ${clock(ran)}${auto.pausedSince?' · paused':''}${done&&left?' · about '+clock(left)+' left':''}${autoUse()}`;
  }
  // What the run used of Cloudflare's free daily AI allowance (10,000 "neurons"), when the Worker could tell.
  const ALLOWANCE=10000;
  function autoUse(end){
    if(!auto)return '';
    const n=x=>Math.round(x).toLocaleString();
    const gemini=auto.geminiCalls?` · Gemini: ${n(auto.geminiCalls)} request${auto.geminiCalls===1?'':'s'}${end?' (your daily limit is in Google AI Studio)':''}`:'';
    if(auto.usePartial||!auto.neurons||!auto.useClips)return gemini;
    const each=auto.neurons/auto.useClips;
    return gemini+(end?` · Cloudflare: about ${n(auto.neurons)} neurons, ${n(each)} a clip (the free ${n(ALLOWANCE)} a day fits about ${n(ALLOWANCE/each)} clips)`
      :` · Cloudflare: about ${n(auto.neurons)} of the free ${n(ALLOWANCE)} a day`);
  }
  // When Cloudflare's free AI allowance comes back (midnight UTC), in the person's own time.
  function allowanceMessage(geminiToo){
    if(geminiToo)return `Both free AI allowances are used up for today: Cloudflare's comes back ${clockAt(C.allowanceResets())} (midnight UTC) and Gemini's ${clockAt(C.pacificMidnight())} (midnight Pacific). Press Start again then; it carries on with the clips not done yet.`;
    return `Cloudflare's free AI allowance for today is used up. It starts again ${clockAt(C.allowanceResets())} (midnight UTC); press Start again then, and it carries on with the clips not done yet.`;
  }
  // What one clip gave: how many words were heard, how many screenshots or slides were read, and how long it took.
  function autoFacts(res,meta){
    if(!meta||res.status==='unavailable')return '';
    const words=(res.transcript||'').split(/\s+/).filter(Boolean).length;
    const read=typeof res.read==='number'&&res.read<meta.shots&&!meta.slides?`${res.read} of `:'';
    return [words?`${words} word${words===1?'':'s'} heard`:'no speech heard',
      meta.slides?`${meta.slides} slide${meta.slides===1?'':'s'}`:meta.shots?`${read}${meta.shots} screenshot${meta.shots===1?'':'s'}${read?' read':''}`:'',
      clock(meta.ms),C.speedLabel(meta.rate),meta.tries>1?'played on the second try':'',auto&&auto.provider==='gemini'&&res.via?res.via:''].filter(Boolean).join(' · ');
  }
  // While a clip's AI work runs (during the next clip), its line says so; the result then takes its place.
  function autoPending(r){
    const li=document.createElement('li');li.className='pending';
    const b=document.createElement('strong');b.textContent=r.title||r.place||'A clip';
    li.append(b,document.createTextNode(` · reading it with ${auto.provider==='gemini'&&!auto.geminiOff?'Gemini':'Cloudflare'}…`));
    $('#autoResults').prepend(li);return li;
  }
  // One clip's result in the run's list. A clip that was filled in opens to show what was found
  // (the newest one open, the earlier ones folded); the others are one line.
  function autoListItem(before,r,res,meta,pending){
    const list=$('#autoResults'),li=document.createElement('li');
    const facts=document.createElement('small');facts.textContent=autoFacts(res,meta);
    const strong=t=>{const b=document.createElement('strong');b.textContent=t;return b;};
    if(res.status==='transcribed'){
      li.className='ok';
      li.append(strong(r.title||'A clip'),document.createTextNode(`: “${(res.transcript||'').slice(0,90)}${(res.transcript||'').length>90?'…':''}”`),facts);
    }else if(res.status!=='understood'){
      li.className='not';
      li.append(strong(r.title||'A clip'),document.createTextNode(`: ${AUTO_REASONS[res.reason]||C.AUTO_LABELS[res.status]||res.reason}${res.detail?' ('+res.detail+')':''}`),facts);
    }else{
      li.className='ok';
      const n=(r.places||[]).length,d=document.createElement('details'),sum=document.createElement('summary'),body=document.createElement('div');
      sum.append(strong(r.title||'Untitled'),document.createTextNode(` → ${emojiFor(r.category)} ${r.category}${n?` · 📍 ${plural(n,'place','places')}`:''}${res.heard||res.seen?' (from '+[res.heard&&'what was said',res.seen&&'what was shown'].filter(Boolean).join(' and ')+')':''}`));
      body.className='found';body.innerHTML=autoFound(before,r,res);
      d.append(sum,body);li.append(d,facts);
      for(const old of list.querySelectorAll('details[data-auto-open]')){old.open=false;delete old.dataset.autoOpen;}
      d.open=true;d.dataset.autoOpen='1';
    }
    if(pending&&pending.isConnected)pending.replaceWith(li);else list.prepend(li);
    while(list.children.length>40)list.lastChild.remove();
  }
  // What auto-review found in one clip and what it changed (``before``: the clip as it was).
  function autoFound(before,r,res){
    const out=[],cut=(t,n)=>{t=String(t||'').replace(/\s+/g,' ').trim();return t.length>n?t.slice(0,n)+'…':t;};
    const where=[r.place,[r.city,r.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    if(where)out.push(`<p class="found-where">📍 ${html(where)}</p>`);
    if(res.summary)out.push(`<p class="found-summary">${html(res.summary)}</p>`);
    const places=r.places||[];
    if(places.length)out.push(`<ul class="found-places">${places.map(p=>`<li>${C.PLACE_EMOJI[C.placeType(p.type)]} <b>${html(p.name)}</b>${p.city?' · '+html(p.city):''}${p.note?' — '+html(p.note):''}${p.address?` <span class="found-address">📍 ${html(p.address)}</span>`:''}</li>`).join('')}</ul>`
      +(r.placesBy==='person'?'<p class="found-note">These are the places as you edited them; auto-review leaves them as they are.</p>':''));
    for(const [label,text,n] of [['Heard',res.transcript,280],['On screen',res.onScreen,200],['Seen',res.shows,160]])
      if(cut(text,n))out.push(`<p class="found-quote"><span>${label}</span> “${html(cut(text,n))}”</p>`);
    const tags=(r.tags||[]).filter(t=>!(before.tags||[]).includes(t));
    if(tags.length)out.push(`<p class="found-tags">${tags.map(t=>'#'+html(t)).join(' ')}</p>`);
    const changed=[],kept=[];
    for(const [k,label] of [['title','title'],['category','category'],['place','place'],['city','city'],['country','country'],['creator','creator'],['caption','text from the video']]){
      if(String(before[k]||'')!==String(r[k]||''))changed.push(label);
      else if(['title','place','city','country'].includes(k)&&before[k]&&res[k]&&String(res[k]).toLowerCase()!==String(before[k]).toLowerCase())kept.push(label);
    }
    const had=new Set((before.places||[]).map(p=>p.name.toLowerCase())),added=places.filter(p=>!had.has(p.name.toLowerCase())).length;
    if(added)changed.push(plural(added,'new place','new places'));
    if(tags.length)changed.push(plural(tags.length,'tag','tags'));
    out.push(`<p class="found-changes">${changed.length?'Filled in: '+html(changed.join(', '))+'.':'Nothing new to fill in.'}${kept.length?' Kept yours: '+html(kept.join(', '))+'.':''}</p>`);
    // Only Unsorted clips are moved by themselves; for the others, the AI's choice is offered.
    const said=C.categoryName(res.category);
    if(said&&said!=='Unsorted'&&r.category!=='Unsorted'&&r.category!==said&&categoryList().some(c=>c.name===said))
      out.push(`<p class="found-suggest">The AI would file it under ${html(emojiFor(said))} ${html(said)}; it stays in ${html(r.category)}. <button type="button" class="link-inline" data-action="use-category" data-id="${html(r.id)}" data-category="${html(said)}">Move it to ${html(said)}</button></p>`);
    return out.join('');
  }
  async function startAuto(){
    if(auto)return;
    $('#autoError').textContent='';
    if(!autoSupported()){$('#autoError').textContent='Auto-review needs Chrome or Edge on a computer.';return;}
    if(saveBlocked){$('#autoError').textContent='Resolve the save problem first (see the message at the top).';return;}
    const mode=$('#autoMode').value;
    const queue=C.autoQueue(state.records,$('#autoScope').value,{redo:$('#autoRedo').checked,mode});
    if(!queue.length)return;
    let stream;
    try{
      stream=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser',frameRate:10},
        audio:{suppressLocalAudioPlayback:true,echoCancellation:false,noiseSuppression:false,autoGainControl:false},
        preferCurrentTab:true,selfBrowserSurface:'include',surfaceSwitching:'exclude',systemAudio:'exclude'});
    }catch(err){
      $('#autoError').textContent=err&&err.name==='NotAllowedError'?'Sharing was cancelled, so auto-review did not start.':'This browser would not share the tab ('+(err&&err.name||'error')+').';
      return;
    }
    if(!stream.getAudioTracks().length){
      stream.getTracks().forEach(t=>t.stop());
      $('#autoError').textContent='The tab\'s sound was not shared. Press Start again and turn on "Also share tab audio".';return;
    }
    auto={queue,index:0,stream,stop:false,tally:{},failsInRow:0,mark:mode==='details'&&$('#autoMark').checked,mode,
      chunks:[],recording:false,startedAt:Date.now(),pausedMs:0,pausedSince:0,finished:0,
      speed:Number($('#autoSpeed').value)||1,neurons:0,useClips:0,usePartial:false,speedWarned:false,
      provider:aiConfig.gemini&&$('#autoAI').value!=='cloudflare'?'gemini':'cloudflare',cloudflare:aiConfig.cloudflare,geminiOff:'',geminiCalls:0,geminiTokens:0,notes:[]};
    try{localStorage.setItem('ClipAtlasAutoSpeed',String(auto.speed));if(aiConfig.gemini)localStorage.setItem('ClipAtlasAutoAI',$('#autoAI').value);}catch(_){/* remembered only when the browser allows */}
    auto.clock=setInterval(autoTime,1000);autoTime();
    $('#autoSetup').hidden=true;$('#autoRun').hidden=false;$('#autoResults').replaceChildren();
    $('#autoStart').hidden=true;$('#autoStop').hidden=false;$('#autoHint').textContent='Keep this tab open and on screen while it works.';
    let stopReason='';
    try{
      stream.getVideoTracks()[0].addEventListener('ended',()=>{if(!auto)return;auto.stop=true;auto.ended=true;auto.finishClip?.('SHARING_STOPPED');});
      const ctx=new AudioContext();auto.ctx=ctx;
      await ctx.audioWorklet.addModule('recorder.js');
      const source=ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const node=new AudioWorkletNode(ctx,'clipatlas-recorder');auto.node=node;
      const silent=ctx.createGain();silent.gain.value=0;
      source.connect(node);node.connect(silent).connect(ctx.destination);
      node.port.onmessage=e=>{if(!auto||!auto.recording)return;const d=e.data;auto.chunks.push(d);
        let sum=0;for(let i=0;i<d.length;i+=4)sum+=d[i]*d[i];if(sum/Math.max(1,d.length/4)>1e-4)auto.loudAt=Date.now();};
      if(ctx.state!=='running')await ctx.resume();
      const video=document.createElement('video');video.muted=true;video.playsInline=true;
      video.srcObject=new MediaStream(stream.getVideoTracks());await video.play();auto.video=video;
      try{auto.wake=await navigator.wakeLock?.request('screen');}catch(_){/* the screen may sleep; capture still works while the tab is open */}
      // Save one clip's result. False when the run has to stop.
      const keep=async(r,res,meta,pending)=>{
        if(res.stopRun){pending?.remove();stopReason=res.message;auto.stop=true;return false;}
        const i=state.records.findIndex(x=>x.id===r.id);if(i<0){pending?.remove();return true;}
        const before=state.records[i];
        let next=C.applyUnderstanding(before,res,{markReviewed:auto.mark});
        // The library is one saved file of at most 2 MB: keep long transcripts short when it is nearly full.
        if(next.auto?.transcript&&JSON.stringify(state).length>1_700_000){next={...next,auto:{...next.auto,transcript:next.auto.transcript.slice(0,500)}};auto.trimmed=true;}
        state.records[i]=next;
        tidyPlan();
        auto.tally[res.status]=(auto.tally[res.status]||0)+1;
        auto.finished++;
        if(res.use){auto.neurons+=res.use.neurons;auto.useClips++;if(res.use.partial)auto.usePartial=true;}
        if(meta&&C.speedMissing(auto.speed,meta.rate)&&!auto.speedWarned){auto.speedWarned=true;
          autoNote('Clips are playing at normal speed: the ClipAtlas playback speed extension does not seem to be on (see the README, "Playback speed").');}
        autoListItem(before,state.records[i],res,meta,pending);
        commit();await persist();
        if(saveBlocked){stopReason='Saving failed, so auto-review stopped. Download a backup.';auto.stop=true;return false;}
        auto.failsInRow=res.status==='failed'?auto.failsInRow+1:0;
        if(res.detail)auto.lastDetail=res.detail;
        if(auto.failsInRow>=3){stopReason=`Three clips in a row failed, so auto-review stopped.${auto.lastDetail?' Last problem: '+auto.lastDetail+'.':''} "Check the AI setup" tests each step.`;auto.stop=true;return false;}
        return true;
      };
      // Each clip's AI work runs while the next clips play; results are saved in order.
      // At most two clips wait for their AI work, so a slow AI step cannot pile up.
      let chain=Promise.resolve(true);const waiting=[];
      const later=(r,work,meta,pending=null)=>{
        const item={finished:false};
        item.promise=chain=chain.then(async go=>{
          if(!go){pending?.remove();item.finished=true;return false;}
          const res=await work.catch(err=>({status:'failed',reason:'AI_FAILED',detail:String(err&&err.message||err)}));
          const more=await keep(r,res,meta,pending);item.finished=true;
          if(!more)auto.finishClip?.('STOPPED_BY_RUN');  // cut the clip that is playing now
          return more;
        });
        waiting.push(item);
      };
      for(;auto.index<auto.queue.length&&!auto.stop;auto.index++){
        while(waiting.filter(i=>!i.finished).length>=2)await waiting.find(i=>!i.finished).promise;
        if(auto.stop)break;
        const r=state.records.find(x=>x.id===auto.queue[auto.index]);if(!r)continue;
        autoCounts();
        const clipStarted=Date.now(),pausedBefore=auto.pausedMs;
        const got=await autoPlayClip(r);
        const meta={ms:Date.now()-clipStarted-(auto.pausedMs-pausedBefore),shots:got.played?got.played.shots.length:0,slides:got.played?got.played.slides:0,
          rate:got.played?got.played.rate:0,tries:got.played?got.played.tries:0};
        if(got.done&&(got.done.reason==='SHARING_STOPPED'||got.done.reason==='STOPPED'))break;  // nothing saved for a clip cut short
        later(r,got.done?Promise.resolve(got.done):autoAnalyze(r,got),meta,got.done?null:autoPending(r));
      }
      if(waiting.some(i=>!i.finished))autoSay('Finishing the last clips…');
      await chain;
    }catch(err){stopReason='Auto-review stopped: '+(err&&err.message||err);}
    finally{
      clearInterval(auto.clock);autoTime();
      const took=Date.now()-auto.startedAt-auto.pausedMs;
      $('#autoTime').textContent=`Took ${clock(took)}${auto.finished?' · '+clock(took/auto.finished)+' a clip on average':''}${autoUse(true)}`;
      const done=auto.index>=auto.queue.length,ended=auto.ended,t=auto.tally,trimmed=auto.trimmed,warned=auto.notes.length>0;
      autoCounts();
      autoCleanup();
      $('#autoStart').hidden=false;$('#autoStop').hidden=true;
      if(!warned)$('#autoHint').textContent='';
      if(done)$('#autoBar').style.width='100%';
      autoSay((stopReason||(done?'Done.':ended?'Tab sharing stopped, so auto-review stopped.':'Stopped.'))+` ${t.understood||0} filled in, ${t.transcribed?t.transcribed+' transcribed, ':''}${t.empty||0} nothing heard or seen, ${t.unavailable||0} would not play, ${t.failed||0} failed.`+(t.understood?' Filter Discoveries by "Auto-reviewed" to check them.':'')+(t.transcribed?' Transcripts show in Review clips and are searchable.':'')+(trimmed?' Your library is nearly full, so the last transcripts were kept short.':''));
      // What is left of this list: Start carries on with those (finished clips are saved and skipped).
      const left=$('#autoRedo').checked?0:C.autoQueue(state.records,$('#autoScope').value,{mode:$('#autoMode').value}).length;
      $('#autoStart').textContent=left?`Continue · ${left} left`:'Start again';$('#autoStart').dataset.ran='1';
      render();
    }
  }
  function autoCleanup(){
    if(!auto)return;
    try{auto.node&&auto.node.port.postMessage({record:false});}catch(_){}
    try{auto.stream.getTracks().forEach(t=>t.stop());}catch(_){}
    try{auto.ctx&&auto.ctx.close();}catch(_){}
    try{auto.wake&&auto.wake.release();}catch(_){}
    const note=document.createElement('p');note.className='player-none';note.textContent='Each clip plays here while it is reviewed.';
    $('#autoFrame').replaceChildren(note);
    auto=null;
  }
  // Take what the shared tab shows inside the player's box.
  function autoShot(frame){
    const v=auto.video;if(!v||!v.videoWidth)return null;
    const box=frame.getBoundingClientRect(),sx=v.videoWidth/window.innerWidth,sy=v.videoHeight/window.innerHeight;
    const w=360,h=640,c=document.createElement('canvas');c.width=w;c.height=h;
    c.getContext('2d').drawImage(v,box.left*sx,box.top*sy,box.width*sx,box.height*sy,0,0,w,h);
    return c;
  }
  // A small grayscale picture of one screenshot (72×128), to spot one that repeats the one before.
  function autoShotSig(shot){
    const c=document.createElement('canvas');c.width=72;c.height=128;
    const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(shot,0,0,72,128);
    const d=g.getImageData(0,0,72,128).data,out=new Uint8Array(72*128);
    for(let i=0;i<out.length;i++)out[i]=(d[i*4]*3+d[i*4+1]*6+d[i*4+2])/10;
    return out;
  }
  // Sheets of up to three screenshots side by side, at most six sheets (eighteen
  // screenshots; a longer slideshow is sampled evenly, first and last kept).
  function autoSheets(shots){
    let pick=shots;
    if(shots.length>18)pick=Array.from({length:18},(_,i)=>shots[Math.round(i*(shots.length-1)/17)]);
    const sheets=[];
    for(let i=0;i<pick.length;i+=3){
      const part=pick.slice(i,i+3),c=document.createElement('canvas');c.width=360*part.length;c.height=640;
      const g=c.getContext('2d');part.forEach((s,j)=>g.drawImage(s,j*360,0));
      sheets.push(c.toDataURL('image/jpeg',0.8));
    }
    return sheets;
  }
  function wavBase64(samples){return wavBase64At(samples,16000);}
  function wavBase64At(samples,rate){
    const bytes=C.wavBytes(samples,rate);let bin='';
    for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
    return btoa(bin);
  }
  // "Check the AI setup": each model once on a 1-second tone and a picture with words on it.
  async function checkSetup(){
    const btn=$('#aiCheckBtn'),out=$('#aiCheckOut');btn.disabled=true;out.replaceChildren();out.hidden=false;
    const wait=document.createElement('li');wait.textContent='Checking each step (about 10 seconds)…';out.append(wait);
    const tone=new Float32Array(16000);for(let i=0;i<tone.length;i++)tone[i]=0.3*Math.sin(2*Math.PI*440*i/16000);
    const c=document.createElement('canvas');c.width=360;c.height=640;const g=c.getContext('2d');
    g.fillStyle='#1d6b5a';g.fillRect(0,0,360,640);g.fillStyle='#fff';g.font='bold 40px sans-serif';
    g.fillText('BEST NOODLES',24,290);g.fillText('IN TAIPEI',24,345);
    let data;
    try{
      const res=await fetch('/api/aicheck',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
        body:JSON.stringify({audio:wavBase64(tone),image:c.toDataURL('image/jpeg',0.85)})});
      data=await res.json().catch(()=>({}));
      if(!data.steps)data={steps:[{step:'server',ok:false,detail:data.error||('answered '+res.status)}]};
    }catch(err){data={steps:[{step:'connection',ok:false,detail:String(err&&err.message||err)}]};}
    // Gemini, when it is set up: one request with the same tone and picture.
    if(aiConfig.gemini){
      const started=Date.now();
      const body=JSON.stringify(C.geminiRequest({mode:'details',categories:categoryList().map(x=>({name:x.name,words:x.words||[]})),
        audio:wavBase64(tone),images:[c.toDataURL('image/jpeg',0.85).split(',')[1]]}));
      const res=await geminiPost(body);
      const ms=Date.now()-started;
      if(res.status==='ok'){const a=C.readGeminiAnswer(res.text,categoryList(),{audio:true,images:1});
        data.steps.push({step:'gemini',ok:a.status!=='failed',ms,said:a.status==='failed'?a.detail:`${res.model}: read "${a.onScreen||a.shows||'nothing'}"`,detail:a.detail});}
      else data.steps.push({step:'gemini',ok:false,ms,detail:res.detail||res.error||res.message||res.reason});
    }
    const names={listen:'Listen (speech to text)',look:'Look (reading screenshots)',decide:'Decide (filling in details)',gemini:'Gemini (all three in one)'};
    out.replaceChildren(...data.steps.map(st=>{const li=document.createElement('li');li.className=st.ok?'ok':'not';
      const b=document.createElement('strong');b.textContent=`${st.ok?'✓':'✗'} ${names[st.step]||st.step}`;
      li.append(b,document.createTextNode(` ${st.ms?'· '+(st.ms/1000).toFixed(1)+'s ':''}· ${st.ok?st.said:st.detail}`));return li;}));
    btn.disabled=false;
  }
  // The recorded sound of one clip, as 16 kHz samples (null when nothing was recorded).
  function autoAudio(){
    const total=auto.chunks.reduce((n,c)=>n+c.length,0);if(!total){auto.chunks=[];return null;}
    const all=new Float32Array(total);let at=0;for(const c of auto.chunks){all.set(c,at);at+=c.length;}
    auto.chunks=[];
    return C.downsample(all,auto.ctx.sampleRate,16000);
  }
  // For Cloudflare: base64 WAV pieces of at most 55 seconds, quiet pieces left out.
  function audioPieces(pcm){
    const out=[];if(!pcm)return out;
    for(const [a,b] of C.pieces(pcm.length,16000,55)){
      const part=pcm.subarray(a,b);if(part.length<16000*0.8||C.loudness(part)<0.002)continue;
      out.push(wavBase64(part));
    }
    return out;
  }
  // For Gemini: the whole clip as one base64 WAV ('' when silent). Past 5 minutes it goes
  // to 8 kHz so a 10-minute clip still fits Google's 20 MB (it hears speech at 16 kbps anyway).
  function audioWhole(pcm){
    if(!pcm||pcm.length<16000*0.8||C.loudness(pcm)<0.002)return '';
    return pcm.length>16000*300?wavBase64At(C.downsample(pcm,16000,8000),8000):wavBase64(pcm);
  }
  async function autoPost(path,body){
    let res,data;
    try{res=await fetch('/api/'+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      data=await res.json().catch(()=>({}));}
    catch(_){return {status:'failed',reason:'NETWORK'};}
    if(res.status===401)return {stopRun:true,message:'Your sign-in expired. Sign in again, then start again.'};
    if(res.status===429)return {stopRun:true,message:data.reason==='AI_DAILY_LIMIT'||!data.error?allowanceMessage(auto&&auto.geminiOff==='day'):data.error};
    if(res.status===503)return {stopRun:true,message:'Auto-review is not set up on the server yet (it needs the AI binding; see the README).'};
    if(!data.status)return {status:'failed',reason:'SERVER_'+res.status};
    return data;
  }
  // Play one clip; resolve with what the Worker made of it (or why not).
  // Videos play to the end (at most MAX_VIDEO seconds); slideshows are walked slide by slide.
  const MAX_VIDEO=600,MAX_SLIDES=35;
  let sigCanvas=null;
  // A small grayscale picture of what the player shows right now, from the shared tab.
  function autoSig(frame){
    const v=auto&&auto.video;if(!v||!v.videoWidth)return null;
    const box=frame.getBoundingClientRect(),sx=v.videoWidth/window.innerWidth,sy=v.videoHeight/window.innerHeight;
    if(!sigCanvas){sigCanvas=document.createElement('canvas');sigCanvas.width=36;sigCanvas.height=64;}
    const g=sigCanvas.getContext('2d',{willReadFrequently:true});
    // A little in from the edges, so the frame around the player does not count.
    const ix=box.width*0.06,iy=box.height*0.06;
    g.drawImage(v,(box.left+ix)*sx,(box.top+iy)*sy,(box.width-2*ix)*sx,(box.height-2*iy)*sy,0,0,36,64);
    const d=g.getImageData(0,0,36,64).data,out=new Uint8Array(36*64);
    for(let i=0;i<out.length;i++)out[i]=(d[i*4]*3+d[i*4+1]*6+d[i*4+2])/10;
    return out;
  }
  // Wait until a slide has finished loading: at least a second, the picture
  // unchanged for 0.8 seconds, not one flat color (a blank, loading slide)
  // unless 5 seconds pass, and different from the slide before unless 4
  // seconds pass. At most 10 seconds of visible time; time while the tab is
  // hidden does not count.
  function autoSteady(frame,before,isDone){
    return new Promise(resolve=>{
      let last=null,calm=0,waited=0,tick=Date.now();
      const step=()=>{
        if(!auto||auto.stop||isDone())return resolve(null);
        const now=Date.now();if(!document.hidden)waited+=now-tick;tick=now;
        if(document.hidden)return setTimeout(step,250);
        const sig=autoSig(frame);
        if(sig){
          calm=last&&C.sigChange(sig,last)<0.004?calm+1:0;last=sig;
          const settled=calm>=4&&waited>=1000;
          // A plain slide (one flat color) is taken only after 5 seconds, in case it is still loading.
          const loaded=settled&&(!C.sigFlat(sig)||waited>=5000)&&(!before||C.sigChange(sig,before)>0.01||waited>=4000);
          if(loaded||waited>=10000)return resolve(sig);
        }else if(waited>=10000)return resolve(null);
        setTimeout(step,200);
      };
      setTimeout(step,200);
    });
  }
  // Play one clip; resolve with its sound (in auto.chunks) and screenshots, or why not.
  function autoPlay(r){
    return new Promise(resolve=>{
      const box=$('#autoFrame'),frame=document.createElement('iframe');
      frame.src=C.playerUrl(r,{auto:true,speed:auto.speed});frame.title='TikTok video player';
      frame.allow='autoplay; encrypted-media; fullscreen';frame.referrerPolicy='strict-origin-when-cross-origin';
      box.replaceChildren(frame);
      let lastError=null;
      let started=Date.now(),ready=0,lastTick=0,length=MAX_VIDEO,times=null,shots=[],timeEvents=false,unmutes=0,triedPlay=false,finished=false,now=0;
      let listening=false,paused=false,pausedAt=0;
      // The speed it really plays at: the player's clock against the wall clock (the speed extension may change it).
      let prevT=null,prevAt=0,vidSum=0,wallSum=0;
      const rate=()=>wallSum>=1.5?vidSum/wallSum:0;
      // A slideshow (photo post): walk every slide with the player's navigateTo,
      // wait until each one has finished loading, and screenshot it.
      let slides=false,want=-1,askedAt=0,probed=false,waitingSlide=false,lastSig=null;
      const send=(type,value=null)=>{try{frame.contentWindow.postMessage({type,value,'x-tiktok-player':true},'https://www.tiktok.com');}catch(_){}};
      const goTo=i=>{want=i;askedAt=Date.now();send('navigateTo',i);if(!paused)autoSay(`Reading slide ${i+1}…`);};
      const onSlide=i=>{
        if(!slides){slides=true;shots=[];send('pause');goTo(0);if(i===0)onSlide(0);return;}
        if(i!==want||waitingSlide)return;
        waitingSlide=true;
        if(!paused)autoSay(`Slide ${i+1}: waiting for it to load…`);
        autoSteady(frame,lastSig,()=>finished).then(sig=>{
          waitingSlide=false;if(finished)return;
          if(sig)lastSig=sig;shoot();
          if(want+1>=MAX_SLIDES)finish('SLIDES');else goTo(want+1);
        });
      };
      const shoot=()=>{const s=autoShot(frame);if(s)shots.push(s);};
      const record=on=>{auto.recording=on;try{auto.node.port.postMessage({record:on});}catch(_){}};
      // Hidden tab: the browser stops drawing it, so screenshots would be stale. Pause until it is back.
      const onVisible=()=>{
        if(finished)return;
        if(document.hidden&&!paused){
          paused=true;pausedAt=Date.now();auto.pausedSince=pausedAt;if(!slides)send('pause');record(false);
          autoSay('Paused: this tab is hidden. Come back to it to continue.');
        }else if(!document.hidden&&paused){
          paused=false;const gap=Date.now()-pausedAt;auto.pausedMs+=gap;auto.pausedSince=0;started+=gap;if(ready)ready+=gap;askedAt+=gap;lastTick=Date.now();prevT=null;
          if(!slides)send('play');if(listening)record(true);
          autoSay('Continuing…');
        }
      };
      const finish=reason=>{
        if(finished)return;finished=true;
        clearInterval(timer);window.removeEventListener('message',onMessage);document.removeEventListener('visibilitychange',onVisible);
        if(paused){auto.pausedMs+=Date.now()-pausedAt;auto.pausedSince=0;}
        record(false);send('pause');auto.finishClip=null;
        // Take the player away at once, so its end card does not stay up while the next clip loads.
        const note=document.createElement('p');note.className='player-none';note.textContent='Next clip…';
        frame.remove();box.replaceChildren(note);
        resolve({reason,shots,played:now,slides:slides?shots.length:0,error:lastError,rate:slides?0:rate()});
      };
      auto.finishClip=finish;
      const startListening=()=>{if(listening)return;listening=true;auto.chunks=[];if(!paused)record(true);};
      const onMessage=e=>{
        if(e.source!==frame.contentWindow||e.origin!=='https://www.tiktok.com')return;
        let d=e.data;if(typeof d==='string'){try{d=JSON.parse(d);}catch(_){return;}}
        if(!d||typeof d.type!=='string')return;
        const v=d.value&&typeof d.value==='object'?d.value:d;
        if(d.type==='onPlayerReady'){if(!ready){ready=Date.now();send('unMute');if(!paused)send('play');startListening();}}
        else if(d.type==='onImageChange'){const i=Number(d.value&&typeof d.value==='object'?d.value.index??d.value.value:d.value);if(isFinite(i))onSlide(i);}
        else if(d.type==='onMute'&&d.value===true&&unmutes<3){unmutes++;send('unMute');}
        else if(d.type==='onStateChange'&&Number(d.value)===1)startListening();
        else if(d.type==='onStateChange'&&Number(d.value)===0&&!slides)finish('ENDED');
        else if(d.type==='onCurrentTime'){
          const t=Number(v.currentTime),dur=Number(v.duration);if(!isFinite(t))return;
          const at=Date.now();
          if(!paused&&prevT!==null&&t>prevT&&t-prevT<3&&at-prevAt<3000){vidSum+=t-prevT;wallSum+=(at-prevAt)/1000;}
          prevT=t;prevAt=at;
          timeEvents=true;lastTick=at;now=t;startListening();
          if(slides)return;  // a slideshow's music: the slides decide when it is done
          if(!times&&dur>0){length=Math.min(dur,MAX_VIDEO);times=C.shotTimes(length);}
          // Not in the first 1.5 seconds: the shared tab can still show the clip before.
          while(times&&times.length&&t>=times[0]&&Date.now()-ready>=1500){times.shift();shoot();}
          if(!paused){const fast=C.speedLabel(rate());autoSay(`Watching and listening · ${Math.floor(t)}s of ${Math.ceil(length)}s${fast?' · '+fast:''} · 📸 ${plural(shots.length,'screenshot','screenshots')} · ${Date.now()-(auto.loudAt||0)<1500?'🔊 hearing sound':'🔇 quiet'}`);}
          if(t>=length-0.5)finish('ENDED');
        }
        else if(d.type==='onPlayerError'||d.type==='onError'){
          const code=Number(v.errorCode??d.value);
          if(code===3002&&!triedPlay){triedPlay=true;send('play');return;}
          lastError=code;finish(code===1001?'NOT_FOUND':code===3002?'AUTOPLAY':'PLAYBACK');
        }
      };
      window.addEventListener('message',onMessage);
      document.addEventListener('visibilitychange',onVisible);
      autoSay('Loading the clip…');
      onVisible();
      // Photo posts and quiet players may not report the time: fall back to the clock.
      const timer=setInterval(()=>{
        if(paused)return;
        const t=Date.now();
        if(!ready&&t-started>20000)return finish('NO_PLAYER');
        // Ask for slide 2 once: a slideshow answers with onImageChange; a video ignores it.
        if(ready&&!probed&&t-ready>1200){probed=true;send('navigateTo',1);}
        if(slides){
          // No answer for the next slide: that was the last one.
          if(!waitingSlide&&t-askedAt>4000){if(!shots.length)shoot();finish('SLIDES');}
          return;
        }
        if(ready&&!timeEvents){
          const s=(t-ready)/1000;
          if(s>=2&&shots.length<1)shoot();if(s>=6&&shots.length<2)shoot();if(s>=10&&shots.length<3)shoot();
          if(s>=12)finish('NO_TIME');
        }
        // The last second or two: when the clock stops, TikTok's end card is up. Move on.
        if(timeEvents&&length<MAX_VIDEO&&now>=length-2&&t-lastTick>1200)return finish('ENDED');
        if(timeEvents&&t-lastTick>15000)finish(shots.length?'STALLED_PART':'STALLED');
        if(t-started>(length+60)*1000)finish('TIMEOUT');
      },500);
    });
  }
  // Play one clip, then take its sound (in pieces) and its screenshot sheets
  // straight away, since the next clip reuses the recorder.
  // A player that errors, never loads or stops early is often a passing hiccup:
  // such a clip is played once more before it counts as "would not play".
  // A removed or private one (NOT_FOUND) is not tried again.
  const AUTO_RETRY=['NO_PLAYER','PLAYBACK','STALLED'];
  async function autoPlayClip(r){
    let played=await autoPlay(r),tries=1;
    if(AUTO_RETRY.includes(played.reason)&&!auto.stop){
      autoSay(`It would not play${played.error?' (player error '+played.error+')':''}. Trying once more…`);
      await new Promise(res=>setTimeout(res,1500));
      if(!auto.stop){auto.chunks=[];played=await autoPlay(r);tries=2;}
    }
    played.tries=tries;
    if(played.reason==='SHARING_STOPPED')return {done:{reason:'SHARING_STOPPED'}};
    if(auto.stop&&AUTO_RETRY.includes(played.reason))return {done:{reason:'STOPPED'}};
    if(played.reason==='STOPPED_BY_PERSON'||played.reason==='STOPPED_BY_RUN')return {done:{reason:'STOPPED'}};
    if(['NO_PLAYER','NOT_FOUND','PLAYBACK','AUTOPLAY','STALLED'].includes(played.reason))
      return {done:{status:'unavailable',reason:played.reason,detail:[played.error&&`player error ${played.error}`,tries>1&&'tried twice'].filter(Boolean).join(', ')}};
    return {played,pcm:autoAudio(),shots:auto.mode==='transcript'?[]:played.shots};
  }
  // The AI part of one clip. It runs while the next clip plays.
  async function autoAnalyze(r,got){
    if(auto.provider==='gemini'&&!auto.geminiOff){
      const res=await geminiAnalyze(r,got);
      if(!res.fallback)return res;
      // Gemini cannot take more today (or is not working): the rest of the run uses Cloudflare.
      if(!auto.geminiOff){auto.geminiOff=res.why;
        autoNote(res.why==='day'?`Gemini's free requests are used up for today (they come back ${clockAt(C.pacificMidnight())}); continuing with Cloudflare.`
          :`Gemini did not work (${res.detail||res.why}); continuing with Cloudflare.`);}
      if(!auto.cloudflare)return {stopRun:true,message:geminiStopMessage(res)};
    }
    return cloudflareAnalyze(r,got);
  }
  const clockAt=d=>`${d.toDateString()===new Date().toDateString()?'today':'tomorrow'} at ${d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;
  function geminiStopMessage(res){
    return res.why==='day'?`Gemini's free requests are used up for today. They come back ${clockAt(C.pacificMidnight())} (midnight Pacific); press Start again then, and it carries on with the clips not done yet.`
      :`Gemini did not work, and Cloudflare's AI is not set up: ${res.detail||res.why}.`;
  }
  // One clip through Gemini: one request with the clip's sound and its screenshot sheets.
  async function geminiAnalyze(r,{played,pcm,shots}){
    const audio=audioWhole(pcm);
    const picked=auto.mode==='transcript'?[]:C.pickShots(shots.map(autoShotSig),{slides:played.slides>0,words:0}).map(i=>shots[i]);
    const images=autoSheets(picked).map(u=>u.slice(u.indexOf(',')+1));
    if(!audio&&!images.length)return auto.mode==='transcript'?{status:'empty',reason:'NOTHING_SAID',via:'Gemini'}:{status:'empty',reason:'NOTHING_TO_READ',via:'Gemini'};
    const body=JSON.stringify(C.geminiRequest({mode:auto.mode,categories:categoryList().map(c=>({name:c.name,words:c.words||[]})),audio,images}));
    for(let tries=0;;tries++){
      const res=await geminiPost(body);
      if(res.stopRun)return res;
      if(res.status==='ok'){
        auto.geminiCalls++;auto.geminiTokens+=(res.usage?.prompt||0)+(res.usage?.output||0);
        const out=C.readGeminiAnswer(res.text,categoryList(),{mode:auto.mode,audio:!!audio,images:images.length});
        console.info('ClipAtlas auto-review',{clip:r.id,via:'gemini',model:res.model,ended:played.reason,tries:played.tries,slides:played.slides,screenshots:shots.length,
          read:picked.length,sheets:images.length,audioSeconds:audio?Math.round(pcm.length/16000):0,result:out.status,finish:res.finish});
        return {...out,via:'Gemini',read:picked.length,detail:out.detail||(res.finish&&res.finish!=='STOP'?'gemini: '+res.finish:'')};
      }
      // Too many at once: wait as long as Google says (at most a minute) and try again, a few times.
      if(res.reason==='GEMINI_BUSY'&&tries<4&&!auto.stop){await new Promise(ok=>setTimeout(ok,Math.min(60,Math.max(1,res.retryAfter||20))*1000));continue;}
      if(res.reason==='GEMINI_FAILED'&&tries<1&&!auto.stop){await new Promise(ok=>setTimeout(ok,5000));continue;}
      if(res.reason==='GEMINI_DAILY_LIMIT')return {fallback:true,why:'day'};
      if(['GEMINI_KEY','GEMINI_REGION','GEMINI_NO_MODEL','GEMINI_NOT_SET_UP'].includes(res.reason))return {fallback:true,why:'setup',detail:res.detail||res.error||res.reason};
      return {status:'failed',reason:'AI_FAILED',detail:res.detail||res.reason,via:'Gemini'};
    }
  }
  async function geminiPost(body,purpose='clip'){
    let res,data;
    try{res=await fetch('/api/gemini'+(purpose==='ask'?'?for=ask':''),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body});
      data=await res.json().catch(()=>({}));}
    catch(_){return {status:'failed',reason:'GEMINI_FAILED',detail:'connection problem',retryAfter:5};}
    if(res.status===401)return {stopRun:true,message:'Your sign-in expired. Sign in again, then start again.'};
    if(data.reason==='CLIPATLAS_LIMIT')return {stopRun:true,message:data.error};
    if(!data.status)return {status:'failed',reason:'GEMINI_FAILED',detail:'answered '+res.status};
    return data;
  }
  async function cloudflareAnalyze(r,{played,pcm,shots}){
    const parts=audioPieces(pcm);
    // How much of Cloudflare's daily AI allowance this clip used, as the Worker reports it.
    const use={neurons:0,partial:false};
    const count=d=>{if(typeof d.neurons==='number')use.neurons+=d.neurons;else use.partial=true;};
    // 1. What was said: each piece of sound through the speech-to-text model.
    const words=[];let listenFailed=false,listenDetail='';
    for(const part of parts){
      const heard=await autoPost('transcribe',{audio:part});
      if(heard.stopRun)return heard;
      if(heard.status!=='failed')count(heard);
      if(heard.status==='transcribed')words.push(heard.text);else if(heard.status==='failed'){listenFailed=true;listenDetail=heard.detail||heard.reason;}
    }
    const transcript=words.join(' ').trim().slice(0,4000);
    if(auto.mode==='transcript'){
      if(transcript)return {status:'transcribed',reason:'TRANSCRIBED',heard:true,transcript,use,via:'Cloudflare'};
      return listenFailed?{status:'failed',reason:'AI_FAILED',detail:listenDetail,use,via:'Cloudflare'}:{status:'empty',reason:'NOTHING_SAID',use,via:'Cloudflare'};
    }
    // 2. Which screenshots to read: every slide; for a video, no repeats, and fewer when plenty was said.
    const wordCount=transcript.split(/\s+/).filter(Boolean).length;
    const picked=C.pickShots(shots.map(autoShotSig),{slides:played.slides>0,words:wordCount}).map(i=>shots[i]);
    const images=autoSheets(picked);
    // 3. What it is about: the transcript and the screenshots.
    const trace={clip:r.id,ended:played.reason,tries:played.tries,slides:played.slides,screenshots:shots.length,read:picked.length,sheets:images.length,
      speed:played.rate?Math.round(played.rate*100)/100:0,soundParts:parts.length,heardWords:wordCount,listenDetail};
    if(!transcript&&!images.length){console.info('ClipAtlas auto-review',trace);
      return listenFailed?{status:'failed',reason:'AI_FAILED',detail:listenDetail,use,via:'Cloudflare'}:{status:'empty',reason:'NOTHING_TO_READ',use,via:'Cloudflare'};}
    const data=await autoPost('understand',{transcript,images,categories:categoryList().map(c=>({name:c.name,words:c.words||[]}))});
    if(!data.stopRun)count(data);
    console.info('ClipAtlas auto-review',{...trace,result:data.status,reason:data.reason,detail:data.detail,neurons:use.partial?'unknown':Math.round(use.neurons)});
    if(data.stopRun)return data;
    return {...data,transcript,read:picked.length,use,via:'Cloudflare',detail:[data.detail,listenFailed&&listenDetail].filter(Boolean).join('; ')};
  }
  function stopAuto(){if(auto){auto.stop=true;autoSay('Stopping…');auto.finishClip?.('STOPPED_BY_PERSON');}}
  function initAuto(){
    const dlg=$('#autoDialog');
    $('#startAuto').addEventListener('click',openAuto);
    $('#aiCheckBtn').addEventListener('click',checkSetup);
    $('#autoStart').addEventListener('click',startAuto);
    $('#autoStop').addEventListener('click',stopAuto);
    $('#autoScope').addEventListener('change',autoEstimate);
    try{const kept=localStorage.getItem('ClipAtlasAutoSpeed');if(kept&&[...$('#autoSpeed').options].some(o=>o.value===kept))$('#autoSpeed').value=kept;}catch(_){/* default speed */}
    $('#autoSpeed').addEventListener('change',autoEstimate);
    $('#autoMode').addEventListener('change',()=>{const keep=$('#autoScope').value;openAuto();$('#autoScope').value=keep;autoEstimate();});
    $('#autoRedo').addEventListener('change',()=>{const keep=$('#autoScope').value;openAuto();$('#autoScope').value=keep;autoEstimate();});
    const close=()=>{if(auto&&!confirm('Stop auto-review and close?'))return;stopAuto();if(!auto)dlg.close();else{const wait=setInterval(()=>{if(!auto){clearInterval(wait);dlg.close();}},200);}};
    $('#autoClose').addEventListener('click',close);
    dlg.addEventListener('cancel',e=>{e.preventDefault();close();});
  }
  /* ---- Settings: categories with sort words, optional tabs, starter sets ---- */
  function renderSettings(){
    const counts={};for(const r of state.records)counts[r.category]=(counts[r.category]||0)+1;
    const list=categoryList();
    $('#tabItinerary').checked=tabOn('itinerary');
    const kept=state.plan.length;
    $('#tabItineraryNote').textContent=!tabOn('itinerary')&&kept?`Your ${kept} planned stop${kept===1?' is':'s are'} kept and come back when you turn it on.`:'';
    $('#categoryRows').innerHTML=list.length?list.map((c,i)=>`<div class="cat-row" data-cat="${html(c.id)}">
      <input class="cat-emoji" data-field="emoji" value="${html(c.emoji)}" aria-label="Emoji for ${html(c.name)}" maxlength="8">
      <input class="cat-name" data-field="name" value="${html(c.name)}" aria-label="Category name" maxlength="40">
      <input class="cat-words" data-field="words" value="${html(c.words.join(', '))}" aria-label="Sort words for ${html(c.name)}" placeholder="sort words, separated by commas">
      <button type="button" class="cat-count link-count" data-cat-select="${html(c.name)}" ${counts[c.name]?'':'disabled'} title="Select these clips in Discoveries (to delete or move them)">${counts[c.name]||0} clip${counts[c.name]===1?'':'s'}</button>
      <span class="cat-actions"><button type="button" data-cat-move="-1" ${i===0?'disabled':''} aria-label="Move up">↑</button><button type="button" data-cat-move="1" ${i===list.length-1?'disabled':''} aria-label="Move down">↓</button>
      <select data-cat-merge aria-label="Merge ${html(c.name)} into another category"><option value="">Merge into…</option>${list.filter(o=>o.id!==c.id).map(o=>`<option value="${html(o.name)}">${html(o.name)}</option>`).join('')}</select>
      <button type="button" class="danger" data-cat-delete aria-label="Delete ${html(c.name)}">Delete</button></span></div>`).join(''):'<p class="hint">No categories yet. Add one below, or add a starter set.</p>';
    $('#unsortedCount').textContent=`${counts.Unsorted||0} clip${counts.Unsorted===1?' is':'s are'} Unsorted.`;
    $('#starterPick').innerHTML=Object.entries(C.STARTERS).filter(([k])=>k!=='empty').map(([k,v])=>`<option value="${html(k)}">${html(v.label)}</option>`).join('');
  }
  function categoryById(id){return categoryList().find(c=>c.id===id);}
  function settingsChange(evt){
    const t=evt.target;
    if(t.id==='tabItinerary'){state.settings={...(state.settings||{}),tabs:{...(state.settings?.tabs||{}),itinerary:t.checked}};commit();return;}
    const row=t.closest('[data-cat]');if(!row)return;
    const c=categoryById(row.dataset.cat);if(!c)return;
    if(t.dataset.catMerge!==undefined&&t.value){
      const target=t.value;
      if(!confirm(`Move every "${c.name}" clip to "${target}" and remove "${c.name}"?`)){t.value='';return;}
      state=C.deleteCategory(state,c.name,target);commit();toast(`Merged into ${target}.`);return;
    }
    if(t.dataset.field==='name'){
      const res=C.renameCategory(state,c.name,t.value);
      if(res.error){toast(res.error);t.value=c.name;return;}
      state=res.state;commit();return;
    }
    if(t.dataset.field==='emoji'){state.categories=categoryList().map(x=>x.id===c.id?{...x,emoji:t.value.trim().slice(0,8)||'🔖'}:x);commit();return;}
    if(t.dataset.field==='words'){state.categories=C.normalizeCategories(categoryList().map(x=>x.id===c.id?{...x,words:t.value}:x));commit();}
  }
  function settingsClick(evt){
    const pickCat=evt.target.closest('[data-cat-select]');if(pickCat){selectCategory(pickCat.dataset.catSelect);return;}
    const t=evt.target.closest('button');if(!t)return;
    const row=t.closest('[data-cat]');
    if(row&&t.dataset.catMove){
      const list=[...categoryList()],i=list.findIndex(c=>c.id===row.dataset.cat),j=i+Number(t.dataset.catMove);
      if(i<0||j<0||j>=list.length)return;[list[i],list[j]]=[list[j],list[i]];state.categories=list;commit();return;
    }
    if(row&&t.dataset.catDelete!==undefined){
      const c=categoryById(row.dataset.cat);if(!c)return;
      const n=state.records.filter(r=>r.category===c.name).length;
      if(!confirm(`Delete "${c.name}"?${n?` Its ${n} clip${n===1?'':'s'} will move to Unsorted.`:''}`))return;
      state=C.deleteCategory(state,c.name);commit();return;
    }
    if(t.id==='addCategory'){
      const name=C.categoryName($('#newCatName').value);
      if(!name){toast('Give the new category a name (not "Unsorted").');return;}
      if(categoryList().some(c=>c.name.toLowerCase()===name.toLowerCase())){toast(`You already have "${name}".`);return;}
      state.categories=C.normalizeCategories([...categoryList(),{name,emoji:$('#newCatEmoji').value,words:$('#newCatWords').value}]);
      for(const id of ['newCatName','newCatEmoji','newCatWords'])$('#'+id).value='';
      commit();toast(`Added "${name}".`);return;
    }
    if(t.id==='sortNow'){
      const n=C.sortUnsorted(state.records,categoryList());commit();
      toast(n?`Sorted ${n} clip${n===1?'':'s'} by their sort words.`:'No Unsorted clip matched any sort words.');return;
    }
    if(t.id==='addStarter'){
      const key=$('#starterPick').value;const before=categoryList().length;
      state=C.applyStarter(state,key,{keepTabs:true});commit();
      toast(`Added ${categoryList().length-before} categor${categoryList().length-before===1?'y':'ies'} from ${C.STARTERS[key].label}.`);
    }
  }
  function openStarterDialog(){
    const dlg=$('#starterDialog');
    $('#starterChoices').innerHTML=Object.entries(C.STARTERS).map(([k,v])=>`<button type="button" class="starter-choice" data-starter="${html(k)}"><strong>${html(v.label)}</strong><span>${html(v.blurb)}</span><small>${v.categories.length?html(v.categories.map(c=>c[1]+' '+c[0]).join(' · ')):'Make your own categories in Settings'}${v.tabs.itinerary?' · plus the Itinerary tab':''}</small></button>`).join('');
    dlg.addEventListener('cancel',e=>e.preventDefault());
    dlg.onclick=e=>{const b=e.target.closest('[data-starter]');if(!b)return;state=C.applyStarter(state,b.dataset.starter);dlg.close();commit();toast('All set. You can change categories and tabs any time in Settings.');};
    dlg.showModal();
  }
  function viewEnriched(){
    activeCollection='';$('#search').value='';$('#categoryFilter').value='all';$('#statusFilter').value='all';
    $('#analysisFilter').value='enriched';selectTab('library');
  }
  function init() {
    // Category lists are filled from the account's own categories in render().
    document.addEventListener('click',evt=>{
      const tab=evt.target.closest('[data-tab]');if(tab){selectTab(tab.dataset.tab);return;}
      const lib=evt.target.closest('[data-lib-view]');
      if(lib){libraryView=lib.dataset.libView;try{localStorage.setItem('ClipAtlasLibraryView',libraryView);}catch(_){/* remembered for this visit only */}renderLibrary();return;}
      const coll=evt.target.closest('[data-collection]');if(coll){activeCollection=coll.dataset.collection;selectTab('library');return;}
      const action=evt.target.closest('[data-action]');if(!action)return;
      const {action:kind,id}=action.dataset;
      if(kind==='watch'){const byId=new Map(state.records.map(r=>[r.id,r]));rv.shown=shownIds.filter(x=>C.isClip(byId.get(x)));openReview('shown',id);}
      else if(kind==='edit')openEditor(id);
      else if(kind==='read-item')readItem(id);
      else if(kind==='plan-ai-example'){const box=$('#planAIInput'),v=box.value.trim();box.value=v?v.replace(/[.;,]?$/,'; ')+action.dataset.q.toLowerCase():action.dataset.q;box.focus();}
      else if(kind==='plan-ai-use')usePlanProposal();
      else if(kind==='plan-ai-discard'){planProposal=null;renderPlanAI();}
      else if(kind==='report-download'&&lastReport){const name=activeCollection||'Saved places';
        download(`${name.replace(/[^\w\- ]+/g,'').trim().replace(/\s+/g,'-').toLowerCase()||'places'}-places-by-city.md`,C.reportMarkdown(lastReport,`${name}: places by city`),'text/markdown');}
      else if(kind==='report-jump'){const sec=[...$$('#placesReport .report-city')].find(x=>x.dataset.reportCity===action.dataset.city);if(sec)sec.scrollIntoView({behavior:'smooth',block:'start'});}
      else if(kind==='ask-example'){$('#askInput').value=action.dataset.q;$('#askForm').requestSubmit();}
      else if(kind==='edit-item')openEditor(id,'tiktok',action.dataset.place||'');
      else if(kind==='use-category'){const r=state.records.find(x=>x.id===id),cat=action.dataset.category;
        if(r&&categoryList().some(c=>c.name===cat)){state.records[state.records.indexOf(r)]={...r,category:cat,autoSorted:undefined,updatedAt:new Date().toISOString()};commit();
          const p=action.closest('.found-suggest');if(p)p.textContent=`Moved to ${emojiFor(cat)} ${cat}.`;}}
      else if(kind==='plan')addToPlan(id);
      else if(kind==='delete'){
        const r=state.records.find(x=>x.id===id);
        if(!r||!confirm('Delete this discovery? It will also leave the itinerary.'))return;
        state.records=state.records.filter(x=>x.id!==id);state.plan=state.plan.filter(x=>x.recordId!==id);commit();toast('Discovery deleted');
      } else if(kind==='remove-plan'){state.plan=state.plan.filter(p=>p.id!==id);commit();}
      else if(kind==='day-city-remove'){const day=Number(action.dataset.day),next={...(state.dayCities||{})};
        next[day]=dayCitiesOf(day).filter(c=>c!==action.dataset.city);state.dayCities=C.cleanDayCities(next,state.dayCount);commit();}
      else if(kind==='show-city')showCity(action.dataset.city);
      else if(kind==='jump-city'){const panel=[...$$('#itineraryCities .city-panel')].find(p=>p.dataset.cityKey===action.dataset.city.toLowerCase());if(panel){panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'start'});}}
      else if(kind==='itinerary-view'){itineraryView=action.dataset.itineraryView;renderItinerary();}
      else if(kind==='ask-again'){const q=(state.questions||[]).find(x=>x.id===id);if(q)askNow(q.q,q.id);}
      else if(kind==='ask-delete'){state.questions=(state.questions||[]).filter(x=>x.id!==id);commit();}
      else if(kind==='split-stop'){const r=state.records.find(x=>x.id===id);if(r){state.plan=C.splitClipStop(state.plan,r,stopId);commit();}}
      else if(kind==='trip-move'&&trip){const i=trip.cities.findIndex(t=>t.name===action.dataset.city),j=i+Number(action.dataset.step);
        if(i>=0&&j>=0&&j<trip.cities.length){[trip.cities[i],trip.cities[j]]=[trip.cities[j],trip.cities[i]];trip.edited=true;renderOverview();}}
      else if(kind==='trip-suggest'&&trip){const {o}=tripState();trip.cities=C.suggestDays(o.cities,state.dayCount);trip.from='suggested';trip.edited=false;trip.forDays=state.dayCount;renderOverview();}
      else if(kind==='trip-fill'&&trip)fillDays();
      else if(kind==='up')movePlan(id,-1);else if(kind==='down')movePlan(id,1);
    });
    for(const id of ['addButton','emptyAdd'])$("#"+id).addEventListener('click',()=>openEditor());
    initReview();
    initAuto();
    initBulk();
    $('#analyzeLinks').addEventListener('click',analyzeLinks);
    $('#viewEnriched').addEventListener('click',viewEnriched);
    $('#settingsPage').addEventListener('change',settingsChange);
    $('#settingsPage').addEventListener('click',settingsClick);
    $('#cancelAnalyze').addEventListener('click',()=>{stopAnalysis=true;});
    $('#newCollection').addEventListener('click',addCollection);
    $('#editForm').addEventListener('submit',editorSave);
    $('#kindPick').addEventListener('click',e=>{const b=e.target.closest('[data-kind]');if(b){setKind(b.dataset.kind,true);$('#modalError').textContent='';}});
    $('#readPageBtn').addEventListener('click',readPageIntoEditor);
    // A pasted link shows the right fields: a TikTok as a TikTok, any other page as a web link.
    $('#editForm').elements.namedItem('url').addEventListener('change',e=>{if(editingId||editingKind==='note')return;
      const v=e.target.value;if(editingKind==='link'&&C.parseTikTokURL(v))setKind('tiktok',true);else if(editingKind==='tiktok'&&!C.parseTikTokURL(v)&&C.webLink(v))setKind('link',true);});
    $('#closeDialog').addEventListener('click',()=>$('#editDialog').close());
    $('#cancelEdit').addEventListener('click',()=>$('#editDialog').close());
    $('#planAIForm').addEventListener('submit',e=>{e.preventDefault();planWithAI($('#planAIInput').value);});
    $('#planAIInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#planAIForm').requestSubmit();}});
    $('#askForm').addEventListener('submit',async e=>{e.preventDefault();if(await askNow($('#askInput').value))$('#askInput').value='';});
    $('#askInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#askForm').requestSubmit();}});
    $('#addPlace').addEventListener('click',()=>{const row=placeRow({city:$('#editForm').elements.namedItem('city').value});$('#editPlaces').append(row);row.querySelector('.pl-name').focus();});
    $('#editPlaces').addEventListener('click',e=>{const b=e.target.closest('.pl-remove');if(b)b.closest('.place-row').remove();});
    $('#search').addEventListener('input',renderLibrary);
    for(const id of ['categoryFilter','statusFilter','analysisFilter','sortFilter'])$('#'+id).addEventListener('change',renderLibrary);
    for(const [value,label] of Object.entries(C.ANALYSIS_LABELS))$('#analysisFilter').insertAdjacentHTML('beforeend',`<option value="${html(value)}">${html(label)}</option>`);
    $('#tripTitle').addEventListener('change',evt=>{state.tripTitle=evt.target.value.trim().slice(0,140);commit();});
    $('#dayCount').addEventListener('change',evt=>{
      const next=C.cleanDayCount(evt.target.value);
      if(!evt.target.value.trim()||next===state.dayCount){evt.target.value=String(state.dayCount);return;}
      const later=state.plan.some(x=>x.day>next),cities=Object.keys(state.dayCities||{}).some(d=>Number(d)>next);
      if((later||cities)&&!confirm(`Going down to ${next} day${next===1?'':'s'}: ${later?'stops on later days move to day '+next:''}${later&&cities?', and ':''}${cities?'the cities set for later days are cleared':''}. Continue?`)){evt.target.value=String(state.dayCount);return;}
      state.plan.forEach(x=>x.day=Math.min(x.day,next));state.dayCount=next;state.dayCities=C.cleanDayCities(state.dayCities,next);commit();
    });
    // A city for a day: picked from the list, or typed and Enter.
    $('#itineraryDays').addEventListener('input',evt=>{
      const t=evt.target;if(!t.dataset.dayCity||(evt.inputType&&evt.inputType!=='insertReplacementText'))return;
      if([...$('#cityOptions').options].some(o=>o.value===t.value))addDayCity(Number(t.dataset.dayCity),t.value);
    });
    $('#itineraryDays').addEventListener('keydown',evt=>{
      const t=evt.target;if(!t.dataset.dayCity||evt.key!=='Enter')return;
      evt.preventDefault();if(!addDayCity(Number(t.dataset.dayCity),t.value))t.value='';
    });
    $('#itineraryOverview').addEventListener('change',evt=>{
      const t=evt.target;if(!trip)return;
      if(t.id==='tripCountry'){trip={country:t.value,include:null,cities:null,edited:false};}
      else if(t.dataset.tripInclude!==undefined){
        const all=C.tripOverview(state.records,trip.country).types.map(t=>t.type);
        const on=new Set(trip.include||all);t.checked?on.add(t.dataset.tripInclude):on.delete(t.dataset.tripInclude);
        trip.include=all.every(c=>on.has(c))?null:[...on];
      }
      else if(t.dataset.tripDays!==undefined){const hit=trip.cities.find(x=>x.name===t.dataset.tripDays);
        if(hit){hit.days=Math.max(0,Math.min(C.MAX_DAYS,Math.round(Number(t.value))||0));trip.edited=true;}}
      else return;
      renderOverview();
    });
    $('#itineraryCities').addEventListener('change',evt=>{
      if(evt.target.dataset.cityPlan)planOnDay(evt.target.dataset.cityPlan,Number(evt.target.value));
      else if(evt.target.dataset.cityFill)setItemCity(evt.target.dataset.cityFill,evt.target.value);
    });
    $('#itineraryDays').addEventListener('change',evt=>{
      if(evt.target.dataset.planDay){const p=state.plan.find(p=>p.id===evt.target.dataset.planDay);if(p){p.day=Number(evt.target.value);commit();}}
      else if(evt.target.dataset.planNote){const p=state.plan.find(p=>p.id===evt.target.dataset.planNote);if(p){p.note=evt.target.value.slice(0,500);commit();}}
    });
    $('#itineraryDays').addEventListener('focusout',evt=>{
      if(evt.target.dataset.planNote){const p=state.plan.find(p=>p.id===evt.target.dataset.planNote);if(p){p.note=evt.target.value.slice(0,500);commit();}}
    });
    const exportBackup=()=>download('clipatlas-backup-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify({kind:'clipatlas-backup',version:1,exportedAt:new Date().toISOString(),state},null,2),'application/json');
    $('#exportBackup').addEventListener('click',exportBackup);$('#exportSide').addEventListener('click',exportBackup);
    const exportCSV=()=>download('clipatlas-library.csv',C.recordsToCSV(state.records),'text/csv;charset=utf-8');
    $('#exportCsv').addEventListener('click',exportCSV);$('#exportCsvImport').addEventListener('click',exportCSV);
    $('#downloadTemplate').addEventListener('click',()=>download('clipatlas-import-template.csv',C.csvTemplate(),'text/csv;charset=utf-8'));
    $('#exportPlan').addEventListener('click',()=>download('clipatlas-itinerary.md',C.planMarkdown(state.plan,state.records,state.tripTitle,state.dayCities),'text/markdown;charset=utf-8'));
    $('#fileImport').addEventListener('change',e=>importFile(e.target.files?.[0]));
    const drop=$('#dropZone');
    for(const name of ['dragover','dragenter'])drop.addEventListener(name,e=>{e.preventDefault();drop.classList.add('dragging');});
    for(const name of ['dragleave','drop'])drop.addEventListener(name,e=>{e.preventDefault();drop.classList.remove('dragging');});
    drop.addEventListener('drop',e=>importFile(e.dataTransfer.files?.[0]));
    $('#bulkImport').addEventListener('click',()=>{
      const pasted=$('#bulkLinks').value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
      if(!pasted.length){toast('Paste at least one TikTok URL.');return;}
      const result=merge(pasted.map(url=>({url})),$('#bulkCollection').value.trim());
      $('#bulkLinks').value='';toast(`Added ${result.added} new link(s); ${result.duplicates} duplicates; ${result.invalid} invalid.`);
    });
    render();
  }
  function applyState(saved) {
    state = saved && Array.isArray(saved.records) ? {...emptyState(),...saved} : emptyState();
    if(!Array.isArray(state.plan))state.plan=[];
    if(!Array.isArray(state.collections))state.collections=[];
    state.dayCount=C.cleanDayCount(state.dayCount);state.dayCities=C.cleanDayCities(state.dayCities,state.dayCount);state.questions=C.cleanQuestions(state.questions);
    const setup=C.ensureSetup(state);state=setup.state;return setup;
  }
  function authUI() {
    const form=$('#authForm'), toggle=$('#authToggle'), head=$('#authHeading');
    let creating=false;
    function mode() {
      head.textContent=creating?'Create your account':'Welcome back';
      $('#displayWrap').hidden=!creating;
      $('#authDisplay').required=creating;
      $('#authSubmit').textContent=creating?'Create account':'Sign in';
      toggle.textContent=creating?'Already have an account? Sign in':'Create a free account';
      $('#authError').textContent='';
      $('#authPassword').autocomplete=creating?'new-password':'current-password';
    }
    toggle.onclick=()=>{creating=!creating;mode();};mode();
    form.onsubmit=async e=>{
      e.preventDefault();$('#authError').textContent='';$('#authSubmit').disabled=true;
      try {
        const email=$('#authEmail').value.trim(),pass=$('#authPassword').value;
        if(creating)await Cloud.register(email,pass,$('#authDisplay').value.trim());
        else await Cloud.login(email,pass);
        await enter();
      }catch(err){$('#authError').textContent=err.message;}
      finally{$('#authSubmit').disabled=false;}
    };
  }
  async function enter() {
    const saved=await Cloud.load();const setup=applyState(saved);
    // A plan made before the clips' places were listed: each clip's stop becomes its places' stops.
    const wholeStops=state.plan.filter(p=>!p.placeId).length;tidyPlan();
    const split=wholeStops-state.plan.filter(p=>!p.placeId).length;
    $('#authGate').hidden=true;$('#appShell').hidden=false;
    $('#saveStatus').textContent='Saved to your account';
    init();
    if(setup.needsChoice)openStarterDialog();
    else if(setup.migrated||split)commit();
    if(split)toast(`Your itinerary now has a stop for each place (${state.plan.length} stops). Itinerary → Overview → Fill the days spreads them over your days.`);
  }
  document.addEventListener('DOMContentLoaded',async()=>{
    authUI();
    $('#signOut').addEventListener('click',async()=>{
      if(saveBusy || saveTimer || dirty){toast('Make sure your changes have finished saving before signing out.');return;}
      try {await Cloud.logout();location.reload();}catch(e){toast(e.message);}
    });
    $('#importLocal').addEventListener('click',async()=>{
      if(state.records.length && !confirm('Merge the old local library into this account?'))return;
      const legacy=await load();
      if(!legacy || !Array.isArray(legacy.records)){toast('No old local library on this browser.');return;}
      const known=new Set(state.records.map(r=>r.key||r.url));
      let added=0;
      for(const record of legacy.records){if(!known.has(record.key||record.url)){state.records.push(record);known.add(record.key||record.url);added++;}}
      for(const c of legacy.collections||[])if(!state.collections.includes(c))state.collections.push(c);
      if(!state.plan.length)state.plan=legacy.plan||[];
      if(Array.isArray(state.categories))state=C.addMissingCategories(state);
      commit();toast('Imported '+added+' discoveries from this browser.');
    });
    try {if(await Cloud.me())await enter();}
    catch(err){$('#authError').textContent='Connection error: '+err.message;}
  });
})();
