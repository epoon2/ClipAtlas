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
test('plain category hints do not invent venue names',()=>{
 const r=C.createRecord({url:long,caption:'Taipei street food night market'});
 assert.equal(r.category,'Taiwan · Food');assert.equal(r.place,'');
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
