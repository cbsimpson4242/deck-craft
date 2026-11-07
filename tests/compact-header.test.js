import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LAYOUTS, THEMES } from '../src/catalog.js';
import { createSession, reduceSession } from '../src/session.js';
import { createViewOptions, renderSession } from '../src/views.js';
import { NativeSession } from '../src/native.js';

const between = (html, open, close) => html.slice(html.indexOf(open), html.indexOf(close, html.indexOf(open)) + close.length);
const render = layout => renderSession(reduceSession(createSession(), { type: 'layout', value: layout.id }), createViewOptions());

test('the closed header is one slim bar: brand, three workspaces, a status slot and a Settings cog only', () => {
  for (const layout of LAYOUTS) {
    const html = render(layout), header = between(html, '<header class="deckbar"', '</header>');
    assert.equal((html.match(/<header class="deckbar"/g) || []).length, 1, layout.id + ' has one application bar');
    assert.match(header, /class="deckbar"/);
    assert.match(header, /DECK CRAFT/, 'original branding is kept');
    assert.match(header, /data-value="perform"[^>]*>Perform</);
    assert.match(header, /data-value="prepare"[^>]*>Library</);
    assert.match(header, /class="deckbar-mode canvas-entry" data-editor="open-canvas">Build</);
    assert.match(header, /class="deckbar-status" role="status"/);
    assert.equal((header.match(/data-action="open-settings"/g) || []).length, 1);
    for (const attribute of ['aria-label="Settings"', 'aria-haspopup="dialog"', 'aria-expanded="false"']) assert.ok(header.includes(attribute), attribute);
    for (const moved of ['<select', 'layout-picker', 'theme-picker', 'app-mixer', 'hidden-deck', 'native-import', 'engine-label', 'session-name'])
      assert.ok(!header.includes(moved), layout.id + ' header must not contain ' + moved);
  }
});

test('every secondary control lives in exactly one settings dialog', () => {
  for (const layout of LAYOUTS) {
    const html = render(layout), dialog = between(html, '<dialog class="settings-dialog"', '</dialog>');
    assert.equal((html.match(/<dialog class="settings-dialog"/g) || []).length, 1);
    assert.match(dialog, /aria-labelledby="settings-title"/);
    assert.match(dialog, /One session<span class="session-sub"> \/ four decks/);
    for (const theme of THEMES) assert.ok(dialog.includes(`value="${theme.id}"`), theme.id + ' selectable');
    for (const control of ['class="theme-picker" data-action="theme"', 'class="settings-button app-mixer" data-action="open-mixer"', 'engine-label']) assert.ok(dialog.includes(control), control);
    assert.ok(!dialog.includes('layout-picker') && !dialog.includes('hidden-decks'), 'one console: no layout picker and no hidden decks');
  }
});

test('native-only audio and file actions appear in settings; their error band exists only for desktop', () => {
  const state = createSession(), plain = renderSession(state, createViewOptions());
  assert.ok(!plain.includes('native-import') && !plain.includes('native-audio-bar') && !plain.includes('reconnect-audio'));
  globalThis.deckCraftNative = {};
  try {
    const html = renderSession(state, createViewOptions()), dialog = between(html, '<dialog class="settings-dialog"', '</dialog>');
    for (const control of ['data-action="reconnect-audio"', 'data-action="library-import" data-kind="files"', 'class="settings-button native-import" data-action="import-audio"', 'settings-audio-state'])
      assert.ok(dialog.includes(control), control);
    const band = between(html, '<div class="native-audio-bar"', '</div>');
    assert.match(band, /role="status" hidden>/, 'the band is hidden until output is unavailable');
    assert.ok(html.indexOf('persistence-warning') < html.indexOf('native-audio-bar') && html.indexOf('native-audio-bar') < html.indexOf('<main'), 'band sits under the header, above the workspace');
  } finally { delete globalThis.deckCraftNative; }
});

test('the application bar and settings dialog contract is in the stylesheet', async () => {
  const css = await readFile(new URL('../src/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.deckbar\{[^}]*min-height:52px/);
  assert.match(css, /\.settings-dialog\[open\]\{display:flex/);
  for (const name of ['app.css', 'canvas.css', 'native.css'])
    assert.ok(!/\.(?:appbar|wordmark|session-name|master-section|mobile-engine-notice|layout-choice)\b/.test(await readFile(new URL('../src/' + name, import.meta.url), 'utf8').then(text => text.replace(/\/\*[\s\S]*?\*\//g, ''))), name + ' keeps no dead header rules');
});

function fakeDocument(spec) {
  const element = (extra = {}) => ({ hidden: false, disabled: false, textContent: '', querySelector: () => null, ...extra });
  const nodes = { '.app': element(), '.native-audio-bar': element(), '.deckbar-status': element(), '.settings-audio-state': element(), '.native-import': element(), '.deckbar-brand small': element() };
  nodes['.native-audio-bar'].querySelector = selector => selector === '.native-audio-state' ? (nodes.state ||= element()) : null;
  const reconnect = [element(), element()];
  return { nodes, reconnect, document: { body: { classList: { add() {} } }, querySelector: selector => nodes[selector] || null, querySelectorAll: selector => selector === '[data-action="reconnect-audio"]' ? reconnect : [] } };
}
function paint(status, { busy = [], initialized = true } = {}) {
  const fake = fakeDocument(), previous = globalThis.document;
  globalThis.document = fake.document;
  try { NativeSession.prototype.paint.call({ store: { get: createSession }, status, busy: new Set(busy), initialized, mixerSynced:true, paintStrip:NativeSession.prototype.paintStrip, paintClock() {} }); } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
  return fake;
}

test('native paint keeps output errors visible and the idle top free of bands', () => {
  let fake = paint({ ready: true, decks: [], output: { sampleRate: 48000 } });
  assert.equal(fake.nodes['.native-audio-bar'].hidden, true);
  assert.equal(fake.nodes['.deckbar-status'].textContent, '');
  assert.equal(fake.nodes['.settings-audio-state'].textContent, '', 'idle ready status stays blank');
  assert.equal(fake.nodes['.native-import'].disabled, false);
  assert.ok(fake.reconnect.every(button => button.hidden));
  fake = paint({ ready: false, decks: [] });
  assert.equal(fake.nodes['.native-audio-bar'].hidden, false);
  assert.match(fake.nodes.state.textContent, /Audio output unavailable/);
  assert.match(fake.nodes['.settings-audio-state'].textContent, /Audio output unavailable/);
  assert.equal(fake.nodes['.native-import'].disabled, true);
  assert.ok(fake.reconnect.every(button => !button.hidden));
  fake = paint({ ready: false, error: 'audio_engine_unavailable', decks: [] });
  assert.match(fake.nodes.state.textContent, /Audio engine could not start/);
  fake = paint({ ready: true, decks: [] }, { busy: ['A'] });
  assert.equal(fake.nodes['.deckbar-status'].textContent, 'Loading local audio…');
  assert.equal(fake.nodes['.native-audio-bar'].hidden, true);
  fake = paint({ ready: false, decks: [] }, { initialized: false });
  assert.equal(fake.nodes['.native-audio-bar'].hidden, true, 'no error flash before the engine has answered');
  assert.equal(fake.nodes['.deckbar-status'].textContent, 'Starting audio…');
});
