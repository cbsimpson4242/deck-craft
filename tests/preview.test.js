import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const source=readFileSync(new URL('../desktop/preview.cjs',import.meta.url),'utf8');
function load(release='0.3.1-test'){
 const calls=[],titles=[],identity=[];
 const app={getPath(name){assert.equal(name,'appData');return '/config';},setName(v){identity.push(v);},setAppUserModelId(v){identity.push(v);},setDesktopName(v){identity.push(v);}};
 const module={exports:{}};
 const require=name=>name==='electron'?{app}:name==='node:path'?path:name==='../preview.json'?{release}:name==='./main.cjs'?{startDesktop:async options=>{calls.push(options);return {window:{on(event,fn){assert.equal(event,'page-title-updated');let prevented=false;fn({preventDefault(){prevented=true;}});assert.ok(prevented);},setTitle(v){titles.push(v);}}};}}:assert.fail('Unexpected dependency '+name);
 vm.runInNewContext(source,{require,module,console,process:{}});
 return {start:module.exports.startPreview,calls,titles,identity};
}
test('portable entry preserves the installed state boundary and identifies its window',async()=>{
 const p=load();await p.start();
 assert.equal(p.calls.length,1);assert.deepEqual(Object.keys(p.calls[0]),['userData']);
 assert.equal(p.calls[0].userData,'/config/deck-craft-preview/0.3.1-test');
 assert.match(p.titles[0],/Deck Craft Preview/);assert.ok(p.identity.includes('org.deckcraft.preview'));
 assert.ok(!p.calls[0].userData.startsWith('/config/deck-craft/'));
});
test('different portable releases have independent state; untrusted release paths are rejected',async()=>{
 const a=load('0.3.1-a'),b=load('0.3.1-b');await a.start();await b.start();
 assert.notEqual(a.calls[0].userData,b.calls[0].userData);
 for(const release of ['../deck-craft','/config/deck-craft','',null,'x'.repeat(101)])assert.throws(()=>load(release),/Invalid preview release/);
});
