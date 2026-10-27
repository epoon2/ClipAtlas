const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('./core.cjs');
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
