// Run with a concrete Node >=22: node --test tests/native-warnings.test.js
// Isolated Chromium DOM integration; native bridge is MOCKED. No audio acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {createSession, serializeSession} from '../src/session.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const capacity = 'Local library changes are not saved: library capacity exceeded.';
const restore = 'Local library could not be restored: invalid saved registry.';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(30); }
  throw Error('Timed out: ' + label);
}
function fixture({ startup = '', blocked = false, tableOnly = false } = {}) {
  const saved=createSession();
  saved.library={...saved.library,crate:'collection-12345678-1234-1234-1234-123456789abc',query:'invisible old query',sort:'order',target:'D'};
  return `(() => {
    localStorage.removeItem('deck-craft.ui.v1');
    ${tableOnly?`localStorage.setItem('deck-craft.ui.v1',${JSON.stringify(serializeSession(saved))});`:''}
    const setItem = Storage.prototype.setItem;
    const track = { id:'local-12345678-1234-1234-1234-123456789abc', title:'Synthetic warning fixture.wav', duration:20, peaks:[] };
    const snapshot = { ready:true, seq:1, engineId:'mock-warning-engine', decks:[] };
    let listener;
    const mock = window.warningFixture = { warning:${JSON.stringify(capacity)}, calls:[], requests:[],
      restoreStorage() { Storage.prototype.setItem=setItem; },
      emitProgress() { listener({type:'import-progress',completed:1,total:2,added:1,failed:0}); },
      emit(warning, present=true) { listener({type:'track',track,...(present?{warning}:{})}); }
    };
    window.deckCraftNative = {
      onEvent(fn) { listener=fn; },
      async command(request) {
        mock.calls.push(request.type);mock.requests.push(request);
        if(request.type==='library') return {ok:true,tracks:${tableOnly?'[track,{...track,id:"local-12345678-1234-1234-1234-123456789abd",title:"Another fixture.wav"}]':'[]'},collections:${tableOnly?JSON.stringify([{id:saved.library.crate,name:'Preserved playlist',kind:'playlist',trackIds:[]}]):'[]'},warning:${JSON.stringify(startup)}};
        if(request.type==='load') return {ok:true,track,snapshot:{...snapshot,seq:++snapshot.seq}};
        if(request.type==='status') return {ok:true,snapshot};
        if(request.type==='pick') return {ok:true,track,snapshot:{...snapshot,seq:++snapshot.seq},warning:mock.warning};
        return {ok:true}; // Ordinary transport replies deliberately have NO warning property.
      }
    };
    ${blocked ? "Storage.prototype.setItem=function(){throw new DOMException('Blocked fixture','QuotaExceededError')};" : ''}
  })();`;
}

test('MOCKED native bridge warnings reach the real renderer DOM', async t => {
  let chrome, ws, server, profile;
  const errors = [], pending = new Map();
  let sequence = 0, pageFixture = '';
  const call = (method, params={}) => new Promise((resolve,reject) => {
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},45000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
  });
  const evaluate = async expression => {
    const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const dom = () => evaluate(`(() => {const e=document.querySelector('.persistence-warning');return {text:e.textContent,visible:!e.hidden&&e.getBoundingClientRect().height>0,saved:document.querySelector('#app').dataset.saved,toast:document.querySelector('.toast').textContent};})()`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fresh = async options => {
    pageFixture=fixture(options);
    await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html?case=${++sequence}`});
    await until(()=>evaluate("Boolean(document.querySelector('.native-import:not(:disabled)'))"),'mock native initialization');
  };
  try {
    server=createServer(async (req,res)=>{
      try {
        const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
        const filename=path.resolve(root,'.'+name);
        if(!filename.startsWith(root)) {res.writeHead(403).end();return;}
        let body=await readFile(filename);
        if(name==='/index.html') body=body.toString().replace('<script type="module"', '<script>'+pageFixture+'</script><script type="module"');
        res.setHeader('Content-Type',filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.svg')?'image/svg+xml':'text/html');res.end(body);
      } catch {res.writeHead(404).end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    assert.ok(process.env.TMPDIR,'Set TMPDIR to a private scratch directory');
    profile=await mkdtemp(path.join(process.env.TMPDIR,'deckcraft-warning-dom-'));
    chrome=spawn(process.env.CHROMIUM||'/usr/bin/chromium',['--headless=new','--no-proxy-server','--disable-background-networking','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
    chrome.stderr.on('data', b => { if(process.env.WARNING_BROWSER_DEBUG) process.stderr.write(b); });
    let port;
    await until(async()=>{try {port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);return !!port;} catch{return false;}},'Chromium');
    const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws=new WebSocket(targets.find(x=>x.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    ws.addEventListener('message',event=>{
      const m=JSON.parse(String(event.data));
      if(process.env.WARNING_BROWSER_DEBUG && (m.id || m.method==='Page.frameNavigated')) console.error(JSON.stringify(m));
      if(m.id) {const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}
      else if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    });
    await call('Runtime.enable');await call('Page.enable');
    await t.test('table-only library renders in both workspaces and duplicate canvas browsers, ignores saved filters and retains row loading',async()=>{
      await fresh({tableOnly:true});
      await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
      const stored=await evaluate("JSON.parse(localStorage.getItem('deck-craft.ui.v1'))");
      const evidence=process.env.DECKCRAFT_EVIDENCE_DIR;const geometries=[];
      if(evidence)await mkdir(evidence,{recursive:true});
      const calls=await evaluate('warningFixture.calls.length');
      for(const layout of ['perform','prepare']) {
        await evaluate(`document.querySelector('[data-action="mode"][data-value="${layout}"]').click()`);
        const geometry=await evaluate(`(()=>{const p=document.querySelector('.local-library'),t=p.querySelector('.table-wrap'),f=p.querySelector('.library-feedback');return {rows:p.querySelectorAll('tr[data-track-id]:not([hidden])').length,removed:p.querySelectorAll('.library-toolbar,.library-imports,.library-navigation,.library-selection,.load-choice').length,gap:t.getBoundingClientRect().top-p.querySelector('.library-main').getBoundingClientRect().top,statusHeight:f.getBoundingClientRect().height,load:p.querySelector('tr:not([hidden]) .load').disabled};})()`);
        assert.equal(geometry.rows,2,layout);assert.equal(geometry.removed,0);assert.ok(geometry.gap<=1,JSON.stringify(geometry));assert.equal(geometry.statusHeight,0);assert.equal(geometry.load,false);geometries.push({layout,...geometry});
        if(evidence){const image=await call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(evidence,'local-library-'+layout+'.png'),Buffer.from(image.data,'base64'));}
      }
      await click('.canvas-entry');
      for(let i=0;i<2;i++)await click('[data-editor="add"][data-kind="browser"]');
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.canvas-stage .local-library')].map(p=>p.querySelectorAll('tr[data-track-id]:not([hidden])').length)"),[2,2]);
      if(evidence){const image=await call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(evidence,'local-library-canvas.png'),Buffer.from(image.data,'base64'));await writeFile(path.join(evidence,'local-library-geometry.json'),JSON.stringify(geometries,null,2));}
      await evaluate('warningFixture.emitProgress()');
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.local-library .library-feedback')].map(e=>({text:e.textContent,visible:e.getBoundingClientRect().height>0}))"),Array(2).fill({text:'Importing 1 / 2 · 1 added · 0 failed',visible:true}));
      const after=await evaluate("JSON.parse(localStorage.getItem('deck-craft.ui.v1'))");
      assert.deepEqual(after.library,stored.library);assert.deepEqual(after.decks,stored.decks);assert.deepEqual(after.mixer,stored.mixer);
      assert.equal(await evaluate('warningFixture.calls.length'),calls,'layout/canvas render must not issue native commands');
      await evaluate("document.querySelector('.local-library tr:not([hidden]) .load').click()");
      await until(()=>evaluate("warningFixture.requests.some(r=>r.type==='load'&&r.deck==='D')"),'row load into retained target D');
      assert.equal(await evaluate("JSON.parse(localStorage.getItem('deck-craft.ui.v1')).decks.D.playing"),false);
      await evaluate("warningFixture.emit(undefined,false)");
      // Global import still works; progress/status paints must not require removed controls.
      await evaluate("warningFixture.requests.length=0");
      await click('.native-import');
      await until(()=>evaluate("warningFixture.calls.includes('pick')&&!document.querySelector('.native-import').disabled"),'global import after canvas');
      await click('[data-action="mode"][data-value="perform"]'); // leave the canvas so later subtests start on the console
    });
    await t.test('startup restore warning is persistently visible and not saved',async()=>{
      await fresh({startup:restore});
      const d=await dom();assert.equal(d.visible,true);assert.equal(d.text,restore);assert.equal(d.saved,'false');
    });
    await t.test('waveform capacity event survives ordinary transport replies, absent event warning, and layout remount',async()=>{
      await fresh();await evaluate(`warningFixture.emit(${JSON.stringify(capacity)})`);
      let d=await dom();assert.equal(d.visible,true);assert.equal(d.text,capacity);assert.equal(d.saved,'false');
      await evaluate(`(()=>{const e=document.querySelector('[data-action="crossfader"]');e.value=31;e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await until(()=>evaluate("warningFixture.calls.filter(x=>x==='crossfader').length===2"),'ordinary transport reply');
      await evaluate('warningFixture.emit(undefined,false)');
      await evaluate(`(()=>{document.querySelector('[data-editor="open-canvas"]').click();document.querySelector('[data-action="mode"][data-value="perform"]').click();})()`);
      d=await dom();assert.equal(d.visible,true);assert.equal(d.text,capacity);assert.equal(d.saved,'false');
      await evaluate("warningFixture.emit('')");
      d=await dom();assert.equal(d.visible,false);assert.equal(d.text,'');assert.equal(d.saved,'true');
    });
    await t.test('import success toast cannot replace persistent warning; later save clears native warning',async()=>{
      await fresh();await click('.native-import');
      await until(()=>evaluate("document.querySelector('.toast').textContent.startsWith('Loaded ')") ,'import completion');
      let d=await dom();assert.match(d.toast,/Ready, paused/);assert.equal(d.visible,true);assert.equal(d.text,capacity);assert.equal(d.saved,'false');
      await delay(2900);d=await dom();assert.equal(d.toast,'');assert.equal(d.visible,true);
      await evaluate("warningFixture.warning='' ");await click('.native-import');
      await until(()=>evaluate("warningFixture.calls.filter(x=>x==='pick').length===2&&!document.querySelector('.native-import').disabled"),'successful library save');
      d=await dom();assert.equal(d.visible,false);assert.equal(d.text,'');assert.equal(d.saved,'true');
    });
    await t.test('native save recovery retains independent renderer-storage warning',async()=>{
      await fresh({blocked:true});await evaluate(`warningFixture.emit(${JSON.stringify(capacity)})`);
      await click('[data-action="mode"][data-value="prepare"]');
      let d=await dom();assert.match(d.text,/Changes are not saved/);assert.ok(d.text.includes(capacity));assert.equal(d.visible,true);assert.equal(d.saved,'false');
      await evaluate("warningFixture.warning='' ");await click('.native-import');
      await until(()=>evaluate("warningFixture.calls.includes('pick')&&!document.querySelector('.native-import').disabled"),'successful save with renderer refusal');
      d=await dom();assert.match(d.text,/Changes are not saved/);assert.ok(!d.text.includes(capacity));assert.equal(d.visible,true);assert.equal(d.saved,'false');
    });
    await t.test('renderer save recovery retains independent native warning',async()=>{
      await fresh({startup:restore,blocked:true});await click('[data-action="mode"][data-value="prepare"]');
      let d=await dom();assert.match(d.text,/Changes are not saved/);assert.ok(d.text.includes(restore));
      await evaluate('warningFixture.restoreStorage()');await click('[data-action="mode"][data-value="perform"]');
      d=await dom();assert.equal(d.text,restore);assert.equal(d.visible,true);assert.equal(d.saved,'false');
    });
    assert.deepEqual(errors,[],'renderer runtime errors');
  } finally {
    if(chrome){const exited=new Promise(resolve=>chrome.once('exit',resolve));try{await call('Browser.close');}catch{}await Promise.race([exited,delay(3000)]);if(chrome.exitCode===null){chrome.kill('SIGKILL');await exited;}}
    ws?.close();for(const p of pending.values())clearTimeout(p.timer);
    if(server)await new Promise(resolve=>server.close(resolve));
    if(profile)await rm(profile,{recursive:true,force:true});
  }
});
