import assert from 'node:assert/strict';
import { DRAG_PROBE, DRAG_TYPE } from './drag-probe.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=pathToFileURL(path.join(root,'dist/deck-craft.html')).href;
const parent=process.env.TMPDIR||path.join(homedir(),'.cache');
await mkdir(parent,{recursive:true});
const profile=await mkdtemp(path.join(parent,'deckcraft-browser-'));
const evidence=process.env.DECKCRAFT_EVIDENCE_DIR;
if(evidence)await mkdir(evidence,{recursive:true});
const report={presentationTransitions:0,responsiveCases:[],checks:[],errors:[]};
let chrome,client,dragData=null;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=15000) {
 const start=Date.now();while(Date.now()-start<timeout){try{const value=await fn();if(value)return value;}catch{}await delay(50);}throw new Error('Timed out: '+label);
}
async function launch() {
 await rm(path.join(profile,'DevToolsActivePort'),{force:true});
 chrome=spawn(process.env.CHROMIUM||'chromium',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
 let stderr='';chrome.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-12000);});
 const port=await until(async()=>{const text=await readFile(path.join(profile,'DevToolsActivePort'),'utf8');return Number(text.split('\n')[0]);},'Chromium startup');
 const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 const target=targets.find(t=>t.type==='page');assert.ok(target);
 const ws=new WebSocket(target.webSocketDebuggerUrl);const pending=new Map();let sequence=0;
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 ws.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.id){const item=pending.get(message.id);if(item){pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);}}else if(message.method==='Input.dragIntercepted'){dragData=message.params.data;}else if(message.method==='Runtime.exceptionThrown'){report.errors.push(message.params.exceptionDetails.text+' '+(message.params.exceptionDetails.exception?.description||''));}});
 client={ws,call:(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));})};
 await client.call('Runtime.enable');await client.call('Page.enable');
 await client.call('Page.navigate',{url});
 await until(()=>evaluate("Boolean(document.querySelector('.theme-picker'))"),'application startup');
}
async function evaluate(expression) {
 const result=await client.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
 return result.result.value;
}
async function close() {
 if(!chrome)return;
 const owned=chrome;
 const exit=new Promise(resolve=>owned.once('exit',resolve));
 try{await client.call('Browser.close');}catch{}
 await Promise.race([exit,delay(3000)]);
 if(owned.exitCode===null){owned.kill('SIGTERM');await Promise.race([exit,delay(2000)]);}
 if(owned.exitCode===null)owned.kill('SIGKILL');
 client?.ws.close();chrome=null;
}
const select=async(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing select');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const click=async(selector,shift=false)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing button '+${JSON.stringify(selector)});e.dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:${shift}}));return true})()`);
const input=async(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing input');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
const snapshot=()=>evaluate("JSON.parse(localStorage.getItem('deck-craft.ui.v1'))");
const musical=state=>({decks:state.decks,mixer:state.mixer,library:state.library});
// A real pointer drag: Chromium reports the drag it would start (with the data our dragstart set); we then deliver it to the target.
async function realDrag(sourceSelector,targetSelector) {
 const point=selector=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 const from=await point(sourceSelector),to=await point(targetSelector);
 dragData=null;await client.call('Input.setInterceptDrags',{enabled:true});
 try {
  await client.call('Input.dispatchMouseEvent',{type:'mouseMoved',...from});
  await client.call('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',clickCount:1});
  await client.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:from.x+10,y:from.y+10,button:'left',buttons:1});
  await client.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:from.x+30,y:from.y+30,button:'left',buttons:1});
  const data=await until(()=>dragData,'drag interception');
  await client.call('Input.dispatchDragEvent',{type:'dragEnter',...to,data});
  await client.call('Input.dispatchDragEvent',{type:'dragOver',...to,data});
  const hover=await evaluate("[...document.querySelectorAll('.drop-target')].map(e=>e.dataset.dropDeck)");
  await client.call('Input.dispatchDragEvent',{type:'drop',...to,data});
  await client.call('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',clickCount:1});
  return {data,hover};
 } finally {await client.call('Input.setInterceptDrags',{enabled:false});}
}
try {
 await launch();
 assert.equal(await evaluate("document.querySelector('#app').dataset.layout"),'console');
 assert.equal(await evaluate("document.querySelectorAll('iframe').length"),0);
 assert.equal(await evaluate("document.querySelectorAll('.deck-lane').length+':'+document.querySelectorAll('.deck-panel').length+':'+document.querySelectorAll('.mixer .channel').length"),'4:4:4');
 // A real wheel event must zoom the hovered waveform, not seek or scroll the page.
 {
  await client.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  const before=await snapshot();
  const selector='section.deck-lane[data-deck="A"] .wavebox.scroll';
  const probe=()=>evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,zoom:Number(b.style.getPropertyValue('--zoom')),width:b.querySelector('.wave-track').getBoundingClientRect().width/r.width,scroll:scrollY}})()`);
  const start=await probe();
  assert.ok(await evaluate(`!!document.elementFromPoint(${start.x},${start.y})?.closest('.wavebox.scroll')`),'wheel target is on screen');
  await client.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:start.x,y:start.y,deltaY:-120,deltaX:0});
  await delay(100);
  const zoomed=await probe();
  assert.ok(zoomed.zoom>start.zoom,'wheel up zooms into the waveform');
  assert.ok(zoomed.width>start.width,'the rendered waveform actually expands');
  assert.equal(zoomed.scroll,start.scroll,'zoom does not scroll the page');
  assert.equal(await evaluate("document.querySelector('section.deck-lane[data-deck=B] .wavebox.scroll').style.getPropertyValue('--zoom')"),'5','other decks retain their zoom');
  assert.ok(Math.abs(await evaluate("document.querySelector('section.deck-lane[data-deck=A] .wavebox.overview .wave-track').getBoundingClientRect().width/document.querySelector('section.deck-lane[data-deck=A] .wavebox.overview').clientWidth")-1)<.01,'overview remains full-track');
  assert.deepEqual(await snapshot(),before,'wheel zoom never changes stored musical state');
  await client.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:start.x,y:start.y,deltaY:120,deltaX:0});
  await delay(100);
  assert.ok(Math.abs((await probe()).zoom-start.zoom)<.001,'wheel down reverses zoom');
  report.checks.push('real scroll-wheel zoom expands/contracts only the hovered lane waveform without seeking, page scroll or persisted musical changes; overview stays full-track');
 }
 await evaluate("window.__sessionIdentity='same-document';window.__startTime=performance.timeOrigin");
 await click('[data-action="pair"][data-value="cd"]');
 await select('.load-target','C');await click('[data-action="load"][data-track="quiet-motion"]');
 await input('[data-action="deck-number"][data-deck="C"][data-field="position"]',177.3);
 await click('section.deck-panel[data-deck="C"] [data-action="hot-cue"][data-index="1"]',true);
 await click('section.deck-panel[data-deck="C"] [data-action="toggle-deck"][data-field="playing"]');
 await click('section.deck-panel[data-deck="C"] [data-field="loopEnabled"]');
 await click('section.deck-panel[data-deck="C"] [data-action="loop-size"][data-factor="2"]');
 await input('.mixer [data-deck="A"][data-field="hi"]',70);
 await input('.mixer [data-deck="D"][data-field="level"]',55);
 await input('.mixer [data-action="crossfader"]',31);
 await click('.app-mixer');
 await click('.mixer-dialog [data-action="toggle-fx"][data-effect="echo"]');
 await input('.mixer-dialog [data-action="fx-wet"][data-effect="echo"]',62);
 await click('[data-action="close-mixer"]');
 await click('[data-action="pair"][data-value="ab"]');
 await input('[data-deck="A"][data-field="pitch"]',2.5);
 await input('.search','Orbit');
 const expected=musical(await snapshot());
 assert.equal(expected.decks.C.cues[1],177.3);assert.equal(expected.decks.C.playing,true);
 const steps=[
  ['perform to library',()=>click('[data-action="mode"][data-value="prepare"]'),()=>evaluate("document.body.classList.contains('prepare-mode')")],
  ['library to perform',()=>click('[data-action="mode"][data-value="perform"]'),()=>evaluate("!document.body.classList.contains('prepare-mode')")],
  ['pair C / D',()=>click('[data-action="pair"][data-value="cd"]'),()=>evaluate("document.querySelector('#app').dataset.pair==='cd'&&getComputedStyle(document.querySelector('.deck-panel[data-deck=\"C\"]')).display!=='none'&&getComputedStyle(document.querySelector('.deck-panel[data-deck=\"A\"]')).display==='none'")],
  ['pair A / B',()=>click('[data-action="pair"][data-value="ab"]'),()=>evaluate("document.querySelector('#app').dataset.pair==='ab'")],
  ['loop pads',()=>click('[data-action="pad-mode"][data-deck="A"][data-value="loop"]'),()=>evaluate("!document.querySelector('.deck-panel[data-deck=\"A\"] .loop-pads').hidden&&document.querySelector('.deck-panel[data-deck=\"A\"] .pads').hidden")],
  ['cue pads',()=>click('[data-action="pad-mode"][data-deck="A"][data-value="cue"]'),()=>evaluate("document.querySelector('.deck-panel[data-deck=\"A\"] .loop-pads').hidden")],
  ['open build',()=>click('.canvas-entry'),()=>evaluate("document.querySelector('#app').dataset.layout==='canvas'")],
  ['build to perform',()=>click('[data-action="mode"][data-value="perform"]'),()=>evaluate("document.querySelector('#app').dataset.layout==='console'")],
  ['theme Studio',()=>select('.theme-picker','daylight'),()=>evaluate("document.body.dataset.theme==='daylight'")],
  ['theme Night',()=>select('.theme-picker','graphite'),()=>evaluate("document.body.dataset.theme==='graphite'")]
 ];
 for(const [name,act,check] of steps){
  await act();assert.equal(await check(),true,name);
  assert.deepEqual(musical(await snapshot()),expected,name+' changed musical/session state');
  assert.equal(await evaluate("window.__sessionIdentity==='same-document'&&window.__startTime===performance.timeOrigin"),true,name+' reloaded the document');
  assert.equal(await evaluate("document.querySelector('.search')?.value??JSON.parse(localStorage.getItem('deck-craft.ui.v1')).library.query"),'Orbit',name+' lost the search');
  report.presentationTransitions++;
 }
 report.checks.push(report.presentationTransitions+' presentation changes (mode, deck pair, pad bank, build round trip, theme) preserve four decks, cues, loops, mixer, FX, pitch and library; no iframe or document reload');
 await click('[data-action="pair"][data-value="cd"]');await client.call('Page.reload');
 await until(()=>evaluate("document.querySelector('#app')?.dataset.layout==='console'&&Boolean(document.querySelector('.deck-panel'))"),'reload');
 const paused=structuredClone(expected);for(const deck of Object.values(paused.decks))deck.playing=false;
 assert.deepEqual(musical(await snapshot()),expected,'restoration must not silently overwrite storage before a gesture');
 assert.equal(await evaluate("document.querySelector('section.deck-panel[data-deck=\"C\"] .play').getAttribute('aria-pressed')"),'false');
 await click('[data-action="density"]');paused.library.dense=true;assert.deepEqual(musical(await snapshot()),paused);
 report.checks.push('reload restores preference and musical settings with UI transport paused');
 await select('.theme-picker','ember');
 await close();await launch();
 assert.equal(await evaluate("document.querySelector('.theme-picker').value"),'ember');
 assert.match(await evaluate("document.querySelector('section.deck-lane[data-deck=\"C\"] .remaining').textContent"),/03:17/);
 report.checks.push('theme and position survive a complete Chromium process restart');
 await select('.theme-picker','graphite');await input('.search','');
 for(const [width,height] of [[1920,1080],[1440,900],[1366,768],[1280,720],[390,844],[360,844]]){
  await client.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  for(const pair of ['ab','cd']){
   await click(`[data-action="pair"][data-value="${pair}"]`);
   const geometry=await evaluate(`(()=>{const pick=document.querySelector('.settings-open').getBoundingClientRect();
    const panels=[...document.querySelectorAll('.console-row .deck-panel')].filter(p=>p.getClientRects().length);
    const clipped=panels.some(p=>{const d=p.getBoundingClientRect();return [...p.querySelectorAll('.bpm-value,.pad,.transport button,.elapsed,.remaining')].some(el=>{if(!el.getClientRects().length)return false;const r=el.getBoundingClientRect();return r.right>d.right+1||r.left<d.left-1||r.bottom>d.bottom+1});});
    const wrap=document.querySelector('.table-wrap').getBoundingClientRect();
    const loadRects=[...document.querySelectorAll('tr[data-track-id]:not([hidden]) .load')].map(el=>{const r=el.getBoundingClientRect();return {w:r.width,l:r.left,r:r.right,ok:r.width>=25&&r.left>=wrap.left&&r.right<=wrap.right+1}});const loads=loadRects.every(r=>r.ok);window.__loadDebug=JSON.stringify({wrap:[wrap.left,wrap.right],n:loadRects.length,bad:loadRects.filter(r=>!r.ok).slice(0,2)});
    return {overflow:document.documentElement.scrollWidth>innerWidth,pickerVisible:pick.width>0&&pick.left>=0&&pick.right<=innerWidth,deckCount:panels.length,lanes:[...document.querySelectorAll('.deck-lane')].filter(l=>l.getClientRects().length).length,channels:document.querySelectorAll('.mixer .channel').length,clippedControls:clipped,collectionOverflow:!loads,accent:getComputedStyle(document.body).getPropertyValue('--accent').trim()}})()`);
   assert.equal(geometry.clippedControls,false,pair+' clipped readout/cue bank at '+width);
   assert.equal(geometry.overflow,false,pair+' overflow at '+width);assert.equal(geometry.pickerVisible,true);
   assert.equal(geometry.deckCount,2,pair+' visible deck panels at '+width);
   assert.equal(geometry.lanes,4);assert.equal(geometry.channels,4);
   assert.equal(geometry.collectionOverflow,false,pair+' collection hides load actions at '+width+' '+await evaluate('window.__loadDebug'));
   assert.equal(geometry.accent,'#c8f542',pair+' lost the Night treatment');
   await click('.settings-open');await click('.app-mixer');assert.equal(await evaluate("document.querySelector('.mixer-dialog').open"),true);await click('[data-action="close-mixer"]');
   report.responsiveCases.push({width,height,pair,...geometry});
   if(evidence&&(width===1440||width===390)&&pair==='ab'){const image=await client.call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(evidence,'console-'+width+'.png'),Buffer.from(image.data,'base64'));}
  }
 }
 report.checks.push('12 responsive cases: four lanes, contained transport/clocks/cues, four-channel mixer and reachable collection load actions with no page overflow');
 {
  const accents={graphite:'#c8f542',ember:'#ff7a3d',daylight:'#4f46e5'};
  await client.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await click('[data-action="pair"][data-value="ab"]');
  const before=musical(await snapshot());
  let themed=0;
  for(const [width,height] of [[1440,900],[390,844]]){
   await client.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
   for(const mode of ['perform','prepare']){
    await click(`[data-action="mode"][data-value="${mode}"]`);
    for(const [theme,accent] of Object.entries(accents)){
     await select('.theme-picker',theme);
     await click('.settings-open');
     const probe=await evaluate(`(()=>{const body=document.body,pick=document.querySelector('.theme-picker').getBoundingClientRect(),bar=document.querySelector('.settings-dialog').getBoundingClientRect();return {theme:body.dataset.theme,accent:getComputedStyle(body).getPropertyValue('--accent').trim(),overflow:document.documentElement.scrollWidth>innerWidth,pickInside:pick.left>=0&&pick.right<=innerWidth&&pick.top>=bar.top-1&&pick.bottom<=bar.bottom+1,picker:document.querySelector('.theme-picker').value,glass:getComputedStyle(document.querySelector('.deck-lane .lane-wave')||document.body).backgroundColor}})()`);
     await click('.settings-close');
     assert.equal(probe.theme,theme);assert.equal(probe.accent,accent,mode+' '+theme+' accent token');assert.equal(probe.picker,theme);
     assert.equal(probe.overflow,false,mode+' '+theme+' at '+width+' overflowed horizontally');assert.equal(probe.pickInside,true,mode+' '+theme+' theme picker clipped in Settings at '+width);
     if(mode==='perform')assert.equal(probe.glass,'rgb(5, 6, 10)',theme+' waveform glass must stay dark');
     themed++;
    }
   }
  }
  await click('[data-action="mode"][data-value="perform"]');
  assert.deepEqual(musical(await snapshot()),before,'theme and mode changes alter no musical state');
  await select('.theme-picker','ember');
  await client.call('Page.reload');await until(()=>evaluate("Boolean(document.querySelector('.theme-picker'))"),'theme restore');
  assert.equal(await evaluate("document.body.dataset.theme"),'ember');assert.equal(await evaluate("document.querySelector('.theme-picker').value"),'ember');
  await select('.theme-picker','graphite');
  await client.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  report.themeCases=themed;
  report.checks.push(themed+' theme x mode x width cases: themed tokens, dark waveform glass, no overflow or clipped picker, no musical change, theme restores after reload');
 }
 {
  await client.call('Emulation.setDeviceMetricsOverride',{width:1440,height:2600,deviceScaleFactor:1,mobile:false});
  await evaluate(DRAG_PROBE);await evaluate("window.__dragIdentity=performance.timeOrigin");
  const probe=(method,...args)=>evaluate(`window.__dragProbe.${method}(...${JSON.stringify(args)})`);
  const tracks=['low-orbit','glass-transit','open-water','last-platform'];let drops=0;
  for(const pair of ['ab','cd']) {
   await click(`[data-action="pair"][data-value="${pair}"]`);
   for(const [selector,attribute] of [['section.deck-panel[data-drop-deck]','dropDeck'],['section.deck-lane[data-drop-deck]','dropDeck'],['[data-wave-deck]','waveDeck']]) {
    const targets=await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length).map(e=>e.dataset[${JSON.stringify(attribute)}])`);
    for(const [index,deck] of targets.entries()) {
     const trackId=tracks[drops++%tracks.length],before=musical(await snapshot()),expected=structuredClone(before);
     assert.deepEqual((await probe('start',trackId)).payload,[[DRAG_TYPE,trackId]]);
     assert.deepEqual((await probe('fire','dragover',selector,index)).hover,[deck]);
     assert.deepEqual(await probe('fire','drop',selector,index),{prevented:true,hover:[],dragging:0});
     expected.decks[deck]={...before.decks[deck],trackId,position:0,playing:false,sync:false,cues:[0,48,136,208]};
     assert.deepEqual(musical(await snapshot()),expected,'only the drop target loads, paused');
    }
   }
  }
  await probe('forge',DRAG_TYPE,'low-orbit');
  assert.equal((await probe('fire','dragover','.deck-lane',0)).prevented,false);
  assert.equal((await probe('fire','drop','.deck-lane',0)).prevented,false);
  const frozen=musical(await snapshot());
  await probe('start','low-orbit');await probe('set',DRAG_TYPE,'glass-transit');await probe('fire','drop','.deck-lane',0);
  assert.deepEqual(musical(await snapshot()),frozen,'an altered payload changes nothing');
  await probe('start','low-orbit');await probe('fire','dragover','.deck-lane',0);
  assert.deepEqual((await probe('fire','dragleave','.deck-lane',0,'.deckbar')).hover,[]);
  await probe('fire','dragover','.deck-lane',1);await probe('fire','dragend','@row');
  assert.deepEqual(await probe('state'),{hover:[],dragging:0});
  await click('[data-action="pair"][data-value="ab"]');
  const real=await realDrag('tr[data-track-id="glass-transit"] .name-cell','section.deck-panel[data-deck="B"] .dp-head');
  assert.deepEqual(real.data.items,[{mimeType:DRAG_TYPE,data:'glass-transit'}]);assert.deepEqual(real.hover,['B']);
  assert.equal((await snapshot()).decks.B.trackId,'glass-transit');assert.equal((await snapshot()).decks.B.playing,false);
  const realWave=await realDrag('tr[data-track-id="open-water"] .name-cell','section.deck-lane[data-deck="D"] .wavebox.scroll');
  assert.deepEqual(realWave.hover,['D']);assert.equal((await snapshot()).decks.D.trackId,'open-water');
  await input('section.deck-lane[data-deck="D"] .wave-seek',90);assert.equal((await snapshot()).decks.D.position,90);
  await select('.load-target','A');await click('[data-action="load"][data-track="last-platform"]');assert.equal((await snapshot()).decks.A.trackId,'last-platform');
  assert.deepEqual(await probe('state'),{hover:[],dragging:0});
  assert.equal(await evaluate("window.__dragIdentity===performance.timeOrigin"),true);
  report.checks.push(drops+' console drops cover both deck pairs, all four waveform lanes and each embedded waveform; real pointer drags carry only the opaque ID; foreign/altered drops, hover cleanup, seeking and Load arrow checked');
  await client.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 }
 await input('.search','<img src=x onerror=alert(1)>');assert.equal(await evaluate("document.querySelector('.empty').hidden"),false);assert.equal(await evaluate("document.querySelectorAll('img').length"),0);
 await click('[data-action="clear-search"]');
 await evaluate("localStorage.setItem('unrelated-app','preserve');localStorage.setItem('deck-craft.ui.v1','{broken')");
 await client.call('Page.reload');await until(()=>evaluate("Boolean(document.querySelector('.theme-picker'))"),'corruption recovery');
 assert.equal(await evaluate("document.querySelector('#app').dataset.layout"),'console');assert.match(await evaluate("document.querySelector('.persistence-warning').textContent"),/Recovered/);assert.equal(await evaluate("localStorage.getItem('unrelated-app')"),'preserve');
 report.checks.push('HTML-like search is inert and malformed saved state recovers without clearing other apps');
 await client.call('Page.addScriptToEvaluateOnNewDocument',{source:"Storage.prototype.setItem=function(){throw new DOMException('Denied','QuotaExceededError')}"});
 await client.call('Page.reload');await until(()=>evaluate("Boolean(document.querySelector('.theme-picker'))"),'storage refusal');await select('.theme-picker','ember');
 assert.equal(await evaluate("document.body.dataset.theme"),'ember');assert.match(await evaluate("document.querySelector('.persistence-warning').textContent"),/not saved/);
 report.checks.push('blocked persistence keeps the UI usable and shows an explicit unsaved warning');
 assert.deepEqual(report.errors,[]);
 console.log(JSON.stringify({passed:true,presentationTransitions:report.presentationTransitions,responsiveCases:report.responsiveCases.length,checks:report.checks},null,2));
 if(evidence)await writeFile(path.join(evidence,'browser-report.json'),JSON.stringify(report,null,2));
} finally {await close();await rm(profile,{recursive:true,force:true});}
