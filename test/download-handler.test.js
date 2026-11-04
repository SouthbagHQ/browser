const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/main/main.js'), 'utf8');
const start = source.indexOf("  ses.on('will-download',");
const end = source.indexOf('\n  ses.setPermissionRequestHandler', start);
const handler = source.slice(start, end);
function run(os, contents) {
 let listener, canceled = 0, tracked = 0; const dialogs=[];
 const ses={on: (_name, cb) => { listener=cb; }};
 new Function('ses','runningOnSouthbagOS','BrowserWindow','tabsByContents','dialog','trackDownload','isPrivate',handler)(ses,()=>os,{fromWebContents: c=>{assert.ok(c);return undefined;}},new Map(),{showMessageBox:(...a)=>{dialogs.push(a);return Promise.resolve();}},()=>{tracked++;},false);
 listener({}, {cancel(){canceled++;}}, contents);
 return {canceled,tracked,dialogs};
}
test('OS download with no source contents cancels without exception',()=>{const r=run(true,null);assert.equal(r.canceled,1);assert.equal(r.tracked,0);assert.equal(r.dialogs[0][1].message,'Local downloads are disabled on Southbag OS');});
test('OS contents download also cancels',()=>assert.equal(run(true,{id:123}).canceled,1));
test('standalone keeps its normal download manager',()=>{const r=run(false,null);assert.equal(r.canceled,0);assert.equal(r.tracked,1);assert.equal(r.dialogs.length,0);});
