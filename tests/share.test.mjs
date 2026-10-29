// Sharing through the real Worker and a real (in-memory SQLite) database: view-only links, shared spaces,
// people by email and by invite link, roles, and two people saving at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { memoryD1 } from './site.mjs';

const BASE = 'https://clipatlas.test';
const env = { DB: memoryD1(), ASSETS: { fetch: async req => new Response(new URL(req.url).pathname === '/view'   // as Cloudflare serves view.html
  ? readFileSync(new URL('../public/view.html', import.meta.url), 'utf8') : '<!doctype html><title>ClipAtlas</title>app', { headers: { 'content-type': 'text/html' } }) } };
async function call(path, { method = 'GET', body, cookie = '', origin = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = BASE;
  const res = await worker.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* a page */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function account(name) {
  const r = await call('/api/register', { method: 'POST', body: { email: name.toLowerCase() + '@example.com', password: 'correct horse battery', displayName: name } });
  assert.equal(r.status, 201);
  return /clipatlas_session=([a-f0-9]{64})/.exec(r.headers.get('set-cookie'))[0];
}
const record = (id, title, extra = {}) => ({ id, key: 'k:' + id, url: 'https://www.tiktok.com/@a/video/73456789012345678' + id.slice(-2), title, category: 'Food',
  collections: ['Taiwan'], tags: [], places: [{ id: 'pl-' + id + 'aaaa', name: title, type: 'food', city: 'Taipei', country: 'Taiwan', address: '', note: '' }], notes: '', ...extra });
const library = { version: 1, records: [record('r01', 'Raohe Night Market', { notes: 'private tip', auto: { status: 'understood', transcript: 'said words', summary: 'A night market.' } }),
  record('r02', 'Tokyo ramen', { collections: ['Japan'] })], collections: ['Taiwan', 'Japan'], plan: [{ id: 'p1', recordId: 'r01', day: 1, note: 'dinner' }],
  tripTitle: 'Asia', dayCount: 5, categories: [{ name: 'Food', emoji: '🍜' }], settings: { purpose: 'travel' } };

test('sharing', async t => {
  const ann = await account('Ann'), ben = await account('Ben'), cat = await account('Cat');
  assert.equal((await call('/api/library', { method: 'PUT', cookie: ann, body: { state: library, revision: 0 } })).status, 200);

  await t.test('a view-only link shows the collection to anyone, without private details', async () => {
    const made = await call('/api/share', { method: 'POST', cookie: ann, body: { kind: 'collection', collection: 'Taiwan' } });
    assert.equal(made.status, 201);
    assert.match(made.json.link.url, /^\/s\/[a-f0-9]{32}$/);
    const again = await call('/api/share', { method: 'POST', cookie: ann, body: { kind: 'collection', collection: 'Taiwan', includeNotes: true } });
    assert.equal(again.json.link.token, made.json.link.token, 'the same collection keeps its link');
    assert.equal(again.json.link.includeNotes, true);
    await call('/api/share/' + made.json.link.token, { method: 'PATCH', cookie: ann, body: { includeNotes: false } });
    const view = await call('/api/view/' + made.json.link.token, { origin: false });
    assert.equal(view.status, 200);
    assert.equal(view.headers.get('x-robots-tag'), 'noindex');
    assert.deepEqual([view.json.view.title, view.json.view.owner, view.json.view.records.map(r => r.title)], ['Taiwan', 'Ann', ['Raohe Night Market']]);
    assert.ok(!view.text.includes('private tip') && !view.text.includes('said words') && !view.text.includes('ann@example.com'));
    const page = await call(made.json.link.url, { origin: false });
    assert.match(page.text, /<title>Taiwan · shared by Ann<\/title>/);
    const odd = await call('/api/share', { method: 'POST', cookie: ann, body: { kind: 'collection', collection: '0;url=//evil.example/x $& $\' http-equiv=refresh' } });
    const oddPage = (await call(odd.json.link.url, { origin: false })).text;
    assert.ok(oddPage.includes('content="0;url=//evil.example/x $&amp; $&#39; http-equiv=refresh · shared by Ann"') && !oddPage.includes('content="Shared from ClipAtlas"'), 'a name is only ever text in the page');
    assert.equal((await call('/api/share/' + made.json.link.token, { method: 'DELETE', cookie: ben })).status, 404, 'only its maker turns a link off');
    assert.equal((await call('/api/share/' + made.json.link.token, { method: 'DELETE', cookie: ann })).status, 200);
    assert.equal((await call('/api/view/' + made.json.link.token, { origin: false })).status, 404);
    const trip = await call('/api/share', { method: 'POST', cookie: ann, body: { kind: 'itinerary' } });
    const tripView = await call('/api/view/' + trip.json.link.token, { origin: false });
    assert.deepEqual([tripView.json.view.title, tripView.json.view.plan.map(p => p.note)], ['Asia', ['dinner']]);
  });

  let space;
  await t.test('a shared space, people by email, roles, and two people saving at once', async () => {
    const state = { version: 1, records: [library.records[0]], collections: ['Taiwan'], plan: library.plan, tripTitle: 'Taiwan', dayCount: 5 };
    const made = await call('/api/spaces', { method: 'POST', cookie: ann, body: { name: 'Taiwan', state } });
    assert.equal(made.status, 201);
    space = made.json.space;
    assert.deepEqual([space.role, space.revision, space.owner], ['owner', 1, 'Ann']);
    assert.equal((await call('/api/spaces/' + space.id, { cookie: ben })).status, 404, 'not in it: nothing to see');
    const nobody = await call('/api/spaces/' + space.id + '/people', { method: 'POST', cookie: ann, body: { email: 'nobody@example.com', role: 'edit' } });
    assert.equal(nobody.status, 404);
    assert.match(nobody.json.error, /invite link/);
    const added = await call('/api/spaces/' + space.id + '/people', { method: 'POST', cookie: ann, body: { email: 'BEN@example.com', role: 'view' } });
    assert.deepEqual([added.status, added.json.person.pending], [201, true]);
    assert.equal((await call('/api/spaces/' + space.id, { cookie: ben })).status, 404, 'someone added by email is not in until they accept');
    assert.deepEqual((await call('/api/spaces', { cookie: ben })).json.spaces.map(s => [s.name, s.pending]), [['Taiwan', true]], 'it waits in their list');
    assert.equal((await call(`/api/spaces/${space.id}/accept`, { method: 'POST', cookie: ben })).status, 200);
    const seen = await call('/api/spaces/' + space.id, { cookie: ben });
    assert.deepEqual([seen.json.space.role, seen.json.state.records[0].title], ['view', 'Raohe Night Market']);
    assert.equal((await call('/api/spaces/' + space.id, { method: 'PUT', cookie: ben, body: { state, revision: 1 } })).status, 403, 'view only');
    assert.equal((await call('/api/spaces/' + space.id + '/invites', { method: 'POST', cookie: ben, body: { role: 'edit' } })).status, 403);
    const people = await call('/api/spaces/' + space.id + '/people', { cookie: ben });
    assert.deepEqual(people.json.people.map(p => [p.name, p.role, p.email || '']), [['Ann', 'owner', ''], ['Ben', 'view', 'ben@example.com']], 'members see names; emails only their own');
    assert.equal(people.json.invites, undefined);
    const me = people.json.people.find(p => p.you);
    assert.equal((await call(`/api/spaces/${space.id}/people/${me.userId}`, { method: 'PATCH', cookie: ann, body: { role: 'edit' } })).status, 200);
    const benSave = await call('/api/spaces/' + space.id, { method: 'PUT', cookie: ben, body: { state: { ...state, tripTitle: 'Taiwan 2027' }, revision: 1 } });
    assert.deepEqual([benSave.status, benSave.json.revision], [200, 2]);
    const annSave = await call('/api/spaces/' + space.id, { method: 'PUT', cookie: ann, body: { state, revision: 1 } });
    assert.deepEqual([annSave.status, annSave.json.revision], [409, 2], 'a save from an older copy is refused, with the revision to merge from');
    assert.deepEqual((await call(`/api/spaces/${space.id}?since=2`, { cookie: ann })).json, { revision: 2, unchanged: true });
    assert.equal((await call(`/api/spaces/${space.id}?since=1`, { cookie: ann })).json.state.tripTitle, 'Taiwan 2027');
    const versions = await call(`/api/spaces/${space.id}/history`, { cookie: ann });
    assert.deepEqual(versions.json.versions.map(v => v.revision), [1], 'the version a save replaced is kept');
    assert.equal((await call(`/api/spaces/${space.id}/history`, { cookie: ben })).status, 403);
    const restored = await call(`/api/spaces/${space.id}/history`, { method: 'POST', cookie: ann, body: { revision: 1 } });
    assert.deepEqual([restored.status, restored.json.revision], [200, 3]);
    assert.equal((await call(`/api/spaces/${space.id}`, { cookie: ben })).json.state.tripTitle, 'Taiwan', 'the owner brought the earlier version back');
    const list = await call('/api/spaces', { cookie: ben });
    assert.deepEqual(list.json.spaces.map(s => [s.name, s.role, s.people]), [['Taiwan', 'edit', 2]]);
    assert.equal((await call('/api/spaces', { method: 'POST', cookie: ann, body: { name: 'x', state }, origin: false })).status, 403, 'other sites cannot post');
  });

  await t.test('invite links: join, turn off, leave, and stop sharing', async () => {
    const inv = await call(`/api/spaces/${space.id}/invites`, { method: 'POST', cookie: ann, body: { role: 'edit' } });
    assert.equal(inv.status, 201);
    const token = inv.json.invite.token;
    assert.deepEqual((await call('/api/join/' + token, { origin: false })).json.invite, { space: 'Taiwan', owner: 'Ann', role: 'edit' }, 'who it is from, before signing in');
    assert.equal((await call('/join/' + token, { origin: false })).text.includes('app'), true, 'the link opens the app');
    assert.equal((await call('/api/join/' + token, { method: 'POST' })).status, 401);
    const joined = await call('/api/join/' + token, { method: 'POST', cookie: cat });
    assert.deepEqual([joined.status, joined.json.space.id, joined.json.space.role], [200, space.id, 'edit']);
    const owners = await call(`/api/spaces/${space.id}/people`, { cookie: ann });
    assert.deepEqual(owners.json.people.map(p => [p.name, p.role]), [['Ann', 'owner'], ['Ben', 'edit'], ['Cat', 'edit']]);
    const bid = owners.json.people.find(p => p.name === 'Ben').userId;
    await call(`/api/spaces/${space.id}/people/${bid}`, { method: 'PATCH', cookie: ann, body: { role: 'view' } });
    await call('/api/join/' + token, { method: 'POST', cookie: ben });
    assert.equal((await call('/api/spaces/' + space.id, { cookie: ben })).json.space.role, 'view', 'an old invite link never changes what someone can do');
    await call(`/api/spaces/${space.id}/people/${bid}`, { method: 'PATCH', cookie: ann, body: { role: 'edit' } });
    assert.equal(owners.json.invites.length, 1);
    await call(`/api/spaces/${space.id}/invites/${token}`, { method: 'DELETE', cookie: ann });
    assert.equal((await call('/api/join/' + token, { origin: false })).status, 404);
    const cid = owners.json.people.find(p => p.name === 'Cat').userId, aid = owners.json.people.find(p => p.name === 'Ann').userId;
    assert.equal((await call(`/api/spaces/${space.id}/people/${aid}`, { method: 'DELETE', cookie: cat })).status, 400, 'nobody removes the owner');
    assert.equal((await call(`/api/spaces/${space.id}/people/${cid}`, { method: 'DELETE', cookie: cat })).status, 200, 'anyone can leave');
    assert.equal((await call('/api/spaces/' + space.id, { cookie: cat })).status, 404);
    const again = await call(`/api/spaces/${space.id}/invites`, { method: 'POST', cookie: ann, body: { role: 'edit' } });
    assert.equal((await call('/api/join/' + again.json.invite.token, { method: 'POST', cookie: cat })).status, 200, 'someone who left can come back with a link');
    assert.equal((await call(`/api/spaces/${space.id}/people/${cid}`, { method: 'DELETE', cookie: ann })).status, 200);
    const blocked = await call('/api/join/' + again.json.invite.token, { method: 'POST', cookie: cat });
    assert.deepEqual([blocked.status, /removed/.test(blocked.json.error)], [403, true], 'someone the owner removed cannot come back through a link');
    await call(`/api/spaces/${space.id}/people`, { method: 'POST', cookie: ann, body: { email: 'cat@example.com', role: 'view' } });
    assert.equal((await call(`/api/spaces/${space.id}/accept`, { method: 'POST', cookie: cat })).status, 200, '… until the owner adds them again');
    const link = await call('/api/share', { method: 'POST', cookie: ann, body: { kind: 'space', spaceId: space.id } });
    assert.equal((await call('/api/view/' + link.json.link.token, { origin: false })).json.view.title, 'Taiwan');
    assert.equal((await call('/api/spaces/' + space.id, { method: 'DELETE', cookie: ben, body: { revision: 3 } })).status, 403);
    const now = (await call(`/api/spaces/${space.id}`, { cookie: ann })).json.revision;
    const stale = await call('/api/spaces/' + space.id, { method: 'DELETE', cookie: ann, body: { revision: now - 1 } });
    assert.deepEqual([stale.status, stale.json.revision], [409, now], 'stopping sharing an older copy is refused, so a newer save is not lost');
    assert.equal((await call('/api/spaces/' + space.id, { method: 'DELETE', cookie: ann, body: { revision: now } })).status, 200);
    assert.equal((await call('/api/spaces/' + space.id, { cookie: ben })).status, 404);
    assert.equal((await call('/api/view/' + link.json.link.token, { origin: false })).status, 404, 'its view-only link goes with it');
  });
});
