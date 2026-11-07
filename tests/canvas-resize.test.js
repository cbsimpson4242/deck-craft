import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, STORAGE_KEY } from '../src/store.js';
import { createSession } from '../src/session.js';
import { renderCanvas } from '../src/canvas-view.js';
import { COMPONENT_KINDS, ITEM_BOUNDS, RESIZE_HANDLES, createComponent, createWorkspace, minSize, reduceWorkspace, resizeItem, validateWorkspace } from '../src/workspace.js';

const box = (kind = 'deck', patch = {}) => ({ id: 'item-1', design: createComponent(kind), x: 320, y: 220, width: 620, height: 600, ...patch });
const edges = item => ({ left: item.x, top: item.y, right: item.x + item.width, bottom: item.y + item.height });
const grabbed = handle => ({ left: handle.includes('w'), right: handle.includes('e'), top: handle.includes('n'), bottom: handle.includes('s') });

test('eight handles: four sides and four corners, each moving only its own edges', () => {
  assert.deepEqual([...RESIZE_HANDLES].sort(), ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
  const start = box(), before = structuredClone(start);
  const expected = {
    n: { x: 320, y: 160, width: 620, height: 660 }, s: { x: 320, y: 220, width: 620, height: 660 },
    e: { x: 320, y: 220, width: 720, height: 600 }, w: { x: 220, y: 220, width: 720, height: 600 },
    ne: { x: 320, y: 160, width: 720, height: 660 }, nw: { x: 220, y: 160, width: 720, height: 660 },
    se: { x: 320, y: 220, width: 720, height: 660 }, sw: { x: 220, y: 220, width: 720, height: 660 }
  };
  for (const handle of RESIZE_HANDLES) {
    const dx = grabbed(handle).left ? -100 : grabbed(handle).right ? 100 : 0, dy = grabbed(handle).top ? -60 : grabbed(handle).bottom ? 60 : 0;
    assert.deepEqual(resizeItem(start, handle, dx, dy), expected[handle], handle);
  }
  assert.deepEqual(start, before, 'resizeItem is pure and never edits the item it measures');
  assert.throws(() => resizeItem(start, 'x', 1, 1), /Unknown resize handle/);
});

test('north and west resizing anchor the opposite edge, including when shrinking and at the smallest size', () => {
  const start = box(), [minW, minH] = minSize('deck');
  const shrunk = resizeItem(start, 'nw', 40, 20);
  assert.deepEqual(shrunk, { x: 360, y: 240, width: 580, height: 580 });
  assert.equal(shrunk.x + shrunk.width, 940, 'right edge did not move');
  assert.equal(shrunk.y + shrunk.height, 820, 'bottom edge did not move');
  const smallest = resizeItem(start, 'nw', 5000, 5000);
  assert.deepEqual(smallest, { x: 940 - minW, y: 820 - minH, width: minW, height: minH });
  assert.deepEqual(resizeItem(start, 'sw', 5000, -5000), { x: 940 - minW, y: 220, width: minW, height: minH });
  assert.deepEqual(resizeItem(start, 'ne', -5000, 5000), { x: 320, y: 820 - minH, width: minW, height: minH });
  assert.deepEqual(resizeItem(start, 'se', -5000, -5000), { x: 320, y: 220, width: minW, height: minH });
  for (const handle of ['n', 'w']) assert.equal(resizeItem(start, handle, 5000, 5000)[handle === 'n' ? 'height' : 'width'], handle === 'n' ? minH : minW);
});

test('every component kind stops at the smallest size that fits its whole face from every direction', () => {
  for (const kind of COMPONENT_KINDS) {
    const [minW, minH] = minSize(kind), start = box(kind, { x: 800, y: 900, width: minW + 200, height: minH + 200 });
    for (const handle of RESIZE_HANDLES) {
      const g = grabbed(handle), result = resizeItem(start, handle, g.left ? 9999 : g.right ? -9999 : 0, g.top ? 9999 : g.bottom ? -9999 : 0);
      assert.equal(result.width, g.left || g.right ? minW : start.width, kind + ' ' + handle + ' width');
      assert.equal(result.height, g.top || g.bottom ? minH : start.height, kind + ' ' + handle + ' height');
      const after = edges(result), anchored = edges(start);
      if (!g.left) assert.equal(after.left, anchored.left, kind + ' ' + handle + ' left');
      if (!g.right) assert.equal(after.right, anchored.right, kind + ' ' + handle + ' right');
      if (!g.top) assert.equal(after.top, anchored.top, kind + ' ' + handle + ' top');
      if (!g.bottom) assert.equal(after.bottom, anchored.bottom, kind + ' ' + handle + ' bottom');
    }
  }
});

test('canvas origin and maximum size are boundaries; the anchored edge does not jump when they are hit', () => {
  const start = box();
  const origin = resizeItem(start, 'nw', -9999, -9999);
  assert.deepEqual(origin, { x: 0, y: 0, width: 940, height: 820 }, 'dragging past the top-left stops at the canvas origin');
  const wide = box('deck', { x: 1000, y: 100, width: 1000, height: 700 });
  const capped = resizeItem(wide, 'w', -9999, 0);
  assert.equal(capped.width, ITEM_BOUNDS.size);
  assert.equal(capped.x + capped.width, 2000, 'maximum width reached without moving the right edge');
  assert.equal(capped.x, 400);
  assert.equal(resizeItem(wide, 'e', 9999, 0).width, ITEM_BOUNDS.size);
  const tall = box('mixer', { x: 0, y: 3000, width: 500, height: 800 });
  assert.equal(resizeItem(tall, 's', 0, 9999).height, ITEM_BOUNDS.size);
  assert.deepEqual(resizeItem(tall, 'n', 0, -9999), { x: 0, y: 2200, width: 500, height: 1600 });
  const far = box('deck', { x: ITEM_BOUNDS.x, y: ITEM_BOUNDS.y, width: 1600, height: 1600 });
  const pushed = resizeItem(far, 'nw', 9999, 9999);
  assert.ok(pushed.x <= ITEM_BOUNDS.x && pushed.y <= ITEM_BOUNDS.y, 'a drag cannot move the origin beyond the schema limits');
  assert.equal(pushed.x + pushed.width, 4000);
  validateWorkspace({ ...createWorkspace().snapshot, items: [{ id: 'item-1', design: far.design, x: pushed.x, y: pushed.y, width: pushed.width, height: pushed.height }] });
});

test('snap rounds the dragged edge to the grid and off permits exact pixels; results are total-travel, not accumulated', () => {
  const start = box();
  assert.deepEqual(resizeItem(start, 'e', 9, 0), { x: 320, y: 220, width: 620, height: 600 }, '9 px snaps back to the nearest 20 px grid line');
  assert.equal(resizeItem(start, 'e', 17, 0).width, 640);
  assert.equal(resizeItem(start, 'e', 13, 0, { snap: false }).width, 633);
  assert.deepEqual(resizeItem(start, 'nw', -13, -13, { snap: false }), { x: 307, y: 207, width: 633, height: 613 });
  // Path independence: the same total travel always gives the same box, and returning to the start restores it.
  for (const handle of RESIZE_HANDLES) {
    const away = resizeItem(start, handle, 9999, -9999), back = resizeItem(start, handle, 0, 0);
    assert.deepEqual(back, { x: 320, y: 220, width: 620, height: 600 }, handle + ' returns exactly to the start');
    assert.deepEqual(resizeItem(start, handle, 9999, -9999), away);
  }
  const offGrid = box('deck', { x: 333, y: 217, width: 611, height: 593 });
  assert.deepEqual(resizeItem(offGrid, 'se', 0, 0, { snap: false }), { x: 333, y: 217, width: 611, height: 593 }, 'without snapping nothing moves');
});

test('seeded random drags never leave the bounds, never move an ungrabbed edge and always validate', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 1500; n++) {
    const kind = COMPONENT_KINDS[n % COMPONENT_KINDS.length], [minW, minH] = minSize(kind);
    const x = Math.round(random() * 24) * 100, y = Math.round(random() * 48) * 100;
    const start = box(kind, { x, y, width: minW + Math.round(random() * 1000 / 20) * 20, height: minH + Math.round(random() * 1000 / 20) * 20 });
    start.width = Math.min(start.width, 1600); start.height = Math.min(start.height, 1600);
    const handle = RESIZE_HANDLES[n % 8], snap = n % 3 !== 0, dx = Math.round((random() - .5) * 6000), dy = Math.round((random() - .5) * 6000);
    const r = resizeItem(start, handle, dx, dy, { snap }), g = grabbed(handle), a = edges(start), b = edges(r);
    assert.ok(r.x >= 0 && r.x <= ITEM_BOUNDS.x && r.y >= 0 && r.y <= ITEM_BOUNDS.y, 'origin in range');
    assert.ok(r.width >= minW && r.width <= ITEM_BOUNDS.size && r.height >= minH && r.height <= ITEM_BOUNDS.size, 'size in range');
    if (!g.left) assert.equal(b.left, a.left); if (!g.right) assert.equal(b.right, a.right);
    if (!g.top) assert.equal(b.top, a.top); if (!g.bottom) assert.equal(b.bottom, a.bottom);
    validateWorkspace({ ...createWorkspace().snapshot, items: [{ id: 'item-1', design: start.design, ...r }] });
  }
});

test('a resize is one undoable layout entry that never touches the shared session', () => {
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const store = createStore(storage), session = structuredClone(store.get());
  store.dispatchWorkspace({ type: 'add', kind: 'deck', deck: 'B', position: { x: 320, y: 220 } });
  const added = structuredClone(store.getWorkspace().snapshot.items[0]);
  const patch = resizeItem(added, 'nw', -100, -60);
  store.dispatchWorkspace({ type: 'item', id: added.id, patch });
  const resized = store.getWorkspace().snapshot.items[0];
  assert.deepEqual({ x: resized.x, y: resized.y, width: resized.width, height: resized.height }, patch);
  assert.equal(resized.x + resized.width, added.x + added.width, 'saved layout keeps the anchored edge');
  store.dispatchWorkspace({ type: 'undo' });
  assert.deepEqual(store.getWorkspace().snapshot.items[0], added);
  store.dispatchWorkspace({ type: 'redo' });
  assert.deepEqual(store.getWorkspace().snapshot.items[0], resized);
  assert.deepEqual(store.get(), session);
  assert.equal(data.get(STORAGE_KEY) ?? null, null, 'resizing writes no musical state');
  assert.equal(JSON.parse(data.get('deck-craft.workspace.v1')).snapshot.items[0].width, patch.width, 'the new size is persisted with the workspace');
  assert.equal(reduceWorkspace(store.getWorkspace(), { type: 'item', id: resized.id, patch: { width: 1 } }).snapshot.items[0].width, minSize('deck')[0], 'the reducer still enforces the smallest size');
});

test('the builder renders eight handles and a compact action group per component while editing, and no inspector', () => {
  const workspace = createWorkspace();
  for (const kind of COMPONENT_KINDS) workspace.snapshot.items.push({ id: 'item-' + (workspace.snapshot.items.length + 1), design: createComponent(kind), x: 0, y: 0, ...Object.fromEntries(['width', 'height'].map((k, i) => [k, minSize(kind)[i]])) });
  workspace.active = true;
  const edit = renderCanvas(workspace, { editing: true, selected: 'item-1', deck: 'A' }, { undo: 0, redo: 0 }, createSession());
  assert.equal((edit.match(/class="widget-handle"/g) || []).length, 8 * COMPONENT_KINDS.length);
  for (const handle of RESIZE_HANDLES) assert.equal((edit.match(new RegExp('data-handle="' + handle + '"', 'g')) || []).length, COMPONENT_KINDS.length, handle);
  assert.equal((edit.match(/class="widget-actions"/g) || []).length, COMPONENT_KINDS.length);
  for (const action of ['duplicate', 'save-template', 'remove']) assert.equal((edit.match(new RegExp('data-editor="' + action + '"', 'g')) || []).length, COMPONENT_KINDS.length, action);
  assert.ok(!/component-inspector|inspector-|widget-resize|data-editor-field="(name|deck|x|y|width|height|theme|waveform|cues|artwork)"/.test(edit), 'the properties inspector and numeric/internal editors are gone');
  assert.deepEqual([...new Set([...edit.matchAll(/data-editor-field="([^"]+)"/g)].map(m => m[1]))].sort(), ['snap', 'theme-all']);
  assert.equal((edit.match(/class="canvas-widget selected"/g) || []).length, 1, 'exactly one component is selected');
  const perform = renderCanvas(workspace, { editing: false, selected: 'item-1', deck: 'A' }, { undo: 0, redo: 0 }, createSession());
  assert.ok(!/widget-handle|widget-actions/.test(perform), 'Perform mode renders no resize handles or layout actions');
});
