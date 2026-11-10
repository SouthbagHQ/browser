const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../src/main/shell.js'),'utf8');
const start=src.indexOf('    const showLoadedWindow =');
const end=src.indexOf('\n\n    // The chrome is a local app',start);
const setup=src.slice(start,end);
function harness(){const handlers={};let visible=false,destroyed=false,shows=0;const w={isDestroyed:()=>destroyed,isVisible:()=>visible,show(){visible=true;shows++;},once:(name,cb)=>handlers[name]=cb,loadFile(){assert.ok(handlers['ready-to-show']);assert.ok(handlers['did-finish-load']);}};new Function('path','__dirname',setup).call({window:w,chrome:w},path,__dirname);return {handlers,get shows(){return shows;},destroy(){destroyed=true;}};}
test('loaded chrome becomes visible even without ready-to-show',()=>{const h=harness();h.handlers['did-finish-load']();assert.equal(h.shows,1);});
test('ready and load events do not show twice',()=>{const h=harness();h.handlers['ready-to-show']();h.handlers['did-finish-load']();assert.equal(h.shows,1);});
test('a closed window is never revived',()=>{const h=harness();h.destroy();h.handlers['did-finish-load']();assert.equal(h.shows,0);});
