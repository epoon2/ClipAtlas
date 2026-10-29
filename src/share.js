// Sharing, for src/worker.js:
//  - Shared spaces: a collection (with its own itinerary and research) saved as a library of its own,
//    which its owner and the people they add open and edit together. Roles: owner, edit, view.
//  - People are added by the email of their ClipAtlas account, or join through an invite link.
//  - View-only links: anyone with the link sees a collection, an itinerary or a shared space, read-only,
//    with only what core.js shareView() lets out (no transcripts or page text; notes only if asked).
// Every space route checks the account's role in that space before reading or writing it.
import '../public/core.js';

const C = globalThis.ClipAtlasCore;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '', items INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS space_members (space_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, added_at INTEGER NOT NULL, accepted INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (space_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS space_removed (space_id TEXT NOT NULL, user_id TEXT NOT NULL, removed_at INTEGER NOT NULL, PRIMARY KEY (space_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS space_history (space_id TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL, saved_at INTEGER NOT NULL, saved_by TEXT NOT NULL DEFAULT '', items INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (space_id, revision))`,
  `CREATE INDEX IF NOT EXISTS space_members_by_user ON space_members(user_id)`,
  `CREATE TABLE IF NOT EXISTS space_invites (token TEXT PRIMARY KEY, space_id TEXT NOT NULL, role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS space_invites_by_space ON space_invites(space_id)`,
  `CREATE TABLE IF NOT EXISTS share_links (token TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, space_id TEXT NOT NULL DEFAULT '', collection TEXT NOT NULL DEFAULT '', include_notes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS share_links_by_owner ON share_links(owner_id)`,
  `CREATE INDEX IF NOT EXISTS share_links_by_space ON share_links(space_id)`
];
export const SHARING_SCHEMA = SCHEMA;
// The tables are made the first time sharing is used (also in migrations/0002_sharing.sql), so a
// deploy needs no separate database step.
const made = new WeakMap();
export function sharingReady(env) {
  if (!made.has(env.DB)) made.set(env.DB, env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(err => { made.delete(env.DB); throw err; }));
  return made.get(env.DB);
}

const ROLES = ['edit', 'view'];
const TOKEN = /^[a-f0-9]{32}$/, SPACE_ID = /^sp[a-f0-9]{24}$/;
const LIMITS = { spacesOwned: 50, people: 50, invites: 10, links: 100, history: 10 };
// An earlier version is kept when the last kept one is this old, or when a save takes out many items.
const HISTORY_EVERY = 30 * 60 * 1000;
const itemCount = state => Array.isArray(state && state.records) ? state.records.length : 0;
const GONE = 'This shared space was removed, or you are no longer in it.';
const cleanName = v => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const roleOf = v => ROLES.includes(v) ? v : '';
const iso = ms => ms ? new Date(Number(ms)).toISOString() : '';

// Your place in a space: only once you have accepted (someone added by email accepts first).
async function member(env, spaceId, userId, { pending = false } = {}) {
  if (!SPACE_ID.test(spaceId)) return null;
  return env.DB.prepare('SELECT s.id,s.name,s.owner_id,s.revision,s.updated_at,s.updated_by,s.items,m.role,m.accepted,u.display_name AS owner_name FROM spaces s JOIN space_members m ON m.space_id=s.id JOIN users u ON u.id=s.owner_id WHERE s.id=? AND m.user_id=?' + (pending ? '' : ' AND m.accepted=1'))
    .bind(spaceId, userId).first();
}
const spaceInfo = (m, people) => ({ id: m.id, name: m.name, role: m.role, owner: m.owner_name, ownerIsYou: m.role === 'owner',
  revision: m.revision, updatedAt: iso(m.updated_at), ...(m.accepted === 0 ? { pending: true } : {}), ...(people === undefined ? {} : { people }) });

/** The sharing routes. Returns a Response, or null when the path is not one of them. */
export async function sharingRoute(req, env, user, h) {
  const { path, method, response, bad, jsonBody, validateState, randomHex, blocked, MAX_STATE } = h;
  if (!/^\/api\/(spaces|share|join|view)(\/|$)/.test(path)) return null;
  await sharingReady(env);
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const parts = path.split('/').slice(2);   // e.g. ['spaces', id, 'people', userId]

  // ---- public: what a view-only link shows, and who an invite link is from
  if (parts[0] === 'view' && method === 'GET' && parts.length === 2) {
    if (!TOKEN.test(parts[1])) return bad('This link was turned off or does not exist.', 404);
    if (await blocked(env, 'view:' + ip, 600, 3600000)) return bad('Too many views from here; try again in a while.', 429);
    const view = await buildView(env, parts[1]);
    if (!view) return bad('This link was turned off or does not exist.', 404);
    return response({ view }, 200, { 'x-robots-tag': 'noindex' });
  }
  if (parts[0] === 'join' && parts.length === 2 && method === 'GET') {
    if (!TOKEN.test(parts[1])) return bad('This invite link was turned off or does not exist.', 404);
    if (await blocked(env, 'joininfo:' + ip, 120, 3600000)) return bad('Too many tries; try again later.', 429);
    const inv = await invite(env, parts[1]);
    if (!inv) return bad('This invite link was turned off or does not exist.', 404);
    return response({ invite: { space: inv.name, owner: inv.owner_name, role: inv.role } });
  }
  if (!user) return bad('Please sign in', 401);

  // ---- joining through an invite link
  if (parts[0] === 'join' && parts.length === 2 && method === 'POST') {
    const inv = TOKEN.test(parts[1]) && await invite(env, parts[1]);
    if (!inv) return bad('This invite link was turned off or does not exist.', 404);
    const now = Date.now(), had = await member(env, inv.space_id, user.id, { pending: true });
    if (!had && await env.DB.prepare('SELECT 1 AS x FROM space_removed WHERE space_id=? AND user_id=?').bind(inv.space_id, user.id).first())
      return bad('You were removed from this shared space. Ask its owner to add you again.', 403);
    if (!had) {
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM space_members WHERE space_id=?').bind(inv.space_id).first();
      if ((count?.n || 0) >= LIMITS.people) return bad('This shared space is full (' + LIMITS.people + ' people).', 403);
      await env.DB.prepare('INSERT INTO space_members(space_id,user_id,role,added_at,accepted) VALUES(?,?,?,?,1)').bind(inv.space_id, user.id, inv.role, now).run();
    } else if (!had.accepted) await env.DB.prepare('UPDATE space_members SET accepted=1 WHERE space_id=? AND user_id=?').bind(inv.space_id, user.id).run();
    // Someone already in the space keeps what they can do: an old invite link never changes it.
    return response({ space: spaceInfo({ ...(await member(env, inv.space_id, user.id)) }) });
  }

  // ---- view-only links you made
  if (parts[0] === 'share') {
    if (parts.length === 1 && method === 'GET') {
      const rows = await env.DB.prepare('SELECT token,kind,space_id,collection,include_notes,created_at FROM share_links WHERE owner_id=? ORDER BY created_at').bind(user.id).all();
      return response({ links: (rows.results || []).map(linkOut) });
    }
    if (parts.length === 1 && method === 'POST') {
      let body; try { body = await jsonBody(req, 4096); } catch { return bad('Invalid request'); }
      const kind = C.SHARE_KINDS.includes(body.kind) ? body.kind : '', includeNotes = body.includeNotes ? 1 : 0;
      const collection = kind === 'collection' ? String(body.collection ?? '').trim().slice(0, 80) : '';
      const spaceId = kind === 'space' ? String(body.spaceId || '') : '';
      if (!kind || (kind === 'collection' && !collection)) return bad('Say what to share');
      if (kind === 'space') {
        const m = await member(env, spaceId, user.id);
        if (!m) return bad(GONE, 404);
        if (m.role !== 'owner') return bad('Only the owner of a shared space makes its view-only link.', 403);
      }
      const same = await env.DB.prepare('SELECT token FROM share_links WHERE owner_id=? AND kind=? AND space_id=? AND collection=?').bind(user.id, kind, spaceId, collection).first();
      if (same) {
        await env.DB.prepare('UPDATE share_links SET include_notes=? WHERE token=?').bind(includeNotes, same.token).run();
        return response({ link: linkOut({ token: same.token, kind, space_id: spaceId, collection, include_notes: includeNotes }) });
      }
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM share_links WHERE owner_id=?').bind(user.id).first();
      if ((count?.n || 0) >= LIMITS.links) return bad('You have ' + LIMITS.links + ' view-only links. Turn some off first.', 403);
      const token = randomHex(16), now = Date.now();
      await env.DB.prepare('INSERT INTO share_links(token,owner_id,kind,space_id,collection,include_notes,created_at) VALUES(?,?,?,?,?,?,?)')
        .bind(token, user.id, kind, spaceId, collection, includeNotes, now).run();
      return response({ link: linkOut({ token, kind, space_id: spaceId, collection, include_notes: includeNotes, created_at: now }) }, 201);
    }
    if (parts.length === 2 && TOKEN.test(parts[1]) && (method === 'PATCH' || method === 'DELETE')) {
      const found = await env.DB.prepare('SELECT token,kind,space_id,collection,include_notes,created_at FROM share_links WHERE token=? AND owner_id=?').bind(parts[1], user.id).first();
      if (!found) return bad('That link is already off.', 404);
      if (method === 'DELETE') { await env.DB.prepare('DELETE FROM share_links WHERE token=?').bind(found.token).run(); return response({ ok: true }); }
      let body; try { body = await jsonBody(req, 1024); } catch { return bad('Invalid request'); }
      const includeNotes = body.includeNotes ? 1 : 0;
      await env.DB.prepare('UPDATE share_links SET include_notes=? WHERE token=?').bind(includeNotes, found.token).run();
      return response({ link: linkOut({ ...found, include_notes: includeNotes }) });
    }
    return bad('Not found', 404);
  }

  // ---- shared spaces
  if (parts[0] !== 'spaces') return bad('Not found', 404);
  if (parts.length === 1 && method === 'GET') {
    const rows = await env.DB.prepare(`SELECT s.id,s.name,s.revision,s.updated_at,m.role,m.accepted,u.display_name AS owner_name,
        (SELECT COUNT(*) FROM space_members x WHERE x.space_id=s.id AND x.accepted=1) AS people
      FROM space_members m JOIN spaces s ON s.id=m.space_id JOIN users u ON u.id=s.owner_id WHERE m.user_id=? ORDER BY s.updated_at DESC LIMIT 200`).bind(user.id).all();
    return response({ spaces: (rows.results || []).map(r => spaceInfo(r, r.people)) });
  }
  if (parts.length === 1 && method === 'POST') {
    let body; try { body = await jsonBody(req); } catch { return bad('Invalid request or too large'); }
    const name = cleanName(body.name);
    if (!name) return bad('Give the shared space a name');
    if (!validateState(body.state)) return bad('Invalid space');
    const raw = JSON.stringify(body.state); if (raw.length > MAX_STATE) return bad('A shared space can hold at most 2 MB');
    const owned = await env.DB.prepare("SELECT COUNT(*) AS n FROM space_members WHERE user_id=? AND role='owner'").bind(user.id).first();
    if ((owned?.n || 0) >= LIMITS.spacesOwned) return bad('You own ' + LIMITS.spacesOwned + ' shared spaces already.', 403);
    if (await blocked(env, 'space-new:' + user.id, 30, 86400000)) return bad('Too many shared spaces made today; try tomorrow.', 429);
    const id = 'sp' + randomHex(12), now = Date.now(), from = String(body.fromCollection ?? '').trim().slice(0, 80);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO spaces(id,owner_id,name,json,revision,created_at,updated_at,updated_by,items) VALUES(?,?,?,?,1,?,?,?,?)').bind(id, user.id, name, raw, now, now, user.id, itemCount(body.state)),
      env.DB.prepare("INSERT INTO space_members(space_id,user_id,role,added_at,accepted) VALUES(?,?,'owner',?,1)").bind(id, user.id, now),
      // The collection's view-only link keeps working, now showing the shared space.
      env.DB.prepare("UPDATE share_links SET kind='space',space_id=?,collection='' WHERE owner_id=? AND kind='collection' AND collection=?").bind(id, user.id, from)]);
    return response({ space: spaceInfo(await member(env, id, user.id), 1) }, 201);
  }
  if (parts.length === 3 && parts[2] === 'accept' && method === 'POST') {
    const p = await member(env, parts[1], user.id, { pending: true });
    if (!p) return bad(GONE, 404);
    if (!p.accepted) await env.DB.prepare('UPDATE space_members SET accepted=1 WHERE space_id=? AND user_id=?').bind(p.id, user.id).run();
    return response({ space: spaceInfo({ ...p, accepted: 1 }) });
  }
  if (parts.length === 4 && parts[2] === 'people' && parts[3] === user.id && method === 'DELETE') {   // decline (or leave)
    const p = await member(env, parts[1], user.id, { pending: true });
    if (p && !p.accepted) { await env.DB.prepare('DELETE FROM space_members WHERE space_id=? AND user_id=?').bind(p.id, user.id).run(); return response({ ok: true }); }
  }
  const m = parts[1] ? await member(env, parts[1], user.id) : null;
  if (!m) return bad(GONE, 404);
  const owner = m.role === 'owner', id = m.id;
  if (parts.length === 2) {
    if (method === 'GET') {
      const since = url(req).searchParams.get('since');
      if (since !== null && Number(since) === m.revision) return response({ revision: m.revision, unchanged: true });
      const row = await env.DB.prepare('SELECT json FROM spaces WHERE id=?').bind(id).first();
      return response({ space: spaceInfo(m), state: JSON.parse(row.json), revision: m.revision });
    }
    if (method === 'PUT') {
      if (m.role === 'view') return bad('You can view this space but not edit it.', 403);
      let body; try { body = await jsonBody(req); } catch { return bad('Invalid space JSON or too large'); }
      if (!validateState(body.state) || !Number.isInteger(body.revision)) return bad('Invalid space or revision');
      const raw = JSON.stringify(body.state); if (raw.length > MAX_STATE) return bad('A shared space can hold at most 2 MB');
      const now = Date.now(), items = itemCount(body.state);
      // Keep the version this save replaces, now and then and whenever a save takes out many items, so the
      // owner can bring it back (only the newest few are kept).
      const last = await env.DB.prepare('SELECT MAX(saved_at) AS at FROM space_history WHERE space_id=?').bind(id).first();
      if (body.revision === m.revision && (!last?.at || now - last.at > HISTORY_EVERY || (m.items - items >= 5 && items < m.items * 0.7))) await keepVersion(env, id, now);
      const r = await env.DB.prepare('UPDATE spaces SET json=?,revision=revision+1,updated_at=?,updated_by=?,items=? WHERE id=? AND revision=?').bind(raw, now, user.id, items, id, body.revision).run();
      if (!r.meta?.changes) {
        const now = await env.DB.prepare('SELECT revision FROM spaces WHERE id=?').bind(id).first();
        return response({ error: 'Someone else saved this space just now.', revision: now?.revision || 0 }, 409);
      }
      return response({ ok: true, revision: body.revision + 1 });
    }
    if (method === 'PATCH') {
      if (!owner) return bad('Only the owner renames a shared space.', 403);
      let body; try { body = await jsonBody(req, 1024); } catch { return bad('Invalid request'); }
      const name = cleanName(body.name); if (!name) return bad('Give the shared space a name');
      await env.DB.prepare('UPDATE spaces SET name=? WHERE id=?').bind(name, id).run();
      return response({ ok: true, name });
    }
    if (method === 'DELETE') {
      if (!owner) return bad('Only the owner stops sharing a space. To leave it, remove yourself.', 403);
      let body; try { body = await jsonBody(req, 1024); } catch { return bad('Invalid request'); }
      if (!Number.isInteger(body.revision)) return bad('Say which version was moved back');
      // Only the version the owner moved back into their library: a save that came in since is not lost.
      const gone = await env.DB.prepare('DELETE FROM spaces WHERE id=? AND revision=?').bind(id, body.revision).run();
      if (!gone.meta?.changes) return response({ error: 'Someone saved this space just now.', revision: m.revision }, 409);
      await env.DB.batch(['DELETE FROM space_members WHERE space_id=?', 'DELETE FROM space_invites WHERE space_id=?', 'DELETE FROM share_links WHERE space_id=?',
        'DELETE FROM space_removed WHERE space_id=?', 'DELETE FROM space_history WHERE space_id=?'].map(sql => env.DB.prepare(sql).bind(id)));
      return response({ ok: true });
    }
  }
  if (parts[2] === 'history') {
    if (!owner) return bad('Only the owner brings back an earlier version.', 403);
    if (parts.length === 3 && method === 'GET') {
      const rows = await env.DB.prepare('SELECT h.revision,h.saved_at,h.items,u.display_name FROM space_history h LEFT JOIN users u ON u.id=h.saved_by WHERE h.space_id=? ORDER BY h.revision DESC').bind(id).all();
      return response({ versions: (rows.results || []).map(v => ({ revision: v.revision, savedAt: iso(v.saved_at), by: v.display_name || '', items: v.items })) });
    }
    if (parts.length === 3 && method === 'POST') {
      let body; try { body = await jsonBody(req, 1024); } catch { return bad('Invalid request'); }
      const old = await env.DB.prepare('SELECT revision,items FROM space_history WHERE space_id=? AND revision=?').bind(id, Number(body.revision)).first();
      if (!old) return bad('That version is no longer kept.', 404);
      const now = Date.now();
      await keepVersion(env, id, now);   // what is there now can be brought back too
      await env.DB.prepare('UPDATE spaces SET json=(SELECT json FROM space_history WHERE space_id=? AND revision=?),items=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=?')
        .bind(id, old.revision, old.items, now, user.id, id).run();
      const after = await env.DB.prepare('SELECT revision FROM spaces WHERE id=?').bind(id).first();
      return response({ ok: true, revision: after.revision });
    }
  }
  if (parts[2] === 'people') {
    if (parts.length === 3 && method === 'GET') {
      const rows = await env.DB.prepare('SELECT m.user_id,m.role,m.added_at,m.accepted,u.display_name,u.email FROM space_members m JOIN users u ON u.id=m.user_id WHERE m.space_id=? ORDER BY m.added_at').bind(id).all();
      const people = (rows.results || []).filter(p => p.accepted || owner).map(p => ({ userId: p.user_id, name: p.display_name, role: p.role, you: p.user_id === user.id, ...(p.accepted ? {} : { pending: true }),
        ...(owner || p.user_id === user.id ? { email: p.email } : {}) }));
      const out = { space: spaceInfo(m, people.filter(p => !p.pending).length), people };
      if (owner) {
        const inv = await env.DB.prepare('SELECT token,role,created_at FROM space_invites WHERE space_id=? ORDER BY created_at').bind(id).all();
        const links = await env.DB.prepare("SELECT token,kind,space_id,collection,include_notes,created_at FROM share_links WHERE space_id=? AND kind='space'").bind(id).all();
        out.invites = (inv.results || []).map(i => ({ token: i.token, role: i.role, url: '/join/' + i.token, createdAt: iso(i.created_at) }));
        out.links = (links.results || []).map(linkOut);
      }
      return response(out);
    }
    if (parts.length === 3 && method === 'POST') {
      if (!owner) return bad('Only the owner adds people.', 403);
      let body; try { body = await jsonBody(req, 1024); } catch { return bad('Invalid request'); }
      const email = String(body.email || '').trim().toLowerCase(), role = roleOf(body.role);
      if (!email || !role) return bad('Give their email and Can edit or Can view');
      if (await blocked(env, 'addperson:' + user.id, 40, 86400000)) return bad('Too many people added today; send an invite link instead.', 429);
      const who = await env.DB.prepare('SELECT id,display_name,email FROM users WHERE email=?').bind(email).first();
      if (!who) return bad('No ClipAtlas account uses that email. Send them an invite link instead: it lets them make an account and join.', 404);
      if (who.id === user.id) return bad('That is your own account.');
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM space_members WHERE space_id=?').bind(id).first();
      const already = await env.DB.prepare('SELECT role FROM space_members WHERE space_id=? AND user_id=?').bind(id, who.id).first();
      if (!already && (count?.n || 0) >= LIMITS.people) return bad('A shared space holds at most ' + LIMITS.people + ' people.', 403);
      // Someone added by email sees it in their sidebar and accepts it before they are in.
      if (already) await env.DB.prepare('UPDATE space_members SET role=? WHERE space_id=? AND user_id=?').bind(role, id, who.id).run();
      else await env.DB.prepare('INSERT INTO space_members(space_id,user_id,role,added_at,accepted) VALUES(?,?,?,?,0)').bind(id, who.id, role, Date.now()).run();
      await env.DB.prepare('DELETE FROM space_removed WHERE space_id=? AND user_id=?').bind(id, who.id).run();
      return response({ person: { userId: who.id, name: who.display_name, email: who.email, role, ...(already ? {} : { pending: true }) } }, already ? 200 : 201);
    }
    if (parts.length === 4 && (method === 'PATCH' || method === 'DELETE')) {
      const target = parts[3];
      const row = await env.DB.prepare('SELECT role FROM space_members WHERE space_id=? AND user_id=?').bind(id, target).first();
      if (!row) return bad('They are not in this space.', 404);
      if (row.role === 'owner') return bad(target === user.id ? 'You own this space: stop sharing it instead.' : 'The owner stays.', 400);
      if (method === 'DELETE') {
        if (!owner && target !== user.id) return bad('Only the owner removes people.', 403);
        await env.DB.prepare('DELETE FROM space_members WHERE space_id=? AND user_id=?').bind(id, target).run();
        // Someone the owner removed cannot come back through an invite link (the owner can add them again).
        if (target !== user.id) await env.DB.prepare('INSERT OR REPLACE INTO space_removed(space_id,user_id,removed_at) VALUES(?,?,?)').bind(id, target, Date.now()).run();
        return response({ ok: true });
      }
      if (!owner) return bad('Only the owner changes what people can do.', 403);
      let body; try { body = await jsonBody(req, 1024); } catch { return bad('Invalid request'); }
      const role = roleOf(body.role); if (!role) return bad('Can edit or Can view');
      await env.DB.prepare('UPDATE space_members SET role=? WHERE space_id=? AND user_id=?').bind(role, id, target).run();
      return response({ ok: true, role });
    }
  }
  if (parts[2] === 'invites') {
    if (!owner) return bad('Only the owner makes invite links.', 403);
    if (parts.length === 3 && method === 'POST') {
      let body; try { body = await jsonBody(req, 1024); } catch { return bad('Invalid request'); }
      const role = roleOf(body.role); if (!role) return bad('Can edit or Can view');
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM space_invites WHERE space_id=?').bind(id).first();
      if ((count?.n || 0) >= LIMITS.invites) return bad('This space has ' + LIMITS.invites + ' invite links. Turn one off first.', 403);
      const token = randomHex(16), now = Date.now();
      await env.DB.prepare('INSERT INTO space_invites(token,space_id,role,created_by,created_at) VALUES(?,?,?,?,?)').bind(token, id, role, user.id, now).run();
      return response({ invite: { token, role, url: '/join/' + token, createdAt: iso(now) } }, 201);
    }
    if (parts.length === 4 && method === 'DELETE' && TOKEN.test(parts[3])) {
      await env.DB.prepare('DELETE FROM space_invites WHERE token=? AND space_id=?').bind(parts[3], id).run();
      return response({ ok: true });
    }
  }
  return bad('Not found', 404);
}

const url = req => new URL(req.url);
async function keepVersion(env, id, now) {
  await env.DB.prepare('INSERT OR IGNORE INTO space_history(space_id,revision,json,saved_at,saved_by,items) SELECT id,revision,json,?,updated_by,items FROM spaces WHERE id=?').bind(now, id).run();
  await env.DB.prepare('DELETE FROM space_history WHERE space_id=? AND revision NOT IN (SELECT revision FROM space_history WHERE space_id=? ORDER BY revision DESC LIMIT ?)').bind(id, id, LIMITS.history).run();
}
const linkOut = l => ({ token: l.token, url: '/s/' + l.token, kind: l.kind, collection: l.collection || '', spaceId: l.space_id || '',
  includeNotes: !!l.include_notes, createdAt: iso(l.created_at) });
function invite(env, token) {
  return env.DB.prepare('SELECT i.space_id,i.role,s.name,u.display_name AS owner_name FROM space_invites i JOIN spaces s ON s.id=i.space_id JOIN users u ON u.id=s.owner_id WHERE i.token=?').bind(token).first();
}

/** The view-only page's content for a link, or null when the link is off. Read live, so it always shows
    the latest saved version. */
export async function buildView(env, token) {
  if (!TOKEN.test(token)) return null;
  await sharingReady(env);
  const link = await env.DB.prepare('SELECT l.*,u.display_name FROM share_links l JOIN users u ON u.id=l.owner_id WHERE l.token=?').bind(token).first();
  if (!link) return null;
  let state, title = '', updated = 0;
  if (link.kind === 'space') {
    const row = await env.DB.prepare('SELECT json,name,updated_at FROM spaces WHERE id=? AND owner_id=?').bind(link.space_id, link.owner_id).first();
    if (!row) return null;
    state = JSON.parse(row.json); title = row.name; updated = row.updated_at;
  } else {
    const row = await env.DB.prepare('SELECT json,updated_at FROM libraries WHERE user_id=?').bind(link.owner_id).first();
    state = row ? JSON.parse(row.json) : { records: [], plan: [] }; updated = row?.updated_at || 0;
  }
  return C.shareView(state, { kind: link.kind, collection: link.collection, includeNotes: !!link.include_notes,
    owner: link.display_name, title, updatedAt: iso(updated) });
}

/** The page at /s/<token>: view.html, with the link's title for link previews. */
export async function viewPage(req, env, token) {
  // Cloudflare serves view.html at /view (and redirects /view.html there); the tests' file server has /view.html.
  let page = await env.ASSETS.fetch(new Request(new URL('/view', req.url)));
  if (!page.ok) page = await env.ASSETS.fetch(new Request(new URL('/view.html', req.url)));
  let text = await page.text(), title = 'Shared from ClipAtlas', about = 'A view-only page from ClipAtlas.';
  try {
    if (TOKEN.test(token)) {
      await sharingReady(env);
      const l = await env.DB.prepare('SELECT l.kind,l.collection,u.display_name,s.name FROM share_links l JOIN users u ON u.id=l.owner_id LEFT JOIN spaces s ON s.id=l.space_id WHERE l.token=?').bind(token).first();
      if (l) {
        title = (l.kind === 'space' ? l.name : l.kind === 'collection' ? l.collection : 'Trip itinerary') + ' · shared by ' + l.display_name;
        about = l.kind === 'collection' ? 'Saved places, research and links, view-only on ClipAtlas.' : 'An itinerary with its places and links, view-only on ClipAtlas.';
      }
    }
  } catch { /* the page still loads and says what it can */ }
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  // Replaced with functions, so a name with $& or $' in it stays plain text.
  text = text.replace('<title>Shared from ClipAtlas</title>', () => `<title>${esc(title)}</title>`)
    .replaceAll('content="Shared from ClipAtlas"', () => `content="${esc(title)}"`).replaceAll('content="A view-only page from ClipAtlas."', () => `content="${esc(about)}"`);
  return new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
}
