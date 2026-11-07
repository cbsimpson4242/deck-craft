import { trackById } from './catalog.js';
import { SCRUB_SLOP_PX, scrubGeometry, scrollTarget, fitTarget } from './scrub.js';

const KEY_IDLE_MS = 150;
const waveClamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Pointer and keyboard scrubbing of the zoomable waveforms. A gesture owns only a transient preview position;
 * the transport remains whatever native receipts say. Commits go through `audio` (NativeSession) as coalesced
 * seeks, or straight to the session in the browser-only UI. A gesture is cancelled, never replayed, when the
 * pointer is cancelled, the track changes, ownership is superseded, the window hides or the page is disposed.
 */
export class WaveGesture {
  constructor(root, { store, painter, audio = null, zoom, say = () => {} }) {
    this.root = root;
    this.store = store;
    this.painter = painter;
    this.audio = audio;
    this.zoom = zoom;
    this.say = say;
    this.active = null;
    this.previews = new Map();
    this.keys = new Map();
    this.sequence = 0;
    this.move = (event) => this.onMove(event);
    this.up = (event) => this.onUp(event);
    this.cancelled = (event) => {
      if (this.active && event.pointerId === this.active.pointerId) this.cancel();
    };
    this.visibility = () => {
      if (typeof document !== "undefined" && document.hidden) this.cancelAll();
    };
    this.lost = (event) => {
      if (this.active && event.pointerId === this.active.pointerId) this.cancel();
    };
    this.blur = () => this.cancelAll();
    root.addEventListener("pointerdown", (event) => this.onDown(event));
    root.addEventListener("keydown", (event) => this.onKey(event));
    root.addEventListener("keyup", (event) => this.onKeyUp(event));
    root.addEventListener("lostpointercapture", this.lost);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.visibility);
    window.addEventListener("blur", this.blur);
  }
  /** The transient position a deck's waveforms should show, or undefined to show the native receipt. */
  preview(deck) {
    return this.previews.get(deck)?.pos;
  }
  position(deck) {
    return this.preview(deck) ?? this.store.get().decks[deck].position;
  }
  hold(deck, id, pos, token) {
    this.previews.set(deck, { id, pos, token });
    this.painter.mark();
  }
  release(deck, id) {
    if (this.previews.get(deck)?.id !== id) return;
    this.previews.delete(deck);
    this.painter.setScrubbing(deck, false);
    this.painter.mark();
  }
  setWindowListeners(on) {
    const method = on ? "addEventListener" : "removeEventListener";
    window[method]("pointermove", this.move);
    window[method]("pointerup", this.up);
    window[method]("pointercancel", this.cancelled);
  }
  onDown(event) {
    if (this.active || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const box = event.target.closest?.(".wavebox.detail[data-wave-deck]");
    if (!box || !this.root.contains(box) || box.closest(".design-preview") || event.target.closest(".zoom-ctl")) return;
    const deck = box.dataset.waveDeck,
      state = this.store.get(),
      track = trackById(state.decks[deck].trackId),
      rect = box.getBoundingClientRect();
    if (!track || rect.width <= 0) return;
    const geo = scrubGeometry(this.zoom.level(box), track.duration, rect.width, box.classList.contains("scroll"));
    event.preventDefault();
    box.focus({ preventScroll: true });
    try {
      box.setPointerCapture(event.pointerId);
    } catch {}
    const gesture = (this.active = {
      id: ++this.sequence,
      pointerId: event.pointerId,
      deck,
      trackId: track.id,
      duration: track.duration,
      startX: event.clientX,
      startPosition: this.position(deck),
      fit: geo.fit,
      scroll: box.classList.contains("scroll"),
      fitWindow: geo.window,
      fitStart: geo.fit?0:Math.max(0,Math.min(track.duration-geo.window,this.position(deck)-geo.window/2)),
      spp: geo.window / rect.width,
      left: rect.left,
      width: rect.width,
      begun: null,
      engaged: false,
      warned: false,
      position: null,
    });
    this.setWindowListeners(true);
    // A fit view is a static track: pressing it targets that point immediately, like the old seek bar.
    if (geo.fit) this.engage(gesture, event.clientX);
  }
  engage(gesture, x) {
    gesture.engaged = true;
    // Ownership is taken only once the press becomes a drag, so a plain tap cannot supersede a pending Play.
    gesture.begun = this.audio ? this.audio.beginScrub(gesture.deck, { onCancel: () => {
      if (this.active === gesture) this.cancel();
      this.release(gesture.deck, gesture.id);
    } }) : { ok: true, token: null };
    if (!gesture.begun.ok) {
      if (!gesture.warned) this.say(gesture.begun.message);
      gesture.warned = true;
      return false;
    }
    this.painter.setScrubbing(gesture.deck, true);
    this.drive(gesture, x, false);
    return true;
  }
  drive(gesture, x, final) {
    const position = gesture.fit
      ? gesture.fitStart + fitTarget(x, gesture.left, gesture.width, gesture.fitWindow)
      : scrollTarget(gesture.startPosition, x - gesture.startX, gesture.spp, gesture.duration);
    gesture.position = position;
    this.hold(gesture.deck, gesture.id, position, gesture.begun.token);
    if (!final && this.audio) this.audio.scrubMove(gesture.begun.token, position);
  }
  onMove(event) {
    const gesture = this.active;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (this.store.get().decks[gesture.deck].trackId !== gesture.trackId) return this.cancel();
    if (!gesture.engaged) {
      if (Math.abs(event.clientX - gesture.startX) < SCRUB_SLOP_PX) return;
      if (!this.engage(gesture, event.clientX)) return;
    }
    if (gesture.begun?.ok) this.drive(gesture, event.clientX, false);
  }
  onUp(event) {
    const gesture = this.active;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    this.setWindowListeners(false);
    this.active = null;
    // Preserve the console's click-to-seek timeline mapping at every zoom. Scrolling details ignore a tap.
    if(!gesture.engaged&&!gesture.scroll){gesture.fit=true;this.engage(gesture,event.clientX);}
    // A tap on a scrolling waveform moves nothing; the fit view always targets the pointer-up point.
    if (!gesture.engaged || !gesture.begun?.ok || this.store.get().decks[gesture.deck].trackId !== gesture.trackId) {
      if (gesture.begun?.ok) this.audio?.scrubCancel(gesture.begun.token);
      this.release(gesture.deck, gesture.id);
      return;
    }
    this.drive(gesture, event.clientX, true);
    this.commit(gesture.deck, gesture.id, gesture.begun.token, gesture.position);
  }
  commit(deck, id, token, position) {
    if (!this.audio) {
      this.store.dispatch({ type: "deck", deck, field: "position", value: position });
      this.release(deck, id);
      return Promise.resolve(true);
    }
    // The preview stays pinned until native acknowledges this exact seek (or it fails or is superseded).
    return this.audio.scrubEnd(token, position).then((ok) => {
      this.release(deck, id);
      return ok;
    });
  }
  cancel() {
    const gesture = this.active;
    this.setWindowListeners(false);
    this.active = null;
    if (!gesture) return;
    if (gesture.begun?.ok) this.audio?.scrubCancel(gesture.begun.token);
    this.release(gesture.deck, gesture.id);
  }
  /** A view replacement, hidden window or lost focus cancels queued pointer and keyboard targets. */
  cancelAll() {
    this.cancel();
    for (const deck of [...this.keys.keys()]) this.dropKeys(deck, true);
    for (const [deck, preview] of [...this.previews]) {
      if (preview.token) this.audio?.scrubCancel(preview.token);
      this.release(deck, preview.id);
    }
  }
  onKey(event) {
    const box = event.target;
    if (!box.matches?.(".wavebox.detail[data-wave-deck]") || box.closest(".design-preview") || event.altKey || event.ctrlKey || event.metaKey) return;
    const deck = box.dataset.waveDeck,
      state = this.store.get(),
      track = trackById(state.decks[deck].trackId);
    if (!track) return;
    if (event.key === "Escape") {
      if (this.active || this.keys.has(deck)) {
        event.preventDefault();
        this.cancel();
        this.dropKeys(deck, true);
      }
      return;
    }
    const zoomStep = ["+", "="].includes(event.key) ? -1 : ["-", "_"].includes(event.key) ? 1 : 0;
    if (zoomStep) {
      event.preventDefault();
      this.zoom.adjust(box, -zoomStep);
      return;
    }
    const base = this.position(deck),
      large = event.shiftKey || event.key === "PageUp" || event.key === "PageDown",
      delta = Math.max(0.05, (large ? 120 : 24) * track.duration / this.zoom.level(box) / Math.max(1,box.getBoundingClientRect().width));
    const target = { ArrowLeft: base - delta, ArrowDown: base - delta, PageDown: base - delta, ArrowRight: base + delta, ArrowUp: base + delta, PageUp: base + delta, Home: 0, End: track.duration }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    this.nudge(deck, waveClamp(target, 0, track.duration));
  }
  /** Held keys coalesce into one gesture: interim targets are rate-limited and the last one is always sent. */
  nudge(deck, position) {
    if (!this.audio) {
      this.store.dispatch({ type: "deck", deck, field: "position", value: position });
      return;
    }
    let key = this.keys.get(deck);
    if (!key) {
      const begun = this.audio.beginScrub(deck, { onCancel: () => {
        if (this.keys.get(deck) === key) this.dropKeys(deck, false);
        if (key) this.release(deck, key.id);
      } });
      if (!begun.ok) {
        this.say(begun.message);
        return;
      }
      key = { id: "key-" + ++this.sequence, token: begun.token, timer: 0 };
      this.keys.set(deck, key);
    }
    clearTimeout(key.timer);
    key.position = position;
    this.hold(deck, key.id, position, key.token);
    this.audio.scrubMove(key.token, position, true);
    key.timer = setTimeout(() => this.endKeys(deck), KEY_IDLE_MS);
  }
  onKeyUp(event) {
    if (event.target.matches?.(".wavebox.detail[data-wave-deck]")) this.endKeys(event.target.dataset.waveDeck);
  }
  endKeys(deck) {
    const key = this.keys.get(deck);
    if (!key) return;
    clearTimeout(key.timer);
    this.keys.delete(deck);
    this.commit(deck, key.id, key.token, key.position);
  }
  dropKeys(deck, cancel) {
    const key = this.keys.get(deck);
    if (!key) return;
    clearTimeout(key.timer);
    this.keys.delete(deck);
    if (cancel) this.audio?.scrubCancel(key.token);
    this.release(deck, key.id);
  }
  dispose() {
    this.cancelAll();
    window.removeEventListener("blur", this.blur);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.visibility);
  }
}
