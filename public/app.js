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
  const listCollections = () => [...new Set([...state.collections, ...state.records.flatMap(r => r.collections || [])])].sort((a,b)=>a.localeCompare(b));
  function selectTab(tab) {
    if (!['library','itinerary','import'].includes(tab)) return;
    currentTab=tab;
    $$('.page').forEach(x=>x.classList.toggle('active',x.id===tab+'Page'));
    $$('.nav-link').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
    $('#crumb').textContent=({library:'DISCOVERIES',itinerary:'ITINERARY',import:'IMPORT & BACKUP'})[tab];
    if (tab==='library') renderLibrary(); else if(tab==='itinerary') renderItinerary();
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
  const symbols = {Unsorted:'✦','Taiwan · Food':'🍜','Taiwan · Shopping':'🛍️','Taiwan · Activities':'🏮','Dates & restaurants':'🌷','Travel ideas':'🧳','Points & miles':'✈️',Other:'🔖'};
  function renderStats() {
    $('#statClips').textContent=state.records.length;
    $('#statCollections').textContent=listCollections().length;
    $('#statReview').textContent=state.records.filter(x=>x.status!=='reviewed').length;
    $('#statPlan').textContent=state.plan.length;
  }
  function renderLibrary() {
    renderStats(); renderCollections();
    const q=$('#search').value.toLocaleLowerCase().trim();
    const category=$('#categoryFilter').value, status=$('#statusFilter').value;
    let records=state.records.filter(r=>(!activeCollection || (r.collections||[]).includes(activeCollection))
      && (category==='all'||r.category===category)
      && (status==='all'||r.status===status)
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
      return `<article class="clip-card"><div class="clip-card-head"><span class="clip-emoji">${symbols[r.category]||'✦'}</span><span class="status ${r.status==='reviewed'?'reviewed':''}">${r.status==='reviewed'?'✓ Reviewed':'Needs review'}</span></div><div class="clip-body"><div class="category">${html(r.category)}</div><h3>${html(title)}</h3><p class="location">${html(loc||'Location not yet identified')}${r.savedAt?' · Saved '+html(r.savedAt):''}</p>${r.notes||r.caption?`<p class="clip-notes">${html(r.notes||r.caption)}</p>`:''}<div class="chips">${chips.map(t=>`<span class="chip">${html(t)}</span>`).join('')}</div></div><div class="clip-actions"><a href="${html(r.url)}" target="_blank" rel="noopener noreferrer">↗ TikTok</a><button data-action="edit" data-id="${html(r.id)}">Edit</button><button data-action="plan" data-id="${html(r.id)}">${inPlan?'✓ Planned':'+ Plan'}</button><button class="danger" data-action="delete" data-id="${html(r.id)}" aria-label="Delete clip">✕</button></div></article>`;
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
  function render() { renderStats(); renderCollections(); if(currentTab==='library')renderLibrary(); else if(currentTab==='itinerary')renderItinerary(); }
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
          state=clean;commit();toast('Full backup restored.');$('#importFeedback').textContent='Backup restored successfully.';return;
        }
        entries=C.extractTikTokFavorites(data);
      } else throw new Error('Use a .json or .csv file. Unzip TikTok’s download first.');
      if(!entries.length){$('#importFeedback').textContent='No favorite TikTok links found. Try the official JSON export with Favorite Videos included, or use the CSV template.';return;}
      const result=merge(entries,$('#bulkCollection').value.trim());
      $('#importFeedback').textContent=`Imported ${result.added} new links; ${result.duplicates} duplicates; ${result.updated} enriched; ${result.invalid} invalid. Your existing notes and itinerary were kept.`;
      toast('Import finished: '+result.added+' new discoveries');
    }catch(err){$('#importFeedback').textContent='Import error: '+err.message;toast('Could not import this file.');}
    finally{$('#fileImport').value='';}
  }
  // Conservative suggestions from caption text only. Never invent a place or price.
  const RULES = [
    ['Taiwan Food',/taiwan.*(food|eat|restaurant|night market)|taipei.*(food|eat|restaurant|cafe)|夜市|小吃|美食|餐廳|餐厅|吃什麼|吃什么|珍珠奶茶|bubble tea/i],
    ['Taiwan Shopping',/taiwan.*(shopping|shop|buy|store)|taipei.*(shopping|shop|store)|逛街|購物|购物|伴手禮|伴手礼/i],
    ['Taiwan Activities',/taiwan.*(things to do|attractions|itinerary|explore)|taipei.*(things to do|attractions)|九份|十分|景點|景点/i],
    ['Date Ideas',/date night|date idea|romantic|couples|約會|约会/i],
    ['Credit Card Points',/points transfer|transfer partner|credit card points|miles redemption|amex points|chase points|capital one miles/i],
    ['Travel',/travel|vacation|hotel|flight|itinerary|trip|旅遊|旅游/i]
  ];
  function suggestMetadata(title){
    const text=String(title||'');const lower=text.toLowerCase();
    const category=RULES.find(r=>r[1].test(text))?.[0]||'';
    const city = /taipei|台北|臺北/i.test(text)?'Taipei':/taichung|台中|臺中/i.test(text)?'Taichung':/tainan|台南/i.test(text)?'Tainan':/kaohsiung|高雄/i.test(text)?'Kaohsiung':'';
    const country=/taiwan|台灣|台湾|臺灣|taipei|taichung|tainan|kaohsiung|台北|臺北|台中|臺中|台南|高雄/i.test(text)?'Taiwan':'';
    const tags=[...new Set((text.match(/#[\p{L}\p{N}_]+/gu)||[]).map(h=>h.slice(1)))].slice(0,12);
    return {category,city,country,tags};
  }
  let stopAnalysis=false, analysisRunning=false;
  async function analyzeLinks(){
    if(analysisRunning)return;
    if(saveBlocked){toast('Resolve the save conflict first.');return;}
    if(saveBusy||dirty||saveTimer){await persist();if(saveBlocked)return;}
    const records=state.records.filter(r=>r.status!=='reviewed'&&r.url&&(!r.enrichedAt||r.enrichmentStatus==='unavailable'));
    if(!records.length){$('#analyzeProgress').textContent='No unreviewed links awaiting analysis.';return;}
    analysisRunning=true;stopAnalysis=false;$('#analyzeLinks').disabled=true;$('#cancelAnalyze').hidden=false;
    let enriched=0,unavailable=0,failed=0;
    try{
      for(let i=0;i<records.length;i++){
        if(stopAnalysis||saveBlocked)break;
        const r=records[i];$('#analyzeProgress').textContent=`Processing ${i+1}/${records.length} · ${enriched} filled · ${unavailable} unavailable · ${failed} errors`;
        try{
          const res=await fetch('/api/enrich',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:r.url}),credentials:'same-origin'});
          const data=await res.json();if(!res.ok)throw new Error(data.error||'Lookup failed');
          r.enrichmentStatus=data.available?'metadata':'unavailable';
          r.enrichedAt=new Date().toISOString();
          if(data.available){
            const title=data.title||''; const suggestion=suggestMetadata(title);
            if(!r.title&&title)r.title=title;
            if(!r.caption&&title)r.caption=title;
            if(!r.creator&&data.creator)r.creator=data.creator;
            if((!r.category||r.category==='Other'||r.category==='Uncategorized')&&suggestion.category)r.category=suggestion.category;
            if(!r.city&&suggestion.city)r.city=suggestion.city;
            if(!r.country&&suggestion.country)r.country=suggestion.country;
            r.tags=[...new Set([...(r.tags||[]),...suggestion.tags])].slice(0,20);
            enriched++;
          } else unavailable++;
          commit();await persist();
        }catch(err){failed++;if(/limit reached|sign in/i.test(err.message)){toast(err.message);break;}}
        if(i<records.length-1)await new Promise(resolve=>setTimeout(resolve,350));
      }
    }finally{
      analysisRunning=false;$('#analyzeLinks').disabled=false;$('#cancelAnalyze').hidden=true;
      $('#analyzeProgress').textContent=`Finished: ${enriched} enriched, ${unavailable} unavailable, ${failed} errors. Check suggested categories before marking Reviewed.`;
      render();
    }
  }
  function init() {
    for(const c of C.CATEGORIES){$('#categoryFilter').insertAdjacentHTML('beforeend',`<option value="${html(c)}">${html(c)}</option>`);$('#formCategory').insertAdjacentHTML('beforeend',`<option value="${html(c)}">${html(c)}</option>`);}
    $('#categoryFilter').insertAdjacentHTML('afterbegin','<option value="all" selected>All categories</option>');
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
    $('#cancelAnalyze').addEventListener('click',()=>{stopAnalysis=true;});
    $('#newCollection').addEventListener('click',addCollection);
    $('#editForm').addEventListener('submit',editorSave);
    $('#closeDialog').addEventListener('click',()=>$('#editDialog').close());
    $('#cancelEdit').addEventListener('click',()=>$('#editDialog').close());
    $('#search').addEventListener('input',renderLibrary);
    for(const id of ['categoryFilter','statusFilter','sortFilter'])$('#'+id).addEventListener('change',renderLibrary);
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
    const saved=await Cloud.load();applyState(saved);
    $('#authGate').hidden=true;$('#appShell').hidden=false;
    $('#saveStatus').textContent='Saved to your account';
    init();
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
      commit();toast('Imported '+added+' discoveries from this browser.');
    });
    try {if(await Cloud.me())await enter();}
    catch(err){$('#authError').textContent='Connection error: '+err.message;}
  });
})();
