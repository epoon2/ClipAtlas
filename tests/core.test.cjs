const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('./load-core.cjs');
const long='https://www.tiktok.com/@abc/video/7345678901234567890?lang=en&is_copy_url=1';
test('normalizes video id and removes tracking params',()=>{
 const r=C.parseTikTokURL(long);assert.equal(r.key,'tiktok:7345678901234567890');
 assert.equal(r.url,'https://www.tiktok.com/@abc/video/7345678901234567890');
});
test('blocks javascript and non-TikTok URLs',()=>{
 assert.equal(C.parseTikTokURL('javascript:alert(1)'),null);
 assert.equal(C.parseTikTokURL('https://example.com/video/7345678901234567890'),null);
 assert.equal(C.parseTikTokURL('https://tiktok.com.evil.tld/@abc/video/7345678901234567890'),null);
});
test('keeps short links separate unless exact same path',()=>{
 const r=C.parseTikTokURL('https://vm.tiktok.com/AbcD123/?share_item_id=123');
 assert.equal(r.key,'link:https://vm.tiktok.com/abcd123');
 assert.equal(C.parseTikTokURL('https://vm.tiktok.com/AbcD123/').key,r.key);
});
test('imports Favorite Videos but not unrelated private sections',()=>{
 const data={Activity:{'Favorite Videos':{FavoriteVideoList:[{Date:'2026-01-02 15:42:10',Link:long}]}},'Like List':[{Link:'https://www.tiktok.com/@x/video/1345678901234567890'}], 'Direct Messages': [{Link:'https://www.tiktok.com/@z/video/1345678901234567891'}]};
 const arr=C.extractTikTokFavorites(data);assert.equal(arr.length,1);assert.equal(arr[0].savedAt,'2026-01-02');
});
test('imports Favourite Videos spelling and flat favorites arrays',()=>{
 const url='https://www.tiktokv.com/share/video/7345678901234567890/';
 assert.equal(C.extractTikTokFavorites({'Your Activity':{'Favourite Videos':[{Link:url}]}}).length,1);
 assert.equal(C.extractTikTokFavorites([{Link:url,Date:'2025-10-10'}]).length,1);
});
test('does not import likes when favorites absent',()=>{
 assert.deepEqual(C.extractTikTokFavorites({'Like List':[{Link:long}]}),[]);
});
test('CSV parses quoted commas and embedded newlines',()=>{
 const r=C.parseCSV('url,title,notes,collection\n"'+long+'","Food, Taipei","line 1\nline 2","Food | Taiwan"');
 assert.equal(r.length,1);assert.equal(r[0].title,'Food, Taipei');assert.equal(r[0].notes,'line 1\nline 2');
});
test('merge keeps previous edited notes but imports missing collections',()=>{
 const current=C.createRecord({url:long,notes:'my note',collections:'Taiwan'});
 const incoming=[{url:'https://www.tiktok.com/@other/video/7345678901234567890',notes:'overwrite?',collection:'Food',title:'Great place'}];
 const m=C.mergeRecords([current],incoming);
 assert.equal(m.records.length,1);assert.equal(m.duplicates,1);assert.equal(m.records[0].notes,'my note');
 assert.deepEqual(m.records[0].collections,['Taiwan','Food']);assert.equal(m.records[0].title,'Great place');
});
test('invalid record rejected and not merged',()=>{
 const m=C.mergeRecords([],[{url:'https://example.com/foo'}, {url:long}]);assert.equal(m.added,1);assert.equal(m.invalid,1);
});
test('importing never guesses a category or a venue; sorting is separate',()=>{
 const r=C.createRecord({url:long,caption:'Taipei street food night market'});
 assert.equal(r.category,'Unsorted');assert.equal(r.place,'');
 const {state}=C.ensureSetup({version:1,records:[r],collections:[],plan:[]});
 assert.equal(C.sortUnsorted(state.records,state.categories),1);
 assert.equal(state.records[0].category,'Taiwan · Food');
 assert.deepEqual(state.records[0].autoSorted.words,['taipei+food','night market']);
 assert.equal(state.records[0].place,'');
});
test('a CSV can bring its own category names',()=>{
 assert.equal(C.createRecord({url:long,category:'Hikes to try'}).category,'Hikes to try');
 assert.equal(C.createRecord({url:long,category:'Taiwan Food'}).category,'Taiwan · Food','first-version name');
 assert.equal(C.createRecord({url:long,category:'unsorted'}).category,'Unsorted');
});
test('itinerary export includes original source and notes',()=>{
 const r=C.createRecord({url:long,title:'Visit place',notes:'verify hours'});
 const p=C.planMarkdown([{id:'p',recordId:r.id,day:2,note:'Lunch'}],[r],'Taiwan trip');
 assert.match(p,/## Day 2/);assert.match(p,/Visit place/);assert.match(p,/Lunch/);assert.match(p,/not been independently verified/);
});
const ID='7662085125500407061';
const ZW=String.fromCharCode(0x200b),NBSP=String.fromCharCode(0xa0);
test('share links from the TikTok export keep their video id, hidden characters removed',()=>{
 for(const url of [`https://www.tiktok.com/share/video/${ID}`,`https://www.tiktokv.com/share/video/${ID}/`,
   `${ZW}https://www.tiktok.com/share/video/${ID}${NBSP}`,`<https://www.tiktok.com/share/video/${ID}>.`,
   `http://m.tiktok.com/v/${ID}.html`,`https://www.tiktok.com/embed/v2/${ID}`,`https://www.tiktok.com/@a.b/photo/${ID}`,
   `https://www.tiktok.com/share/video/${ID}%E2%80%8B`]){
  const r=C.parseTikTokURL(url);assert.ok(r,url);assert.equal(r.key,'tiktok:'+ID,url);assert.match(r.url,/^https:\/\//);
 }
 assert.equal(C.parseTikTokURL(`https://www.tiktok.com:8080/@a/video/${ID}`),null);
 assert.equal(C.parseTikTokURL(`https://u:p@www.tiktok.com/@a/video/${ID}`),null);
});
test('analysis state: only real details count as filled in',()=>{
 assert.equal(C.analysisState({}),'not_analyzed');
 assert.equal(C.analysisState({enrichmentStatus:'metadata',title:'x'}),'enriched');
 assert.equal(C.analysisState({enrichmentStatus:'metadata'}),'empty','old false successes');
 assert.equal(C.analysisState({enrichmentStatus:'unavailable'}),'unavailable');
 assert.equal(C.analysisState({enrichment:{status:'rejected',reason:'NOT_TIKTOK_LINK'}}),'rejected');
});
test('which links are looked up again',()=>{
 const now=Date.parse('2026-10-27T12:00:00Z'),day=86400000,iso=ms=>new Date(ms).toISOString();
 const rec=(extra)=>({url:'https://www.tiktok.com/share/video/'+ID,status:'unreviewed',...extra});
 assert.equal(C.needsAnalysis(rec({}),now),true);
 assert.equal(C.needsAnalysis(rec({status:'reviewed'}),now),false);
 assert.equal(C.needsAnalysis(rec({enrichment:{status:'enriched',at:iso(now)}}),now),false);
 assert.equal(C.needsAnalysis(rec({enrichment:{status:'failed',at:iso(now)}}),now),true);
 assert.equal(C.needsAnalysis(rec({enrichment:{status:'rejected',at:iso(now)}}),now),true);
 assert.equal(C.needsAnalysis(rec({enrichment:{status:'unavailable',at:iso(now-day)}}),now),false);
 assert.equal(C.needsAnalysis(rec({enrichment:{status:'unavailable',at:iso(now-8*day)}}),now),true);
 assert.equal(C.needsAnalysis(rec({enrichmentStatus:'metadata'}),now),true,'old empty "successes" are tried again');
});
test('backups and edits keep the analysis result',()=>{
 const r=C.createRecord({url:'https://www.tiktok.com/share/video/'+ID,enrichment:{status:'enriched',reason:'ENRICHED',at:'2026-10-27T00:00:00Z',extra:'x'}});
 assert.deepEqual(r.enrichment,{status:'enriched',reason:'ENRICHED',retryable:false,at:'2026-10-27T00:00:00Z'});
 assert.equal(C.createRecord({url:'https://www.tiktok.com/share/video/'+ID,enrichment:{status:'bogus'}}).enrichment,undefined);
});

// ---- categories each account makes
const R=(category,extra={})=>({...C.createRecord({url:'https://www.tiktok.com/@a/video/'+String(7345678901234567000+Math.floor(Math.random()*999)),category}),...extra});
test('an account from before keeps its categories and its Itinerary',()=>{
 const old={version:1,records:[R('Taiwan · Food'),R('Other'),R('Taiwan Food'),R('Hikes')],collections:[],plan:[{id:'p',recordId:'x',day:1}]};
 const {state,migrated,needsChoice}=C.ensureSetup(old);
 assert.equal(migrated,true);assert.equal(needsChoice,false);
 const names=state.categories.map(c=>c.name);
 assert.deepEqual(names.slice(0,7),C.LEGACY.map(x=>x[0]));
 assert.ok(names.includes('Hikes'),'a name clips use is kept');
 assert.deepEqual(state.records.map(r=>r.category),['Taiwan · Food','Other','Taiwan · Food','Hikes']);
 assert.equal(state.settings.tabs.itinerary,true);
 assert.equal(C.ensureSetup(state).migrated,false,'only once');
});
test('a new account picks a starter set; Start empty has no categories and no Itinerary',()=>{
 const fresh={version:1,records:[],collections:[],plan:[]};
 assert.equal(C.ensureSetup(fresh).needsChoice,true);
 const research=C.applyStarter(fresh,'research');
 assert.deepEqual(research.categories.map(c=>c.name),['Explainers','Studies & data','How-to','Opinions','Resources']);
 assert.equal(research.settings.tabs.itinerary,false);assert.equal(research.settings.purpose,'research');
 assert.equal(C.applyStarter(fresh,'travel').settings.tabs.itinerary,true);
 const empty=C.applyStarter(fresh,'empty');assert.deepEqual(empty.categories,[]);assert.equal(empty.settings.tabs.itinerary,false);
 assert.equal(C.ensureSetup(empty).needsChoice,false);
});
test('adding a starter set later keeps your own categories and tabs',()=>{
 const mine={version:1,records:[],collections:[],plan:[],categories:[{name:'Food',emoji:'🥟',words:['dumplings']}],settings:{purpose:'custom',tabs:{itinerary:false}}};
 const more=C.applyStarter(mine,'travel',{keepTabs:true});
 assert.equal(more.categories[0].emoji,'🥟','yours wins over the starter with the same name');
 assert.equal(more.categories.filter(c=>c.name==='Food').length,1);
 assert.ok(more.categories.some(c=>c.name==='Stays'));
 assert.equal(more.settings.tabs.itinerary,false);
});
test('sort words: whole short words, phrases, a+b pairs, hashtags, Chinese, ties go to the higher category',()=>{
 const cats=C.normalizeCategories([{name:'Food',words:'eat, night market, food'},{name:'Taiwan food',words:['taipei + food','夜市']},{name:'Tea',words:['tea']}]);
 assert.deepEqual(cats[1].words,['taipei+food','夜市']);
 assert.equal(C.suggestCategory('Best night market food in Taipei',cats).name,'Food','3 words beat a pair');
 assert.equal(C.suggestCategory('Taipei food tour',cats).name,'Taiwan food','a pair beats one word');
 assert.equal(C.suggestCategory('#taiwanfood haul',cats).name,'Food','found inside a hashtag');
 assert.equal(C.suggestCategory('士林夜市',cats).name,'Taiwan food');
 assert.equal(C.suggestCategory('great seats here',cats),null,'"eat" is not in "seats"');
 assert.equal(C.suggestCategory('steak and teas',cats).name,'Tea','plural of a short word');
 assert.equal(C.suggestCategory('',cats),null);
 const tie=C.normalizeCategories([{name:'A',words:['coffee']},{name:'B',words:['coffee']}]);
 assert.equal(C.suggestCategory('coffee',tie).name,'A');
});
test('sorting only touches Unsorted clips and says why',()=>{
 const cats=C.normalizeCategories([{name:'Food',words:['ramen']}]);
 const a=R('Unsorted',{title:'Best ramen'}),b=R('Hikes',{title:'ramen after a hike'}),c=R('Unsorted',{title:'nothing'});
 assert.equal(C.sortUnsorted([a,b,c],cats,'2026-10-27T00:00:00Z'),1);
 assert.equal(a.category,'Food');assert.deepEqual(a.autoSorted,{name:'Food',words:['ramen'],at:'2026-10-27T00:00:00Z'});
 assert.equal(b.category,'Hikes');assert.equal(c.category,'Unsorted');
});
test('rename moves every clip; duplicates and "Unsorted" are refused',()=>{
 const s0={records:[R('Food',{autoSorted:{name:'Food',words:['x']}}),R('Hikes')],categories:C.normalizeCategories([{name:'Food'},{name:'Hikes'}])};
 const {state}=C.renameCategory(s0,'Food','Eats');
 assert.deepEqual(state.categories.map(c=>c.name),['Eats','Hikes']);
 assert.equal(state.records[0].category,'Eats');assert.equal(state.records[0].autoSorted.name,'Eats');
 assert.match(C.renameCategory(s0,'Food','hikes').error,/already have/);
 assert.ok(C.renameCategory(s0,'Food','Unsorted').error);
 assert.ok(C.renameCategory(s0,'Food','  ').error);
});
test('delete sends clips to Unsorted, or merges them into another category',()=>{
 const s0={records:[R('Food'),R('Hikes')],categories:C.normalizeCategories([{name:'Food'},{name:'Hikes'},{name:'Eats'}])};
 const gone=C.deleteCategory(s0,'Food');
 assert.deepEqual(gone.categories.map(c=>c.name),['Hikes','Eats']);assert.equal(gone.records[0].category,'Unsorted');
 const merged=C.deleteCategory(s0,'Food','Eats');assert.equal(merged.records[0].category,'Eats');
 assert.equal(C.deleteCategory(s0,'Food','Nope').records[0].category,'Unsorted');
});
test('category lists are cleaned: names, duplicates, Unsorted, limits',()=>{
 const cats=C.normalizeCategories([{name:'  Food  '},{name:'food'},{name:'Unsorted'},{name:''},null,{name:'x'.repeat(80),words:Array(60).fill(0).map((_,i)=>'w'+i)}]);
 assert.deepEqual(cats.map(c=>c.name.length),[4,40]);
 assert.equal(cats[1].words.length,40);assert.ok(cats.every(c=>c.id&&c.emoji));
 assert.equal(C.normalizeCategories(Array(150).fill(0).map((_,i)=>({name:'c'+i}))).length,100);
});
test('categories a CSV brings are added to the list',()=>{
 const s0={records:[R('Hikes'),R('Unsorted')],categories:[]};
 assert.deepEqual(C.addMissingCategories(s0).categories.map(c=>c.name),['Hikes']);
});
test('every file the page loads exists',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const pub=path.join(__dirname,'..','public');
 const page=fs.readFileSync(path.join(pub,'index.html'),'utf8');
 const files=[...page.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css))"/g)].map(m=>m[1]);
 assert.ok(files.length>=4,files.join(','));
 for(const f of files)assert.ok(fs.existsSync(path.join(pub,f)),'public/'+f+' is missing');
});

test('the embedded player plays a clip by its video id; short links have none',()=>{
 assert.equal(C.playerUrl({videoId:'7662085125500407061'}).split('?')[0],'https://www.tiktok.com/player/v1/7662085125500407061');
 assert.equal(C.playerUrl({videoId:''}),'');
 assert.equal(C.playerUrl({videoId:'12"><script>'}),'');
});
test('review queues: needs review, unsorted, a collection, all; newest saved first',()=>{
 const rec=[{id:'a',status:'unreviewed',category:'Food',savedAt:'2026-01-01',collections:['Taiwan']},
  {id:'b',status:'reviewed',category:'Unsorted',savedAt:'2026-03-01',collections:[]},
  {id:'c',status:'unreviewed',category:'Unsorted',savedAt:'2026-02-01',collections:['Taiwan']}];
 assert.deepEqual(C.reviewQueue(rec,'review'),['c','a']);
 assert.deepEqual(C.reviewQueue(rec,'unsorted'),['b','c']);
 assert.deepEqual(C.reviewQueue(rec,'collection:Taiwan'),['c','a']);
 assert.deepEqual(C.reviewQueue(rec,'all'),['b','c','a']);
});
test('a review save keeps the link, creator and lookup; marks reviewed; explains a suggested category',()=>{
 const old=C.createRecord({id:'k1',url:'https://www.tiktokv.com/share/video/7662085125500407061/',creator:'@c',savedAt:'2026-02-01',
  title:'',category:'Unsorted',collections:['Taiwan'],enrichment:{status:'empty',reason:'EMPTY_METADATA'}});
 const fields={title:'Beef noodle soup',category:'Food',place:'Lin Dong Fang',city:'Taipei',country:'Taiwan',
  tags:'noodles, beef',collections:'Taiwan, Must try',notes:'Go early',caption:''};
 const r=C.reviewEdit(old,fields,{suggested:{name:'Food',words:['noodle']},now:'2026-10-27T00:00:00Z'});
 assert.equal(r.id,'k1'); assert.equal(r.url,old.url); assert.equal(r.creator,'@c'); assert.equal(r.savedAt,'2026-02-01');
 assert.equal(r.status,'reviewed'); assert.deepEqual(r.tags,['noodles','beef']); assert.deepEqual(r.collections,['Taiwan','Must try']);
 assert.equal(r.enrichment.reason,'EMPTY_METADATA'); assert.deepEqual(r.autoSorted.words,['noodle']);
 const picked=C.reviewEdit(old,{...fields,category:'Shopping'},{reviewed:false,suggested:{name:'Food',words:['noodle']}});
 assert.equal(picked.status,'unreviewed'); assert.equal(picked.autoSorted,undefined,'a category the person picked needs no explanation');
});
