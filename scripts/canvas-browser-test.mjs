// Actual Chromium UI interactions; browser fixtures only, not native/physical audio acceptance.
import assert from 'node:assert/strict';
import { DRAG_PROBE, DRAG_TYPE } from './drag-probe.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RESIZE_HANDLES, createComponent, resizeItem } from '../src/workspace.js';
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
const pick=({x,y,width,height})=>({x,y,width,height});
const center=selector=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
async function mouseClick(selector){const point=await center(selector);await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});}
async function key(name,modifiers=0){const codes={ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Escape:27},base={key:name,code:name,windowsVirtualKeyCode:codes[name],modifiers};await call('Input.dispatchKeyEvent',{type:'rawKeyDown',...base});await call('Input.dispatchKeyEvent',{type:'keyUp',...base});}
async function importDesign(design){await click('[data-editor="creator"]');await jsonInput(design);await click('[data-editor="validate"]');await click('[data-editor="apply-design"]');}
const drag=(selector,dx,dy)=>gesture(selector,dx,dy);
async function gesture(selector,dx,dy,{escape=false}={}){const point=await center(selector);await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await call('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx/2,y:point.y+dy/2,button:'left',buttons:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx,y:point.y+dy,button:'left',buttons:1});if(escape)await key('Escape');await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+dx,y:point.y+dy,button:'left',clickCount:1});}
try {
 chrome=spawn(process.env.CHROMIUM||'chromium',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--no-proxy-server','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});chrome.stderr.on('data',()=>{});
 const port=await until(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]),'Chromium');
 const target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 ws.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.id){const item=pending.get(m.id);if(item){pending.delete(m.id);clearTimeout(item.timer);m.error?item.reject(Error(m.error.message)):item.resolve(m.result);}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);else if(m.method==='Page.javascriptDialogOpening')call('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{});});
 await call('Page.enable');await call('Runtime.enable');if(!process.env.DECKCRAFT_BROWSER_AUDIO)await call('Page.addScriptToEvaluateOnNewDocument',{source:'delete window.AudioContext;delete window.webkitAudioContext;'});await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:profile});
 await call('Page.navigate',{url:pathToFileURL(path.join(root,'dist/deck-craft.html')).href});
 await until(()=>evaluate("Boolean(document.querySelector('.canvas-entry'))"),'application');
 await click('section.deck-panel[data-deck="C"] .play');const expected=await musical();assert.equal(expected.decks.C.playing,true);
 await evaluate("window.canvasProofIdentity='same-document'");
 await click('.canvas-entry');assert.equal(await evaluate("document.querySelector('#app').dataset.layout"),'canvas');assert.equal(await evaluate("document.querySelectorAll('.canvas-stage .canvas-widget').length"),0);
 checks.push('empty canvas entry preserves current session and the original console');
 await click('[data-editor="add"][data-kind="deck"]');let w=await workspace();assert.equal(w.snapshot.items.length,1);const id=w.snapshot.items[0].id;
 const grip=`[data-item-id="${id}"] .widget-grip`,handle=name=>`[data-item-id="${id}"] [data-handle="${name}"]`,box=async itemId=>pick((await workspace()).snapshot.items.find(i=>i.id===itemId));
 const space=await evaluate(`(()=>{const shell=document.querySelector('.canvas-shell').getBoundingClientRect(),view=document.querySelector('.canvas-viewport').getBoundingClientRect(),drawer=document.querySelector('.component-drawer').getBoundingClientRect();return {viewToShell:Math.abs(shell.right-view.right),leftover:Math.round(shell.width-drawer.width-view.width),inspector:Boolean(document.querySelector('.component-inspector,.inspector-actions,[data-editor-field="x"],[data-editor-field="width"],[data-editor-field="name"]')),fields:[...new Set([...document.querySelectorAll('[data-editor-field]')].map(e=>e.dataset.editorField))].sort(),viewWidth:Math.round(view.width)}})()`);
 assert.equal(space.inspector,false,'the properties inspector is gone');assert.deepEqual(space.fields,['snap','theme-all'],'only the snap and theme-all toolbar controls remain');
 assert.ok(space.viewToShell<=1&&space.leftover<=2,'the canvas fills all of the space the inspector used');assert.ok(space.viewWidth>=1200,'at 1440 px the canvas has the full width beside the drawer: '+space.viewWidth);
 await drag(grip,83,57);assert.deepEqual(await box(id),{x:80,y:60,width:500,height:390});
 await drag(handle('se'),63,43);assert.deepEqual(await box(id),{x:80,y:60,width:560,height:440});
 await drag(handle('se'),-900,-900);w=await workspace();assert.equal(w.snapshot.items[0].width,480,'resize stops at the smallest size that fits the whole deck');assert.equal(w.snapshot.items[0].height,380);
 assert.equal(await evaluate("(()=>{const c=document.querySelector('.canvas-widget .widget-content');return c.scrollHeight<=c.clientHeight+1&&c.scrollWidth<=c.clientWidth+1})()"),true,'a deck at its minimum size has no inner scrolling');
 await drag(handle('se'),100,40);assert.deepEqual(await box(id),{x:80,y:60,width:580,height:420});
 // Eight directions from a spacious position, each checked against a hand-written box, then undone and redone.
 await drag(grip,240,160);const start=await box(id);assert.deepEqual(start,{x:320,y:220,width:580,height:420});
 const cursors={n:'ns-resize',s:'ns-resize',e:'ew-resize',w:'ew-resize',nw:'nwse-resize',se:'nwse-resize',ne:'nesw-resize',sw:'nesw-resize'};
 assert.equal(await evaluate(`document.querySelectorAll('[data-item-id="${id}"] .widget-handle').length`),8);
 for(const name of RESIZE_HANDLES)assert.equal(await evaluate(`getComputedStyle(document.querySelector('${handle(name)}')).cursor`),cursors[name],name+' shows the matching resize cursor');
 assert.equal(await evaluate(`getComputedStyle(document.querySelector('${grip}')).cursor`),'grab');
 assert.equal(await evaluate(`[...document.querySelectorAll('[data-item-id="${id}"] .widget-handle')].every(e=>{const r=e.getBoundingClientRect();return r.width>=6&&r.height>=6})`),true,'every handle has a usable hit area');
 const grown={n:[0,-60,{x:320,y:160,width:580,height:480}],s:[0,60,{x:320,y:220,width:580,height:480}],e:[100,0,{x:320,y:220,width:680,height:420}],w:[-100,0,{x:220,y:220,width:680,height:420}],ne:[100,-60,{x:320,y:160,width:680,height:480}],nw:[-100,-60,{x:220,y:160,width:680,height:480}],se:[100,60,{x:320,y:220,width:680,height:480}],sw:[-100,60,{x:220,y:220,width:680,height:480}]};
 for(const [name,[dx,dy,expectedBox]] of Object.entries(grown)){
  await drag(handle(name),dx,dy);assert.deepEqual(await box(id),expectedBox,name+' resize');
  await click('[data-editor="undo"]');assert.deepEqual(await box(id),start,name+' undo is one step');await click('[data-editor="redo"]');assert.deepEqual(await box(id),expectedBox,name+' redo');await click('[data-editor="undo"]');assert.deepEqual(await box(id),start);
 }
 // Shrinking north/west edges anchors the opposite edge; the smallest size is reached without the anchor drifting.
 const smallest={nw:[600,400,{x:420,y:260,width:480,height:380}],ne:[-600,400,{x:320,y:260,width:480,height:380}],sw:[600,-400,{x:420,y:220,width:480,height:380}],se:[-600,-400,{x:320,y:220,width:480,height:380}],n:[0,400,{x:320,y:260,width:580,height:380}],w:[600,0,{x:420,y:220,width:480,height:420}],s:[0,-400,{x:320,y:220,width:580,height:380}],e:[-600,0,{x:320,y:220,width:480,height:420}]};
 for(const [name,[dx,dy,expectedBox]] of Object.entries(smallest)){await drag(handle(name),dx,dy);assert.deepEqual(await box(id),expectedBox,name+' stops at the smallest deck size and keeps the opposite edges');await click('[data-editor="undo"]');assert.deepEqual(await box(id),start);}
 await drag(handle('nw'),-400,-300);assert.deepEqual(await box(id),{x:0,y:0,width:900,height:640},'dragging past the canvas corner stops at the origin and keeps the bottom-right edges');await click('[data-editor="undo"]');assert.deepEqual(await box(id),start);
 // Clicks, clamped no-ops and Escape leave the model and the redo stack alone.
 const redoReady=()=>evaluate("!document.querySelector('[data-editor=\"redo\"]').disabled");assert.equal(await redoReady(),true);
 const before=await workspace();
 await drag(handle('e'),0,0);assert.deepEqual(await workspace(),before);assert.equal(await redoReady(),true,'a click on a handle adds no history');
 await gesture(handle('se'),120,80,{escape:true});assert.deepEqual(await workspace(),before,'Escape abandons the resize');assert.equal(await redoReady(),true,'a cancelled drag does not clear redo');
 assert.equal(await evaluate(`(()=>{const e=document.querySelector('[data-item-id="${id}"]'),b=e.getBoundingClientRect();return e.style.width==='580px'&&e.style.height==='420px'&&!e.dataset.readout&&!e.dataset.dragging})()`),true,'the cancelled preview is restored');
 await gesture(grip,100,100,{escape:true});assert.deepEqual(await workspace(),before,'Escape also abandons a move');
 await drag(handle('se'),-600,-400);await drag(handle('se'),-600,-400);assert.equal((await box(id)).width,480);await click('[data-editor="undo"]');assert.deepEqual(await box(id),start,'a second clamped drag changes nothing, so one undo returns to the start');
 // Keyboard: arrows move, Alt+arrows resize from the bottom-right corner, with the same bounds.
 await evaluate(`document.querySelector('${grip}').focus()`);
 await key('ArrowRight',1);assert.deepEqual(await box(id),{...start,width:600});await key('ArrowRight');assert.deepEqual(await box(id),{...start,x:340,width:600});await key('ArrowDown',8);assert.deepEqual(await box(id),{...start,x:340,y:320,width:600});
 for(let n=0;n<3;n++)await click('[data-editor="undo"]');assert.deepEqual(await box(id),start);
 assert.deepEqual(await musical(),expected,'resizing and moving never change musical state');
 await change('[data-editor-field="theme-all"]','ember');assert.equal(await evaluate("document.querySelector('.canvas-widget').dataset.theme"),'ember');
 // The inspector is gone, so names and deck bindings come only from reviewed imports; text stays inert.
 await importDesign({...createComponent('deck','C'),name:'Copper <deck>',theme:'ember'});w=await workspace();assert.equal(w.snapshot.items.length,2);const copper=w.snapshot.items[1].id;
 assert.equal(await evaluate(`document.querySelector('[data-item-id="${copper}"] .widget-grip strong').textContent`),'Copper <deck>');assert.equal(await evaluate("document.querySelectorAll('deck').length"),0);
 assert.equal(await evaluate(`document.querySelector('[data-item-id="${copper}"] .grip-kind').textContent`),'Deck C');
 // Selecting by a real click on a title shows that component's compact actions only.
 await mouseClick(`[data-item-id="${id}"] .widget-grip strong`);
 assert.equal(await evaluate("[...document.querySelectorAll('.canvas-widget.selected')].map(e=>e.dataset.itemId).join()"),id);
 assert.equal(await evaluate(`[...document.querySelectorAll('.canvas-widget')].map(e=>e.dataset.itemId+':'+getComputedStyle(e.querySelector('.widget-actions')).display).join()`),`${id}:flex,${copper}:none`);
 assert.equal(await evaluate("[...document.querySelectorAll('.canvas-widget.selected .widget-actions button')].map(e=>e.textContent).join()"),'Duplicate,Save,Remove');
 await mouseClick(`[data-item-id="${id}"] [data-editor="duplicate"]`);assert.equal((await workspace()).snapshot.items.length,3);await click('[data-editor="undo"]');assert.equal((await workspace()).snapshot.items.length,2);
 await mouseClick(`[data-item-id="${id}"] .widget-grip strong`);await mouseClick(`[data-item-id="${id}"] [data-editor="remove"]`);w=await workspace();assert.deepEqual(w.snapshot.items.map(i=>i.id),[copper],'Remove removes only that view');assert.deepEqual(await musical(),expected);
 await mouseClick(`[data-item-id="${copper}"] .widget-grip strong`);await mouseClick(`[data-item-id="${copper}"] [data-editor="save-template"]`);await saveName('Copper template');assert.equal((await workspace()).templates.length,1);
 {const spot=await evaluate("(()=>{const v=document.querySelector('.canvas-viewport').getBoundingClientRect(),x=v.right-70,y=v.bottom-70;return {x,y,empty:document.elementFromPoint(x,y)?.classList.contains('canvas-stage')}})()");assert.equal(spot.empty,true,'a spot of bare canvas exists');await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:spot.x,y:spot.y});await call('Input.dispatchMouseEvent',{type:'mousePressed',x:spot.x,y:spot.y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:spot.x,y:spot.y,button:'left',clickCount:1});}
 assert.equal(await evaluate("document.querySelectorAll('.canvas-widget.selected').length"),0,'clicking empty canvas clears the selection');
 await click('[data-editor="add-template"]');assert.equal((await workspace()).snapshot.items.length,2);
 await click('[data-editor="undo"]');assert.equal((await workspace()).snapshot.items.length,1);await click('[data-editor="redo"]');assert.equal((await workspace()).snapshot.items.length,2);
 checks.push('real pointer move and eight-direction resize (every side and corner) with directional cursors, north/west anchoring, smallest size, canvas origin, one undo per gesture, Escape cancel, keyboard resize, compact contextual actions and no inspector');
 await click('[data-editor="save-preset"]');await saveName('Copper workspace');assert.equal((await workspace()).presets.length,1);
 await click('[data-editor="clear"]');assert.equal((await workspace()).snapshot.items.length,0);await click('[data-editor="load-preset"]');assert.equal((await workspace()).snapshot.items.length,2);
 await click('[data-editor="perform"]');assert.equal(await evaluate("getComputedStyle(document.querySelector('.component-drawer')).display"),'none');assert.equal(await evaluate("document.querySelector('[data-editor=\"clear\"]').disabled"),true);
 const locked=await workspace();await drag('.canvas-widget .widget-grip',60,40);assert.deepEqual(await workspace(),locked);
 assert.equal(await evaluate("document.querySelectorAll('.canvas-widget .widget-handle,.canvas-widget .widget-actions').length"),0,'Perform renders no resize handles or layout actions');
 {const edge=await evaluate("(()=>{const e=document.querySelector('.canvas-widget');e.scrollIntoView({block:'center',inline:'center'});const b=e.getBoundingClientRect();return {x:b.right-3,y:b.bottom-3,left:b.left+3,top:b.top+3};})()");
  for(const [from,to] of [[{x:edge.x,y:edge.y},{x:edge.x+60,y:edge.y+40}],[{x:edge.left,y:edge.top},{x:edge.left-30,y:edge.top-20}]]){await call('Input.dispatchMouseEvent',{type:'mouseMoved',...from});await call('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',clickCount:1});}}
 await key('Delete');await key('ArrowRight',1);assert.deepEqual(await workspace(),locked,'locked Perform ignores edge/corner drags, Delete and keyboard resizing');
 await click('[data-editor="edit"]');assert.deepEqual(await musical(),expected);assert.equal(await evaluate("document.querySelectorAll('.canvas-widget .widget-handle').length"),8*(await workspace()).snapshot.items.length,'Edit mode restores the handles');
 checks.push('saved workspace, blank reset/recovery and locked Perform mode do not change musical state');
 await click('[data-editor="creator"]');assert.equal(await evaluate("document.querySelector('.creator-dialog').open"),true);
 const component=createComponent('deck','D');component.name='Agent copper deck';component.theme='ember';
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
 // Static creator previews paint their synthetic fixture waveforms onto canvases that carry no deck data.
 await jsonInput(createComponent('waveform','A'));await click('[data-editor="validate"]');await change('.preview-state','playing');
 const previewWaves=await evaluate("(()=>[...document.querySelectorAll('.design-preview canvas.wave-canvas')].map(c=>{const d=c.getContext('2d').getImageData(0,0,Math.max(1,c.width),Math.max(1,c.height)).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return {w:c.clientWidth,h:c.clientHeight,ink:n};}))()");
 if(process.env.DECKCRAFT_EVIDENCE_DIR&&process.env.WAVE_SHOT_PREFIX){const rect=await evaluate("(()=>{const r=document.querySelector('.design-preview').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:Math.min(r.height,900)};})()");const shot=await call('Page.captureScreenshot',{format:'png',clip:{...rect,scale:1}});await writeFile(path.join(process.env.DECKCRAFT_EVIDENCE_DIR,process.env.WAVE_SHOT_PREFIX+'-creator-preview.png'),Buffer.from(shot.data,'base64'));}
 assert.ok(previewWaves.some(c=>c.w>0)&&previewWaves.every(c=>c.w===0||c.ink>c.w*2),'creator preview draws its fixture waveforms '+JSON.stringify(previewWaves));
 await jsonInput(component);await click('[data-editor="validate"]');

 await click('[data-editor="download-kit"]');const kit=await until(async()=>JSON.parse(await readFile(path.join(profile,'deckcraft-creator-kit.json'),'utf8')),'actual kit download');
 assert.equal(kit.format,'deckcraft.creator-kit');assert.ok(!JSON.stringify(kit).includes('trackId'));
 const kitDir=path.join(profile,'extracted-kit');await mkdir(kitDir);for(const [name,content] of Object.entries(kit.files))await writeFile(path.join(kitDir,name),content);
 const validation=spawnSync(process.execPath,['validate.mjs','component.json'],{cwd:kitDir,encoding:'utf8'});assert.equal(validation.status,0,validation.stderr);
 await click('[data-editor="apply-design"]');assert.equal((await workspace()).snapshot.items.length,3);assert.deepEqual(await musical(),expected);
 assert.equal(await evaluate("window.canvasProofIdentity"),'same-document');
 checks.push('agent import rejects unknown code, previews inert synthetic states, downloads a usable kit and adds reviewed design without audio mutation');
 await click('[data-editor="export-workspace"]');const exported=await until(async()=>JSON.parse(await readFile(path.join(profile,'deckcraft-workspace.json'),'utf8')),'workspace download');assert.deepEqual(exported,(await workspace()).snapshot);
 await click('[data-editor="creator"]');await jsonInput(exported);await click('[data-editor="validate"]');await click('[data-editor="apply-design"]');assert.deepEqual((await workspace()).snapshot,exported);
 await click('[data-action="mode"][data-value="perform"]');assert.equal(await evaluate("document.querySelector('#app').dataset.layout"),'console');await click('.canvas-entry');assert.equal((await workspace()).snapshot.items.length,3);
 await call('Page.reload');await until(()=>evaluate("document.querySelector('#app')?.dataset.layout==='canvas'"),'canvas restoration');assert.deepEqual((await workspace()).snapshot,exported);
 assert.equal(await evaluate("document.querySelector('.canvas-widget [data-field=\"playing\"]').getAttribute('aria-pressed')"),'false');
 checks.push('export/import, console round trip and reload retain canvas while restoring transport paused');
 await click('[data-editor="clear"]');
 await evaluate(`(()=>{const stage=document.querySelector('.canvas-stage'),r=stage.getBoundingClientRect(),data=new DataTransfer();data.setData('application/x-deckcraft-kind','deck');stage.dispatchEvent(new DragEvent('drop',{bubbles:true,clientX:r.x+83,clientY:r.y+57,dataTransfer:data}));})()`);
 assert.equal((await workspace()).snapshot.items[0].x,80);await click('[data-editor="undo"]');assert.equal((await workspace()).snapshot.items.length,0);
 for(const kind of ['deck','mixer','browser','waveform','cues','crossfader','effects'])await click('[data-editor="add"][data-kind="'+kind+'"]');
 assert.equal((await workspace()).snapshot.items.length,7);
 {
  const ids=(await workspace()).snapshot.items.map(i=>i.id),sessionBefore=await musical();
  for(const itemId of ids)await drag(`[data-item-id="${itemId}"] .widget-grip`,100,100);
  assert.equal(await evaluate("document.querySelectorAll('.canvas-stage .widget-handle').length"),56,'seven components x eight handles');
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2});
  const opacity=itemId=>evaluate(`Number(getComputedStyle(document.querySelector('[data-item-id="${itemId}"] [data-handle="se"]'),'::after').opacity)`);
  await delay(300);assert.ok(await opacity(ids[0])<.1&&await opacity(ids[1])<.1,'handles are quiet until a component is hovered or selected');
  await mouseClick(`[data-item-id="${ids[2]}"] .widget-grip strong`);await delay(300);assert.ok(await opacity(ids[2])>.5,'the selected component shows clear handles');
  for(const itemId of ids)for(const name of RESIZE_HANDLES){
   const item=(await workspace()).snapshot.items.find(i=>i.id===itemId),first=pick(item),dx=name.includes('w')?-40:name.includes('e')?40:0,dy=name.includes('n')?-40:name.includes('s')?40:0;
   await drag(`[data-item-id="${itemId}"] [data-handle="${name}"]`,dx,dy);const after=await box(itemId);
   assert.deepEqual(after,resizeItem(item,name,dx,dy),item.design.kind+' '+name);assert.notDeepEqual(after,first,item.design.kind+' '+name+' really resized');
   if(!name.includes('w')&&!name.includes('e'))assert.equal(after.width,first.width);if(!name.includes('n')&&!name.includes('s'))assert.equal(after.height,first.height);
   if(!name.includes('w'))assert.equal(after.x,first.x);if(!name.includes('e'))assert.equal(after.x+after.width,first.x+first.width);if(!name.includes('n'))assert.equal(after.y,first.y);if(!name.includes('s'))assert.equal(after.y+after.height,first.y+first.height);
   await click('[data-editor="undo"]');assert.deepEqual(await box(itemId),first,item.design.kind+' '+name+' undo');
  }
  assert.deepEqual(await musical(),sessionBefore,'moving and resizing all seven kinds never changes musical state');
 }
 checks.push('all seven component kinds resize from all eight handles (56 real pointer gestures), each undone in one step');
 assert.equal(await evaluate("[...document.querySelectorAll('.canvas-stage [data-action=\"toggle-fx\"],.canvas-stage [data-field=\"sync\"]')].every(e=>e.disabled)"),true);
 await click('[data-editor="add"][data-kind="browser"]');
 await evaluate("(()=>{const x=document.querySelector('.canvas-stage .search');x.value='Orbit';x.dispatchEvent(new Event('input',{bubbles:true}));})()");
 assert.deepEqual(await evaluate("[...document.querySelectorAll('.canvas-stage .search')].map(e=>e.value)"),['Orbit','Orbit']);
 assert.deepEqual(await evaluate("[...document.querySelectorAll('.canvas-stage .track-count')].map(e=>e.textContent)"),['1 track','1 track']);
 checks.push('palette drop uses one undo; all seven kinds render, unavailable controls stay disabled, duplicate browsers share filtering');
 {const before=await workspace(),musicalBefore=await musical(),target=await evaluate(`(()=>{const b=document.querySelector('.canvas-stage .wavebox:not(.overview)');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,zoom:Number(b.dataset.waveZoom)}})()`);
  await call('Input.dispatchMouseEvent',{type:'mouseWheel',x:target.x,y:target.y,deltaX:0,deltaY:-120});
  await until(()=>evaluate(`Number(document.querySelector('.canvas-stage .wavebox:not(.overview)').dataset.waveZoom)>${target.zoom}`),'canvas wheel zoom');
  assert.deepEqual(await workspace(),before);assert.deepEqual(await musical(),musicalBefore);
  checks.push('real wheel zoom over a canvas waveform changes no workspace or musical state');}
 {
  await evaluate(DRAG_PROBE);
  const probe=(method,...args)=>evaluate(`window.__dragProbe.${method}(...${JSON.stringify(args)})`);
  await evaluate("(()=>{const x=document.querySelector('.canvas-stage .search');x.value='';x.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await change('.new-component-deck','D');await click('[data-editor="add"][data-kind="waveform"]');
  const layout=await workspace();
  const dropOn=async(selector,deck,trackId)=>{
   const before=await musical(),expected=structuredClone(before);
   assert.deepEqual((await probe('start',trackId)).payload,[[DRAG_TYPE,trackId]]);
   assert.deepEqual((await probe('fire','dragover',selector)).hover,[deck]);
   assert.deepEqual(await probe('fire','drop',selector),{prevented:true,hover:[],dragging:0});
   expected.decks[deck]={...before.decks[deck],trackId,position:0,playing:false,sync:false,cues:[0,48,136,208]};
   assert.deepEqual(await musical(),expected);assert.deepEqual(await workspace(),layout,'loading never edits workspace data');
  };
  await dropOn('.canvas-widget[data-kind="deck"] .deck-panel','A','low-orbit');
  await dropOn('.canvas-wave[data-drop-deck="D"] .wavebox','D','glass-transit');
  for(const selector of ['.canvas-widget[data-kind="mixer"] .widget-content','.canvas-widget[data-kind="effects"]','.canvas-stage']){
   await probe('start','low-orbit');assert.equal((await probe('fire','dragover',selector)).prevented,false);
   assert.equal((await probe('fire','drop',selector)).prevented,false);await probe('fire','dragend','@row');
  }
  await click('[data-editor="perform"]');await dropOn('.canvas-wave[data-drop-deck="D"]','D','signal-garden');
  await click('[data-editor="edit"]');
  const palette=await evaluate(`(()=>{const dt=new DataTransfer();document.querySelector('[data-editor="add"][data-kind="deck"]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));return [...dt.types]})()`);
  assert.deepEqual(palette,['application/x-deckcraft-kind']);
  await evaluate("(()=>{const e=document.querySelector('.canvas-wave[data-drop-deck=\"D\"] .wave-seek');e.value=120;e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  assert.equal((await musical()).decks.D.position,120);
  checks.push('Build deck and bound waveform drop loading in Edit/Perform changes only the intended deck, preserves workspace/handles and seeking, refuses non-targets and keeps palette dragging separate');
 }
 await change('.starter-picker','console');
 const geometry=[];
 for(const width of [1920,1440,1280,390,360]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
  const measured=await evaluate(`(()=>{const shell=document.querySelector('.canvas-shell').getBoundingClientRect(),viewport=document.querySelector('.canvas-viewport').getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,shellWidth:shell.width,viewportWidth:viewport.width,items:document.querySelectorAll('.canvas-stage .canvas-widget').length,gap:Math.round(shell.width-document.querySelector('.component-drawer').getBoundingClientRect().width-viewport.width),columns:getComputedStyle(document.querySelector('.canvas-layout')).display}})()`);
  if(width>650)assert.ok(measured.gap<=2,'the canvas uses all remaining width at '+width+': '+measured.gap);
  assert.equal(measured.overflow,false,'root overflow at '+width);assert.ok(measured.viewportWidth>0);assert.equal(measured.items,7);geometry.push(measured);
 }
 assert.deepEqual(errors,[]);
 if(process.env.DECKCRAFT_EVIDENCE_DIR){await mkdir(process.env.DECKCRAFT_EVIDENCE_DIR,{recursive:true});await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});const image=await call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(process.env.DECKCRAFT_EVIDENCE_DIR,'canvas-editor.png'),Buffer.from(image.data,'base64'));}
 checks.push('five responsive widths contain the canvas viewport; original document never reloads during editing');
 console.log(JSON.stringify({passed:true,checks,geometry,errors},null,2));
} finally {
 if(chrome){const exited=new Promise(resolve=>chrome.once('exit',resolve));try{await call('Browser.close');}catch{}await Promise.race([exited,delay(3000)]);if(chrome.exitCode===null){chrome.kill('SIGKILL');await exited;}}
 ws?.close();for(const p of pending.values())clearTimeout(p.timer);await rm(profile,{recursive:true,force:true});
}
