import { MIXER_KNOBS, meterFraction } from './mixer.js';
import { DECK_IDS, trackById } from './catalog.js';
import { timeLabel, paintWaveBox, paintKnob } from './components.js';

const paintVisible = (el) => !el.closest('.design-preview');
const unit = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const ARIA_INTERVAL_MS = 250;

/**
 * The hot transport paint. It paints native receipts (or an explicitly transient pointer preview) once per
 * animation frame and writes only the clock text, decoded waveform canvas, playhead and a few inputs. It never
 * queries the library, rebuilds markup or reorders rows; element lists are cached until `invalidate()`
 * (called after a re-render). It does not extrapolate: positions come from the session state it is given.
 */
export class TransportPainter {
  constructor(root, { state, preview = () => undefined, meter = () => null, zoom, request, cancel, now } = {}) {
    this.root = root;
    this.state = state;
    this.preview = preview;
    this.meter = meter;
    this.zoom = zoom;
    this.request = request || (typeof requestAnimationFrame === "function" ? requestAnimationFrame.bind(globalThis) : null);
    this.cancel = cancel || (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame.bind(globalThis) : () => {});
    this.now = now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.cache = null;
    this.handle = 0;
    this.force = true;
    this.stats = { frames: 0, writes: 0 };
  }
  invalidate() {
    this.cache = null;
    this.force = true;
  }
  /** Ask for a paint on the next animation frame; repeated calls within a frame coalesce. */
  mark() {
    if (this.handle) return;
    if (!this.request) {
      this.paint();
      return;
    }
    this.handle = this.request(() => {
      this.handle = 0;
      this.paint();
    });
  }
  /** Paint now, cancelling any queued frame. Used after a re-render or a cold update. */
  flush({ force = true } = {}) {
    if (this.handle) this.cancel(this.handle);
    this.handle = 0;
    if (force) this.force = true;
    this.paint();
  }
  collect() {
    const find = (selector) => [...this.root.querySelectorAll(selector)].filter(paintVisible);
    const decks = {};
    for (const id of DECK_IDS)
      decks[id] = {
        clocks: find(`section.deck[data-deck="${id}"] .elapsed`).map((el) => ({ el, linear: !!el.closest(".linear-clock"), text: null })),
        remaining: find(`section.deck[data-deck="${id}"] .remaining`).map((el) => ({ el, text: null })),
        boxes: find(`[data-wave-deck="${id}"]`).map((el) => ({
          el,
          scroll: el.classList.contains("scroll"),
          slider: el.getAttribute("role") === "slider",
          track: el.querySelector(".wave-track"),
          section: el.closest("section.deck"),
          canvas: el.querySelector("canvas.wave-canvas"),
          shade: el.querySelector(".played-shade"),
          marker: el.querySelector(".position-marker"),
          seek: el.querySelector("input.wave-seek"),
          ratio: null,
          seekValue: null,
          ariaAt: 0,
        })),
        pads: find(`[data-action="hot-cue"][data-deck="${id}"]`).map((el) => ({ el, index: Number(el.dataset.index), pressed: null })),
        levels: find(`[data-deck="${id}"][data-field="level"]`),
        knobs: find(`[data-deck="${id}"][data-field]`).filter(el=>el.matches("input")&&MIXER_KNOBS.includes(el.dataset.field)).map(input=>({input,field:input.dataset.field,label:input.closest("label.knob")})),
        kills: find(`[data-action="eq-kill"][data-deck="${id}"]`),
        assignments: find(`[data-action="assign"][data-deck="${id}"]`),
        meters: find(`[data-vu-deck="${id}"]`).map(el=>({el,bars:[...el.querySelectorAll("i")],last:null,label:null})),
        strip: {},
        position: NaN,
        trackId: null,
        level: NaN,
      };
    for(const c of Object.values(decks))for(const box of c.boxes)if(box.canvas){
      const canvas=box.canvas,view=canvas.ownerDocument.defaultView;
      box.metrics={width:canvas.clientWidth,height:canvas.clientHeight,tint:view.getComputedStyle(canvas).getPropertyValue('--deck').trim()};
    }
    this.cache = { decks, crossfaders: find('[data-action="crossfader"]'), crossfader: NaN };
  }
  active(el) {
    return this.root.ownerDocument?.activeElement === el;
  }
  paint() {
    if (!this.cache) this.collect();
    const force = this.force;
    this.force = false;
    const state = this.state();
    this.stats.frames++;
    for (const id of DECK_IDS) {
      const deck = state.decks[id],
        track = trackById(deck.trackId);
      if (!track) continue;
      const c = this.cache.decks[id],
        held = this.preview(id),
        position = held === undefined ? deck.position : held;
      if (force || position !== c.position || deck.trackId !== c.trackId) {
        c.position = position;
        c.trackId = deck.trackId;
        this.paintPosition(c, position, track, deck);
      }
      for(const el of c.kills){const on=String(deck[el.dataset.band]===0);if(el.getAttribute("aria-pressed")!==on)el.setAttribute("aria-pressed",on);}
      for(const el of c.assignments){const on=String(deck.assign===el.dataset.value);if(el.getAttribute("aria-pressed")!==on)el.setAttribute("aria-pressed",on);}
      const status=this.meter(),native=status?.decks?.find(d=>d.id===id);
      const live=status?.ready===true&&status?.terminal!==true&&status?.capabilities?.channelMeters===true&&native?.playing===true;
      const peaks=live?[native.meter?.l,native.meter?.r]:[0,0];
      for(const m of c.meters){
        const values=peaks.map(meterFraction);
        const key=values.map(v=>v.toFixed(3)).join(":");
        if(force||m.last!==key){
          m.last=key;
          m.bars.forEach((bar,i)=>{bar.style.setProperty("--meter",values[i].toFixed(3));bar.dataset.clip=String(peaks[i]>1);});
          const label=live?"Channel "+id+" peak meter after EQ and fader":"Channel "+id+" meter: silent";
          if(m.label!==label){m.label=label;m.el.setAttribute("aria-label",label);}
        }
      }
      for(const field of MIXER_KNOBS)if(force||c.strip[field]!==deck[field]){
        c.strip[field]=deck[field];
        for(const {input,label,field:knobField} of c.knobs)if(knobField===field){
          if(!this.active(input))input.value=deck[field];
          if(label)paintKnob(label,id,field,Number(input.value));
        }
      }
      if (force || deck.level !== c.level) {
        c.level = deck.level;
        for (const input of c.levels) if (!this.active(input) && Number(input.value) !== deck.level) input.value = deck.level;
      }
    }
    const crossfader = state.mixer.crossfader;
    if (force || crossfader !== this.cache.crossfader) {
      this.cache.crossfader = crossfader;
      for (const input of this.cache.crossfaders) if (!this.active(input) && Number(input.value) !== crossfader) input.value = crossfader;
    }
  }
  paintPosition(c, position, track, deck) {
    const elapsed = timeLabel(position, true),
      remaining = "−" + timeLabel(track.duration - position, true),
      total = timeLabel(track.duration);
    for (const clock of c.clocks) {
      const text = elapsed + (clock.linear ? " / " + total : "");
      if (clock.text !== text) {
        clock.el.textContent = text;
        clock.text = text;
        this.stats.writes++;
      }
    }
    for (const item of c.remaining)
      if (item.text !== remaining) {
        item.el.textContent = remaining;
        item.text = remaining;
        this.stats.writes++;
      }
    const ratio = unit(position / track.duration),
      now = this.now();
    for (const box of c.boxes) {
      if (box.ratio !== ratio) {
        box.ratio = ratio;
        paintWaveBox(box.el,ratio,track,{elements:box});
        this.stats.writes++;
      }
      if (box.seek && box.seekValue !== position && !this.active(box.seek)) {
        box.seek.value = position;
        box.seekValue = position;
      }
      // Assistive-technology values change at a few Hz at most and only for the focused slider.
      if (box.slider && now - box.ariaAt >= ARIA_INTERVAL_MS && this.active(box.el)) {
        box.ariaAt = now;
        box.el.setAttribute("aria-valuenow", position.toFixed(1));
        box.el.setAttribute("aria-valuetext", timeLabel(position, true) + " of " + total);
      }
    }
    for (const pad of c.pads) {
      const pressed = Math.abs(deck.cues[pad.index] - position) < 0.05;
      if (pad.pressed !== pressed) {
        pad.pressed = pressed;
        pad.el.setAttribute("aria-pressed", String(pressed));
      }
    }
  }
  /** Mark the dragging state on a deck's waveforms (cursor and focus ring), without touching other decks. */
  setScrubbing(deck, on) {
    for (const el of [...this.root.querySelectorAll(`[data-wave-deck="${deck}"]`)].filter(paintVisible)) el.classList.toggle("scrubbing", on);
  }
  /** Cold zoom/resize/theme path: refresh viewport decorations and cached canvas metrics. */
  refresh() {
    for(const el of this.root.querySelectorAll('[data-wave-deck]'))if(paintVisible(el))this.zoom.paint(el);
    this.invalidate();this.flush();
  }
}
