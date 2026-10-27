/* ClipAtlas UI. Account data is saved to its own Cloudflare D1 library. */
(() => {
  'use strict';
  const C = window.ClipAtlasCore;
  const Cloud = window.ClipAtlasCloud;
  if (!C) throw new Error('Missing core.js');
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const html = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const emptyState = () => ({ version: 1, records: [], collections: [], plan: [], tripTitle: 'My saved TikTok itinerary', dayCount: 7 });
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
    $('#statReview').textContent=state.records.filter(x=>x.status!=='reviewed').length;
    $('#statPlan').textContent=state.plan.length;
  }
  function renderLibrary() {
    renderStats(); renderCollections();
    const q=$('#search').value.toLocaleLowerCase().trim();
    const category=$('#categoryFilter').value, status=$('#statusFilter').value, analysis=$('#analysisFilter').value;
    let records=state.records.filter(r=>(!activeCollection || (r.collections||[]).includes(activeCollection))
      && (category==='all'||r.category===category)
      && (status==='all'||(status==='auto'?r.autoReviewed===true:r.status===status))
      && (analysis==='all'||C.analysisState(r)===analysis)
      && (!q || [r.title,r.url,r.creator,r.caption,r.notes,r.category,r.place,r.city,r.country,(r.collections||[]).join(' '),(r.tags||[]).join(' '),r.auto?.transcript,r.auto?.onScreen,r.auto?.summary].join(' ').toLocaleLowerCase().includes(q)));
    const sort=$('#sortFilter').value;
    records.sort((a,b) => sort==='title'?(a.title||a.place||'').localeCompare(b.title||b.place||''):
      sort==='oldest'?(a.savedAt||a.createdAt).localeCompare(b.savedAt||b.createdAt):(b.savedAt||b.createdAt).localeCompare(a.savedAt||a.createdAt));
    shownIds=records.map(r=>r.id);
    renderBulkBar();
    $('#filteredCount').textContent=records.length+' '+(records.length===1?'clip':'clips');
    $('#libraryEmpty').hidden=records.length!==0;
    $('#clipGrid').innerHTML=records.map(r=>{
      const title=r.title||r.place||'Untitled saved TikTok';
      const loc=[r.place,r.city,r.country].filter(Boolean).join(' · ');
      const chips=[...(r.collections||[]).slice(0,2),...(r.tags||[]).slice(0,1)];
      const inPlan=state.plan.some(p=>p.recordId===r.id);
      return `<article class="clip-card${selecting?' selecting':''}${selected.has(r.id)?' picked':''}" data-card="${html(r.id)}">${selecting?`<label class="pick"><input type="checkbox" data-pick="${html(r.id)}" ${selected.has(r.id)?'checked':''} aria-label="Select ${html(title)}"></label>`:''}<div class="clip-card-head"><span class="clip-emoji">${html(emojiFor(r.category))}</span><span class="card-flags"><span class="status ${r.status==='reviewed'?'reviewed':''}">${r.status==='reviewed'?'✓ Reviewed':'Needs review'}</span>${r.auto?`<span class="analysis-badge auto-${html(r.auto.status)}" title="${html(r.auto.summary||r.auto.reason||'')}">✦ ${html(r.autoReviewed?'Auto-reviewed':C.AUTO_LABELS[r.auto.status]||'')}</span>`:C.analysisState(r)==='not_analyzed'?'':`<span class="analysis-badge ${html(C.analysisState(r))}" title="${html(r.enrichment?.reason||'')}">${html(C.ANALYSIS_LABELS[C.analysisState(r)])}</span>`}</span></div><div class="clip-body"><div class="category">${html(r.category)}</div>${r.autoSorted&&r.autoSorted.name===r.category&&r.autoSorted.words?.length?`<p class="sorted-why" title="Sorted automatically by these sort words">Sorted by: ${html(r.autoSorted.words.join(', '))}</p>`:''}<h3>${html(title)}</h3><p class="location">${html(loc||'Location not yet identified')}${r.savedAt?' · Saved '+html(r.savedAt):''}</p>${r.notes||r.caption?`<p class="clip-notes">${html(r.notes||r.caption)}</p>`:''}<div class="chips">${chips.map(t=>`<span class="chip">${html(t)}</span>`).join('')}</div></div><div class="clip-actions"><button data-action="watch" data-id="${html(r.id)}" title="Watch it here and fill in its details">▶ Watch</button><a href="${html(r.url)}" target="_blank" rel="noopener noreferrer" title="Open on TikTok">↗ TikTok</a><button data-action="edit" data-id="${html(r.id)}">Edit</button>${tabOn('itinerary')?`<button data-action="plan" data-id="${html(r.id)}">${inPlan?'✓ Planned':'+ Plan'}</button>`:''}<button class="danger" data-action="delete" data-id="${html(r.id)}" aria-label="Delete clip">✕</button></div></article>`;
    }).join('');
  }
  function renderItinerary() {
    $('#tripTitle').value=state.tripTitle||''; $('#dayCount').value=String(state.dayCount||7);
    const days=$('#itineraryDays'); const byId=new Map(state.records.map(r=>[r.id,r]));
    let s='';
    for(let day=1;day<=state.dayCount;day++){
      const items=state.plan.filter(p=>p.day===day&&byId.has(p.recordId));
      s+=`<section class="day-panel"><div class="day-head"><span class="day-num">${String(day).padStart(2,'0')}</span><h3>Day ${day}</h3><small>${items.length} ${items.length===1?'stop':'stops'}</small></div>`;
      if(!items.length)s+='<div class="day-empty">Add stops from Discoveries using the “+ Plan” button.</div>';
      for(let j=0;j<items.length;j++){
        const entry=items[j],r=byId.get(entry.recordId);
        const choices=Array.from({length:state.dayCount},(_,i)=>`<option value="${i+1}" ${day===i+1?'selected':''}>Day ${i+1}</option>`).join('');
        s+=`<div class="stop"><span class="stop-n">${j+1}</span><div><h4>${html(r.title||r.place||'Saved TikTok')}</h4><p>${html([r.place,r.city,r.country].filter(Boolean).join(' · ')||r.category)}</p><a href="${html(r.url)}" target="_blank" rel="noopener noreferrer">View original TikTok ↗</a><input value="${html(entry.note||'')}" placeholder="Plan note (time, order, reservation…)" data-plan-note="${html(entry.id)}" aria-label="Plan note" /></div><div class="stop-actions"><select data-plan-day="${html(entry.id)}" aria-label="Move stop to day">${choices}</select><button data-action="up" data-id="${html(entry.id)}" ${j===0?'disabled':''} title="Move earlier">↑</button><button data-action="down" data-id="${html(entry.id)}" ${j===items.length-1?'disabled':''} title="Move later">↓</button><button data-action="remove-plan" data-id="${html(entry.id)}" title="Remove from itinerary">✕</button></div></div>`;
      }
      s+='</section>';
    }
    days.innerHTML=s;
  }
  function render() {
    fillCategorySelect($('#categoryFilter'), true); fillCategorySelect($('#formCategory'), false); applyTabs();
    renderStats(); renderCollections(); renderAnalysisSummary(); renderReviewCount();
    if(currentTab==='library')renderLibrary(); else if(currentTab==='itinerary')renderItinerary(); else if(currentTab==='settings')renderSettings();
  }
  function openEditor(id=null) {
    editingId=id; const r=state.records.find(x=>x.id===id);
    $('#modalTitle').textContent=r?'Edit discovery':'New discovery'; $('#modalError').textContent='';
    const form=$('#editForm'); form.reset();
    if(r) for(const key of ['url','title','creator','caption','notes','category','place','city','country','status']) {
      const el=form.elements.namedItem(key); if(el) el.value=r[key]||'';
    }
    if(r){form.elements.namedItem('collections').value=(r.collections||[]).join(', ');form.elements.namedItem('tags').value=(r.tags||[]).join(', ');}
    $('#editDialog').showModal();
  }
  function editorSave(evt) {
    evt.preventDefault();
    const form=evt.target;
    const source=Object.fromEntries(new FormData(form).entries());
    const parsed=C.parseTikTokURL(source.url);
    if(!parsed){$('#modalError').textContent='Enter a valid TikTok URL (including a share link).';return;}
    const duplicate=state.records.find(r=>r.key===parsed.key&&r.id!==editingId);
    if(duplicate){$('#modalError').textContent='This video is already saved. Edit its existing card instead.';return;}
    const old=state.records.find(r=>r.id===editingId);
    const created=C.createRecord({...source,id:old?.id,savedAt:old?.savedAt,createdAt:old?.createdAt});
    if(!created){$('#modalError').textContent='Invalid TikTok URL.';return;}
    if(old&&old.key===created.key){created.enrichment=old.enrichment;created.enrichedAt=old.enrichedAt;created.enrichmentStatus=old.enrichmentStatus;}
    if(old)created.auto=old.auto;  // what auto-review heard and saw; the person has checked it now
    if(old&&old.category===created.category)created.autoSorted=old.autoSorted;
    if(old)state.records[state.records.indexOf(old)]={...created,id:old.id};else state.records.push(created);
    $('#editDialog').close();commit();toast(old?'Discovery updated':'New discovery saved');
  }
  function addToPlan(id){
    const r=state.records.find(r=>r.id===id); if(!r)return;
    if(state.plan.some(p=>p.recordId===id)){toast('This discovery is already in your itinerary.');return;}
    const day=1;
    state.plan.push({id:'stop-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),recordId:id,day,note:''});
    commit();toast('Added to Day 1. Open Itinerary to organize it.');
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
          clean.plan=inputPlan.filter(p=>ids.has(p.recordId)&&Number(p.day)>=1&&Number(p.day)<=14);
          clean.collections=Array.isArray(data.state.collections)?data.state.collections.filter(x=>typeof x==='string'):[];
          clean.tripTitle=String(data.state.tripTitle||clean.tripTitle);
          clean.dayCount=Math.max(3,Math.min(14,Number(data.state.dayCount)||7));
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
    for(const id of ['bulkMove','bulkReviewed','bulkDelete'])$('#'+id).disabled=!n;
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
    const minutes=Math.ceil(queue.length*(Math.min(Number($('#autoCap').value),60)+8)/60);
    const short=state.records.filter(r=>!C.playerUrl(r)).length;
    $('#autoEstimate').textContent=(queue.length?`${queue.length} clip${queue.length===1?'':'s'} · up to about ${minutes<90?minutes+' minutes':Math.round(minutes/6)/10+' hours'}.`:'No clips to auto-review in this list.')+
      (short?` ${short} short link${short===1?' (vm.tiktok.com) cannot play here and is':'s (vm.tiktok.com) cannot play here and are'} left out.`:'');
    $('#autoStart').disabled=!queue.length||!autoSupported();
  }
  function openAuto(){
    if(!state.records.length){toast('Import or add some clips first.');return;}
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
  function autoCounts(){
    const t=auto.tally;
    $('#autoCounts').textContent=`${auto.index>=auto.queue.length?'All '+auto.queue.length+' clips':'Clip '+(auto.index+1)+' of '+auto.queue.length} · ${auto.mode==='transcript'?(t.transcribed||0)+' transcribed':(t.understood||0)+' filled in'} · ${t.empty||0} nothing heard or seen · ${t.unavailable||0} would not play · ${t.failed||0} failed`;
    $('#autoBar').style.width=Math.round(auto.index/auto.queue.length*100)+'%';
  }
  function autoListItem(r,res){
    const li=document.createElement('li');
    if(res.status==='transcribed'){
      const li=document.createElement('li');li.className='ok';const b=document.createElement('strong');b.textContent=r.title||'A clip';
      li.append(b,document.createTextNode(`: “${(res.transcript||'').slice(0,90)}${(res.transcript||'').length>90?'…':''}”`));
      const list=$('#autoResults');list.prepend(li);while(list.children.length>8)list.lastChild.remove();return;
    }
    const ok=res.status==='understood';
    li.className=ok?'ok':'not';
    const title=document.createElement('strong');title.textContent=ok?(r.title||'Untitled'):(r.title||'A clip');
    li.append(title,document.createTextNode(ok?` → ${emojiFor(r.category)} ${r.category}${res.heard||res.seen?' (from '+[res.heard&&'what was said',res.seen&&'what was shown'].filter(Boolean).join(' and ')+')':''}`
      :`: ${AUTO_REASONS[res.reason]||C.AUTO_LABELS[res.status]||res.reason}`));
    const list=$('#autoResults');list.prepend(li);while(list.children.length>8)list.lastChild.remove();
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
      stream=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser',frameRate:5},
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
    auto={queue,index:0,stream,stop:false,tally:{},failsInRow:0,cap:Number($('#autoCap').value),mark:mode==='details'&&$('#autoMark').checked,mode,
      chunks:[],recording:false};
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
      node.port.onmessage=e=>{if(auto&&auto.recording)auto.chunks.push(e.data);};
      if(ctx.state!=='running')await ctx.resume();
      const video=document.createElement('video');video.muted=true;video.playsInline=true;
      video.srcObject=new MediaStream(stream.getVideoTracks());await video.play();auto.video=video;
      try{auto.wake=await navigator.wakeLock?.request('screen');}catch(_){/* the screen may sleep; capture still works while the tab is open */}
      for(;auto.index<auto.queue.length&&!auto.stop;auto.index++){
        const r=state.records.find(x=>x.id===auto.queue[auto.index]);if(!r)continue;
        autoCounts();
        const res=await autoClip(r);
        if(res.reason==='SHARING_STOPPED'||res.reason==='STOPPED')break;  // nothing saved for a clip cut short
        if(res.stopRun){stopReason=res.message;break;}
        const i=state.records.findIndex(x=>x.id===r.id);if(i<0)continue;
        let next=C.applyUnderstanding(state.records[i],res,{markReviewed:auto.mark});
        // The library is one saved file of at most 2 MB: keep long transcripts short when it is nearly full.
        if(next.auto?.transcript&&JSON.stringify(state).length>1_700_000){next={...next,auto:{...next.auto,transcript:next.auto.transcript.slice(0,500)}};auto.trimmed=true;}
        state.records[i]=next;
        auto.tally[res.status]=(auto.tally[res.status]||0)+1;
        autoListItem(state.records[i],res);
        commit();await persist();
        if(saveBlocked){stopReason='Saving failed, so auto-review stopped. Download a backup.';break;}
        auto.failsInRow=res.status==='failed'?auto.failsInRow+1:0;
        if(auto.failsInRow>=3){stopReason='Three clips in a row failed, so auto-review stopped. Try again later.';break;}
      }
    }catch(err){stopReason='Auto-review stopped: '+(err&&err.message||err);}
    finally{
      const done=auto.index>=auto.queue.length,ended=auto.ended,t=auto.tally,trimmed=auto.trimmed;
      autoCounts();
      autoCleanup();
      $('#autoStart').hidden=false;$('#autoStop').hidden=true;$('#autoHint').textContent='';
      if(done)$('#autoBar').style.width='100%';
      autoSay((stopReason||(done?'Done.':ended?'Tab sharing stopped, so auto-review stopped.':'Stopped.'))+` ${t.understood||0} filled in, ${t.transcribed?t.transcribed+' transcribed, ':''}${t.empty||0} nothing heard or seen, ${t.unavailable||0} would not play, ${t.failed||0} failed.`+(t.understood?' Filter Discoveries by "Auto-reviewed" to check them.':'')+(t.transcribed?' Transcripts show in Review clips and are searchable.':'')+(trimmed?' Your library is nearly full, so the last transcripts were kept short.':''));
      $('#autoStart').textContent='Start again';
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
    const w=270,h=480,c=document.createElement('canvas');c.width=w;c.height=h;
    c.getContext('2d').drawImage(v,box.left*sx,box.top*sy,box.width*sx,box.height*sy,0,0,w,h);
    return c;
  }
  function autoGrid(shots){
    if(!shots.length)return '';
    const c=document.createElement('canvas');c.width=270*shots.length;c.height=480;
    const g=c.getContext('2d');shots.forEach((s,i)=>g.drawImage(s,i*270,0));
    return c.toDataURL('image/jpeg',0.82);
  }
  // The recorded sound as base64 WAV pieces of at most 55 seconds, quiet pieces left out.
  function autoAudio(){
    const total=auto.chunks.reduce((n,c)=>n+c.length,0);if(!total)return [];
    const all=new Float32Array(total);let at=0;for(const c of auto.chunks){all.set(c,at);at+=c.length;}
    auto.chunks=[];
    const pcm=C.downsample(all,auto.ctx.sampleRate,16000),out=[];
    for(const [a,b] of C.pieces(pcm.length,16000,55)){
      const part=pcm.subarray(a,b);if(part.length<16000*0.8||C.loudness(part)<0.002)continue;
      const bytes=C.wavBytes(part,16000);let bin='';
      for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
      out.push(btoa(bin));
    }
    return out;
  }
  async function autoPost(path,body){
    let res,data;
    try{res=await fetch('/api/'+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      data=await res.json().catch(()=>({}));}
    catch(_){return {status:'failed',reason:'NETWORK'};}
    if(res.status===401)return {stopRun:true,message:'Your sign-in expired. Sign in again, then start again.'};
    if(res.status===429)return {stopRun:true,message:data.error||"Today's auto-review allowance is used up. Continue tomorrow."};
    if(res.status===503)return {stopRun:true,message:'Auto-review is not set up on the server yet (it needs the AI binding; see the README).'};
    if(!data.status)return {status:'failed',reason:'SERVER_'+res.status};
    return data;
  }
  // Play one clip; resolve with what the Worker made of it (or why not).
  function autoPlay(r){
    return new Promise(resolve=>{
      const box=$('#autoFrame'),frame=document.createElement('iframe');
      frame.src=C.playerUrl(r,{auto:true});frame.title='TikTok video player';
      frame.allow='autoplay; encrypted-media; fullscreen';frame.referrerPolicy='strict-origin-when-cross-origin';
      box.replaceChildren(frame);
      const started=Date.now();let ready=0,lastTick=0,limit=auto.cap,times=null,shots=[],timeEvents=false,unmutes=0,triedPlay=false,finished=false,now=0;
      const send=type=>{try{frame.contentWindow.postMessage({type,value:null,'x-tiktok-player':true},'https://www.tiktok.com');}catch(_){}};
      const shoot=()=>{const s=autoShot(frame);if(s)shots.push(s);};
      const finish=reason=>{
        if(finished)return;finished=true;
        clearInterval(timer);window.removeEventListener('message',onMessage);
        auto.recording=false;try{auto.node.port.postMessage({record:false});}catch(_){}
        send('pause');auto.finishClip=null;
        resolve({reason,shots,played:now});
      };
      auto.finishClip=finish;
      const startListening=()=>{if(auto.recording)return;auto.chunks=[];auto.recording=true;auto.node.port.postMessage({record:true});};
      const onMessage=e=>{
        if(e.source!==frame.contentWindow||e.origin!=='https://www.tiktok.com')return;
        let d=e.data;if(typeof d==='string'){try{d=JSON.parse(d);}catch(_){return;}}
        if(!d||typeof d.type!=='string')return;
        const v=d.value&&typeof d.value==='object'?d.value:d;
        if(d.type==='onPlayerReady'){if(!ready){ready=Date.now();send('unMute');send('play');startListening();}}
        else if(d.type==='onMute'&&d.value===true&&unmutes<3){unmutes++;send('unMute');}
        else if(d.type==='onStateChange'&&Number(d.value)===1)startListening();
        else if(d.type==='onStateChange'&&Number(d.value)===0)finish('ENDED');
        else if(d.type==='onCurrentTime'){
          const t=Number(v.currentTime),dur=Number(v.duration);if(!isFinite(t))return;
          timeEvents=true;lastTick=Date.now();now=t;startListening();
          if(!times&&dur>0){limit=Math.min(dur,auto.cap);times=C.shotTimes(limit);}
          while(times&&times.length&&t>=times[0]){times.shift();shoot();}
          autoSay(`Listening and looking · ${Math.floor(t)}s of ${Math.ceil(limit)}s`);
          if(t>=limit-0.25)finish('LIMIT');
        }
        else if(d.type==='onPlayerError'||d.type==='onError'){
          const code=Number(v.errorCode??d.value);
          if(code===3002&&!triedPlay){triedPlay=true;send('play');return;}
          finish(code===1001?'NOT_FOUND':code===3002?'AUTOPLAY':'PLAYBACK');
        }
      };
      window.addEventListener('message',onMessage);
      autoSay('Loading the clip…');
      // Photo posts and quiet players may not report the time: fall back to the clock.
      const timer=setInterval(()=>{
        const t=Date.now();
        if(!ready&&t-started>20000)return finish('NO_PLAYER');
        if(ready&&!timeEvents){
          const s=(t-ready)/1000;
          if(s>=2&&shots.length<1)shoot();if(s>=6&&shots.length<2)shoot();if(s>=10&&shots.length<3)shoot();
          if(s>=Math.min(12,auto.cap))finish('NO_TIME');
        }
        if(timeEvents&&t-lastTick>15000)finish(shots.length?'STALLED_PART':'STALLED');
        if(t-started>(auto.cap+40)*1000)finish('TIMEOUT');
      },500);
    });
  }
  async function autoClip(r){
    const played=await autoPlay(r);
    if(played.reason==='SHARING_STOPPED')return {reason:'SHARING_STOPPED'};
    if(played.reason==='STOPPED_BY_PERSON')return {reason:'STOPPED'};
    if(['NO_PLAYER','NOT_FOUND','PLAYBACK','AUTOPLAY','STALLED'].includes(played.reason))
      return {status:'unavailable',reason:played.reason==='STALLED'?'STALLED':played.reason};
    // 1. What was said: each piece of sound through the speech-to-text model.
    const parts=autoAudio(),words=[];let listenFailed=false;
    for(let i=0;i<parts.length;i++){
      autoSay(parts.length>1?`Turning the sound into words (part ${i+1} of ${parts.length})…`:'Turning the sound into words…');
      const heard=await autoPost('transcribe',{audio:parts[i]});
      if(heard.stopRun)return heard;
      if(heard.status==='transcribed')words.push(heard.text);else if(heard.status==='failed')listenFailed=true;
    }
    const transcript=words.join(' ').trim().slice(0,4000);
    if(auto.mode==='transcript'){
      if(transcript)return {status:'transcribed',reason:'TRANSCRIBED',heard:true,transcript};
      return listenFailed?{status:'failed',reason:'AI_FAILED'}:{status:'empty',reason:'NOTHING_SAID'};
    }
    // 2. What it is about: the transcript and the screenshots.
    const image=autoGrid(played.shots);
    if(!transcript&&!image)return listenFailed?{status:'failed',reason:'AI_FAILED'}:{status:'empty',reason:'NOTHING_TO_READ'};
    autoSay('Working out what it is about…');
    const data=await autoPost('understand',{transcript,image,categories:categoryList().map(c=>({name:c.name,words:c.words||[]}))});
    if(data.stopRun)return data;
    return {...data,transcript};
  }
  function stopAuto(){if(auto){auto.stop=true;autoSay('Stopping…');auto.finishClip?.('STOPPED_BY_PERSON');}}
  function initAuto(){
    const dlg=$('#autoDialog');
    $('#startAuto').addEventListener('click',openAuto);
    $('#autoStart').addEventListener('click',startAuto);
    $('#autoStop').addEventListener('click',stopAuto);
    for(const id of ['autoScope','autoCap'])$('#'+id).addEventListener('change',autoEstimate);
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
      const coll=evt.target.closest('[data-collection]');if(coll){activeCollection=coll.dataset.collection;selectTab('library');return;}
      const action=evt.target.closest('[data-action]');if(!action)return;
      const {action:kind,id}=action.dataset;
      if(kind==='watch'){rv.shown=shownIds.slice();openReview('shown',id);}
      else if(kind==='edit')openEditor(id);
      else if(kind==='plan')addToPlan(id);
      else if(kind==='delete'){
        const r=state.records.find(x=>x.id===id);
        if(!r||!confirm('Delete this discovery? It will also leave the itinerary.'))return;
        state.records=state.records.filter(x=>x.id!==id);state.plan=state.plan.filter(x=>x.recordId!==id);commit();toast('Discovery deleted');
      } else if(kind==='remove-plan'){state.plan=state.plan.filter(p=>p.id!==id);commit();}
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
    $('#closeDialog').addEventListener('click',()=>$('#editDialog').close());
    $('#cancelEdit').addEventListener('click',()=>$('#editDialog').close());
    $('#search').addEventListener('input',renderLibrary);
    for(const id of ['categoryFilter','statusFilter','analysisFilter','sortFilter'])$('#'+id).addEventListener('change',renderLibrary);
    for(const [value,label] of Object.entries(C.ANALYSIS_LABELS))$('#analysisFilter').insertAdjacentHTML('beforeend',`<option value="${html(value)}">${html(label)}</option>`);
    $('#tripTitle').addEventListener('change',evt=>{state.tripTitle=evt.target.value.trim().slice(0,140);commit();});
    $('#dayCount').addEventListener('change',evt=>{
      const next=Number(evt.target.value);
      if(state.plan.some(x=>x.day>next)&&!confirm('Stops assigned to later days will be moved to the last visible day. Continue?')){evt.target.value=String(state.dayCount);return;}
      state.plan.forEach(x=>x.day=Math.min(x.day,next));state.dayCount=next;commit();
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
    $('#exportPlan').addEventListener('click',()=>download('clipatlas-itinerary.md',C.planMarkdown(state.plan,state.records,state.tripTitle),'text/markdown;charset=utf-8'));
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
    $('#authGate').hidden=true;$('#appShell').hidden=false;
    $('#saveStatus').textContent='Saved to your account';
    init();
    if(setup.needsChoice)openStarterDialog();
    else if(setup.migrated)commit();
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
