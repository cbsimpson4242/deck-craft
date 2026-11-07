import { reduceSession, EQ_BANDS, ASSIGNMENTS } from './session.js';
import { DECK_IDS, trackById, registerLocalTrack, replaceLocalLibrary, setLocalWaveDetail } from "./catalog.js";
import { SeekPump, SEEK_INTERVAL_MS, INPUT_SEEK_LEAD_MS } from "./scrub.js";
import { MIXER_KNOBS, MIXER_VALUE_FIELDS } from "./mixer.js";
const CONTROL_INTERVAL_MS=40;

const nativeErrors = {
  audio_output_unavailable: "The default audio output is unavailable. Check PipeWire and your output device, then reconnect audio.",
  audio_engine_disconnected: "The audio engine disconnected. Playback has stopped; reconnect audio to continue.",
  file_unavailable: "This audio file is no longer available. Import it again.",
  file_changed: "This file changed since it was selected. Import it again.",
  unsupported_or_corrupt_audio: "This audio file is unsupported or damaged. Try a WAV, MP3, FLAC or Ogg Vorbis file.",
  duration_unavailable: "The decoder could not determine this file’s duration.",
  unsupported_duration: "This file is empty or longer than the supported two-hour duration.",
  seek_failed: "The decoder could not seek this file.",
  load_cancelled: "The pending load was cancelled.",
  audio_command_timed_out: "The audio engine stopped responding. Reconnect audio; playback will not restart automatically.",
};
export async function restoreNativeCatalog(bridge) {
  if (!bridge) return;
  const result = await bridge.command({ type: "library" });
  if (!result.ok) throw Error(result.error);
  replaceLocalLibrary(result.tracks, result.collections || []);
  return result.warning || "";
}

/** Native receipts own transport and its sample-derived clock, not DOM timers. */
export class NativeSession {
  constructor(bridge, store, { redraw, say, update, seek = {}, clock }) {
    this.bridge = bridge;
    this.store = store;
    this.redraw = redraw;
    // A light repaint for transport changes (play/pause, a seek's loading flag); a full redraw is for engine readiness.
    this.update = update || redraw;
    this.say = say;
    this.seekTiming = { interval: seek.interval ?? SEEK_INTERVAL_MS, lead: seek.lead ?? INPUT_SEEK_LEAD_MS };
    this.clock = clock;
    this.painter = null;
    this.scrubs = new Map();
    this.inputSeeks = new Map();
    this.status = { ready: false, decks: [] };
    this.sequence = 0;
    this.engineId = null;
    this.sourceId = null;
    this.retiredSources = new Set();
    this.retiredEngines = new Set();
    this.busy = new Set();
    this.owners = { A: 0, B: 0, C: 0, D: 0 };
    this.pending = new Map();
    this.throttled = new Map();
    // False from connection until the saved channel-strip values were restored to the engine, so the
    // engine's neutral defaults can never overwrite the saved session.
    this.mixerSynced = false;
    this.initialized = false;
    this.warning = "";
    bridge.onEvent((event) => {
      if (event.type === "import-progress") this.libraryUI?.progress(event);
      else if (event.type === "state") this.accept(event.snapshot, true);
      else if (event.type === "waveform-detail") {
        // Presentation data for the loaded deck only: never persisted, never a transport action.
        try {
          const active = this.status.decks.find(d => d.id === event.deck && d.trackId === event.trackId && d.waveGeneration === event.loadGeneration);
          if (!this.status.ready || this.status.terminal || this.isRetired(event) ||
              event.engineId !== this.engineId || event.sourceId !== this.sourceId ||
              !Number.isSafeInteger(event.loadGeneration) || !active) return;
          // The native load reply can still be awaiting persistence: cache the validated active
          // source now, but never select it or grant transport authority from presentation data.
          const loaded = DECK_IDS.map((id) => this.store.get().decks[id].trackId);
          if (setLocalWaveDetail(event.trackId, event.detail, loaded)) { this.painter?.invalidate(); this.paintClock(); }
        } catch {}
      } else if (event.type === "track") {
        try {
          registerLocalTrack(event.track);
          if (Object.hasOwn(event, "warning")) this.warning = event.warning || "";
          this.redraw();
        } catch {}
      }
    });
  }
  accept(snapshot, allowNew = false) {
    if (!snapshot || !Array.isArray(snapshot.decks)) return;
    if (this.isRetired(snapshot)) return;
    let connectionChanged = false;
    if (snapshot.sourceId && snapshot.sourceId !== this.sourceId) {
      if (this.sourceId && !allowNew) return;
      if (this.sourceId) { this.retiredSources.add(this.sourceId); connectionChanged = true; }
      this.sourceId = snapshot.sourceId;
    }
    if (snapshot.engineId && snapshot.engineId !== this.engineId) {
      if (this.engineId && !allowNew) return;
      if (this.engineId) { this.retiredEngines.add(this.engineId); connectionChanged = true; }
      this.engineId = snapshot.engineId;
      this.sequence = 0;
      this.mixerSynced = false;
    }
    if (snapshot.terminal === true) {
      // Connection retirement is irreversible; native success ordering stays exact.
      if (snapshot.sourceId) this.retiredSources.add(snapshot.sourceId);
      if (snapshot.engineId) this.retiredEngines.add(snapshot.engineId);
      for (const id of DECK_IDS) this.takeOwnership(id);
      this.mixerSynced = false;
      for(const slot of this.throttled.values())clearTimeout(slot.timer);
      this.throttled.clear();
    } else {
      if (Number.isFinite(snapshot.seq) && snapshot.seq <= this.sequence) return;
      this.sequence = snapshot.seq || this.sequence;
    }
    if (snapshot.terminal !== true && (connectionChanged || !snapshot.ready))
      for (const id of DECK_IDS) this.takeOwnership(id);
    const before = this.store.get();
    const readyChanged = this.status.ready !== snapshot.ready;
    const loadingChanged = DECK_IDS.some((id) => !!this.status.decks.find((d) => d.id === id)?.loading !== !!snapshot.decks.find((d) => d.id === id)?.loading);
    this.status = snapshot;
    this.store.dispatch({ type: "native-clock", snapshot, mixer: this.mixerSynced });
    const transportChanged = DECK_IDS.some((id) => before.decks[id].playing !== this.store.get().decks[id].playing);
    // Only engine readiness rebuilds the page. A seek's loading flag or a play/pause flip repaints the transport
    // controls; an ordinary clock receipt repaints just the clocks and waveforms on the next animation frame.
    if (readyChanged) this.redraw();
    else if (loadingChanged || transportChanged) this.update();
    else this.paintClock();
  }
  get mixerSupported() {
    const c=this.status.capabilities;
    return !!c&&c.channelEq===true&&c.channelMeters===true&&c.crossfaderAssign===true;
  }
  isRetired(snapshot) {
    return this.retiredSources.has(snapshot.sourceId) || this.retiredEngines.has(snapshot.engineId);
  }
  takeOwnership(deck) {
    const key = deck + ":position";
    clearTimeout(this.pending.get(key));
    this.pending.delete(key);
    // A newer action invalidates any open pointer gesture or slider burst for this deck: they drop their
    // queued targets and can never replay after a load, pause, play, cue or reconnect.
    const scrub = this.scrubs.get(deck);
    if (scrub) this.scrubCancel(scrub);
    this.inputSeeks.get(deck)?.pump.cancel();
    this.inputSeeks.delete(deck);
    return ++this.owners[deck];
  }
  /**
   * Begin a pointer or keyboard scrub of one deck. Returns {ok:false,message} when the deck cannot be sought
   * (demo fixture, engine offline, loading, not yet loaded natively) so the UI never previews an impossible seek.
   */
  beginScrub(deck, { onCancel = () => {} } = {}) {
    if (!this.initialized || !this.mixerSynced) return { ok: false, message: "Audio initialization or mixer restoration is still in progress." };
    const state = this.store.get().decks[deck];
    if (!trackById(state?.trackId)?.local) return { ok: false, message: "Demo fixtures contain no audio. Import a local audio file first." };
    const actual = this.status.decks.find((item) => item.id === deck);
    if (!this.status.ready) return { ok: false, message: nativeErrors.audio_output_unavailable };
    if (this.busy.has(deck) || actual?.loading) return { ok: false, message: "Deck " + deck + " is still loading." };
    if (actual?.trackId !== state.trackId) return { ok: false, message: "Deck " + deck + " has not finished loading this track." };
    const owner = this.takeOwnership(deck);
    const token = { deck, owner, wasPlaying: !!actual.playing, pump: null, onCancel };
    token.pump = new SeekPump({
      send: (position) => this.call({ type: "seek", deck, position }),
      current: () => this.scrubLive(token),
      onError: (error) => {
        this.scrubCancel(token);
        if (error.message !== "action_superseded") this.say(error.message);
      },
      interval: this.seekTiming.interval,
      clock: this.clock,
    });
    this.scrubs.set(deck, token);
    return { ok: true, token };
  }
  scrubLive(token) {
    return this.scrubs.get(token.deck) === token && token.owner === this.owners[token.deck];
  }
  /** Interim target while the pointer is down. Only a deck that was playing is sought continuously. */
  scrubMove(token, position, always = false) {
    if (this.scrubLive(token) && (always || token.wasPlaying)) token.pump.move(position);
  }
  /** Final target. Resolves true only when native acknowledged exactly this seek; false means superseded or failed. */
  scrubEnd(token, position) {
    if (!this.scrubLive(token)) return Promise.resolve(false);
    return token.pump.finish(position).then((ok) => {
      if (this.scrubs.get(token.deck) === token) this.scrubs.delete(token.deck);
      return ok;
    });
  }
  scrubCancel(token) {
    const current = this.scrubs.get(token.deck) === token;
    if (current) this.scrubs.delete(token.deck);
    token.pump.cancel();
    if (current) token.onCancel();
  }
  /** Slider-style seek input (no explicit end event): coalesced, one request in flight, latest value wins. */
  inputSeek(deck, position) {
    let slot = this.inputSeeks.get(deck);
    if (!slot || slot.pump.dead) {
      const owner = this.takeOwnership(deck);
      slot = { owner, pump: null };
      slot.pump = new SeekPump({
        send: async (value) => {
          await this.ensureLoaded(deck, owner);
          this.assertOwner(deck, owner);
          await this.call({ type: "seek", deck, position: value });
        },
        current: () => this.inputSeeks.get(deck) === slot && owner === this.owners[deck],
        onError: (error) => {
          if (error.message !== "action_superseded") this.say(error.message);
        },
        interval: this.seekTiming.interval,
        lead: this.seekTiming.lead,
        clock: this.clock,
      });
      this.inputSeeks.set(deck, slot);
    }
    slot.pump.move(position);
  }
  async call(request) {
    const result = await this.bridge.command(request);
    if (!result.ok)
      throw Error(nativeErrors[result.error] || "Audio command rejected: " + String(result.error || "unknown error").replaceAll("_", " "));
    if (result.snapshot) {
      if (this.isRetired(result.snapshot)) throw Error("action_superseded");
      this.accept(result.snapshot);
    }
    // Only library-save receipts carry this property; transport replies must not clear it.
    if (Object.hasOwn(result, "warning")) {
      const warning = result.warning || "";
      if (this.warning !== warning) {
        this.warning = warning;
        this.redraw();
      }
      if (warning) this.say(warning);
    }
    return result;
  }
  async initialize() {
    this.initialized = false;
    const saved = structuredClone(this.store.get());
    try {
      // Preserve selected-source ownership even when status is offline and no
      // native load can run. Reconnect must not discard those references.
      for (const id of DECK_IDS) {
        if (trackById(saved.decks[id].trackId)?.local)
          await this.call({ type: "retain-track", deck: id, trackId: saved.decks[id].trackId });
      }
      const result = await this.bridge.command({ type: "status" });
      if (result.snapshot) this.accept(result.snapshot, true);
      if (!this.status.ready) {
        this.initialized = true;
        this.redraw();
        return;
      }
      // Saved strip settings reach the engine before any restored (always paused) source is loaded.
      for (const id of DECK_IDS)
        for (const field of MIXER_VALUE_FIELDS) await this.call({ type: field, deck: id, value: saved.decks[id][field] });
      await this.call({ type: "crossfader", value: saved.mixer.crossfader });
      if(this.mixerSupported)for(const id of DECK_IDS)await this.call({type:"assign",deck:id,side:saved.decks[id].assign});
      this.mixerSynced = true;
      for (const id of DECK_IDS) {
        const d = saved.decks[id];
        if (!trackById(d.trackId)?.local) continue;
        try {
          const r = await this.call({ type: "load", deck: id, trackId: d.trackId });
          registerLocalTrack(r.track);
          await this.call({ type: "seek", deck: id, position: d.position });
        } catch (error) {
          this.say("Deck " + id + ": " + error.message);
        }
      }
    } catch (error) {
      this.say(error.message);
    }
    this.initialized = true;
    this.redraw();
  }
  async importAudio(deck) {
    if (this.busy.size || !this.initialized) return;
    const owner = this.takeOwnership(deck);
    this.busy.add(deck);
    this.redraw();
    let message = "";
    try {
      const result = await this.call({ type: "pick", deck });
      if (result.cancelled || owner !== this.owners[deck]) return;
      registerLocalTrack(result.track);
      this.store.dispatch({ type: "load", deck, trackId: result.track.id });
      this.store.dispatch({ type: "native-clock", snapshot: result.snapshot });
      message = "Loaded " + result.track.title + " into deck " + deck + ". Ready, paused.";
    } catch (error) {
      message = error.message;
    } finally {
      this.busy.delete(deck);
      this.redraw();
      if (message) this.say(message);
    }
  }
  assertOwner(deck, owner) {
    if (owner !== this.owners[deck]) throw Error("action_superseded");
  }
  async ensureLoaded(deck, owner) {
    const d = this.store.get().decks[deck];
    if (!trackById(d.trackId)?.local) throw Error("Demo fixtures contain no audio. Import a local audio file first.");
    const actual = this.status.decks.find((item) => item.id === deck);
    if (actual?.trackId !== d.trackId) {
      const result = await this.call({ type: "load", deck, trackId: d.trackId });
      this.assertOwner(deck, owner);
      registerLocalTrack(result.track);
      await this.call({ type: "seek", deck, position: d.position });
      this.assertOwner(deck, owner);
    }
  }
  dispatch(action) {
    const audioAction =
      action.type === "load" ||
      action.type === "cue" ||
      action.type === "hotCue" ||
      action.type === "mixer" ||
      action.type === "assign" || action.type === "eq-kill" ||
      action.type === "fx" ||
      (action.type === "deck" &&
        [
          "playing",
          "position",
          "level",
          "pitch",
          ...MIXER_KNOBS,
          "sync",
          "headphone",
          "loopEnabled",
          "loopLength",
        ].includes(action.field));
    if (!audioAction) return false;
    if (!this.initialized || (this.status.ready && !this.mixerSynced)) {
      this.say(this.initialized ? "Mixer settings could not be restored. Reconnect audio before using playback or mixer controls." : "Audio initialization is still in progress.");
      return true;
    }
    if(action.type==="eq-kill"){
      const key=action.deck+":"+action.band,slot=this.throttled.get(key);
      if(slot)clearTimeout(slot.timer);
      this.throttled.delete(key);
    }
    if (action.type === "deck" && action.field === "position") this.inputSeek(action.deck, action.value);
    else if (action.type === "mixer" || (action.type === "deck" && (action.field === "level" || MIXER_KNOBS.includes(action.field)))) {
      this.throttle(action.type === "mixer" ? "crossfader" : action.deck + ":" + action.field, action);
    } else this.perform(action).catch((error) => this.say(error.message));
    return true;
  }
  throttle(key, action) {
    const slot = this.throttled.get(key) || { last: 0, timer: null, action: null };
    this.throttled.set(key, slot);
    slot.action = action;
    if (slot.timer) return;
    const fire = () => {
      slot.timer = null;
      slot.last = Date.now();
      const next = slot.action;
      slot.action = null;
      this.perform(next).catch((error) => this.say(error.message));
    };
    const wait = Math.max(0, slot.last + CONTROL_INTERVAL_MS - Date.now());
    if (wait === 0) fire();
    else slot.timer = setTimeout(fire, wait);
  }
  async perform(action) {
    const deck = action.deck;
    if(action.type==="assign"||action.type==="eq-kill"){
      if(!this.mixerSupported)throw Error("This audio engine needs updating for band kills and assignments.");
      if(action.type==="assign"){
        if(!ASSIGNMENTS.includes(action.value))throw Error("Invalid crossfader assignment");
        await this.call({type:"assign",deck,side:action.value});
      }else{
        if(!EQ_BANDS.includes(action.band))return;
        const before=this.store.get(),after=reduceSession(before,action);
        if(after===before)return;
        await this.call({type:action.band,deck,value:after.decks[deck][action.band]});
        this.store.dispatch({type:"eq-memory",deck,band:action.band,value:after.decks[deck].eqRestore[action.band]});
      }
      return;
    }
    if (action.type === "mixer") {
      if (action.field !== "crossfader") throw Error("This mixer function is not implemented.");
      await this.call({ type: "crossfader", value: action.value });
      return;
    }
    if (action.type === "deck" && (action.field === "level" || MIXER_KNOBS.includes(action.field))) {
      await this.call({ type: action.field, deck, value: action.value });
      return;
    }
    if (action.type === "fx" || (action.type === "deck" && !["playing", "position"].includes(action.field)))
      throw Error("This DSP or routing function is not implemented in this first audio milestone.");
    if (action.type === "load") {
      if (!trackById(action.trackId)?.local) throw Error("Demo fixtures contain no audio. Import a local audio file first.");
      const owner = this.takeOwnership(deck);
      this.busy.add(deck);
      this.redraw();
      try {
        const result = await this.call({ type: "load", deck, trackId: action.trackId });
        if (owner !== this.owners[deck]) return;
        registerLocalTrack(result.track);
        this.store.dispatch(action);
        this.store.dispatch({ type: "native-clock", snapshot: result.snapshot });
      } finally {
        this.busy.delete(deck);
        this.redraw();
      }
      return;
    }
    if (action.type === "deck" && action.field === "playing" && !action.value) {
      this.takeOwnership(deck);
      await this.call({ type: "pause", deck });
      return;
    }
    const owner = this.takeOwnership(deck);
    await this.ensureLoaded(deck, owner);
    this.assertOwner(deck, owner);
    if (action.type === "cue") {
      await this.call({ type: "pause", deck });
      this.assertOwner(deck, owner);
      await this.call({ type: "seek", deck, position: 0 });
    } else if (action.type === "hotCue") {
      await this.call({ type: "seek", deck, position: this.store.get().decks[deck].cues[action.index] });
    } else if (action.type === "deck" && action.field === "position") {
      await this.call({ type: "seek", deck, position: action.value });
    } else if (action.type === "deck" && action.field === "playing") await this.call({ type: "play", deck });
  }
  /** Gain, EQ and filter are real controls: they only wait for a connected, initialized engine. */
  paintStrip() {
    if (typeof document === "undefined") return;
    const usable = this.status.ready && this.initialized && this.mixerSynced;
    for(const el of document.querySelectorAll('[data-action="eq-kill"],[data-action="assign"]'))el.disabled=!usable||!this.mixerSupported;
    for (const el of document.querySelectorAll([...MIXER_VALUE_FIELDS.map((field) => `input[data-field="${field}"]`), 'input[data-action="crossfader"]'].join(","))) {
      el.disabled = !usable;
      el.closest(".knob")?.classList.toggle("offline", !usable);
    }
  }
  /** Native receipts are batched into the cached transport painter. */
  paintClock() {
    this.painter?.mark();
  }
  /** Transport-only repaint: Play enablement and labels, plus the hidden-deck status text. */
  paintTransport() {
    if (typeof document === "undefined") return;
    const state = this.store.get();
    for (const el of document.querySelectorAll('[data-field="playing"]')) {
      if (el.closest(".design-preview")) continue;
      const d = state.decks[el.dataset.deck];
      el.disabled =
        !this.status.ready ||
        !this.initialized || !this.mixerSynced ||
        !trackById(d.trackId)?.local ||
        (!d.playing && !!this.status.decks.find((item) => item.id === el.dataset.deck)?.loading);
      el.setAttribute("aria-label", (d.playing ? "Pause" : "Play") + " deck " + el.dataset.deck);
    }
    for (const id of DECK_IDS) {
      const hidden = document.querySelector(`[data-hidden-deck="${id}"] .hidden-state`);
      if (hidden) hidden.textContent = state.decks[id].playing ? "Playing" : "Paused";
    }
  }
  paint() {
    if (typeof document === "undefined") return;
    document.body.classList.add("native-desktop");
    const state = this.store.get();
    const app = document.querySelector(".app");
    if (!app) return;
    const ready = this.status.ready;
    const busy = !!this.busy.size;
    const summary = busy
      ? "Loading local audio…"
      : ready
        ? ""
        : this.status.error === "audio_engine_unavailable"
          ? "Audio engine could not start · check your desktop installation. Library import remains available."
          : "Audio output unavailable · check your device and reconnect. You can still organize your library.";
    // The only band under the header appears while output is unavailable; the header chip covers transient work.
    const bar = document.querySelector(".native-audio-bar");
    if (bar) {
      bar.hidden = (ready && this.mixerSynced) || !this.initialized;
      const text = bar.querySelector(".native-audio-state");
      if (text) text.textContent = ready && !this.mixerSynced ? "Mixer settings could not be restored. Reconnect audio to continue." : summary;
    }
    const chip = document.querySelector(".deckbar-status");
    if (chip) chip.textContent = busy ? "Loading local audio…" : !ready && !this.initialized ? "Starting audio…" : "";
    const detail = document.querySelector(".settings-audio-state");
    if (detail) detail.textContent = summary;
    for (const el of document.querySelectorAll('[data-action="reconnect-audio"]')) el.hidden = ready && (!this.initialized || this.mixerSynced);
    const button = document.querySelector(".native-import");
    if (button) {
      button.textContent = "Open file → Deck " + state.library.target;
      button.disabled = busy || !ready || !this.initialized;
    }
    for (const el of document.querySelectorAll(".engine-label")) el.textContent = ready ? "NATIVE AUDIO" : "OUTPUT OFFLINE";
    const version = document.querySelector(".deckbar-brand small");
    if (version) version.textContent = "0.3.1";
    for (const el of document.querySelectorAll(".settings-note")) el.textContent = "NATIVE FILE PLAYBACK · ADVANCED DSP PENDING";
    for (const el of document.querySelectorAll(
      '[data-field="sync"],[data-field="headphone"],[data-field="loopEnabled"],[data-field="pitch"],[data-action="loop-size"],[data-action="loop-length"],[data-action="toggle-fx"],[data-action="fx-wet"]',
    )) {
      el.disabled = true;
      el.title = "Not implemented in this first audio milestone";
    }
    this.paintStrip();
    for (const el of document.querySelectorAll('[data-field="playing"]')) {
      const d = state.decks[el.dataset.deck];
      el.disabled =
        !ready ||
        !this.initialized ||
        !this.mixerSynced ||
        !trackById(d.trackId)?.local ||
        (!d.playing && !!this.status.decks.find((item) => item.id === el.dataset.deck)?.loading);
      el.setAttribute("aria-label", (d.playing ? "Pause" : "Play") + " deck " + el.dataset.deck);
    }
    for (const el of document.querySelectorAll(".fx-trailing")) el.textContent = "FX NOT IMPLEMENTED";

    for (const el of document.querySelectorAll(".rail-bottom")) el.textContent = "Local audio only · no uploads";
    for (const el of document.querySelectorAll(".load-choice>span")) el.textContent = "Local files play; demo rows are fixtures";
    for (const el of document.querySelectorAll(".rail-heading.second")) el.textContent = "LOCAL + DEMO COLLECTION";
    for (const el of document.querySelectorAll(".fx-trailing")) el.textContent = "FX NOT IMPLEMENTED";
    for (const id of DECK_IDS) {
      const local = trackById(state.decks[id].trackId)?.local;
      for (const section of document.querySelectorAll(`section.deck[data-deck="${id}"]`)) {
        if (local) {
          for (const el of section.querySelectorAll(".bpm-value")) el.textContent = "—";
          for (const el of section.querySelectorAll(".pads .pad .pad-name")) el.textContent = "CUE";
        }
      }
    }
    for (const row of document.querySelectorAll("tr[data-track-id]"))
      if (trackById(row.dataset.trackId)?.local) row.querySelector(".bpm-cell").textContent = "—";
    const footer = document.querySelector(".statusbar>span");
    if (footer)
      footer.textContent = ready
        ? "Native audio · local files · gain / full-kill EQ / filter / meters live · FX / sync / headphone routing not implemented"
        : "Audio offline · playback is paused";
    const info = document.querySelector(".info-dialog");
    if (info && !info.dataset.native) {
      info.dataset.native = "true";
      info.innerHTML =
        '<h2>Deck Craft · native audio foundation</h2><p>One session drives four decks. Local files are decoded and played by a separate Rust engine using Rodio and CPAL through the default Linux audio device.</p><p>Play, pause, seek, manual cue points, per-deck gain, three-band EQ and sweep filter, channel levels, full-kill EQ, native stereo peak meters and L/R/THRU assignments use native audio. Imported waveforms come from decoded PCM; BPM, key, beat grids, time stretching, loops, effects, controller support and headphone routing are not implemented yet.</p><p>No network service or music upload. Restored transport is always paused. Device latency has not been benchmarked.</p><button class="dialog-close" data-action="close-info">Back to the decks</button>';
    }
    const mixerInfo = document.querySelector(".mixer-dialog>p");
    if (mixerInfo) mixerInfo.textContent = "FX and headphone cue are not implemented · gain, EQ, filter and levels are live in the console mixer";
    const about = document.querySelector(".footer-info");
    if (about) about.textContent = "About / audio";
    this.paintClock();
  }
  async reconnect() {
    for (const id of DECK_IDS) this.takeOwnership(id);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const slot of this.throttled.values()) clearTimeout(slot.timer);
    this.throttled.clear();
    this.mixerSynced = false;
    this.initialized = false;
    try {
      await this.call({ type: "reconnect" });
      await this.initialize();
    } catch (error) {
      this.say(error.message);
    }
  }
}
