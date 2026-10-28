// ClipAtlas API — Cloudflare Worker + D1, with a private library per account.
import {readTikTokLink,lookupTikTok,MESSAGES} from './tiktok.js';
import {readUnderstandRequest,understandClip,readTranscribeRequest,transcribeAudio,checkAI,MESSAGES as UNDERSTAND} from './understand.js';
import {relayGemini,geminiAllowed,GEMINI_MAX} from './gemini.js';
const encoder = new TextEncoder();
const JSON_HEADERS = {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const MAX_STATE = 2 * 1024 * 1024;
const UNDERSTAND_MAX = 5 * 1024 * 1024;
const SESSION_DAYS = 14;
const bad = (message,status=400) => response({error:message},status);
function response(data,status=200,headers={}) {return new Response(JSON.stringify(data),{status,headers:{...JSON_HEADERS,...headers}});}
const hex = a=>Array.from(new Uint8Array(a)).map(x=>x.toString(16).padStart(2,'0')).join('');
const randomHex=n=>hex(crypto.getRandomValues(new Uint8Array(n)));
async function digest(s) {return hex(await crypto.subtle.digest('SHA-256',encoder.encode(s)));}
async function hashPassword(password,salt){const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'},key,256));}
// compare without short-circuiting on first differing character
function equalHash(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0;}
function cookie(name,val,maxAge){return `${name}=${val}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;}
function originOK(req){const o=req.headers.get('origin');if(!o)return false;try{return new URL(o).origin===new URL(req.url).origin;}catch{return false;}}
async function jsonBody(req,max=MAX_STATE+1024){const len=Number(req.headers.get('content-length')||0);if(len>max)throw new Error('Request too large');const text=await req.text();if(text.length>max)throw new Error('Request too large');return JSON.parse(text);}
async function getUser(req,env){const raw=/(?:^|;\s*)clipatlas_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.get('cookie')||'');if(!raw)return null;const tokenHash=await digest(raw[1]);return env.DB.prepare('SELECT u.id,u.email,u.display_name,s.expires_at FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=?').bind(tokenHash).first().then(x=>x&&x.expires_at>Date.now()?x:null);}
function validateState(s){if(!s||typeof s!=='object'||Array.isArray(s)||s.version!==1||!Array.isArray(s.records)||!Array.isArray(s.collections)||!Array.isArray(s.plan))return false;if(s.records.length>10000||s.plan.length>20000||s.collections.length>1000)return false;if(s.categories!==undefined&&(!Array.isArray(s.categories)||s.categories.length>100))return false;if(s.settings!==undefined&&(!s.settings||typeof s.settings!=='object'||Array.isArray(s.settings)))return false;return true;}
async function handle(req,env){const url=new URL(req.url),path=url.pathname,method=req.method;
 if(!path.startsWith('/api/'))return env.ASSETS.fetch(req);
 if(method!=='GET'&&!originOK(req))return bad('Invalid origin',403);
 if(path==='/api/health'&&method==='GET')return response({ok:true});
 if(path==='/api/register'&&method==='POST'){
  if(env.REGISTRATION_ENABLED==='false')return bad('Registration is currently closed',403);
  let body;try{body=await jsonBody(req,4096);}catch{return bad('Invalid request');}
  const email=String(body.email||'').trim().toLowerCase(),password=String(body.password||''),display=String(body.displayName||'').trim();
  if(!/^[^\s@]{1,100}@[^\s@]{1,150}\.[^\s@]{2,30}$/.test(email))return bad('Enter a valid email address');
  if(password.length<12||password.length>128)return bad('Password must be 12–128 characters');
  if(display.length<1||display.length>60)return bad('Display name must be 1–60 characters');
  const ip=req.headers.get('cf-connecting-ip')||'unknown';if(await blocked(env,'register:'+ip,5,3600000))return bad('Too many attempts; try again later',429);
  const id=crypto.randomUUID(),salt=randomHex(16),hash=await hashPassword(password,salt),now=Date.now();
  try{await env.DB.prepare('INSERT INTO users(id,email,display_name,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)').bind(id,email,display,salt,hash,now).run();}catch{return bad('Could not create account (email may already be registered)',409);}
  return issueSession(id,env,{id,email,display_name:display},201);
 }
 if(path==='/api/login'&&method==='POST'){
  let body;try{body=await jsonBody(req,4096);}catch{return bad('Invalid request');}
  const email=String(body.email||'').trim().toLowerCase(),password=String(body.password||'');const ip=req.headers.get('cf-connecting-ip')||'unknown';
  if(await blocked(env,'login:'+ip,20,900000))return bad('Too many login attempts; try later',429);
  const user=await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
  if(!user||!equalHash(await hashPassword(password,user.password_salt),user.password_hash))return bad('Email or password incorrect',401);
  return issueSession(user.id,env,user);
 }
 const user=await getUser(req,env);
 if(path==='/api/me'&&method==='GET')return response({user:user?{id:user.id,email:user.email,displayName:user.display_name}:null});
 if(!user)return bad('Please sign in',401);
 if(path==='/api/logout'&&method==='POST'){
  const raw=/(?:^|;\s*)clipatlas_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.get('cookie')||'');if(raw)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(raw[1])).run();
  return response({ok:true},200,{'set-cookie':cookie('clipatlas_session','',0)});
 }
 // Authenticated public metadata lookup (src/tiktok.js). The link is cleaned and
 // must be a TikTok video, photo or short link; requests go only to TikTok hosts
 // (to follow TikTok's own redirect from a share link) and to TikTok's oEmbed.
 if(path==='/api/enrich'&&method==='POST'){
  let body;try{body=await jsonBody(req,2048);}catch{return bad('Invalid request');}
  const link=readTikTokLink(body.url);
  if(!link.ok)return response({error:MESSAGES[link.reason],status:'rejected',reason:link.reason,retryable:false,available:false},400);
  if(await blocked(env,'enrich:'+user.id,180,3600000))return response({error:'Metadata lookup limit reached; retry in an hour',status:'failed',reason:'CLIPATLAS_LIMIT',retryable:true,available:false},429);
  return response(await lookupTikTok(body.url));
 }
 // Auto-review. /api/transcribe: one piece (at most a minute) of a clip's recorded sound in, its words out.
 // /api/understand: a clip's transcript and screenshots in, its details out.
 if((path==='/api/transcribe'||path==='/api/understand')&&method==='POST'){
  if(!env.AI)return response({error:'Auto-review is not set up on this server.',status:'failed',reason:'AI_NOT_SET_UP'},503);
  let body;try{body=await jsonBody(req,UNDERSTAND_MAX);}catch{return response({error:UNDERSTAND.BAD_INPUT,status:'failed',reason:'BAD_INPUT'},400);}
  const listen=path==='/api/transcribe';
  const request=listen?readTranscribeRequest(body):readUnderstandRequest(body);
  if(!request.ok)return response({error:UNDERSTAND.BAD_INPUT,status:'failed',reason:'BAD_INPUT'},400);
  const clips=Math.max(1,Number(env.AUTO_REVIEW_DAILY_LIMIT)||300),daily=listen?clips*4:clips;
  if(await blocked(env,(listen?'transcribe:':'understand:')+user.id,daily,86400000))return response({error:`Auto-review limit reached (${clips} clips a day); continue tomorrow.`,status:'failed',reason:'CLIPATLAS_LIMIT'},429);
  const result=listen?await transcribeAudio(request.audio,env.AI):await understandClip(request,env.AI);
  return response(result,result.reason==='AI_DAILY_LIMIT'?429:200);
 }
 // Which AI services auto-review can use on this site, for this account.
 if(path==='/api/ai-config'&&method==='GET')return response({gemini:geminiAllowed(env,user.email),cloudflare:!!env.AI});
 // Auto-review through Gemini: the page's request is passed on unread (see src/gemini.js), with the key added here.
 if(path==='/api/gemini'&&method==='POST'){
  if(!geminiAllowed(env,user.email))return response({status:'failed',reason:'GEMINI_NOT_SET_UP',error:'Gemini is not set up for this account.'},503);
  const len=Number(req.headers.get('content-length')||0);
  if(len>GEMINI_MAX)return response({status:'failed',reason:'BAD_INPUT',error:'That clip is too large to send.'},413);
  const clips=Math.max(1,Number(env.AUTO_REVIEW_DAILY_LIMIT)||300);
  if(await blocked(env,'gemini:'+user.id,clips*2,86400000))return response({status:'failed',reason:'CLIPATLAS_LIMIT',error:`Auto-review limit reached (${clips} clips a day); continue tomorrow.`},429);
  const body=await req.arrayBuffer();
  if(!body.byteLength||body.byteLength>GEMINI_MAX)return response({status:'failed',reason:'BAD_INPUT',error:'That clip is too large to send.'},413);
  const out=await relayGemini(body,env);const {http,...rest}=out;
  return response(rest,out.status==='ok'?200:http||502);
 }
 // Auto-review setup check: each model once on a tiny test sound and picture, with the real error if one fails.
 if(path==='/api/aicheck'&&method==='POST'){
  if(!env.AI)return response({ok:false,steps:[{step:'setup',ok:false,detail:'setup: no Workers AI binding (deploy with the [ai] section in wrangler.toml)'}]},503);
  let body;try{body=await jsonBody(req,900000);}catch{return response({error:UNDERSTAND.BAD_INPUT},400);}
  if(await blocked(env,'aicheck:'+user.id,30,86400000))return response({error:'Setup check limit reached (30 a day).'},429);
  return response(await checkAI(body,env.AI));
 }
 if(path==='/api/library'&&method==='GET'){
  const found=await env.DB.prepare('SELECT json,revision FROM libraries WHERE user_id=?').bind(user.id).first();return response({state:found?JSON.parse(found.json):null,revision:found?.revision||0});
 }
 if(path==='/api/library'&&method==='PUT'){
  let body;try{body=await jsonBody(req);}catch{return bad('Invalid library JSON or too large');}
  if(!validateState(body.state)||!Number.isInteger(body.revision)||body.revision<0)return bad('Invalid library or revision');
  const raw=JSON.stringify(body.state);if(raw.length>MAX_STATE)return bad('Library exceeds 2 MB');
  const now=Date.now();const r=await env.DB.prepare(`INSERT INTO libraries(user_id,json,revision,updated_at) VALUES(?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json,revision=libraries.revision+1,updated_at=excluded.updated_at WHERE libraries.revision=?`).bind(user.id,raw,now,body.revision).run();
  if(!r.meta?.changes)return bad('Library changed in another tab or device. Export your unsaved copy, reload, and import it before saving.',409);
  return response({ok:true,revision:body.revision+1});
 }
 return bad('Not found',404);
}
async function blocked(env,key,max,window){const now=Date.now();const r=await env.DB.prepare('SELECT count,reset_at FROM rate_limits WHERE key=?').bind(key).first();if(r&&r.reset_at>now&&r.count>=max)return true;await env.DB.prepare('INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<? THEN ? ELSE reset_at END').bind(key,now+window,now,now,now+window).run();return false;}
async function issueSession(id,env,user,status=200){const token=randomHex(32),expiry=Date.now()+SESSION_DAYS*86400000;await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await digest(token),id,expiry,Date.now()).run();return response({user:{id,email:user.email,displayName:user.display_name}},status,{'set-cookie':cookie('clipatlas_session',token,SESSION_DAYS*86400)});}
export default {async fetch(req,env){try{return await handle(req,env);}catch(err){console.error('ClipAtlas API error',err?.message);return bad('Unexpected server error',500);}}};
