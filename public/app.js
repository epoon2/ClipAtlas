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
  let toastTimer = null;

  function toast(message) {
    const el = $('#toast'); el.textContent = message; el.classList.add('shown');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('shown'), 4500);
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
      && (status==='all'||r.status===status)
      && (analysis==='all'||C.analysisState(r)===analysis)
      && (!q || [r.title,r.url,r.creator,r.caption,r.notes,r.category,r.place,r.city,r.country,(r.collections||[]).join(' '),(r.tags||[]).join(' ')].join(' ').toLocaleLowerCase().includes(q)));
    const sort=$('#sortFilter').value;
    records.sort((a,b) => sort==='title'?(a.title||a.place||'').localeCompare(b.title||b.place||''):
      sort==='oldest'?(a.savedAt||a.createdAt).localeCompare(b.savedAt||b.createdAt):(b.savedAt||b.createdAt).localeCompare(a.savedAt||a.createdAt));
    $('#filteredCount').textContent=records.length+' '+(records.length===1?'clip':'clips');
    $('#libraryEmpty').hidden=records.length!==0;
    $('#clipGrid').innerHTML=records.map(r=>{
      const title=r.title||r.place||'Untitled saved TikTok';
      const loc=[r.place,r.city,r.country].filter(Boolean).join(' · ');
      const chips=[...(r.collections||[]).slice(0,2),...(r.tags||[]).slice(0,1)];
      const inPlan=state.plan.some(p=>p.recordId===r.id);
      return `<article class="clip-card"><div class="clip-card-head"><span class="clip-emoji">${html(emojiFor(r.category))}</span><span class="card-flags"><span class="status ${r.status==='reviewed'?'reviewed':''}">${r.status==='reviewed'?'✓ Reviewed':'Needs review'}</span>${C.analysisState(r)==='not_analyzed'?'':`<span class="analysis-badge ${html(C.analysisState(r))}" title="${html(r.enrichment?.reason||'')}">${html(C.ANALYSIS_LABELS[C.analysisState(r)])}</span>`}</span></div><div class="clip-body"><div class="category">${html(r.category)}</div>${r.autoSorted&&r.autoSorted.name===r.category&&r.autoSorted.words?.length?`<p class="sorted-why" title="Sorted automatically by these sort words">Sorted by: ${html(r.autoSorted.words.join(', '))}</p>`:''}<h3>${html(title)}</h3><p class="location">${html(loc||'Location not yet identified')}${r.savedAt?' · Saved '+html(r.savedAt):''}</p>${r.notes||r.caption?`<p class="clip-notes">${html(r.notes||r.caption)}</p>`:''}<div class="chips">${chips.map(t=>`<span class="chip">${html(t)}</span>`).join('')}</div></div><div class="clip-actions"><a href="${html(r.url)}" target="_blank" rel="noopener noreferrer">↗ TikTok</a><button data-action="edit" data-id="${html(r.id)}">Edit</button>${tabOn('itinerary')?`<button data-action="plan" data-id="${html(r.id)}">${inPlan?'✓ Planned':'+ Plan'}</button>`:''}<button class="danger" data-action="delete" data-id="${html(r.id)}" aria-label="Delete clip">✕</button></div></article>`;
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
    renderStats(); renderCollections(); renderAnalysisSummary();
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
      $('#analyzeProgress').textContent=`${stopReason}Done: ${tallyText(tally)}.${why?' Why: '+why+'.':''}${left?` ${left} still waiting; click Analyze again for the next batch.`:''} Check suggested categories before marking Reviewed.`;
      render();
    }
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
      <span class="cat-count">${counts[c.name]||0} clip${counts[c.name]===1?'':'s'}</span>
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
      if(kind==='edit')openEditor(id);
      else if(kind==='plan')addToPlan(id);
      else if(kind==='delete'){
        const r=state.records.find(x=>x.id===id);
        if(!r||!confirm('Delete this discovery? It will also leave the itinerary.'))return;
        state.records=state.records.filter(x=>x.id!==id);state.plan=state.plan.filter(x=>x.recordId!==id);commit();toast('Discovery deleted');
      } else if(kind==='remove-plan'){state.plan=state.plan.filter(p=>p.id!==id);commit();}
      else if(kind==='up')movePlan(id,-1);else if(kind==='down')movePlan(id,1);
    });
    for(const id of ['addButton','emptyAdd'])$("#"+id).addEventListener('click',()=>openEditor());
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
