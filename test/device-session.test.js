const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readDeviceSession,adoptDeviceSession} = require('../src/main/device-session');
const token = 'valid.token_abc-123~456';
function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'os-session-'));
 const dataDir=path.join(root,'browser');fs.mkdirSync(dataDir);
 fs.writeFileSync(path.join(root,'generation'),'era-1\n',{mode:0o600});
 const cookie={domain:'.southbag.cc',name:'__Secure-better-auth.session_token',value:'cookie-secret',path:'/',secure:true,httpOnly:true};
 const value={generation:'era-1',subject:'user-1',accessToken:token,expiresAt:Date.now()+3600000,cookies:[cookie]};
 const write=(v=value)=>fs.writeFileSync(path.join(root,'browser-handoff.json'),JSON.stringify(v),{mode:0o600});write();
 return {root,dataDir,value,write,options:{dataDir,generation:'era-1'}};
}
test('reads only a private current generation and the scoped Identity cookie',()=>{
 const f=fixture();try{
  const session=readDeviceSession(f.options);assert.equal(session.subject,'user-1');
  assert.equal(session.cookies[0].url,'https://identity.southbag.cc/');
  for(const patch of [{generation:'old'},{expiresAt:0},{expiresAt:Date.now()+90000000},{accessToken:'bad'},{cookies:[]},{cookies:[{...f.value.cookies[0],domain:'.example.com'}]},{cookies:[{...f.value.cookies[0],name:'other'}]},{cookies:[{...f.value.cookies[0],httpOnly:false}]}]) {
   f.write({...f.value,...patch});assert.throws(()=>readDeviceSession(f.options));
  }
  f.write();fs.chmodSync(path.join(f.root,'browser-handoff.json'),0o644);assert.throws(()=>readDeviceSession(f.options),/not private/);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('rejects symlink handoffs and retired generation',()=>{
 const f=fixture();try{
  fs.writeFileSync(path.join(f.root,'generation'),'era-2');assert.throws(()=>readDeviceSession(f.options),/retired/);
  fs.writeFileSync(path.join(f.root,'generation'),'era-1');
  fs.renameSync(path.join(f.root,'browser-handoff.json'),path.join(f.root,'other'));
  fs.symlinkSync('other',path.join(f.root,'browser-handoff.json'));assert.throws(()=>readDeviceSession(f.options));
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('adoption independently verifies userinfo before installing cookies; no second OAuth',async()=>{
 const f=fixture();try{
  const seen=[];const auth={session:null,async fetchUser(){seen.push('userinfo');assert.equal(this.session.accessToken,token);return {sub:'user-1'};}};
  const browsing={cookies:{async set(c){seen.push('cookie');assert.equal(c.domain,'.southbag.cc');},async flushStore(){seen.push('flush');},async remove(){seen.push('remove');}}};
  assert.equal((await adoptDeviceSession({...f.options,auth,browsing})).sub,'user-1');
  assert.deepEqual(seen,['userinfo','cookie','flush']);assert.equal(auth.session.deviceGeneration,'era-1');
  seen.length=0;auth.fetchUser=async()=>({sub:'different'});
  await assert.rejects(adoptDeviceSession({...f.options,auth,browsing}),/account changed/);assert.equal(auth.session,null);assert.ok(!seen.includes('cookie'));
  auth.fetchUser=async()=>{fs.writeFileSync(path.join(f.root,'generation'),'retired');return {sub:'user-1'};};
  await assert.rejects(adoptDeviceSession({...f.options,auth,browsing}),/retired/);assert.equal(auth.session,null);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
