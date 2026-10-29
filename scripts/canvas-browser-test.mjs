// Actual Chromium UI interactions; browser fixtures only, not native/physical audio acceptance.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createComponent } from '../src/workspace.js';
const root=fileURLToPath(new URL('../',import.meta.url)),parent=process.env.TMPDIR||path.join(homedir(),'.cache');
await mkdir(parent,{recursive:true});const profile=await mkdtemp(path.join(parent,'deckcraft-canvas-'));
const checks=[],errors=[],pending=new Map();let chrome,ws,sequence=0;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+20000;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch{}await delay(50);}throw Error('Timed out: '+label);}
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
async function evaluate(expression){const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;}
const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const change=(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const jsonInput=value=>evaluate(`(()=>{const e=document.querySelector('.design-json');e.value=${JSON.stringify(JSON.stringify(value))};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const workspace=()=>evaluate("JSON.parse(localStorage.getItem('deck-craft.workspace.v1'))");
const musical=()=>evaluate("JSON.parse(localStorage.getItem('deck-craft.ui.v1'))");
const saveName=async(name)=>{await change('.canvas-name-input',name);await click('[data-editor="confirm-name"]');};
async function drag(selector,dx,dy){const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx,y:point.y+dy,button:'left',buttons:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+dx,y:point.y+dy,button:'left',clickCount:1});}
try {
 chrome=spawn(process.env.CHROMIUM||'chromium',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--no-proxy-server','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});chrome.stderr.on('data',()=>{});
 const port=await until(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]),'Chromium');
 const target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 ws.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.id){const item=pending.get(m.id);if(item){pending.delete(m.id);clearTimeout(item.timer);m.error?item.reject(Error(m.error.message)):item.resolve(m.result);}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);else if(m.method==='Page.javascriptDialogOpening')call('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{});});
 await call('Page.enable');await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:profile});
 await call('Page.navigate',{url:pathToFileURL(path.join(root,'dist/deck-craft.html')).href});
 await until(()=>evaluate("Boolean(document.querySelector('.canvas-entry'))"),'application');
 await click('section[data-deck="C"] .play');const expected=await musical();assert.equal(expected.decks.C.playing,true);
 await evaluate("window.canvasProofIdentity='same-document'");
 await click('.canvas-entry');assert.equal(await evaluate("document.querySelector('#app').dataset.layout"),'canvas');assert.equal(await evaluate("document.querySelectorAll('.canvas-stage .canvas-widget').length"),0);
 checks.push('empty canvas entry preserves current session and original Studio Sync default');
 await click('[data-editor="add"][data-kind="deck"]');let w=await workspace();assert.equal(w.snapshot.items.length,1);const id=w.snapshot.items[0].id;
 await drag(`[data-item-id="${id}"] .widget-grip`,83,57);w=await workspace();assert.equal(w.snapshot.items[0].x,80);assert.equal(w.snapshot.items[0].y,60);
 await drag(`[data-item-id="${id}"] .widget-resize`,63,43);w=await workspace();assert.equal(w.snapshot.items[0].width,620);assert.equal(w.snapshot.items[0].height,600);
 await drag(`[data-item-id="${id}"] .widget-resize`,-900,-900);w=await workspace();assert.equal(w.snapshot.items[0].width,520,'resize stops at the smallest size that fits the whole deck');assert.equal(w.snapshot.items[0].height,560);
 assert.equal(await evaluate("(()=>{const c=document.querySelector('.canvas-widget .widget-content');return c.scrollHeight<=c.clientHeight+1&&c.scrollWidth<=c.clientWidth+1})()"),true,'a deck at its minimum size has no inner scrolling');
 await drag(`[data-item-id="${id}"] .widget-resize`,100,40);w=await workspace();assert.equal(w.snapshot.items[0].width,620);assert.equal(w.snapshot.items[0].height,600);
 await change('[data-editor-field="theme"]','ember');assert.equal(await evaluate("document.querySelector('.canvas-widget').dataset.theme"),'ember');await change('[data-editor-field="name"]','Copper <deck>');await change('[data-editor-field="deck"]','C');
 assert.equal(await evaluate("document.querySelector('.canvas-widget .widget-grip strong').textContent"),'Copper <deck>');assert.equal(await evaluate("document.querySelectorAll('deck').length"),0);
 await click('[data-editor="save-template"]');await saveName('Copper template');assert.equal((await workspace()).templates.length,1);
 await click('[data-editor="add-template"]');assert.equal((await workspace()).snapshot.items.length,2);
 await click('[data-editor="undo"]');assert.equal((await workspace()).snapshot.items.length,1);await click('[data-editor="redo"]');assert.equal((await workspace()).snapshot.items.length,2);
 checks.push('real pointer drag/resize, grid snapping, safe text styling, deck binding, template reuse, undo/redo');
 await click('[data-editor="save-preset"]');await saveName('Copper workspace');assert.equal((await workspace()).presets.length,1);
 await click('[data-editor="clear"]');assert.equal((await workspace()).snapshot.items.length,0);await click('[data-editor="load-preset"]');assert.equal((await workspace()).snapshot.items.length,2);
 await click('[data-editor="perform"]');assert.equal(await evaluate("getComputedStyle(document.querySelector('.component-drawer')).display"),'none');assert.equal(await evaluate("document.querySelector('[data-editor=\"clear\"]').disabled"),true);
 const locked=await workspace();await drag('.canvas-widget .widget-grip',60,40);assert.deepEqual(await workspace(),locked);
 await click('[data-editor="edit"]');assert.deepEqual(await musical(),expected);
 checks.push('saved workspace, blank reset/recovery and locked Perform mode do not change musical state');
 await click('[data-editor="creator"]');assert.equal(await evaluate("document.querySelector('.creator-dialog').open"),true);
 const component=createComponent('deck','D');component.name='Agent copper deck';component.theme='orchid';
 await jsonInput({...component,script:'alert(1)'});await click('[data-editor="validate"]');assert.match(await evaluate("document.querySelector('.design-result').textContent"),/unknown field/);assert.equal(await evaluate("document.querySelector('[data-editor=\"apply-design\"]').disabled"),true);
 {const {theme,...rest}=component;await jsonInput({...rest,version:1,style:{accent:'#d39c64',surface:'#18232d',text:'#dce8ef',radius:10,density:'compact',fontScale:110}});await click('[data-editor="validate"]');assert.match(await evaluate("document.querySelector('.design-result').textContent"),/version 1 design.*replaced by the app theme/);assert.equal(await evaluate("document.querySelector('[data-editor=\"apply-design\"]').disabled"),false);}
 const uploadFile=path.join(profile,'upload-component.json');await writeFile(uploadFile,JSON.stringify(component));
 const documentNode=await call('DOM.getDocument');const fileNode=await call('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'.design-file'});
 await call('DOM.setFileInputFiles',{nodeId:fileNode.nodeId,files:[uploadFile]});
 await until(()=>evaluate("document.querySelector('.design-result').textContent.startsWith('Valid v2')"),'chosen JSON file validation');
 await jsonInput(component);await click('[data-editor="validate"]');assert.match(await evaluate("document.querySelector('.design-result').textContent"),/Valid v2/);
 assert.equal(await evaluate("document.querySelectorAll('.design-preview [data-action],.design-preview [data-wave-deck],.design-preview [data-deck]').length"),0);
 assert.equal(await evaluate("[...document.querySelectorAll('.design-preview button,.design-preview input,.design-preview select')].every(e=>e.disabled)"),true);
 for(const variant of ['playing','empty','unavailable','paused']){await change('.preview-state',variant);assert.match(await evaluate("document.querySelector('.preview-caption').textContent"),new RegExp(variant.toUpperCase()));}
 await click('[data-editor="download-kit"]');const kit=await until(async()=>JSON.parse(await readFile(path.join(profile,'deckcraft-creator-kit.json'),'utf8')),'actual kit download');
 assert.equal(kit.format,'deckcraft.creator-kit');assert.ok(!JSON.stringify(kit).includes('trackId'));
 const kitDir=path.join(profile,'extracted-kit');await mkdir(kitDir);for(const [name,content] of Object.entries(kit.files))await writeFile(path.join(kitDir,name),content);
 const validation=spawnSync(process.execPath,['validate.mjs','component.json'],{cwd:kitDir,encoding:'utf8'});assert.equal(validation.status,0,validation.stderr);
 await click('[data-editor="apply-design"]');assert.equal((await workspace()).snapshot.items.length,3);assert.deepEqual(await musical(),expected);
 assert.equal(await evaluate("window.canvasProofIdentity"),'same-document');
 checks.push('agent import rejects unknown code, previews inert synthetic states, downloads a usable kit and adds reviewed design without audio mutation');
 await click('[data-editor="export-workspace"]');const exported=await until(async()=>JSON.parse(await readFile(path.join(profile,'deckcraft-workspace.json'),'utf8')),'workspace download');assert.deepEqual(exported,(await workspace()).snapshot);
 await click('[data-editor="creator"]');await jsonInput(exported);await click('[data-editor="validate"]');await click('[data-editor="apply-design"]');assert.deepEqual((await workspace()).snapshot,exported);
 await change('.layout-picker','signal-one');assert.equal(await evaluate("document.querySelector('#app').dataset.layout"),'signal-one');await change('.layout-picker','canvas');assert.equal((await workspace()).snapshot.items.length,3);
 await call('Page.reload');await until(()=>evaluate("document.querySelector('#app')?.dataset.layout==='canvas'"),'canvas restoration');assert.deepEqual((await workspace()).snapshot,exported);
 assert.equal(await evaluate("document.querySelector('.canvas-widget [data-field=\"playing\"]').getAttribute('aria-pressed')"),'false');
 checks.push('export/import, original layout round trip and reload retain canvas while restoring transport paused');
 await click('[data-editor="clear"]');
 await evaluate(`(()=>{const stage=document.querySelector('.canvas-stage'),r=stage.getBoundingClientRect(),data=new DataTransfer();data.setData('application/x-deckcraft-kind','deck');stage.dispatchEvent(new DragEvent('drop',{bubbles:true,clientX:r.x+83,clientY:r.y+57,dataTransfer:data}));})()`);
 assert.equal((await workspace()).snapshot.items[0].x,80);await click('[data-editor="undo"]');assert.equal((await workspace()).snapshot.items.length,0);
 for(const kind of ['deck','mixer','browser','waveform','cues','crossfader','effects'])await click('[data-editor="add"][data-kind="'+kind+'"]');
 assert.equal((await workspace()).snapshot.items.length,7);
 assert.equal(await evaluate("[...document.querySelectorAll('.canvas-stage [data-action=\"toggle-fx\"],.canvas-stage [data-field=\"sync\"]')].every(e=>e.disabled)"),true);
 await click('[data-editor="add"][data-kind="browser"]');
 await evaluate("(()=>{const x=document.querySelector('.canvas-stage .search');x.value='Orbit';x.dispatchEvent(new Event('input',{bubbles:true}));})()");
 assert.deepEqual(await evaluate("[...document.querySelectorAll('.canvas-stage .search')].map(e=>e.value)"),['Orbit','Orbit']);
 assert.deepEqual(await evaluate("[...document.querySelectorAll('.canvas-stage .track-count')].map(e=>e.textContent)"),['1 track','1 track']);
 checks.push('palette drop uses one undo; all seven kinds render, unavailable controls stay disabled, duplicate browsers share filtering');
 await change('.starter-picker','studio-grid');
 const geometry=[];
 for(const width of [1920,1440,1280,390,360]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
  const measured=await evaluate(`(()=>{const shell=document.querySelector('.canvas-shell').getBoundingClientRect(),viewport=document.querySelector('.canvas-viewport').getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,shellWidth:shell.width,viewportWidth:viewport.width,items:document.querySelectorAll('.canvas-stage .canvas-widget').length}})()`);
  assert.equal(measured.overflow,false,'root overflow at '+width);assert.ok(measured.viewportWidth>0);assert.equal(measured.items,6);geometry.push(measured);
 }
 assert.deepEqual(errors,[]);
 if(process.env.DECKCRAFT_EVIDENCE_DIR){await mkdir(process.env.DECKCRAFT_EVIDENCE_DIR,{recursive:true});await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});const image=await call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(process.env.DECKCRAFT_EVIDENCE_DIR,'canvas-editor.png'),Buffer.from(image.data,'base64'));}
 checks.push('five responsive widths contain the canvas viewport; original document never reloads during editing');
 console.log(JSON.stringify({passed:true,checks,geometry,errors},null,2));
} finally {
 if(chrome){const exited=new Promise(resolve=>chrome.once('exit',resolve));try{await call('Browser.close');}catch{}await Promise.race([exited,delay(3000)]);if(chrome.exitCode===null){chrome.kill('SIGKILL');await exited;}}
 ws?.close();for(const p of pending.values())clearTimeout(p.timer);await rm(profile,{recursive:true,force:true});
}
