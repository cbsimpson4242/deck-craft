// Run with a concrete Node >=22 and TMPDIR set: node --test tests/track-drag-native.test.js
// Isolated Chromium DOM integration; the native bridge is MOCKED. No audio, device or native-engine acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRAG_PROBE, DRAG_TYPE } from '../scripts/drag-probe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const A = 'local-11111111-1111-1111-1111-111111111111', B = 'local-22222222-2222-2222-2222-222222222222';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(30); }
  throw Error('Timed out: ' + label);
}
// The mock records every request exactly as the renderer sent it and answers loads like the native authority does:
// the deck is loaded and paused. Requests carry opaque IDs only; this mock has no path to resolve.
const fixture = `(() => {
  localStorage.removeItem('deck-craft.ui.v1');
  const tracks = [{ id:'${A}', title:'Synthetic drag A.wav', duration:200, peaks:[] }, { id:'${B}', title:'Synthetic drag B.wav', duration:300, peaks:[] }];
  const decks = {}; let seq = 1;
  const snapshot = () => ({ ready:true, seq:++seq, engineId:'mock-drag-engine', decks:Object.values(decks) });
  let listener;
  const mock = window.dragFixture = { calls:[], emit() { decks.C ||= {id:"C",trackId:tracks[1].id,position:0,playing:true,loading:false,level:78}; decks.C.playing=true; decks.C.position+=1; listener({type:"state",snapshot:snapshot()}); } };
  window.deckCraftNative = {
    onEvent(fn) { listener=fn; },
    async command(request) {
      mock.calls.push(JSON.parse(JSON.stringify(request)));
      if (request.type === 'library') return { ok:true, tracks, collections:[] };
      if (request.type === 'status') return { ok:true, snapshot:{ ready:true, seq:1, engineId:'mock-drag-engine', decks:[] } };
      if (request.type === 'load') {
        const track = tracks.find(t => t.id === request.trackId);
        if (!track) return { ok:false, error:'file_unavailable' };
        decks[request.deck] = { id:request.deck, trackId:track.id, position:0, playing:false, loading:false, level:78 };
        return { ok:true, track, snapshot:snapshot() };
      }
      return { ok:true, snapshot:snapshot() };
    }
  };
})();`;

test('MOCKED native bridge: library drags load local tracks paused through the shared load request and refuse demo or invalid drops', async t => {
  let chrome, ws, server, profile, pageFixture = '';
  const errors = [], pending = new Map();
  let sequence = 0, dragData = null;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 45000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const probe = (method, ...args) => evaluate(`window.__dragProbe.${method}(...${JSON.stringify(args)})`);
  const select = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const calls = () => evaluate('dragFixture.calls');
  const loads = async () => (await calls()).filter(c => c.type === 'load');
  const snapshot = () => evaluate("JSON.parse(localStorage.getItem('deck-craft.ui.v1'))");
  const fresh = async () => {
    pageFixture = fixture;
    await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html?case=${++sequence}` });
    await until(() => evaluate("Boolean(document.querySelector('.native-import:not(:disabled)'))"), 'mock native initialization');
    await evaluate(DRAG_PROBE);
  };
  const visibleDecks = (selector, attribute) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length).map(e=>e.dataset[${JSON.stringify(attribute)}])`);
  try {
    server = createServer(async (req, res) => {
      try {
        const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const filename = path.resolve(root, '.' + name);
        if (!filename.startsWith(root)) { res.writeHead(403).end(); return; }
        let body = await readFile(filename);
        if (name === '/index.html') body = body.toString().replace('<script type="module"', '<script>' + pageFixture + '</script><script type="module"');
        res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
        res.end(body);
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    assert.ok(process.env.TMPDIR, 'Set TMPDIR to a private scratch directory');
    profile = await mkdtemp(path.join(process.env.TMPDIR, 'deckcraft-drag-dom-'));
    chrome = spawn(process.env.CHROMIUM || '/usr/bin/chromium', ['--headless=new', '--no-proxy-server', '--disable-background-networking', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio:['ignore', 'ignore', 'pipe'] });
    chrome.stderr.on('data', () => {});
    let port;
    await until(async () => { try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return !!port; } catch { return false; } }, 'Chromium');
    // The page target can appear a moment after the debugging port when several browsers start at once.
    let page;
    await until(async () => { try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page'); return Boolean(page); } catch { return false; } }, 'Chromium page target');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once:true }); ws.addEventListener('error', reject, { once:true }); });
    ws.addEventListener('message', event => {
      const m = JSON.parse(String(event.data));
      if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } }
      else if (m.method === 'Input.dragIntercepted') dragData=m.params.data;
      else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    await call('Runtime.enable'); await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width:1440, height:2600, deviceScaleFactor:1, mobile:false });

    await t.test('only local library rows are drag sources; demo fixtures stay inert', async () => {
      await fresh();
      const rows = await evaluate(`[...document.querySelectorAll('tr[data-track-id]')].map(r=>[r.dataset.trackId,r.getAttribute('draggable'),r.title])`);
      assert.ok(rows.length > 2);
      for (const [id, draggable, title] of rows) {
        const local = id === A || id === B;
        assert.equal(draggable, local ? 'true' : 'false', id);
        assert.equal(title, local ? 'Drag onto a deck or waveform to load it' : '', id);
      }
      const demo = await probe('start', 'afterlight');
      assert.equal(demo.prevented, true, 'a demo fixture drag never starts');
      assert.deepEqual(demo.payload, []); assert.equal(demo.dragging, 0);
    });

    await t.test('drops on every deck face and waveform in both console deck pairs send exactly one load request and keep the deck paused', async () => {
      await fresh();
      let drops = 0;
      for (const pair of ['ab','cd']) {
        await evaluate(`document.querySelector('[data-action=pair][data-value=${pair}]').click()`);
        for (const [selector, attribute] of [['section.deck-panel[data-drop-deck]', 'dropDeck'], ['section.deck-lane[data-drop-deck]', 'dropDeck'], ['[data-wave-deck]', 'waveDeck']]) {
          for (const [index, deck] of (await visibleDecks(selector, attribute)).entries()) {
            const trackId = drops++ % 2 ? B : A, before = (await calls()).length;
            const start = await probe('start', trackId);
            assert.deepEqual(start.payload, [[DRAG_TYPE, trackId]], 'the drag carries only the opaque track ID');
            assert.equal((await probe('fire', 'dragover', selector, index)).prevented, true);
            await probe('fire', 'drop', selector, index);
            await until(async () => (await calls()).length > before, pair + ' ' + selector + ' load');
            await delay(25);
            assert.deepEqual((await calls()).slice(before), [{ type:'load', deck, trackId }], 'a drop issues the one semantic load request, never play, seek or a path');
            const state = (await snapshot()).decks[deck];
            assert.equal(state.trackId, trackId); assert.equal(state.playing, false); assert.equal(state.position, 0);
            assert.deepEqual(await probe('state'), { hover:[], dragging:0 });
          }
        }
      }
      assert.ok(drops >= 28);
      assert.ok((await calls()).every(c => !['play', 'pause', 'seek'].includes(c.type)), 'dropping never starts or moves playback');
    });

    await t.test('a real local-track drag survives native clock updates without moving its source row', async () => {
      await fresh();
      await probe('start',B);await probe('fire','drop','section.deck[data-drop-deck]',2);
      await until(async()=>(await loads()).length===1,'load the other deck');
      await evaluate('dragFixture.emit()');
      assert.equal((await snapshot()).decks.C.playing,true);
      const point = selector => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      const from=await point('tr[data-track-id="'+A+'"] .name-cell'),to=await point('section.deck-panel[data-drop-deck="B"] .dp-head');
      dragData=null;await call('Input.setInterceptDrags',{enabled:true});
      try {
        await call('Input.dispatchMouseEvent',{type:'mouseMoved',...from});
        await call('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',clickCount:1});
        await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:from.x+10,y:from.y+10,button:'left',buttons:1});
        await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:from.x+30,y:from.y+30,button:'left',buttons:1});
        await until(()=>Boolean(dragData),'real local-track drag');
        assert.deepEqual(dragData.items,[{mimeType:DRAG_TYPE,data:A}]);
        await evaluate(`(()=>{window.dragRowRemovals=0;const row=document.querySelector('tr[data-track-id="${A}"]');window.dragObserver=new MutationObserver(records=>{for(const r of records)if([...r.removedNodes].includes(row))window.dragRowRemovals++;});dragObserver.observe(row.parentElement,{childList:true});})()`);
        for(let i=0;i<4;i++){await evaluate('dragFixture.emit()');await delay(30);}
        assert.equal(await evaluate('dragRowRemovals'),0,'clock-only updates preserve the live drag source');
        await call('Input.dispatchDragEvent',{type:'dragEnter',...to,data:dragData});
        await call('Input.dispatchDragEvent',{type:'dragOver',...to,data:dragData});
        assert.deepEqual((await probe('state')).hover,['B']);
        const before=(await loads()).length;
        await call('Input.dispatchDragEvent',{type:'drop',...to,data:dragData});
        await call('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',clickCount:1});
        await until(async()=>(await loads()).length===before+1,'real local drop');
        assert.deepEqual((await loads()).at(-1),{type:'load',deck:'B',trackId:A});
        assert.equal((await snapshot()).decks.B.playing,false);
        assert.equal((await snapshot()).decks.C.playing,true,'the other deck keeps playing');
        assert.deepEqual(await probe('state'),{hover:[],dragging:0});
      } finally {await call('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',clickCount:1});await evaluate('window.dragObserver?.disconnect()');await call('Input.setInterceptDrags',{enabled:false});}
    });

    await t.test('external, demo, altered and non-target drags issue no native command', async () => {
      await fresh();
      const before = (await calls()).length, deckSel = 'section.deck[data-drop-deck]';
      const frozen = await snapshot();
      await probe('forge', DRAG_TYPE, A);
      assert.equal((await probe('fire', 'dragover', deckSel, 0)).prevented, false, 'external drag with our type');
      assert.equal((await probe('fire', 'drop', deckSel, 0)).prevented, false);
      await probe('forge', DRAG_TYPE, 'afterlight');
      assert.equal((await probe('fire', 'drop', deckSel, 0)).prevented, false, 'forged demo ID');
      for (const [type, data] of [['text/plain', A], ['Files', A], ['text/uri-list', 'file:///tmp/x.wav']]) { await probe('forge', type, data); assert.equal((await probe('fire', 'drop', deckSel, 0)).prevented, false, type); }
      for (const data of [B, 'afterlight', '/etc/passwd', 'file:///tmp/x.wav', '<img src=x onerror=alert(1)>', A + '/../x']) {
        await probe('start', A); await probe('set', DRAG_TYPE, data); await probe('fire', 'dragover', deckSel, 0);
        assert.deepEqual((await probe('fire', 'drop', deckSel, 0)), { prevented:true, hover:[], dragging:0 }, data);
      }
      await probe('start', A);
      assert.deepEqual(await probe('fire', 'dragover', '.deckbar'), { prevented:false, hover:[], dragging:1 });
      assert.equal((await probe('fire', 'drop', '.deckbar')).prevented, false);
      await probe('fire', 'dragend', '@row');
      await delay(60);
      assert.equal((await calls()).length, before, 'no bridge command was issued');
      assert.deepEqual(await snapshot(), frozen);
      assert.equal(await evaluate("document.querySelectorAll('img').length"), 0);
    });

    await t.test('a track removed from the library mid-drag is refused as stale with a clear message', async () => {
      await fresh();
      const before = (await calls()).length;
      await probe('start', A);
      assert.deepEqual((await probe('fire', 'dragover', 'section.deck[data-drop-deck]', 1)).hover, ['B']);
      await evaluate(`import('/src/catalog.js').then(m=>m.replaceLocalLibrary([{id:${JSON.stringify(B)},title:'Synthetic drag B.wav',duration:300,peaks:[]}]))`);
      const dropped = await probe('fire', 'drop', 'section.deck[data-drop-deck]', 1);
      assert.deepEqual(dropped, { prevented:true, hover:[], dragging:0 });
      assert.match(await evaluate("document.querySelector('.toast').textContent"), /no longer in the library/);
      assert.equal((await calls()).length, before);
    });

    await t.test('hover is cleared on leave, end and redraw', async () => {
      await fresh();
      await probe('start', B);
      assert.deepEqual((await probe('fire', 'dragover', 'section.deck[data-drop-deck]', 0)).hover, ['A']);
      assert.deepEqual((await probe('fire', 'dragleave', 'section.deck[data-drop-deck]', 0, '.deckbar')).hover, []);
      await probe('fire', 'dragover', 'section.deck[data-drop-deck]', 0);
      assert.deepEqual(await probe('fire', 'dragend', '@row'), { prevented:false, hover:[], dragging:0 });
      await probe('start', B); await probe('fire', 'dragover', 'section.deck[data-drop-deck]', 0);
      await evaluate(`document.querySelector('.canvas-entry').click();document.querySelector('[data-action=mode][data-value=perform]').click()`);
      assert.deepEqual((await probe('fire', 'dragover', 'section.deck[data-drop-deck]', 3)).hover, ['D'], 'a redraw leaves no stale mark');
      await probe('fire', 'dragend', '@row');
      assert.deepEqual(await probe('state'), { hover:[], dragging:0 });
    });
    assert.deepEqual(errors, [], 'renderer runtime errors');
  } finally {
    if (chrome) { const exited = new Promise(resolve => chrome.once('exit', resolve)); try { await call('Browser.close'); } catch {} await Promise.race([exited, delay(3000)]); if (chrome.exitCode === null) { chrome.kill('SIGKILL'); await exited; } }
    ws?.close(); for (const p of pending.values()) clearTimeout(p.timer);
    if (server) await new Promise(resolve => server.close(resolve));
    if (profile) await rm(profile, { recursive:true, force:true });
  }
});
