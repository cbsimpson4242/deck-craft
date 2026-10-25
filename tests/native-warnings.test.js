// Run with a concrete Node >=22: node --test tests/native-warnings.test.js
// Isolated Chromium DOM integration; native bridge is MOCKED. No audio acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const capacity = 'Local library changes are not saved: library capacity exceeded.';
const restore = 'Local library could not be restored: invalid saved registry.';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(30); }
  throw Error('Timed out: ' + label);
}
function fixture({ startup = '', blocked = false } = {}) {
  return `(() => {
    localStorage.removeItem('deck-craft.ui.v1');
    const setItem = Storage.prototype.setItem;
    const track = { id:'local-12345678-1234-1234-1234-123456789abc', title:'Synthetic warning fixture.wav', duration:20, peaks:[] };
    const snapshot = { ready:true, seq:1, engineId:'mock-warning-engine', decks:[] };
    let listener;
    const mock = window.warningFixture = { warning:${JSON.stringify(capacity)}, calls:[],
      restoreStorage() { Storage.prototype.setItem=setItem; },
      emit(warning, present=true) { listener({type:'track',track,...(present?{warning}:{})}); }
    };
    window.deckCraftNative = {
      onEvent(fn) { listener=fn; },
      async command(request) {
        mock.calls.push(request.type);
        if(request.type==='library') return {ok:true,tracks:[],warning:${JSON.stringify(startup)}};
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
      await evaluate(`(()=>{const e=document.querySelector('.layout-picker');e.value='signal-wide';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
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
      await click('[data-action="density"]');
      let d=await dom();assert.match(d.text,/Changes are not saved/);assert.ok(d.text.includes(capacity));assert.equal(d.visible,true);assert.equal(d.saved,'false');
      await evaluate("warningFixture.warning='' ");await click('.native-import');
      await until(()=>evaluate("warningFixture.calls.includes('pick')&&!document.querySelector('.native-import').disabled"),'successful save with renderer refusal');
      d=await dom();assert.match(d.text,/Changes are not saved/);assert.ok(!d.text.includes(capacity));assert.equal(d.visible,true);assert.equal(d.saved,'false');
    });
    await t.test('renderer save recovery retains independent native warning',async()=>{
      await fresh({startup:restore,blocked:true});await click('[data-action="density"]');
      let d=await dom();assert.match(d.text,/Changes are not saved/);assert.ok(d.text.includes(restore));
      await evaluate('warningFixture.restoreStorage()');await click('[data-action="density"]');
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
