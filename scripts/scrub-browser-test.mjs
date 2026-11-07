// Real Chromium pointer, touch and keyboard regressions for waveform scrubbing and zoom, plus the hot-path
// rendering guards. Browser-only pages use the real UI; the "native" pages use scripts/mock-native-bridge.mjs
// (a MOCK: no audio, no native engine, no latency claim). Native behavior is covered by test:native/test:desktop.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAYOUTS } from '../src/catalog.js';
import { createSession } from '../src/session.js';
import { SEEK_INTERVAL_MS } from '../src/scrub.js';
import { timeLabel } from '../src/components.js';
import { mockBridgeSource, mockTracks } from './mock-native-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = pathToFileURL(process.env.DECKCRAFT_APP_HTML || path.join(root, 'dist/deck-craft.html')).href;
const parent = process.env.TMPDIR || path.join(homedir(), '.cache');
await mkdir(parent, { recursive: true });
const profile = await mkdtemp(path.join(parent, 'deckcraft-scrub-'));
const evidence = process.env.DECKCRAFT_EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
const tracks = mockTracks();
const KEY = 'deck-craft.ui.v1';
const report = { checks: [], errors: [], perf: {} };
const pending = new Map();
let chrome, ws, sequence = 0, navigation = 0, seedScript = null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await delay(25); }
  throw Error('Timed out: ' + label);
}
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 30000);
  pending.set(id, { resolve, reject, timer });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function launch() {
  chrome = spawn(process.env.CHROMIUM || 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', () => {});
  const port = await until(async () => Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'Chromium startup');
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const item = pending.get(m.id); if (item) { pending.delete(m.id); clearTimeout(item.timer); m.error ? item.reject(Error(m.error.message)) : item.resolve(m.result); } }
    else if (m.method === 'Runtime.exceptionThrown') report.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await call('Page.enable'); await call('Runtime.enable'); await call('Performance.enable');
}
async function open({ bridge = false, seed = null, width = 1440, height = 900 } = {}) {
  if (seedScript) await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedScript });
  const token = ++navigation;
  const source = `(() => { if (sessionStorage.getItem('seed-token') !== '${token}') { localStorage.clear(); ${seed ? `localStorage.setItem('${KEY}', ${JSON.stringify(JSON.stringify(seed))});` : ''} sessionStorage.setItem('seed-token', '${token}'); } })();` + (bridge ? mockBridgeSource(tracks) : '');
  seedScript = (await call('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: app + '?n=' + token });
  await until(() => evaluate("Boolean(document.querySelector('.settings-open'))"), 'application');
  if (bridge) await until(() => evaluate("(()=>{const b=document.querySelector('.native-import');return Boolean(b&&!b.disabled)})()"), 'mock native initialization');
}
const stored = () => evaluate(`JSON.parse(localStorage.getItem('${KEY}'))`);
const select = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const musical = (state) => ({ decks: state.decks, mixer: state.mixer, library: state.library });
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const near = (actual, expected, label, epsilon = 5e-4) => assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} !~ ${expected}`);

// Visible detail waveform of a deck: its rectangle (after scrolling it into view) and how many exist.
const waveRect = (deck, nth = 0, scope = '') => evaluate(`(()=>{const list=[...document.querySelectorAll(${JSON.stringify(scope + ' [data-wave-deck="' + deck + '"].detail')})].filter(e=>e.getClientRects().length&&!e.closest('[hidden]')&&!e.closest('.design-preview'));const e=list[${nth}];if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,count:list.length,fit:e.classList.contains('fit'),label:e.querySelector('.zoom-label')?.textContent}})()`);
const mouse = (type, x, y, pressed) => call('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !pressed ? 'none' : 'left', buttons: pressed ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
async function drag(deck, dx, { nth = 0, scope = '', steps = 10, dwell = 14, startFrac = 0.3, hold = false } = {}) {
  const r = await waveRect(deck, nth, scope);
  assert.ok(r, 'no visible waveform for deck ' + deck);
  const x0 = r.x + r.w * startFrac, y = r.y + r.h * 0.62;
  await mouse('mouseMoved', x0, y, false); await mouse('mousePressed', x0, y, true);
  for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x0 + (dx * i) / steps, y, true); await delay(dwell); }
  if (!hold) await mouse('mouseReleased', x0 + dx, y, false);
  return { ...r, x0, y, x1: x0 + dx };
}
const release = (x, y) => mouse('mouseReleased', x, y, false);
const seedSession = (mutate = () => {}) => { const s = createSession(); mutate(s); return s; };



const clockText = (deck) => evaluate(`document.querySelector('section.deck[data-deck="${deck}"] .elapsed').textContent`);
const mockState = () => evaluate('JSON.parse(JSON.stringify({calls:__mock.calls.map(c=>({type:c.type,position:c.position,deck:c.deck})),A:__mock.engine.decks.A}))');
const mockSeeks = () => evaluate('__mock.seeks().map(c=>c.position)');
const toast = () => evaluate("document.querySelector('.toast').textContent");


const duration=300;
const nativeSeed=()=>seedSession(s=>{s.decks.A.trackId=tracks[0].id;s.decks.A.position=60;s.decks.B.trackId=tracks[1].id;s.decks.B.position=30;});
const position=()=>evaluate('__mock.engine.decks.A.position');
const playing=()=>evaluate('__mock.engine.decks.A.playing');
const zoom=()=>evaluate('Number(document.querySelector("[data-wave-deck=A].detail").dataset.waveZoom)');
async function zoomIn(){await click('[data-wave-deck=A].detail [data-action=zoom-in]');}
async function readyDrag(dx,opts={}){const r=await waveRect('A');const z=await zoom(),base=await position();const h=await drag('A',dx,opts);return {...h,z,base,target:clamp(base-dx*duration/z/r.w,0,duration)};}
const metrics=async()=>Object.fromEntries((await call('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
async function measure(action){
 await evaluate("(()=>{const sample=window.__frames={t:[],raf:0};const loop=t=>{if(window.__frames!==sample)return;sample.t.push(t);sample.raf=requestAnimationFrame(loop)};sample.raf=requestAnimationFrame(loop)})()");
 const a=await metrics(),start=Date.now();await action();const b=await metrics(),seconds=(Date.now()-start)/1000;
 const times=await evaluate('(()=>{const s=window.__frames;cancelAnimationFrame(s.raf);window.__frames=null;return s.t})()');
 return {fps:+((times.length-1)*1000/(times.at(-1)-times[0])).toFixed(1),mainThreadBusyFraction:+((b.TaskDuration-a.TaskDuration)/seconds).toFixed(3)};
}
try{
 await launch();await open({bridge:true,seed:nativeSeed()});
 await zoomIn();
 const coarse=await readyDrag(-60,{steps:12});await until(async()=>Math.abs(await position()-coarse.target)<.001,'coarse paused target');
 assert.equal(await playing(),false);
 await zoomIn();const fine=await readyDrag(60,{steps:12});await until(async()=>Math.abs(await position()-fine.target)<.001,'fine paused target');
 assert.ok((coarse.target-coarse.base)>Math.abs(fine.target-fine.base),'finer actual zoom gives less time per pixel');
 report.checks.push('real pointer drags use the current wheel viewport, preserve paused state and deliver the exact final target');
 // Wheel changes the same viewport used by dragging, without a musical state change.
 const beforeWheel=await position(),r=await waveRect('A'),z=await zoom();
 await mouse('mouseMoved',r.x+r.w*.5,r.y+r.h*.6,false);
 await call('Input.dispatchMouseEvent',{type:'mouseWheel',x:r.x+r.w*.5,y:r.y+r.h*.6,deltaY:-120,deltaX:0});await delay(80);
 assert.ok(await zoom()>z);assert.equal(await position(),beforeWheel);
 const wheeled=await readyDrag(-40);await until(async()=>Math.abs(await position()-wheeled.target)<.001,'wheel-scaled pointer seek');
 // Keyboard routes through the same bounded queue; fit remains an absolute seek surface.
 await evaluate('document.querySelector("[data-wave-deck=A].detail").focus()');
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home'});
 await until(async()=>await position()===0,'keyboard Home');
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End'});
 await until(async()=>await position()===300,'keyboard End');
 report.checks.push('wheel zoom and keyboard Home/End retain their console behavior');
 await open({bridge:true,seed:nativeSeed()});await zoomIn();
 // Paused pointer movement produces no decoder work until release.
 await evaluate('__mock.calls.length=0');const held=await readyDrag(-80,{hold:true});assert.deepEqual(await mockSeeks(),[]);await release(held.x1,held.y);
 await until(async()=>(await mockSeeks()).length===1,'one paused release seek');near((await mockSeeks())[0],held.target,'paused target');
 await until(()=>evaluate("!document.querySelector('section.deck[data-deck=A] .play').disabled"),'paused seek acknowledged');
 // Playing scrubs progress during movement, use bounded requests, and retain the final target.
 await click('section.deck[data-deck=A] .play');await until(playing,'playing');await evaluate('__mock.calls.length=0');
 const moving=await readyDrag(-100,{steps:30,dwell:14});await delay(250);
 const calls=await evaluate('__mock.calls.filter(c=>c.type==="seek")'),requests=calls.map(c=>c.position);
 const elapsed=calls.at(-1).at-calls[0].at;
 assert.ok(requests.length>=2&&requests.length<=Math.ceil(elapsed/90)+2,`bounded seek count over ${elapsed} ms: ${JSON.stringify(calls)}`);
 for(let i=1;i<calls.length-1;i++)assert.ok(calls[i].at-calls[i-1].at>=80,`interim seeks stay rate limited: ${JSON.stringify(calls)}`);
 near(requests.at(-1),moving.target,'playing final target');assert.equal(await playing(),true);
 assert.deepEqual((await evaluate('__mock.types()')).filter(t=>t!=='seek'),[]);
 report.checks.push('playing drag sends bounded intermediate seeks, one latest final target, and no pause/play/load commands');
 // Seek failure must clear a held preview before release, without replay.
 await evaluate('__mock.failures.push("seek_failed");__mock.calls.length=0');
 const failed=await readyDrag(-60,{hold:true});await until(async()=>await evaluate("document.querySelectorAll('.scrubbing').length===0"),'failure clears held preview');await release(failed.x1,failed.y);await delay(150);assert.equal((await mockSeeks()).length,1);
 await click('section.deck[data-deck=A] .play');await until(async()=>!(await playing()),'paused');
 // Touch cancellation discards the paused target.
 await evaluate('__mock.calls.length=0');await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 const touch=await waveRect('A'),ty=touch.y+touch.h*.65,tx=touch.x+touch.w*.6;
 await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx,y:ty}]});
 await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx-60,y:ty}]});await delay(60);
 await call('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await delay(100);assert.deepEqual(await mockSeeks(),[]);
 await call('Emulation.setTouchEmulationEnabled',{enabled:false});
 report.checks.push('failed held drags and cancelled touch gestures clear their previews without replay');
 // Build uses the same waveform and source; workspace replacement cancels an old paused gesture.
 await evaluate('__mock.calls.length=0');const cancelled=await readyDrag(-80,{hold:true});await click('.canvas-entry');await release(cancelled.x1,cancelled.y);await delay(100);assert.deepEqual(await mockSeeks(),[]);
 await click('[data-editor=add][data-kind=waveform]');
 const built=await waveRect('A');assert.ok(built);await click('[data-wave-deck=A].detail [data-action=zoom-in]');
 const buildDrag=await readyDrag(-30);await until(async()=>Math.abs(await position()-buildDrag.target)<.001,'Build uses shared scrub');
 report.checks.push('Build shares scrub controls and view replacement cancels queued paused targets');
 // Stable playing receipts must not touch the library/header or query DOM elements on the hot path.
 await open({bridge:true,seed:nativeSeed()});await click('section.deck[data-deck=A] .play');await until(playing,'playing for hot path');
 await evaluate(`(()=>{const raw=Element.prototype.closest;const count=window.__q={n:0};for(const proto of [Element.prototype,Document.prototype])for(const method of ['querySelector','querySelectorAll']){const original=proto[method];proto[method]=function(...args){count.n++;return original.apply(this,args)}}const writes=window.__writes={cold:0};window.__observer=new MutationObserver(records=>{for(const record of records){const node=record.target.nodeType===1?record.target:record.target.parentElement;if(node&&raw.call(node,'.library,.deckbar,.settings-dialog'))writes.cold++;}});window.__observer.observe(document.body,{subtree:true,attributes:true,characterData:true,childList:true});})()`);
 await evaluate('__mock.start(60)');await delay(1300);await evaluate('__mock.stop()');
 const hot=await evaluate('({queries:__q.n,coldWrites:__writes.cold,receipts:__mock.emits})');assert.equal(hot.queries,0);assert.equal(hot.coldWrites,0);assert.ok(hot.receipts>40);report.perf.hotPath=hot;
 await evaluate('__mock.start(60)');report.perf.playback=await measure(()=>delay(2500));await evaluate('__mock.stop()');
 assert.ok(report.perf.playback.fps>=35,'software renderer remains responsive');
 report.checks.push('native clock hot path uses cached canvas/transport elements and leaves library/header/Settings untouched');
 assert.deepEqual(report.errors,[]);if(evidence)await writeFile(path.join(evidence,'scrub-browser-report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:true,...report},null,2));
}finally{
 if(chrome){const exited=new Promise(resolve=>chrome.once('exit',resolve));try{await call('Browser.close')}catch{}await Promise.race([exited,delay(3000)]);if(chrome.exitCode===null){chrome.kill('SIGKILL');await exited;}}
 ws?.close();for(const p of pending.values())clearTimeout(p.timer);await rm(profile,{recursive:true,force:true});
}
