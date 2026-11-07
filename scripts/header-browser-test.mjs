// Real-Chromium regression for the compact header and settings dialog. Uses trusted pointer/keyboard
// events through CDP (not synthetic DOM clicks) against the built dist/deck-craft.html. The native bridge
// in the desktop section is MOCKED; this checks the renderer only, not audio or the Electron shell.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { THEMES } from '../src/catalog.js';
import { createSession, serializeSession } from '../src/session.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'dist/deck-craft.html')).href;
const parent = process.env.TMPDIR || path.join(homedir(), '.cache');
await mkdir(parent, { recursive: true });
const profile = await mkdtemp(path.join(parent, 'deckcraft-header-'));
const evidence = process.env.DECKCRAFT_EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
const report = { checks: [], errors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, client;

async function until(fn, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch {} await delay(40); }
  throw new Error('Timed out: ' + label);
}
async function launch(fixture = '') {
  await close();
  await rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  chrome = spawn(process.env.CHROMIUM || 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', () => {});
  const port = await until(async () => Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'Chromium startup');
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  const pending = new Map(); let sequence = 0;
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id) { const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); } }
    else if (message.method === 'Runtime.exceptionThrown') report.errors.push(message.params.exceptionDetails.text + ' ' + (message.params.exceptionDetails.exception?.description || ''));
  });
  client = { ws, call: (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); }) };
  await client.call('Runtime.enable'); await client.call('Page.enable'); await client.call('Page.bringToFront');
  if (fixture) await client.call('Page.addScriptToEvaluateOnNewDocument', { source: fixture });
  await client.call('Page.navigate', { url });
  await until(() => evaluate("Boolean(document.querySelector('.settings-open'))"), 'application startup');
}
async function close() {
  if (!chrome) return;
  const owned = chrome, exit = new Promise(resolve => owned.once('exit', resolve));
  try { await client.call('Browser.close'); } catch {}
  await Promise.race([exit, delay(3000)]);
  if (owned.exitCode === null) { owned.kill('SIGKILL'); await Promise.race([exit, delay(2000)]); }
  client?.ws.close(); chrome = null;
}
async function evaluate(expression) {
  const result = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const viewport = (width, height) => client.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
const select = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing '+${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
const snapshot = () => evaluate("JSON.parse(localStorage.getItem('deck-craft.ui.v1'))");
const musical = state => ({ decks: state.decks, mixer: state.mixer, library: state.library });
const dialogOpen = () => evaluate("document.querySelector('.settings-dialog').open");
const activeIs = selector => evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})||false`);
const activeInDialog = () => evaluate("Boolean(document.activeElement?.closest('.settings-dialog'))");

async function pointerClick(selector) {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:Boolean(document.elementFromPoint(x,y)?.closest(${JSON.stringify(selector)}))}})()`);
  assert.ok(point?.hit, 'pointer target is reachable: ' + selector);
  await pointerAt(point.x, point.y);
}
async function pointerAt(x, y) {
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const KEYS = { Escape: { key: 'Escape', code: 'Escape', vk: 27 }, Tab: { key: 'Tab', code: 'Tab', vk: 9 }, Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }, Space: { key: ' ', code: 'Space', vk: 32, text: ' ' }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 } };
async function press(name, modifiers = 0) {
  const k = KEYS[name], base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
  await client.call('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await client.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const focus = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
async function openByPointer() { await pointerClick('.settings-open'); await until(dialogOpen, 'settings opens'); }

const probeIdle = () => evaluate(`(()=>{
  const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none'};
  const bar=document.querySelector('.deckbar'),r=bar.getBoundingClientRect(),app=document.querySelector('.app');
  const body=app.querySelector(':scope > main');
  const kids=[...app.children],bands=kids.slice(0,kids.indexOf(body)).filter(el=>el!==bar&&visible(el)).map(el=>el.className||el.tagName);
  const controls=[...bar.querySelectorAll('button')].filter(visible).map(b=>b.textContent.trim()||b.getAttribute('aria-label'));
  const dialog=document.querySelector('.settings-dialog');
  return {top:r.top,height:r.height,left:r.left,right:r.right,bands,bodyTop:body.getBoundingClientRect().top,controls,selects:bar.querySelectorAll('select').length,
    overflow:document.documentElement.scrollWidth>innerWidth,dialogVisible:visible(dialog),hiddenDecksVisible:[...document.querySelectorAll('.hidden-decks')].some(visible),
    warnH:document.querySelector('.persistence-warning').getBoundingClientRect().height,barOverflow:bar.scrollWidth>bar.clientWidth+1,innerWidth,
    bg:getComputedStyle(bar).backgroundColor}})()`);

const reachable = selectors => evaluate(`(()=>{
  const dialog=document.querySelector('.settings-dialog'),d=dialog.getBoundingClientRect(),out=[];
  for(const selector of ${JSON.stringify(selectors)}){
    const e=document.querySelector(selector);if(!e){out.push([selector,'missing']);continue;}
    e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
    if(!e.getClientRects().length||r.width<=0||r.height<=0)out.push([selector,'not rendered']);
    else if(r.left<d.left-1||r.right>d.right+1||r.top<d.top-1||r.bottom>d.bottom+1)out.push([selector,'outside dialog']);
    else if(!document.elementFromPoint(x,y)?.closest(selector))out.push([selector,'covered']);
  }
  return out})()`);

const luminance = ([r, g, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + .05) / (lo + .05); };
const colors = (selectors) => evaluate(`(()=>{
  const canvas=document.createElement('canvas').getContext('2d');
  const rgb=value=>{canvas.fillStyle='#000';canvas.fillStyle=value;const c=canvas.fillStyle;if(c[0]==='#')return [1,3,5].map(i=>parseInt(c.slice(i,i+2),16));const m=c.match(/[\\d.]+/g).map(Number);return c.startsWith('color(')?m.slice(0,3).map(v=>v*255):m.slice(0,3)};
  return Object.fromEntries(Object.entries(${JSON.stringify(selectors)}).map(([name,[fg,bg]])=>{const f=document.querySelector(fg),b=document.querySelector(bg);return [name,[rgb(getComputedStyle(f).color),rgb(getComputedStyle(b).backgroundColor)]]}))})()`);

const mockBridge = ({ ready = true, warning = '', target = null } = {}) => {
  const saved = createSession();
  if (target) saved.library.target = target;
  return `(()=>{
  localStorage.clear();
  ${target ? `localStorage.setItem('deck-craft.ui.v1',${JSON.stringify(serializeSession(saved))});` : ''}
  const snapshot={ready:${ready},seq:1,engineId:'mock-header-engine',decks:[],output:{sampleRate:48000}};
  const bridge=window.__bridge={calls:[]};
  window.deckCraftNative={onEvent(){},async command(request){
    bridge.calls.push(request);
    if(request.type==='library')return {ok:true,tracks:[],warning:${JSON.stringify(warning)}};
    if(request.type==='status')return {ok:true,snapshot};
    if(request.type==='pick'||request.type==='import')return {ok:true,cancelled:true};
    return {ok:true,snapshot};
  }};
})();`;
};

try {
  // ---- Browser-only application ------------------------------------------------------------------
  await launch();
  await evaluate("window.__identity='same-document'");
  assert.equal(await evaluate("document.querySelectorAll('iframe').length"), 0);
  await select('.load-target', 'C');
  await evaluate("document.querySelector('[data-action=\"load\"][data-track=\"quiet-motion\"]').click()");
  await evaluate("(()=>{const e=document.querySelector('[data-action=\"deck-number\"][data-deck=\"C\"][data-field=\"position\"]');e.value=177.3;e.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await evaluate("document.querySelector('section[data-deck=\"C\"] [data-action=\"hot-cue\"][data-index=\"1\"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))");
  await evaluate("(()=>{const e=document.querySelector('[data-deck=\"D\"][data-field=\"level\"]');e.value=55;e.dispatchEvent(new Event('input',{bubbles:true}))})()");
  await evaluate("(()=>{const e=document.querySelector('[data-action=\"crossfader\"]');e.value=31;e.dispatchEvent(new Event('input',{bubbles:true}))})()");
  const expected = musical(await snapshot());
  assert.equal(expected.decks.C.cues[1], 177.3);

  // The console has three workspaces: Perform, Library (stored mode 'prepare') and Build (the canvas).
  const CASES = [{ id: 'perform' }, { id: 'prepare' }, { id: 'canvas' }];
  const goto = id => pointerClick(id === 'canvas' ? '.canvas-entry' : '.deckbar-mode[data-value="' + id + '"]');
  let idle = 0;
  for (const [width, height] of [[1440, 900], [1280, 720], [390, 844], [360, 640]]) {
    await viewport(width, height);
    for (const entry of CASES) {
      await goto(entry.id);
      const g = await probeIdle();
      const label = entry.id + '@' + width;
      assert.equal(g.top, 0, label + ' bar top');
      assert.ok(Math.abs(g.height - 52) <= 1, label + ' bar is ~52px, got ' + g.height);
      assert.deepEqual(g.bands, [], label + ' idle extra bands');
      assert.ok(Math.abs(g.bodyTop - g.height) <= 1, label + ' workspace starts directly under the bar: ' + g.bodyTop);
      assert.equal(g.selects, 0, label + ' bar has no selects');
      assert.deepEqual(g.controls, ['Perform', 'Library', 'Build', 'Settings'], label + ' bar controls');
      assert.equal(g.overflow, false, label + ' document overflow'); assert.equal(g.barOverflow, false, label + ' bar overflow');
      assert.equal(g.dialogVisible, false, label + ' dialog closed');
      assert.equal(g.warnH, 0, label + ' empty live region occupies no space');
      const m = await evaluate(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();const bar=r('.deckbar'),brand=r('.deckbar-brand'),nav=r('.deckbar-modes'),cog=r('.settings-open');
        const btn=[...document.querySelectorAll('.deckbar-mode')].map(b=>{const x=b.getBoundingClientRect();return {w:x.width,h:x.height,l:x.left,r:x.right,t:x.top,b:x.bottom,shown:getComputedStyle(b).display!=='none'&&getComputedStyle(b).visibility!=='hidden'&&x.width>0}});
        return {bar:{t:bar.top,b:bar.bottom},brandR:brand.right,navL:nav.left,navR:nav.right,navH:nav.height,cogL:cog.left,vw:innerWidth,btn}})()`);
      assert.equal(m.btn.length, 3, label + ' all three workspace buttons exist'); assert.ok(m.btn.every(b => b.shown), label + ' all workspace buttons are visible');
      assert.ok(m.navL >= m.brandR - 0.5, label + ' modes sit beside the brand, not over it'); assert.ok(m.navR <= m.cogL + 0.5, label + ' modes do not overlap the cog'); assert.ok(m.navR <= m.vw, label + ' modes inside viewport');
      assert.ok(m.btn.every(b => b.t >= m.bar.t - 0.5 && b.b <= m.bar.b + 0.5 && b.h >= 28 && b.h <= 36), label + ' mode buttons stay inside the compact bar (28-36px tall)');
      assert.ok(m.navL - m.brandR <= 24, label + ' modes stay next to the brand (gap ' + (m.navL - m.brandR) + ')');
      idle++;
    }
  }
  report.checks.push(idle + ' closed-bar cases (3 workspaces x 4 widths): 52px bar at the top, Perform/Library/Build visible beside the brand inside the bar, workspace directly beneath, no idle bands, no selects or overflow');

  // Pointer + keyboard open/close, focus handling, no reload, no musical mutation, in every view.
  let dialogCases = 0;
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await viewport(width, height);
    for (const entry of CASES) {
      await goto(entry.id);
      const label = entry.id + '@' + width;
      assert.equal(await evaluate("document.querySelector('.settings-open').getAttribute('aria-expanded')"), 'false');
      await openByPointer();
      assert.equal(await evaluate("document.querySelector('.settings-open').getAttribute('aria-expanded')"), 'true', label);
      assert.equal(await activeInDialog(), true, label + ' focus moves into dialog');
      const box = await evaluate("(()=>{const r=document.querySelector('.settings-dialog').getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom,w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth}})()");
      assert.ok(box.l >= 0 && box.r <= box.w && box.t >= 52 - 1 && box.b <= box.h, label + ' dialog fits the viewport ' + JSON.stringify(box));
      assert.deepEqual(await reachable(['.theme-picker', '.app-mixer', '.settings-close']), [], label + ' every secondary control is reachable');
      // Modal focus: Tab / Shift+Tab never reach the inert page behind the dialog (the browser may park focus on
      // the document between wraps) and a full cycle visits every control in the dialog.
      const focusables = "[...document.querySelector('.settings-dialog').querySelectorAll('button,select,input')].filter(e=>!e.disabled&&e.getClientRects().length)";
      const total = await evaluate(focusables + '.length');
      const seen = new Set();
      for (let i = 0; i < total * 2 + 4; i++) {
        await press('Tab');
        const at = await evaluate(`(()=>{const a=document.activeElement;if(!a||a===document.body)return 'parked';return document.querySelector('.settings-dialog').contains(a)?${focusables}.indexOf(a):'behind'})()`);
        assert.notEqual(at, 'behind', label + ' Tab reached the page behind the modal dialog');
        if (typeof at === 'number') seen.add(at);
      }
      assert.equal(seen.size, total, label + ' Tab cycle visits all ' + total + ' dialog controls, saw ' + seen.size);
      for (let i = 0; i < 3; i++) { await press('Tab', 8); assert.notEqual(await evaluate("(()=>{const a=document.activeElement;return a&&a!==document.body&&!a.closest('.settings-dialog')})()"), true, label + ' Shift+Tab reached the page behind'); }
      await press('Escape'); await until(async () => !(await dialogOpen()), 'Escape closes');
      assert.equal(await activeIs('.settings-open'), true, label + ' focus returns to the cog after Escape');
      await until(async () => (await evaluate("document.querySelector('.settings-open').getAttribute('aria-expanded')")) === 'false', label + ' aria-expanded resets (close event is asynchronous)');
      // Keyboard: Enter and Space open, the close button and the backdrop close.
      await press('Enter'); await until(dialogOpen, 'Enter opens'); await press('Escape'); await until(async () => !(await dialogOpen()), 'closed again');
      await press('Space'); await until(dialogOpen, 'Space opens');
      await pointerClick('.settings-close'); await until(async () => !(await dialogOpen()), 'close button');
      assert.equal(await activeIs('.settings-open'), true, label + ' focus returns after the close button');
      await openByPointer(); await pointerAt(Math.min(8, box.l / 2), box.h - 8); await until(async () => !(await dialogOpen()), 'backdrop closes');
      assert.equal(await activeIs('.settings-open'), true, label + ' focus returns after backdrop click');
      assert.equal(await evaluate("window.__identity"), 'same-document', label + ' no document reload');
      assert.deepEqual(musical(await snapshot()), expected, label + ' opening and closing never changes musical state');
      dialogCases++;
    }
  }
  report.checks.push(dialogCases + ' settings lifecycle cases (3 workspaces x desktop/mobile): pointer, Enter, Space, Escape, close button and backdrop; Tab/Shift+Tab trap; focus returns to the cog; no reload or musical change');
  await goto('perform');
  await viewport(1440, 900);

  // Moved controls work from inside the open dialog and the dialog survives the re-render.
  await openByPointer();
  let changed = 0;
  const startTheme = await evaluate("document.body.dataset.theme");
  assert.equal(await evaluate("window.__identity"), 'same-document');
  await focus('.theme-picker'); await press('ArrowDown');
  await until(async () => (await evaluate("document.body.dataset.theme")) !== startTheme, 'keyboard theme change');
  assert.equal(await dialogOpen(), true); assert.equal(await activeIs('.theme-picker'), true);
  for (const theme of THEMES) { await select('.theme-picker', theme.id); changed++; assert.equal(await evaluate("document.body.dataset.theme"), theme.id); }
  await select('.theme-picker', 'graphite');
  await pointerClick('.settings-close'); await until(async () => !(await dialogOpen()), 'closed');
  // Perform / Prepare stay in the bar.
  await pointerClick('.deckbar-mode[data-value="prepare"]');
  assert.equal(await evaluate("document.body.classList.contains('prepare-mode')&&document.querySelector('.deckbar-mode[data-value=\"prepare\"]').getAttribute('aria-pressed')"), 'true');
  await pointerClick('.deckbar-mode[data-value="perform"]');
  assert.equal(await evaluate("document.body.classList.contains('prepare-mode')"), false);
  report.checks.push(changed + ' theme changes from inside the open dialog (keyboard theme change too); dialog and focus survive re-renders; Perform/Prepare work from the bar');

  // Four-deck mixer: closing settings first, then Escape returns focus to the cog.
  await openByPointer(); await pointerClick('.app-mixer');
  await until(() => evaluate("document.querySelector('.mixer-dialog').open"), 'mixer opens');
  assert.equal(await dialogOpen(), false); assert.equal(await evaluate("document.querySelector('.mixer-dialog .cue-editor')!==null"), true);
  await press('Escape'); await until(async () => !(await evaluate("document.querySelector('.mixer-dialog').open")), 'mixer closes');
  assert.equal(await activeIs('.settings-open'), true, 'focus returns to the cog after the mixer');
  report.checks.push('four-deck mixer opens from Settings (settings closes first) and focus returns to the cog');

  // Build is a header workspace: it opens the canvas without a dialog and leaves it for the other two.
  await pointerClick('.canvas-entry');
  await until(async () => (await evaluate("document.querySelector('#app').dataset.layout")) === 'canvas', 'Build');
  assert.equal(await dialogOpen(), false);
  const canvasBar = await probeIdle(); assert.ok(Math.abs(canvasBar.height - 52) <= 1); assert.deepEqual(canvasBar.bands, []);
  assert.deepEqual(canvasBar.controls, ['Perform', 'Library', 'Build', 'Settings'], 'canvas keeps the three workspaces beside the brand');
  assert.equal(await evaluate("document.querySelector('.canvas-entry').getAttribute('aria-pressed')"), 'true');
  {
    const before = musical(await snapshot());
    await pointerClick('.deckbar-mode[data-value="prepare"]');
    assert.equal(await evaluate("document.querySelector('#app').dataset.layout"), 'console', 'Library leaves the canvas');
    assert.equal(await evaluate("document.body.classList.contains('prepare-mode')&&JSON.parse(localStorage.getItem('deck-craft.ui.v1')).mode"), 'prepare');
    await pointerClick('.deckbar-mode[data-value="perform"]');
    assert.equal(await evaluate("!document.body.classList.contains('prepare-mode')&&document.querySelector('.deckbar-mode[data-value=\"perform\"]').getAttribute('aria-pressed')"), 'true');
    assert.deepEqual(musical(await snapshot()), before, 'workspace buttons do not touch musical state');
    assert.equal(await evaluate("window.__identity"), 'same-document');
  }
  assert.deepEqual(musical(await snapshot()).mixer, expected.mixer);
  report.checks.push('Build opens the canvas from the bar (52px, three workspaces visible); Library and Perform leave it; no musical change and no reload');

  // Every theme x every view x desktop/mobile: contrast of the bar and the open dialog.
  let themed = 0;
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await viewport(width, height);
    for (const entry of CASES) {
      await goto(entry.id);
      for (const theme of THEMES) {
        await select('.theme-picker', theme.id); await delay(300); // colour transitions settle
        const label = entry.id + ' ' + theme.id + '@' + width;
        const g = await probeIdle();
        assert.equal(g.overflow, false, label + ' overflow'); assert.ok(Math.abs(g.height - 52) <= 1, label + ' height'); assert.deepEqual(g.bands, [], label);
        const c = await colors({ brand: ['.deckbar-name', '.deckbar'], cog: ['.settings-open', '.deckbar'], activeMode: ['.deckbar-mode.active', '.deckbar-mode.active'], idleMode: ['.deckbar-mode:not(.active)', '.deckbar-modes'] });
        const need = { brand: 4.5, cog: 4.5, activeMode: 4.5, idleMode: 4.5 };
        for (const [name, [fg, bg]] of Object.entries(c)) {
          assert.ok(contrast(fg, bg) >= need[name], label + ' ' + name + ' contrast ' + contrast(fg, bg).toFixed(2));
        }
        await openByPointer();
        const d = await colors({ title: ['.settings-head h2', '.settings-dialog'], group: ['.settings-group h3', '.settings-dialog'], field: ['.settings-field span', '.settings-dialog'], button: ['.app-mixer', '.app-mixer'], select: ['.theme-picker', '.theme-picker'] });
        for (const [name, [fg, bg]] of Object.entries(d)) assert.ok(contrast(fg, bg) >= 4.5, label + ' dialog ' + name + ' contrast ' + contrast(fg, bg).toFixed(2));
        assert.deepEqual(await reachable(['.theme-picker', '.app-mixer']), [], label);
        assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"), false, label + ' open dialog overflow');
        await pointerClick('.settings-close'); await until(async () => !(await dialogOpen()), 'closed');
        themed++;
      }
    }
  }
  await select('.theme-picker', 'graphite');
  assert.deepEqual(musical(await snapshot()), expected, 'theme and workspace work never changes musical state');
  report.checks.push(themed + ' theme x workspace x width cases: bar and open dialog meet 4.5:1 contrast, nothing overflows, controls reachable');

  // Reload restores workspace/theme and keeps the bar compact; blocked persistence warning stays visible.
  await goto('prepare'); await select('.theme-picker', 'ember');
  await client.call('Page.reload'); await until(() => evaluate("Boolean(document.querySelector('.settings-open'))"), 'reload');
  assert.equal((await snapshot()).mode, 'prepare');
  assert.equal(await evaluate("document.querySelector('.theme-picker').value"), 'ember');
  await select('.theme-picker', 'graphite');
  await evaluate("localStorage.setItem('deck-craft.ui.v1','{broken')");
  await client.call('Page.reload'); await until(() => evaluate("Boolean(document.querySelector('.settings-open'))"), 'recovery');
  const warn = await evaluate("(()=>{const w=document.querySelector('.persistence-warning'),r=w.getBoundingClientRect();return {text:w.textContent,h:r.height,top:r.top,bar:document.querySelector('.deckbar').getBoundingClientRect().bottom}})()");
  assert.match(warn.text, /Recovered/); assert.ok(warn.h > 0 && Math.abs(warn.top - warn.bar) <= 1, 'save warning shows directly under the bar');
  report.checks.push('workspace/theme restore after reload; a recovery/save warning appears directly under the bar, only while relevant');

  if (evidence) {
    await viewport(1440, 900); await goto('perform');
    await client.call('Page.reload'); await until(() => evaluate("Boolean(document.querySelector('.settings-open'))"), 'shots');
    const shot = async name => writeFile(path.join(evidence, name), Buffer.from((await client.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await shot('header-test-desktop-closed.png'); await openByPointer(); await shot('header-test-desktop-open.png'); await press('Escape');
  }

  // ---- Desktop bridge (MOCKED): audio/file actions and output errors ------------------------------------
  await launch(mockBridge({ ready: true }));
  await viewport(1440, 900);
  await until(() => evaluate("!document.querySelector('.native-import').disabled"), 'mock native ready');
  let bar = await probeIdle();
  assert.deepEqual(bar.bands, [], 'ready output adds no band'); assert.ok(Math.abs(bar.height - 52) <= 1);
  assert.equal(await evaluate("document.querySelector('.native-audio-bar').getBoundingClientRect().height"), 0);
  await openByPointer();
  assert.deepEqual(await reachable(['.native-import', '.settings-native [data-action="library-import"]']), []);
  assert.equal(await evaluate("document.querySelector('.settings-audio-state').textContent"), '', 'idle ready status stays blank');
  assert.equal(await evaluate("document.querySelector('.settings-native [data-action=\"reconnect-audio\"]').hidden"), true);
  assert.equal(await evaluate("document.querySelector('.engine-label').textContent"), 'NATIVE AUDIO');
  assert.equal(await evaluate("document.querySelector('.native-import').textContent"), 'Open file → Deck A');
  await pointerClick('.settings-native [data-action="library-import"]');
  await until(async () => !(await dialogOpen()), 'Add files leaves Settings');
  await until(() => evaluate("window.__bridge.calls.some(c=>c.type==='import'&&c.kind==='files')"), 'import requested through the bridge');
  await openByPointer(); assert.equal(await evaluate("document.querySelector('.native-import').textContent"), 'Open file → Deck A');
  await pointerClick('.native-import'); await until(async () => !(await dialogOpen()), 'Open file leaves Settings');
  await until(() => evaluate("window.__bridge.calls.some(c=>c.type==='pick'&&c.deck==='A')"), 'pick requested for default deck A');
  assert.equal(await activeIs('.settings-open'), true);
  assert.equal(await evaluate("window.__bridge.calls.filter(c=>c.type==='import'&&c.kind==='files').length"), 1);
  assert.equal(await evaluate("window.__bridge.calls.filter(c=>c.type==='pick').length"), 1);
  report.checks.push('MOCKED desktop bridge: ready output adds no band; Add files and Open file → Deck A work from Settings and call the bridge once, then return focus');

  // The table-only native library intentionally has no target picker. Restore the retained
  // target through a valid persisted session, just as the library renderer regression does.
  await launch(mockBridge({ ready: true, target: 'B' }));
  await viewport(1440, 900);
  await until(() => evaluate("!document.querySelector('.native-import').disabled"), 'restored-target mock native ready');
  assert.equal(await evaluate("document.querySelector('.load-target')"), null, 'removed target picker stays absent');
  assert.equal((await snapshot()).library.target, 'B');
  await openByPointer();
  assert.equal(await evaluate("document.querySelector('.native-import').textContent"), 'Open file → Deck B');
  await pointerClick('.native-import'); await until(async () => !(await dialogOpen()), 'restored-target Open file leaves Settings');
  await until(() => evaluate("window.__bridge.calls.some(c=>c.type==='pick'&&c.deck==='B')"), 'pick requested for retained deck B');
  assert.equal(await evaluate("window.__bridge.calls.filter(c=>c.type==='pick').length"), 1);
  assert.equal((await snapshot()).library.target, 'B');
  assert.equal(await activeIs('.settings-open'), true);
  report.checks.push('MOCKED desktop bridge: Settings Open file restores retained target B without resurrecting the removed library target picker');

  await launch(mockBridge({ ready: false }));
  await viewport(1440, 900);
  await until(() => evaluate("getComputedStyle(document.querySelector('.native-audio-bar')).display!=='none'"), 'error band');
  const band = await evaluate("(()=>{const b=document.querySelector('.native-audio-bar'),r=b.getBoundingClientRect(),bar=document.querySelector('.deckbar').getBoundingClientRect();return {text:b.textContent,h:r.height,top:r.top,bar:bar.bottom,reconnect:Boolean(b.querySelector('[data-action=\"reconnect-audio\"]:not([hidden])'))}})()");
  assert.match(band.text, /Audio output unavailable/); assert.ok(band.h > 0 && Math.abs(band.top - band.bar) <= 1); assert.equal(band.reconnect, true);
  assert.equal(await evaluate("document.querySelector('.native-import').disabled"), true);
  await pointerClick('.native-audio-bar [data-action="reconnect-audio"]');
  await until(() => evaluate("window.__bridge.calls.some(c=>c.type==='reconnect')"), 'reconnect through the bridge');
  await until(() => evaluate("getComputedStyle(document.querySelector('.native-audio-bar')).display!=='none'"), 'still unavailable');
  await openByPointer();
  assert.match(await evaluate("document.querySelector('.settings-audio-state').textContent"), /Audio output unavailable/);
  assert.equal(await evaluate("document.querySelector('.engine-label').textContent"), 'OUTPUT OFFLINE');
  assert.deepEqual(await reachable(['.settings-native [data-action="reconnect-audio"]', '.native-import']), []);
  await pointerClick('.settings-close');
  report.checks.push('MOCKED desktop bridge: unavailable output shows an error band with Reconnect under the bar and the same message in Settings');

  await launch(mockBridge({ ready: true, warning: 'Local library could not be restored: invalid saved registry.' }));
  await viewport(1440, 900);
  await until(() => evaluate("document.querySelector('.persistence-warning').textContent.length>0"), 'native warning');
  const nativeWarn = await evaluate("(()=>{const r=document.querySelector('.persistence-warning').getBoundingClientRect();return {h:r.height,top:r.top,bar:document.querySelector('.deckbar').getBoundingClientRect().bottom,saved:document.querySelector('#app').dataset.saved}})()");
  assert.ok(nativeWarn.h > 0 && Math.abs(nativeWarn.top - nativeWarn.bar) <= 1 && nativeWarn.saved === 'false');
  for (const entry of CASES) { await goto(entry.id); assert.ok((await evaluate("document.querySelector('.persistence-warning').getBoundingClientRect().height")) > 0, entry.id + ' keeps the warning visible'); }
  report.checks.push('MOCKED desktop bridge: a library/save warning stays visible in every workspace without opening Settings');

  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify({ passed: true, checks: report.checks }, null, 2));
} finally { await close(); await rm(profile, { recursive: true, force: true }); }
