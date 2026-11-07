// A MOCK of the desktop bridge for Chromium tests. It follows the real engine's rules (a seek keeps the
// paused/playing state, a seek is one request at a time per deck, receipts carry sourced positions) but makes
// no sound. Its optional ticker advances a MOCK clock so a page has receipts to paint; it is never evidence
// of audio, latency or the native engine. Real engine behavior is covered by test:native and test:desktop.
export function mockBridgeSource(tracks) {
  return `(() => {
  const tracks = ${JSON.stringify(tracks)};
  const engine = { id: 'engine-aa-bb', seq: 0, ready: true, crossfader: 50, decks: {} };
  for (const id of ['A', 'B', 'C', 'D']) engine.decks[id] = { trackId: null, position: 0, playing: false, level: 78, loading: false, busy: false };
  const mock = window.__mock = { calls: [], delays: {}, failures: [], snap: 0, engine, ticker: 0, last: 0, listener: null, emits: 0 };
  const duration = (id) => tracks.find((t) => t.id === id)?.duration || 0;
  const snapshot = () => ({ engineId: engine.id, seq: ++engine.seq, ready: engine.ready, crossfader: engine.crossfader,
    decks: ['A', 'B', 'C', 'D'].map((id) => { const d = engine.decks[id]; return { id, trackId: d.trackId, duration: duration(d.trackId), channels: 2, sampleRate: 48000, position: d.position, playing: d.playing && engine.ready && !d.loading, level: d.level, loadGeneration: 1, loading: d.loading }; }) });
  const emit = () => { mock.emits++; mock.listener && mock.listener({ type: 'state', snapshot: snapshot() }); };
  mock.emit = emit;
  mock.advance = (seconds) => { for (const d of Object.values(engine.decks)) if (d.trackId && d.playing && !d.loading) d.position = Math.min(duration(d.trackId), d.position + seconds); };
  mock.start = (hz = 60) => { mock.stop(); mock.last = performance.now(); mock.ticker = setInterval(() => { const now = performance.now(); mock.advance((now - mock.last) / 1000); mock.last = now; emit(); }, 1000 / hz); };
  mock.stop = () => { clearInterval(mock.ticker); mock.ticker = 0; };
  mock.seeks = () => mock.calls.filter((c) => c.type === 'seek');
  mock.types = () => mock.calls.map((c) => c.type);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.deckCraftNative = Object.freeze({ version: 1,
    onEvent(fn) { mock.listener = fn; return () => { mock.listener = null; }; },
    async command(request) {
      mock.calls.push({ ...request, at: performance.now() });
      const deck = engine.decks[request.deck];
      switch (request.type) {
        case 'library': return { ok: true, tracks, collections: [] };
        case 'status': return { ok: true, snapshot: snapshot() };
        case 'retain-track': case 'level': if (deck && request.type === 'level') deck.level = request.value; return { ok: true, snapshot: snapshot() };
        case 'crossfader': engine.crossfader = request.value; return { ok: true, snapshot: snapshot() };
        case 'load': { deck.trackId = request.trackId; deck.position = 0; deck.playing = false; await wait(mock.delays.load || 0); return { ok: true, snapshot: snapshot(), track: tracks.find((t) => t.id === request.trackId) }; }
        case 'play': deck.playing = true; return { ok: true, snapshot: snapshot() };
        case 'pause': deck.playing = false; return { ok: true, snapshot: snapshot() };
        case 'seek': {
          if (deck.busy) return { ok: false, error: 'deck_loading' };
          deck.busy = true; deck.loading = true; emit();
          await wait(mock.delays.seek || 0);
          const failure = mock.failures.shift();
          deck.loading = false; deck.busy = false;
          if (failure) { emit(); return { ok: false, error: failure }; }
          const landed = mock.snap ? Math.round(request.position / mock.snap) * mock.snap : request.position;
          deck.position = Math.max(0, Math.min(duration(deck.trackId), landed));
          return { ok: true, snapshot: snapshot() };
        }
        default: return { ok: true, snapshot: snapshot() };
      }
    } });
})();`;
}
export function mockTracks() {
  const peaks = (phase) => Array.from({ length: 512 }, (_, i) => Math.min(1, 0.25 + 0.55 * Math.abs(Math.sin(i / 11 + phase)) * (0.6 + 0.4 * Math.sin(i / 53))));
  return [
    { id: 'local-11111111-1111-1111-1111-111111111111', title: 'Mock scrub fixture A.wav', duration: 300, peaks: peaks(0) },
    { id: 'local-22222222-2222-2222-2222-222222222222', title: 'Mock scrub fixture B.wav', duration: 180, peaks: peaks(1) },
  ];
}
