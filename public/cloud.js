// Account/session bridge. Loaded before app.js. Reads only your own library and the shared spaces you are in.
window.ClipAtlasCloud = (() => {
 let revision=0, user=null;
 async function request(path,options={}) {
  const res=await fetch('/api/'+path,{credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},...options});
  const json=await res.json().catch(()=>({error:'Unexpected response'}));
  if(!res.ok) {const err=new Error(json.error||'Server error');err.status=res.status;throw err;}
  return json;
 }
 async function me(){const r=await request('me');user=r.user;return user;}
 async function login(email,password){const r=await request('login',{method:'POST',body:JSON.stringify({email,password})});user=r.user;return user;}
 async function register(email,password,displayName){const r=await request('register',{method:'POST',body:JSON.stringify({email,password,displayName})});user=r.user;return user;}
 async function logout(){await request('logout',{method:'POST',body:'{}'});user=null;revision=0;}
 async function load(){const r=await request('library');revision=r.revision;return r.state;}
 async function save(state){const r=await request('library',{method:'PUT',body:JSON.stringify({state,revision})});revision=r.revision;return r;}
 // Sharing (src/share.js): shared spaces, their people and invite links, and view-only links.
 const send=(path,method,body)=>request(path,{method,body:body===undefined?'{}':JSON.stringify(body)});
 const sharing={
  spaces:()=>request('spaces'),
  createSpace:(name,state,fromCollection)=>send('spaces','POST',{name,state,fromCollection}),
  acceptSpace:id=>send('spaces/'+encodeURIComponent(id)+'/accept','POST'),
  loadSpace:(id,since)=>request('spaces/'+encodeURIComponent(id)+(since===undefined?'':'?since='+since)),
  saveSpace:(id,state,revision)=>send('spaces/'+encodeURIComponent(id),'PUT',{state,revision}),
  renameSpace:(id,name)=>send('spaces/'+encodeURIComponent(id),'PATCH',{name}),
  deleteSpace:(id,revision)=>send('spaces/'+encodeURIComponent(id),'DELETE',{revision}),
  history:id=>request('spaces/'+encodeURIComponent(id)+'/history'),
  restoreVersion:(id,revision)=>send('spaces/'+encodeURIComponent(id)+'/history','POST',{revision}),
  people:id=>request('spaces/'+encodeURIComponent(id)+'/people'),
  addPerson:(id,email,role)=>send('spaces/'+encodeURIComponent(id)+'/people','POST',{email,role}),
  setRole:(id,userId,role)=>send('spaces/'+encodeURIComponent(id)+'/people/'+encodeURIComponent(userId),'PATCH',{role}),
  removePerson:(id,userId)=>send('spaces/'+encodeURIComponent(id)+'/people/'+encodeURIComponent(userId),'DELETE'),
  invite:(id,role)=>send('spaces/'+encodeURIComponent(id)+'/invites','POST',{role}),
  dropInvite:(id,token)=>send('spaces/'+encodeURIComponent(id)+'/invites/'+encodeURIComponent(token),'DELETE'),
  joinInfo:token=>request('join/'+encodeURIComponent(token)),
  join:token=>send('join/'+encodeURIComponent(token),'POST'),
  links:()=>request('share'),
  makeLink:body=>send('share','POST',body),
  setLinkNotes:(token,includeNotes)=>send('share/'+encodeURIComponent(token),'PATCH',{includeNotes}),
  dropLink:token=>send('share/'+encodeURIComponent(token),'DELETE')
 };
 return {me,login,register,logout,load,save,...sharing,get user(){return user;}};
})();
