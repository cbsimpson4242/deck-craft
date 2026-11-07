import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DECK_IDS, LAYOUTS, TRACKS, replaceLocalLibrary, trackById } from '../src/catalog.js';
import { createSession, reduceSession } from '../src/session.js';
import { library } from '../src/components.js';
import { nativeLibrary } from '../src/library.js';
import { createViewOptions, renderSession } from '../src/views.js';
import { renderCanvasContent } from '../src/canvas-view.js';
import { renderDesignPreview } from '../src/canvas-editor.js';
import { createComponent } from '../src/workspace.js';
import { TRACK_DRAG_TYPE, validateTrackDrop } from '../src/drag-load.js';

const localId = 'local-00000000-0000-0000-0000-0000000000d1';
const types = [TRACK_DRAG_TYPE];
const active = id => ({ trackId: id });

test('a drop is accepted only for this document\'s own drag of a known library track', () => {
  replaceLocalLibrary([{ id: localId, title: 'Synthetic drag.wav', duration: 12 }]);
  try {
    assert.deepEqual(validateTrackDrop({ types, data: localId, active: active(localId), native: true }), { ok: true, trackId: localId });
    // Browser demo: synthetic fixtures are the only library and may be dropped.
    assert.deepEqual(validateTrackDrop({ types, data: 'low-orbit', active: active('low-orbit'), native: false }), { ok: true, trackId: 'low-orbit' });
    // Native desktop: demo fixtures contain no audio and cannot be loaded.
    const demo = validateTrackDrop({ types, data: 'low-orbit', active: active('low-orbit'), native: true });
    assert.equal(demo.ok, false);
    assert.equal(demo.reason, 'demo');
    assert.match(demo.message, /no audio/);
    // Foreign drags (files, text, palette components) are not ours at all.
    for (const other of [['text/plain'], ['Files'], ['application/x-deckcraft-kind'], []]) assert.equal(validateTrackDrop({ types: other, data: localId, active: active(localId), native: true }).reason, 'foreign');
    // Our MIME type without an in-app dragstart is external, whatever the payload says.
    assert.equal(validateTrackDrop({ types, data: localId, active: null, native: true }).reason, 'external');
    assert.equal(validateTrackDrop({ types, data: localId, active: {}, native: true }).reason, 'external');
    // The payload must be exactly the ID that was dragged, and only an ID.
    for (const data of ['local-00000000-0000-0000-0000-0000000000d2', '', undefined, null, 7, '/etc/passwd', '../../x', '<img src=x onerror=alert(1)>', localId + '\n', 'a'.repeat(65), JSON.stringify({ id: localId })])
      assert.equal(validateTrackDrop({ types, data, active: active(localId), native: true }).ok, false, String(data));
    // A track removed from the library while it was being dragged is stale.
    replaceLocalLibrary([]);
    const stale = validateTrackDrop({ types, data: localId, active: active(localId), native: true });
    assert.equal(stale.reason, 'stale');
    assert.match(stale.message, /no longer in the library/);
    assert.equal(trackById(localId), undefined);
  } finally { replaceLocalLibrary([]); }
});

test('every library row is a drag source only when its track can be loaded', () => {
  const state = createSession();
  const demo = library(state);
  assert.equal((demo.match(/<tr data-track-id=/g) || []).length, TRACKS.length);
  assert.equal((demo.match(/<tr [^>]*draggable="true"/g) || []).length, TRACKS.length);
  replaceLocalLibrary([{ id: localId, title: '<b>x</b>.wav', duration: 12 }]);
  try {
    const native = nativeLibrary(state);
    const rows = [...native.matchAll(/<tr data-track-id="([^"]+)"[^>]*>/g)];
    assert.equal(rows.length, TRACKS.length + 1);
    for (const [row, id] of rows) {
      const local = id === localId;
      assert.ok(row.includes(`draggable="${local}"`), id);
      assert.equal(row.includes('title="Drag onto a deck or waveform to load it"'), local, id);
    }
    assert.ok(!native.includes('<b>x</b>'), 'basenames stay escaped');
    assert.ok(!native.includes('draggable="undefined"'));
    // The drag carries an opaque ID only: no path, URL or HTML is rendered into a drag attribute.
    assert.ok(!/data-(?:path|url|file|drag)=/.test(native));
  } finally { replaceLocalLibrary([]); }
});

test('the console exposes four waveform lanes and four pair-switched deck panels as bound drop targets', () => {
  const state=createSession(),html=renderSession(state,createViewOptions());
  const targets=[...html.matchAll(/<section class="deck (deck-lane|deck-panel)" data-deck="([A-D])" data-drop-deck="([A-D])"/g)];
  assert.equal(targets.length,8);
  for(const kind of ['deck-lane','deck-panel'])assert.deepEqual(targets.filter(t=>t[1]===kind).map(t=>t[2]).sort(),DECK_IDS);
  for(const [, ,deck,drop] of targets)assert.equal(drop,deck);
  assert.equal((html.match(/data-drop-deck=/g)||[]).length,8);
});

test('canvas waveform and deck views are targets bound to their own deck; previews stay inert', () => {
  const state = createSession();
  for (const id of DECK_IDS) {
    const waveform = createComponent('waveform', id), deck = createComponent('deck', id);
    assert.match(renderCanvasContent(waveform, state), new RegExp(`<section class="canvas-wave" data-drop-deck="${id}">`));
    assert.match(renderCanvasContent(deck, state), new RegExp(`data-deck="${id}" data-drop-deck="${id}"`));
  }
  assert.ok(!/data-drop-deck/.test(renderCanvasContent(createComponent('mixer', 'A'), state)), 'a mixer is not a drop target');
  for (const kind of ['deck', 'waveform', 'browser']) {
    const preview = renderDesignPreview(createComponent(kind, 'A'), 'paused');
    assert.ok(!/data-drop-deck|draggable|data-track-id/.test(preview), kind + ' creator preview must carry no drag source or target');
  }
});

test('the drag module has no file, path, HTML or engine access and the app routes drops through the shared load action', async () => {
  const source = await readFile(new URL('../src/drag-load.js', import.meta.url), 'utf8');
  for (const forbidden of [/\.files\b/, /getData\(['"]text/, /innerHTML/, /deckCraftNative/, /\.command\(/, /localStorage/, /webkitGetAsEntry/]) assert.ok(!forbidden.test(source), String(forbidden));
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.equal((main.match(/type:'load'/g) || []).length, 1, 'one load dispatch serves both the Load button and drops');
  assert.match(main, /case 'load':loadTrack\(state\.library\.target,target\.dataset\.track\)/);
  assert.match(main, /new TrackDragLoader\(root,\{load:loadTrack/);
  const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(build, /'drag-load\.js','main\.js'/);
});

test('the drag styles use theme tokens only and leave the approved stylesheet alone', async () => {
  const css = await readFile(new URL('../src/app.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('/* Drag a library track'));
  assert.match(block, /\.drop-target\{/);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(block) && !/font-size/.test(block), 'tokens only; no new text sizes');
});
