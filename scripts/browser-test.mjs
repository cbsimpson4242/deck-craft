import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAYOUTS } from '../src/catalog.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=pathToFileURL(path.join(root,'dist/deck-craft.html')).href;
const parent=process.env.TMPDIR||path.join(homedir(),'.cache');
await mkdir(parent,{recursive:true});
const profile=await mkdtemp(path.join(parent,'deckcraft-browser-'));
const evidence=process.env.DECKCRAFT_EVIDENCE_DIR;
if(evidence)await mkdir(evidence,{recursive:true});
const report={layoutTransitions:0,responsiveCases:[],checks:[],errors:[]};
let chrome,client;
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
 ws.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.id){const item=pending.get(message.id);if(item){pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);}}else if(message.method==='Runtime.exceptionThrown'){report.errors.push(message.params.exceptionDetails.text+' '+(message.params.exceptionDetails.exception?.description||''));}});
 client={ws,call:(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));})};
 await client.call('Runtime.enable');await client.call('Page.enable');
 await client.call('Page.navigate',{url});
 await until(()=>evaluate("Boolean(document.querySelector('.layout-picker'))"),'application startup');
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
try {
 await launch();
 assert.equal(await evaluate("document.querySelector('#app').dataset.layout"),'studio-sync');
 assert.equal(await evaluate("document.querySelectorAll('iframe').length"),0);
 await evaluate("window.__sessionIdentity='same-document';window.__startTime=performance.timeOrigin");
 await select('.load-target','C');await click('[data-action="load"][data-track="quiet-motion"]');
 await input('[data-action="deck-number"][data-deck="C"][data-field="position"]',177.3);
 await click('section[data-deck="C"] [data-action="hot-cue"][data-index="1"]',true);
 await click('section[data-deck="C"] [data-action="toggle-deck"][data-field="playing"]');
 await click('section[data-deck="C"] [data-field="loopEnabled"]');
 await click('section[data-deck="C"] [data-action="loop-size"][data-factor="2"]');
 await click('.app-mixer');
 await input('.mixer-dialog [data-deck="A"][data-field="hi"]',70);
 await input('.mixer-dialog [data-deck="D"][data-field="level"]',55);
 await input('.mixer-dialog [data-action="crossfader"]',31);
 await click('.mixer-dialog [data-action="toggle-fx"][data-effect="echo"]');
 await input('.mixer-dialog [data-action="fx-wet"][data-effect="echo"]',62);
 await click('[data-action="close-mixer"]');
 await select('.layout-picker','signal-one');
 await input('[data-deck="A"][data-field="pitch"]',2.5);
 await input('.search','Orbit');
 const expected=musical(await snapshot());
 assert.equal(expected.decks.C.cues[1],177.3);assert.equal(expected.decks.C.playing,true);
 for(const from of LAYOUTS){
   await select('.layout-picker',from.id);
   for(const to of LAYOUTS){
     await select('.layout-picker',to.id);
     assert.equal(await evaluate("document.querySelector('#app').dataset.layout"),to.id);
     assert.deepEqual(musical(await snapshot()),expected,'layout transition changed musical/session state');
     assert.equal(await evaluate("window.__sessionIdentity==='same-document'&&window.__startTime===performance.timeOrigin"),true,'document reloaded');
     assert.equal(await evaluate("document.querySelector('.search').value"),'Orbit');
     if(to.decks===2){assert.equal(await evaluate("document.querySelector('.hidden-decks').hidden"),false);assert.match(await evaluate("document.querySelector('[data-hidden-deck=\"C\"]').textContent"),/Quiet Motion.*UI transport on/s);}
     report.layoutTransitions++;
   }
 }
 report.checks.push('all 25 ordered transitions preserve four decks, cues, loops, mixer, FX, pitch and library; no iframe or document reload');
 await select('.layout-picker','signal-wide');await click('[data-action="show-four"]');
 assert.equal(await evaluate("document.querySelector('.layout-picker').value"),'studio-sync');assert.equal((await snapshot()).pair,'cd');assert.deepEqual(musical(await snapshot()),expected);
 report.checks.push('active hidden C/D indicator and quick access to the four-deck view');
 await select('.layout-picker','studio-linear');await client.call('Page.reload');
 await until(()=>evaluate("document.querySelector('#app')?.dataset.layout==='studio-linear'"),'reload');
 const paused=structuredClone(expected);for(const deck of Object.values(paused.decks))deck.playing=false;
 assert.deepEqual(musical(await snapshot()),expected,'restoration must not silently overwrite storage before a gesture');
 assert.equal(await evaluate("document.querySelector('section[data-deck=\"C\"] .play').getAttribute('aria-pressed')"),'false');
 await click('[data-action="density"]');paused.library.dense=true;assert.deepEqual(musical(await snapshot()),paused);
 report.checks.push('reload restores preference and musical settings with UI transport paused');
 await close();await launch();
 assert.equal(await evaluate("document.querySelector('.layout-picker').value"),'studio-linear');
 assert.match(await evaluate("document.querySelector('section[data-deck=\"C\"] .remaining').textContent"),/03:17/);
 report.checks.push('layout preference and position survive a complete Chromium process restart');
 await input('.search','');
 for(const width of [1440,1280,390,360]){
  await client.call('Emulation.setDeviceMetricsOverride',{width,height:width>1000?1000:844,deviceScaleFactor:1,mobile:false});
  for(const layout of LAYOUTS){
   await select('.layout-picker',layout.id);
   if(layout.id==='studio-linear')await click('[data-action="cue-disclosure"]');
   const geometry=await evaluate(`(()=>{const s=document.querySelector('.layout-picker').getBoundingClientRect(),h=document.querySelector('.appbar').getBoundingClientRect();const clipped=[...document.querySelectorAll('section.deck .bpm-value,section.deck .pad')].some(el=>{if(!el.getClientRects().length)return false;const r=el.getBoundingClientRect(),d=el.closest('section.deck').getBoundingClientRect();return r.right>d.right+1||r.bottom>d.bottom+1||r.left<d.left-1});return {overflow:document.documentElement.scrollWidth>innerWidth,pickerVisible:s.width>100&&s.left>=h.left&&s.right<=h.right,deckCount:document.querySelectorAll('section.deck').length,clippedControls:clipped}})()`);
   assert.equal(geometry.clippedControls,false,layout.id+' clipped readout/cue bank at '+width);
   assert.equal(geometry.overflow,false,layout.id+' overflow at '+width);assert.equal(geometry.pickerVisible,true);assert.equal(geometry.deckCount,layout.decks);
   await click('.app-mixer');assert.equal(await evaluate("document.querySelector('.mixer-dialog').open"),true);assert.equal(await evaluate("getComputedStyle(document.querySelector('.mixer-dialog .channel-strips')).display"),'flex');await click('[data-action="close-mixer"]');
   report.responsiveCases.push({width,layout:layout.id,...geometry});
   if(evidence&&(width===1440||width===390)){const image=await client.call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(evidence,layout.id+'-'+width+'.png'),Buffer.from(image.data,'base64'));}
  }
 }
 report.checks.push('20 responsive layout cases and four-channel mixer dialog at every viewport');
 await select('.layout-picker','studio-grid');
 await input('.search','<img src=x onerror=alert(1)>');await select('.layout-picker','studio-sync');assert.equal(await evaluate("document.querySelector('.empty').hidden"),false);assert.equal(await evaluate("document.querySelectorAll('img').length"),0);
 await click('[data-action="clear-search"]');
 await evaluate("localStorage.setItem('unrelated-app','preserve');localStorage.setItem('deck-craft.ui.v1','{broken')");
 await client.call('Page.reload');await until(()=>evaluate("Boolean(document.querySelector('.layout-picker'))"),'corruption recovery');
 assert.equal(await evaluate("document.querySelector('.layout-picker').value"),'studio-sync');assert.match(await evaluate("document.querySelector('.persistence-warning').textContent"),/Recovered/);assert.equal(await evaluate("localStorage.getItem('unrelated-app')"),'preserve');
 report.checks.push('HTML-like search is inert and malformed saved state recovers without clearing other apps');
 await client.call('Page.addScriptToEvaluateOnNewDocument',{source:"Storage.prototype.setItem=function(){throw new DOMException('Denied','QuotaExceededError')}"});
 await client.call('Page.reload');await until(()=>evaluate("Boolean(document.querySelector('.layout-picker'))"),'storage refusal');await select('.layout-picker','signal-wide');
 assert.equal(await evaluate("document.querySelector('#app').dataset.layout"),'signal-wide');assert.match(await evaluate("document.querySelector('.persistence-warning').textContent"),/not saved/);
 report.checks.push('blocked persistence keeps the UI usable and shows an explicit unsaved warning');
 assert.deepEqual(report.errors,[]);
 console.log(JSON.stringify({passed:true,layoutTransitions:report.layoutTransitions,responsiveCases:report.responsiveCases.length,checks:report.checks},null,2));
 if(evidence)await writeFile(path.join(evidence,'browser-report.json'),JSON.stringify(report,null,2));
} finally {await close();await rm(profile,{recursive:true,force:true});}
