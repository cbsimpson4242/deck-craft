import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { THEMES, DEFAULT_THEME, LAYOUTS } from '../src/catalog.js';
import { createSession, reduceSession, restoreSession, serializeSession } from '../src/session.js';
import { createStore } from '../src/store.js';
import { COMPONENT_KINDS, MIN_SIZE, createComponent, createWorkspace, minSize, parseDesign, parseDesignWithNotice, reduceWorkspace, restoreWorkspace, restoreWorkspaceWithNotice, validateComponent, validateWorkspace, workspaceStarter, creatorKit, COMPONENT_SCHEMA } from '../src/workspace.js';

const css = await readFile(new URL('../src/themes.css', import.meta.url), 'utf8');
function tokens(id) {
  const block = css.match(new RegExp(':root body\\[data-theme="' + id + '"\\][^{]*\\{([^}]*)\\}'));
  assert.ok(block, id + ' has a token block');
  return Object.fromEntries([...block[1].matchAll(/--([a-z0-9-]+):(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]]));
}
const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const memory = () => { const data = new Map(); return { getItem: k => data.has(k) ? data.get(k) : null, setItem: (k, v) => data.set(k, v), data }; };

test('five themes define the same token set and meet contrast minimums', () => {
  assert.deepEqual(THEMES.map(t => t.id), ['graphite', 'midnight', 'ember', 'orchid', 'daylight']);
  assert.equal(DEFAULT_THEME, 'graphite');
  const keys = ['bg', 'panel', 'raised', 'raised2', 'well', 'line', 'ink', 'muted', 'faint', 'accent', 'accent-ink', 'a', 'b', 'c', 'd'];
  for (const { id } of THEMES) {
    const t = tokens(id);
    assert.deepEqual(Object.keys(t).sort(), [...keys].sort(), id + ' token set');
    for (const surface of ['bg', 'panel', 'raised']) {
      assert.ok(ratio(t.ink, t[surface]) >= 7, `${id} ink on ${surface}`);
      assert.ok(ratio(t.muted, t[surface]) >= 4.5, `${id} muted on ${surface}`);
      assert.ok(ratio(t.faint, t[surface]) >= 3, `${id} faint on ${surface}`);
    }
    assert.ok(ratio(t.accent, t.panel) >= 3, id + ' accent on panel');
    assert.ok(ratio(t['accent-ink'], t.accent) >= 4.5, id + ' ink on accent');
    for (const deck of ['a', 'b', 'c', 'd']) assert.ok(ratio(t[deck], t.panel) >= 3, `${id} deck ${deck} on panel`);
  }
});

test('themes never redefine the fixed Play, cue and waveform treatments', () => {
  assert.ok(!/--(play|cue|glass)[a-z0-9-]*\s*:/.test(css.replace(/body\{--glass:#0c0d0e\}/, '')), 'only the shared glass default is declared');
  for (const { id } of THEMES.filter(t => t.id !== 'daylight')) {
    const t = tokens(id);
    assert.deepEqual([t.a, t.b, t.c, t.d], ['#d2fa69', '#64d8fa', '#ffbc70', '#c6a0ff'], id + ' keeps the deck identity colors');
  }
});

test('the app theme is presentation only and survives restore', () => {
  const state = createSession();
  assert.equal(state.theme, 'graphite');
  const next = reduceSession(state, { type: 'theme', value: 'ember' });
  assert.equal(next.theme, 'ember');
  assert.deepEqual({ ...next, theme: 'graphite' }, state, 'a theme change touches no musical field');
  assert.equal(reduceSession(state, { type: 'theme', value: 'neon' }), state);
  assert.equal(reduceSession(state, { type: 'theme', value: 'graphite' }), state);
  for (const layout of LAYOUTS) assert.equal(reduceSession(next, { type: 'layout', value: layout.id }).theme, 'ember');
  assert.equal(restoreSession(serializeSession(next)).state.theme, 'ember');
  const saved = JSON.parse(serializeSession(next)); saved.theme = '<script>';
  const restored = restoreSession(JSON.stringify(saved));
  assert.equal(restored.state.theme, 'graphite');
  const old = JSON.parse(serializeSession(state)); delete old.theme;
  assert.equal(restoreSession(JSON.stringify(old)).state.theme, 'graphite');
  assert.equal(restoreSession(JSON.stringify(old)).recovered, false, 'sessions saved before themes still restore cleanly');
});

test('component format v2 replaces free styling with named themes', () => {
  for (const kind of COMPONENT_KINDS) {
    const c = createComponent(kind);
    assert.equal(c.version, 2); assert.equal(c.theme, 'app'); assert.ok(!('style' in c));
    for (const theme of ['app', ...THEMES.map(t => t.id)]) assert.equal(validateComponent({ ...c, theme }).theme, theme);
  }
  assert.throws(() => validateComponent({ ...createComponent(), version: 1 }), /version|expected 2/);
  const schema = JSON.stringify(COMPONENT_SCHEMA);
  for (const word of ['accent', 'surface', 'radius', 'density', 'fontScale']) assert.ok(!schema.includes(word), word + ' is no longer configurable');
  const kit = creatorKit();
  assert.match(kit.files['AGENTS.md'], /Orchid/); assert.match(kit.files['component.schema.json'], /daylight/);
});

test('version 1 designs and saved canvases convert to themes with a notice and keep their layout', () => {
  const legacy = {
    format: 'deckcraft.component', version: 1, name: 'Old copper deck', kind: 'deck', deck: 'B',
    style: { accent: '#d39c64', surface: '#18232d', text: '#dce8ef', radius: 10, density: 'compact', fontScale: 110 },
    parts: { waveform: true, cues: false, artwork: true }
  };
  const parsed = parseDesignWithNotice(JSON.stringify(legacy));
  assert.equal(parsed.upgraded, true); assert.equal(parsed.design.theme, 'app'); assert.equal(parsed.design.version, 2);
  assert.equal(parsed.design.name, 'Old copper deck'); assert.equal(parsed.design.deck, 'B'); assert.equal(parsed.design.parts.cues, false);
  assert.equal(parseDesignWithNotice(JSON.stringify(createComponent())).upgraded, false);
  assert.throws(() => parseDesign(JSON.stringify({ ...legacy, script: 'alert(1)' })), /unknown field/);
  assert.throws(() => parseDesign(JSON.stringify({ ...legacy, name: 7 })), /string/);

  const workspace = createWorkspace();
  const item = { id: 'item-1', design: legacy, x: 40, y: 60, width: 330, height: 200 };
  const legacyStorage = { version: 1, active: true, snapshot: { format: 'deckcraft.workspace', version: 1, name: 'Old canvas', snap: true, items: [item] }, templates: [legacy], presets: [] };
  const restored = restoreWorkspaceWithNotice(JSON.stringify(legacyStorage));
  assert.equal(restored.upgraded, true); assert.equal(restored.workspace.version, 2); assert.equal(restored.workspace.active, true);
  const [first] = restored.workspace.snapshot.items;
  assert.equal(first.design.theme, 'app'); assert.equal(first.x, 40); assert.equal(first.y, 60);
  assert.deepEqual([first.width, first.height], minSize('deck'), 'an undersized old widget grows to the size that fits its whole face');
  assert.equal(restored.workspace.templates[0].theme, 'app');
  assert.equal(restoreWorkspaceWithNotice(JSON.stringify(workspace)).upgraded, false);

  const storage = memory(); storage.setItem('deck-craft.workspace.v1', JSON.stringify(legacyStorage));
  const store = createStore(storage);
  assert.match(store.takeNotice(), /themes/); assert.equal(store.takeNotice(), '', 'the notice is shown once');
  assert.equal(JSON.parse(storage.data.get('deck-craft.workspace.v1')).version, 2);
  assert.equal(storage.data.get('deck-craft.workspace.v1.v1-backup'), JSON.stringify(legacyStorage), 'the original saved canvas is kept');
  assert.equal(createStore(storage).takeNotice(), '');
});

test('component sizes never drop below what fits; themes apply per component or to all', () => {
  const store = createStore(memory());
  for (const kind of COMPONENT_KINDS) store.dispatchWorkspace({ type: 'add', kind });
  const items = store.getWorkspace().snapshot.items;
  for (const item of items) {
    const [w, h] = MIN_SIZE[item.design.kind];
    assert.ok(item.width >= w && item.height >= h, item.design.kind + ' default size');
    store.dispatchWorkspace({ type: 'item', id: item.id, patch: { width: 320, height: 160 } });
  }
  for (const item of store.getWorkspace().snapshot.items) assert.deepEqual([item.width, item.height], minSize(item.design.kind));
  store.dispatchWorkspace({ type: 'theme', id: items[0].id, value: 'midnight' });
  assert.equal(store.getWorkspace().snapshot.items[0].design.theme, 'midnight');
  assert.equal(store.getWorkspace().snapshot.items[1].design.theme, 'app');
  store.dispatchWorkspace({ type: 'theme-all', value: 'orchid' });
  assert.ok(store.getWorkspace().snapshot.items.every(i => i.design.theme === 'orchid'));
  assert.throws(() => store.dispatchWorkspace({ type: 'theme-all', value: 'neon' }), /theme/);
  assert.ok(store.getWorkspace().snapshot.items.every(i => i.design.theme === 'orchid'), 'an invalid theme changes nothing');
  const frozen = JSON.stringify(store.getWorkspace());
  store.dispatchWorkspace({ type: 'style', id: items[0].id, patch: { accent: '#ffffff' } });
  assert.equal(JSON.stringify(store.getWorkspace()), frozen, 'the old free-style action no longer exists');
  for (const layout of LAYOUTS) for (const item of workspaceStarter(layout.id).items) { const [w, h] = minSize(item.design.kind); assert.ok(item.width >= w && item.height >= h, layout.id + ' ' + item.design.kind); }
  assert.equal(reduceWorkspace(createWorkspace(), { type: 'unknown' }).snapshot.items.length, 0);
  validateWorkspace(workspaceStarter('studio-sync'));
});

test('stylesheets carry no per-widget color variables or leftover free-style controls', async () => {
  const canvas = await readFile(new URL('../src/canvas.css', import.meta.url), 'utf8');
  const view = await readFile(new URL('../src/canvas-view.js', import.meta.url), 'utf8');
  assert.ok(!/--widget-(accent|surface|text|radius|scale)/.test(canvas + view));
  assert.ok(!/type="color"|fontScale|data-density/.test(view));
});
