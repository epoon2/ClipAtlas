// Account/session bridge. Loaded before app.js; never reads another user's library.
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
 return {me,login,register,logout,load,save,get user(){return user;}};
})();
