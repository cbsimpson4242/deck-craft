// Scrub geometry and native seek ownership. Bridge fixtures are MOCKED, never audio acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK_IDS, registerLocalTrack } from '../src/catalog.js';
import { SeekPump, scrubGeometry, scrollTarget, fitTarget, SCRUB_SLOP_PX } from '../src/scrub.js';
import { createStore } from '../src/store.js';
import { NativeSession } from '../src/native.js';
import { createSession } from '../src/session.js';
import { createViewOptions, renderSession } from '../src/views.js';
import { createComponent } from '../src/workspace.js';
import { renderDesignPreview } from '../src/canvas-editor.js';
const near=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<=e,`${a} !~ ${b}`);
test('scrub sensitivity follows the actual wheel viewport and clamps both track endpoints',()=>{
  const coarse=scrubGeometry(2,300,600),fine=scrubGeometry(8,300,600);
  near(coarse.spp,.25);near(fine.spp,.0625);
  near(scrollTarget(100,-40,coarse.spp,300),110);
  near(scrollTarget(100,40,fine.spp,300),97.5);
  assert.equal(scrollTarget(1,100,fine.spp,300),0);
  assert.equal(scrollTarget(299,-100,fine.spp,300),300);
  assert.equal(scrubGeometry(1,300,600).fit,true);
  assert.equal(scrubGeometry(1,300,600,true).fit,false);
  assert.equal(fitTarget(350,50,600,240),120);
  assert.equal(fitTarget(-10,50,600,240),0);
  assert.equal(fitTarget(900,50,600,240),240);
});
test('console waveforms expose scrubbing and zoom without restoring obsolete layouts',()=>{
  const html=renderSession(createSession(),createViewOptions());
  for(const id of DECK_IDS)assert.match(html,new RegExp('data-action="zoom-in" data-deck="'+id+'"'));
  assert.match(html,/role="slider"/);assert.doesNotMatch(html,/layout-picker/);
  const preview=renderDesignPreview(createComponent('waveform','A'),'paused');
  assert.match(preview,/zoom-ctl/);assert.doesNotMatch(preview,/role="slider"|tabindex|data-action|data-wave-deck/);
});

// ---- SeekPump -----------------------------------------------------------------------------------------------
function fakeClock() {
  let time = 0, next = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = Math.max(time, due[1].at);
        timers.delete(due[0]);
        due[1].fn();
        await settle();
      }
      time = end;
      await settle();
    },
    pending: () => timers.size,
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function controlledSend() {
  const sent = [], open = [];
  return {
    sent,
    send: (position) => new Promise((resolve, reject) => { sent.push(position); open.push({ resolve, reject }); }),
    ack: async (ok = true, error) => { const request = open.shift(); ok ? request.resolve() : request.reject(error || Error('seek_failed')); await settle(); },
    inFlight: () => open.length,
  };
}

test('pump: a burst of pointer moves sends at most one request at a time and the latest target wins', async () => {
  const clock = fakeClock(), io = controlledSend();
  const pump = new SeekPump({ send: io.send, interval: 90, clock });
  pump.move(1);
  assert.deepEqual(io.sent, [1], 'the first target is not held back');
  for (let i = 2; i <= 200; i++) { pump.move(i); await clock.advance(1); }
  assert.equal(io.inFlight(), 1, 'no second request while the first is open');
  assert.deepEqual(io.sent, [1]);
  await io.ack();
  await clock.advance(100);
  assert.deepEqual(io.sent.length, 2);
  assert.equal(io.sent[1] >= 190, true, 'the newest target replaced all older queued ones');
  await io.ack();
  assert.ok(io.sent.length <= 4, 'a 200-event burst produced only a handful of decoder requests');
});

test('pump: requests are rate limited even when the previous one is acknowledged immediately', async () => {
  const clock = fakeClock(), sent = [];
  const pump = new SeekPump({ send: async (p) => { sent.push([p, clock.now()]); }, interval: 90, clock });
  for (let t = 0; t < 1000; t += 5) { pump.move(t); await clock.advance(5); }
  await clock.advance(200);
  assert.ok(sent.length <= 14 && sent.length >= 8, `about one request per 90 ms, got ${sent.length}`);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i][1] - sent[i - 1][1] >= 89, 'minimum spacing between decoder preparations');
  assert.equal(sent.at(-1)[0] >= 990, true, 'trailing target is not starved by continuous movement');
});

test('pump: the final target is never lost, bypasses the interval, and resolves only when acknowledged', async () => {
  const clock = fakeClock(), io = controlledSend();
  const pump = new SeekPump({ send: io.send, interval: 90, clock });
  pump.move(10);
  pump.move(20);
  let result;
  const done = pump.finish(30).then((ok) => { result = ok; });
  assert.deepEqual(io.sent, [10], 'the final waits only for the open request');
  await io.ack();
  assert.deepEqual(io.sent, [10, 30], 'final sent immediately, not after another interval and not replaced by the stale 20');
  assert.equal(result, undefined);
  await io.ack();
  await done;
  assert.equal(result, true);
});

test('pump: a lone final request is sent immediately and a duplicate of the acknowledged target is not resent', async () => {
  const clock = fakeClock(), io = controlledSend();
  const pump = new SeekPump({ send: io.send, interval: 90, clock });
  const done = pump.finish(42);
  assert.deepEqual(io.sent, [42]);
  await io.ack();
  assert.equal(await done, true);
  const second = new SeekPump({ send: io.send, clock });
  second.move(7);
  const duplicate = second.finish(7);
  assert.deepEqual(io.sent, [42, 7], 'finishing on the target already in flight does not send it twice');
  await io.ack();
  assert.equal(await duplicate, true);
});

test('pump: failure is reported once, drops queued targets and fails the final', async () => {
  const clock = fakeClock(), io = controlledSend(), errors = [];
  const pump = new SeekPump({ send: io.send, onError: (e) => errors.push(e.message), interval: 90, clock });
  pump.move(1);
  pump.move(2);
  const done = pump.finish(3);
  await io.ack(false, Error('seek_failed'));
  assert.equal(await done, false);
  assert.deepEqual(errors, ['seek_failed']);
  assert.deepEqual(io.sent, [1], 'queued targets are dropped after a failure; nothing is replayed');
  pump.move(4);
  assert.equal(await pump.finish(5), false);
  assert.deepEqual(io.sent, [1]);
});

test('pump: cancel and ownership loss drop queued targets and never replay', async () => {
  const clock = fakeClock(), io = controlledSend();
  let owner = true;
  const pump = new SeekPump({ send: io.send, current: () => owner, interval: 90, lead: 40, clock });
  pump.move(5);
  assert.equal(io.sent.length, 0, 'slider-style lead holds the first request briefly');
  owner = false;
  await clock.advance(200);
  assert.deepEqual(io.sent, [], 'a superseded owner never sends');
  assert.equal(await pump.finish(6), false);
  const cancelled = new SeekPump({ send: io.send, interval: 90, clock });
  cancelled.move(1);
  cancelled.move(2);
  const final = cancelled.finish(3);
  cancelled.cancel();
  assert.equal(await final, false);
  await io.ack();
  await clock.advance(500);
  assert.deepEqual(io.sent, [1], 'only the already-open request is sent; cancellation never queues more');
  assert.equal(clock.pending(), 0);
});

const TRACK = { id: 'local-12345678-1234-1234-1234-1234567890ab', title: 'Scrub <mock>.wav', duration: 200, peaks: [] };
function mockEngine({ playing = false, position = 20, loaded = true } = {}) {
  const engine = { seq: 0, playing, position, loaded, calls: [], held: new Map(), fail: new Map(), engineId: 'engine-aa-bb' };
  engine.snapshot = () => ({
    engineId: engine.engineId, seq: ++engine.seq, ready: true, crossfader: 50,
    decks: DECK_IDS.map((id) => ({ id, trackId: id === 'A' && engine.loaded ? TRACK.id : null, playing: id === 'A' && engine.playing, position: id === 'A' ? engine.position : 0, level: 78, channels: 2, sampleRate: 48000, duration: 200, loading: false })),
  });
  engine.bridge = {
    onEvent() {},
    async command(request) {
      engine.calls.push(request);
      if (engine.fail.has(request.type)) return { ok: false, error: engine.fail.get(request.type) };
      if (engine.held.has(request.type)) await new Promise((resolve) => engine.held.get(request.type).push(resolve));
      if (request.type === 'seek') engine.position = Math.min(200, request.position); // the engine keeps playing/paused as it was
      if (request.type === 'play') engine.playing = true;
      if (request.type === 'pause') engine.playing = false;
      if (request.type === 'library') return { ok: true, tracks: [TRACK], collections: [] };
      return { ok: true, snapshot: engine.snapshot(), track: TRACK };
    },
  };
  return engine;
}
function session(engine, extra = {}) {
  registerLocalTrack(TRACK);
  const store = createStore({ getItem: () => null, setItem() {} });
  store.dispatch({ type: 'load', deck: 'A', trackId: TRACK.id });
  const clock = fakeClock(), events = { redraw: 0, update: 0, said: [] };
  const native = new NativeSession(engine.bridge, store, { redraw: () => events.redraw++, update: () => events.update++, say: (m) => events.said.push(m), seek: { interval: 90, lead: 40 }, clock, ...extra });
  native.initialized = true;
  native.accept(engine.snapshot(), true);
  native.mixerSynced = true;
  return { store, native, clock, events };
}
const seeks = (engine) => engine.calls.filter((c) => c.type === 'seek').map((c) => c.position);

test('scrub of a playing deck sends coalesced seeks, a final exact seek, and leaves the deck playing', async () => {
  const engine = mockEngine({ playing: true, position: 20 });
  const { native, clock, store } = session(engine);
  const begun = native.beginScrub('A');
  assert.equal(begun.ok, true);
  for (let i = 0; i < 100; i++) { native.scrubMove(begun.token, 20 + i * 0.3); await clock.advance(5); }
  assert.ok(seeks(engine).length >= 3 && seeks(engine).length <= 8, `bounded interim seeks, got ${seeks(engine).length}`);
  const ok = await native.scrubEnd(begun.token, 61.5);
  assert.equal(ok, true);
  assert.equal(seeks(engine).at(-1), 61.5, 'the pointer-up target is the last seek');
  assert.equal(engine.playing, true, 'a seek never pauses a playing deck');
  assert.equal(store.get().decks.A.playing, true);
  assert.equal(store.get().decks.A.position, 61.5, 'the displayed position now comes from the native receipt');
  assert.equal(engine.calls.filter((c) => c.type === 'play' || c.type === 'pause').length, 0, 'no transport command was issued by scrubbing');
});

test('scrub of a paused deck sends exactly one seek at release and stays paused', async () => {
  const engine = mockEngine({ playing: false, position: 20 });
  const { native, clock, store } = session(engine);
  const { token } = native.beginScrub('A');
  for (let i = 0; i < 50; i++) { native.scrubMove(token, 20 + i); await clock.advance(5); }
  assert.deepEqual(seeks(engine), [], 'a paused deck is silent, so nothing is sought during the drag');
  assert.equal(await native.scrubEnd(token, 33.3), true);
  assert.deepEqual(seeks(engine), [33.3]);
  assert.equal(engine.playing, false);
  assert.equal(store.get().decks.A.playing, false);
  assert.equal(store.get().decks.A.position, 33.3);
});

for (const boundary of ['pause', 'play', 'load', 'cue', 'hotCue', 'reconnect']) {
  test(`a gesture cannot seek after a newer ${boundary} supersedes it`, async () => {
    const engine = mockEngine({ playing: true });
    const { native, clock } = session(engine);
    const { token } = native.beginScrub('A');
    native.scrubMove(token, 50);
    await clock.advance(10);
    const before = seeks(engine).length;
    native.scrubMove(token, 60); // queued behind the open interim seek rules
    if (boundary === 'reconnect') native.owners.A++;
    else await native.perform(boundary === 'pause' ? { type: 'deck', deck: 'A', field: 'playing', value: false } : boundary === 'play' ? { type: 'deck', deck: 'A', field: 'playing', value: true } : boundary === 'load' ? { type: 'load', deck: 'A', trackId: TRACK.id } : { type: boundary, deck: 'A', index: 0 });
    const afterBoundary = seeks(engine).length;
    const ok = await native.scrubEnd(token, 120);
    await clock.advance(500);
    assert.equal(ok, false, 'the final seek of a superseded gesture is refused');
    assert.ok(!seeks(engine).includes(120) && !seeks(engine).includes(60), 'a stale target is never replayed');
    assert.ok(seeks(engine).length <= Math.max(afterBoundary, before + 1) + (boundary === 'cue' || boundary === 'hotCue' ? 1 : 0), 'no additional gesture seeks after the boundary');
  });
}

test('native seek failure is reported once, nothing is retried, and the receipt stays authoritative', async () => {
  const engine = mockEngine({ playing: true, position: 20 });
  const { native, clock, store, events } = session(engine);
  engine.fail.set('seek', 'seek_failed');
  const { token } = native.beginScrub('A');
  native.scrubMove(token, 40);
  await clock.advance(10);
  native.scrubMove(token, 50);
  await clock.advance(300);
  const ok = await native.scrubEnd(token, 70);
  assert.equal(ok, false);
  assert.equal(events.said.length, 1);
  assert.match(events.said[0], /could not seek/i);
  assert.equal(seeks(engine).length, 1, 'no automatic retry');
  assert.equal(store.get().decks.A.position, 20, 'position is whatever native last reported, not the preview');
});

test('beginScrub refuses decks that cannot be sought, with an honest message', () => {
  const engine = mockEngine({ playing: false });
  const { native, store, events } = session(engine);
  native.initialized = false;
  assert.match(native.beginScrub('A').message, /initialization/);
  native.initialized = true;
  assert.match(native.beginScrub('B').message, /Demo fixtures contain no audio/);
  engine.loaded = false;
  native.accept(engine.snapshot());
  assert.match(native.beginScrub('A').message, /not finished loading/);
  engine.loaded = true;
  native.accept(engine.snapshot());
  native.busy.add('A');
  assert.match(native.beginScrub('A').message, /still loading/);
  native.busy.clear();
  native.accept({ ...engine.snapshot(), ready: false });
  assert.match(native.beginScrub('A').message, /audio output is unavailable/i);
  assert.equal(events.said.length, 0);
  assert.equal(store.get().decks.A.trackId, TRACK.id);
});

test('a second gesture on the same deck supersedes the first without leaking its target', async () => {
  const engine = mockEngine({ playing: true });
  const { native, clock } = session(engine);
  const first = native.beginScrub('A').token;
  native.scrubMove(first, 30);
  await clock.advance(10);
  const second = native.beginScrub('A').token;
  assert.equal(await native.scrubEnd(first, 90), false);
  assert.equal(await native.scrubEnd(second, 100), true);
  assert.ok(!seeks(engine).includes(90));
  assert.equal(seeks(engine).at(-1), 100);
});

test('slider-style seek input is coalesced (not debounced to silence) and keeps the latest value', async () => {
  const engine = mockEngine({ playing: false });
  const { native, clock } = session(engine);
  for (let i = 1; i <= 120; i++) { native.dispatch({ type: 'deck', deck: 'A', field: 'position', value: i }); await clock.advance(10); }
  assert.ok(seeks(engine).length >= 8, 'a continuous drag reaches the engine while the pointer is still moving');
  assert.ok(seeks(engine).length <= 16, `bounded request rate, got ${seeks(engine).length}`);
  await clock.advance(400);
  assert.equal(seeks(engine).at(-1), 120, 'trailing value is delivered');
  assert.deepEqual([...seeks(engine)].sort((a, b) => a - b), seeks(engine), 'targets stay in order');
});

test('level and crossfader sliders throttle instead of waiting for the pointer to stop', async () => {
  const engine = mockEngine({ playing: false });
  const { native } = session(engine);
  for (let i = 0; i < 12; i++) { native.dispatch({ type: 'mixer', field: 'crossfader', value: i }); await new Promise((r) => setTimeout(r, 15)); }
  const before = engine.calls.filter((c) => c.type === 'crossfader').length;
  assert.ok(before >= 2, `crossfader reached the engine during the drag (${before})`);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(engine.calls.filter((c) => c.type === 'crossfader').at(-1).value, 11);
});

test('receipts repaint the clock only; loading flips update transport; engine readiness redraws', () => {
  const engine = mockEngine({ playing: true, position: 5 });
  const { native, store, events } = session(engine);
  const marks = [];
  native.painter = { mark: () => marks.push(1) };
  events.redraw = 0; events.update = 0;
  for (let i = 0; i < 20; i++) { engine.position += 0.016; native.accept(engine.snapshot()); }
  assert.equal(events.redraw, 0);
  assert.equal(events.update, 0, 'ordinary clock receipts never trigger a page or transport update');
  assert.equal(marks.length, 20);
  const loading = engine.snapshot();
  loading.decks[0].loading = true;
  native.accept(loading);
  assert.equal(events.update, 1, 'a seek preparing flips loading: light transport update, not a rebuild');
  assert.equal(events.redraw, 0);
  native.accept({ ...engine.snapshot(), ready: false });
  assert.equal(events.redraw, 1, 'losing the output redraws');
  assert.equal(store.get().decks.A.playing, false);
});

test('scrub slop is small enough for precision yet ignores a plain tap', () => {
  assert.ok(SCRUB_SLOP_PX >= 2 && SCRUB_SLOP_PX <= 6);
});


test('scrub cancellation immediately notifies the view on superseding transport, failure and disconnect', async () => {
  for (const boundary of ['pause', 'failure', 'disconnect', 'replacement']) {
    const engine = mockEngine({ playing: true });
    const { native, clock } = session(engine);
    let cancelled = 0;
    const token = native.beginScrub('A', { onCancel: () => cancelled++ }).token;
    if (boundary === 'pause') await native.perform({ type: 'deck', deck: 'A', field: 'playing', value: false });
    if (boundary === 'failure') {
      engine.fail.set('seek', 'seek_failed');
      native.scrubMove(token, 50);
      await clock.advance(1);
    }
    if (boundary === 'disconnect') native.accept({ ...engine.snapshot(), ready: false, terminal: true });
    if (boundary === 'replacement') native.accept({ ...engine.snapshot(), engineId: 'replacement-engine' }, true);
    assert.equal(cancelled, 1, boundary + ' clears the transient view without waiting for pointer-up');
    assert.equal(await native.scrubEnd(token, 90), false);
    native.scrubCancel(token);
    assert.equal(cancelled, 1, 'cancellation is idempotent');
    assert.ok(!seeks(engine).includes(90));
  }
});
