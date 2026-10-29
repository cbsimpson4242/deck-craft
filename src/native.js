import { DECK_IDS, trackById, registerLocalTrack, replaceLocalLibrary } from "./catalog.js";
import { icon, timeLabel, paintWaveBox } from "./components.js";

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
  constructor(bridge, store, { redraw, say }) {
    this.bridge = bridge;
    this.store = store;
    this.redraw = redraw;
    this.say = say;
    this.status = { ready: false, decks: [] };
    this.sequence = 0;
    this.engineId = null;
    this.sourceId = null;
    this.retiredSources = new Set();
    this.retiredEngines = new Set();
    this.busy = new Set();
    this.owners = { A: 0, B: 0, C: 0, D: 0 };
    this.pending = new Map();
    this.initialized = false;
    this.warning = "";
    bridge.onEvent((event) => {
      if (event.type === "import-progress") this.libraryUI?.progress(event);
      else if (event.type === "state") this.accept(event.snapshot, true);
      else if (event.type === "track") {
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
    if (snapshot.sourceId && snapshot.sourceId !== this.sourceId) {
      if (this.sourceId && !allowNew) return;
      if (this.sourceId) this.retiredSources.add(this.sourceId);
      this.sourceId = snapshot.sourceId;
    }
    if (snapshot.engineId && snapshot.engineId !== this.engineId) {
      if (this.engineId && !allowNew) return;
      if (this.engineId) this.retiredEngines.add(this.engineId);
      this.engineId = snapshot.engineId;
      this.sequence = 0;
    }
    if (snapshot.terminal === true) {
      // Connection retirement is irreversible; native success ordering stays exact.
      if (snapshot.sourceId) this.retiredSources.add(snapshot.sourceId);
      if (snapshot.engineId) this.retiredEngines.add(snapshot.engineId);
      for (const id of DECK_IDS) this.takeOwnership(id);
    } else {
      if (Number.isFinite(snapshot.seq) && snapshot.seq <= this.sequence) return;
      this.sequence = snapshot.seq || this.sequence;
    }
    const before = this.store.get();
    const readyChanged =
      this.status.ready !== snapshot.ready ||
      DECK_IDS.some((id) => !!this.status.decks.find((d) => d.id === id)?.loading !== !!snapshot.decks.find((d) => d.id === id)?.loading);
    this.status = snapshot;
    this.store.dispatch({ type: "native-clock", snapshot });
    const transportChanged = DECK_IDS.some((id) => before.decks[id].playing !== this.store.get().decks[id].playing);
    if (readyChanged || transportChanged) this.redraw();
    else this.paintClock();
  }
  isRetired(snapshot) {
    return this.retiredSources.has(snapshot.sourceId) || this.retiredEngines.has(snapshot.engineId);
  }
  takeOwnership(deck) {
    const key = deck + ":position";
    clearTimeout(this.pending.get(key));
    this.pending.delete(key);
    return ++this.owners[deck];
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
      for (const id of DECK_IDS) await this.call({ type: "level", deck: id, value: saved.decks[id].level });
      await this.call({ type: "crossfader", value: saved.mixer.crossfader });
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
      action.type === "fx" ||
      (action.type === "deck" &&
        [
          "playing",
          "position",
          "level",
          "pitch",
          "gain",
          "hi",
          "mid",
          "low",
          "filter",
          "sync",
          "headphone",
          "loopEnabled",
          "loopLength",
        ].includes(action.field));
    if (!audioAction) return false;
    if (!this.initialized) {
      this.say("Audio initialization is still in progress.");
      return true;
    }
    if ((action.type === "deck" && ["position", "level"].includes(action.field)) || action.type === "mixer") {
      const key = action.type === "mixer" ? "crossfader" : action.deck + ":" + action.field;
      clearTimeout(this.pending.get(key));
      // A delayed gesture keeps its original owner, not the source present at fire time.
      const owner = this.owners[action.deck];
      this.pending.set(
        key,
        setTimeout(() => {
          this.pending.delete(key);
          if (action.field === "position" && owner !== this.owners[action.deck]) return;
          this.perform(action).catch((error) => this.say(error.message));
        }, 40),
      );
    } else this.perform(action).catch((error) => this.say(error.message));
    return true;
  }
  async perform(action) {
    const deck = action.deck;
    if (action.type === "mixer") {
      if (action.field !== "crossfader") throw Error("This mixer function is not implemented.");
      await this.call({ type: "crossfader", value: action.value });
      return;
    }
    if (action.type === "deck" && action.field === "level") {
      await this.call({ type: "level", deck, value: action.value });
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
  paintClock() {
    if (typeof document === "undefined") return;
    const state = this.store.get();
    for (const id of DECK_IDS) {
      const d = state.decks[id],
        track = trackById(d.trackId);
      for (const el of document.querySelectorAll(`section.deck[data-deck="${id}"] .elapsed`))
        el.textContent = timeLabel(d.position, true) + (el.closest(".linear-clock") ? " / " + timeLabel(track.duration) : "");
      for (const el of document.querySelectorAll(`section.deck[data-deck="${id}"] .remaining`))
        el.textContent = "−" + timeLabel(track.duration - d.position, true);
      for (const box of document.querySelectorAll(`[data-wave-deck="${id}"]`)) {
        paintWaveBox(box, d.position / track.duration);
        const seek = box.querySelector("input");
        if (seek && document.activeElement !== seek) seek.value = d.position;
      }
      for (const input of document.querySelectorAll(`[data-deck="${id}"][data-field="level"]`))
        if (document.activeElement !== input) input.value = d.level;
    }
    for (const input of document.querySelectorAll('[data-action="crossfader"]'))
      if (document.activeElement !== input) input.value = state.mixer.crossfader;
  }
  paint() {
    if (typeof document === "undefined") return;
    document.body.classList.add("native-desktop");
    const state = this.store.get();
    const app = document.querySelector(".app");
    if (!app) return;
    let bar = document.querySelector(".native-audio-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "native-audio-bar";
      bar.innerHTML =
        '<span class="native-audio-state" role="status"></span><button data-action="reconnect-audio">Reconnect audio</button><button data-action="library-import" data-kind="files">Add files to library</button><button class="native-import" data-action="import-audio">Import audio</button>';
      document.querySelector(".persistence-warning").after(bar);
    }
    const ready = this.status.ready;
    bar.querySelector(".native-audio-state").textContent = this.busy.size
      ? "Loading local audio…"
      : ready
        ? "Audio ready · default Linux output · " + (this.status.output?.sampleRate || "—") + " Hz · load a local track, then press Play"
        : this.status.error === "audio_engine_unavailable"
          ? "Audio engine could not start · check your desktop installation. Library import remains available."
          : "Audio output unavailable · check your device and reconnect. You can still organize your library.";
    bar.querySelector('[data-action="reconnect-audio"]').hidden = ready;
    const button = bar.querySelector(".native-import");
    button.textContent = "Open file → Deck " + state.library.target;
    button.disabled = !!this.busy.size || !ready || !this.initialized;
    for (const el of document.querySelectorAll(".engine-label")) el.textContent = ready ? "NATIVE AUDIO" : "OUTPUT OFFLINE";
    const version = document.querySelector(".wordmark small");
    if (version) version.textContent = "0.3.1";
    for (const el of document.querySelectorAll(".mobile-engine-notice")) el.textContent = "NATIVE FILE PLAYBACK · ADVANCED DSP PENDING";
    for (const el of document.querySelectorAll(
      '[data-field="sync"],[data-field="headphone"],[data-field="loopEnabled"],[data-field="pitch"],[data-action="loop-size"],[data-action="loop-length"],[data-action="toggle-fx"],[data-action="fx-wet"],[data-field="gain"],[data-field="hi"],[data-field="mid"],[data-field="low"],[data-field="filter"]',
    )) {
      el.disabled = true;
      el.title = "Not implemented in this first audio milestone";
    }
    for (const el of document.querySelectorAll('[data-field="playing"]')) {
      const d = state.decks[el.dataset.deck];
      el.disabled =
        !ready ||
        !this.initialized ||
        !trackById(d.trackId)?.local ||
        (!d.playing && !!this.status.decks.find((item) => item.id === el.dataset.deck)?.loading);
      el.setAttribute("aria-label", (d.playing ? "Pause" : "Play") + " deck " + el.dataset.deck);
    }
    for (const el of document.querySelectorAll(".fx-trailing")) el.textContent = "FX NOT IMPLEMENTED";
    for (const el of document.querySelectorAll(".vu")) {
      el.setAttribute("aria-label", "Audio meters not implemented");
      el.title = "Audio meters not implemented";
    }
    for (const el of document.querySelectorAll(".rail-bottom")) el.textContent = "Local audio only · no uploads";
    for (const el of document.querySelectorAll(".load-choice>span")) el.textContent = "Local files play; demo rows are fixtures";
    for (const el of document.querySelectorAll(".rail-heading.second")) el.textContent = "LOCAL + DEMO COLLECTION";
    for (const el of document.querySelectorAll(".fx-trailing")) el.textContent = "FX NOT IMPLEMENTED";
    for (const id of DECK_IDS) {
      const local = trackById(state.decks[id].trackId)?.local;
      for (const section of document.querySelectorAll(`section.deck[data-deck="${id}"]`)) {
        if (local) {
          for (const el of section.querySelectorAll(".bpm-value")) el.textContent = "—";
          for (const el of section.querySelectorAll(".beat-dots")) el.textContent = "PCM";
          for (const el of section.querySelectorAll(".linear-phrase")) el.textContent = "Audio waveform · beat analysis pending";
          for (const el of section.querySelectorAll(".pads .pad span")) el.textContent = "MANUAL CUE";
        }
      }
      const hidden = document.querySelector(`[data-hidden-deck="${id}"] .hidden-state`);
      if (hidden) hidden.textContent = state.decks[id].playing ? "Playing" : "Paused";
    }
    for (const row of document.querySelectorAll("tr[data-track-id]"))
      if (trackById(row.dataset.trackId)?.local) row.querySelector(".bpm-cell").textContent = "—";
    for (const el of document.querySelectorAll(".precision-ruler")) el.textContent = "TRACK OVERVIEW · NO BEAT GRID";
    for (const el of document.querySelectorAll(".plot-toolbar .section-label")) el.textContent = "TRACK OVERVIEWS · NO BEAT GRID";
    for (const el of document.querySelectorAll(".sync-top>div:first-child strong")) el.textContent = "Track overviews";
    for (const el of document.querySelectorAll(".sync-top>div:first-child span")) el.textContent = "Independent timelines · no beat sync";
    const footer = document.querySelector(".statusbar>span");
    if (footer)
      footer.textContent = ready
        ? "Native audio · local files · EQ / FX / sync / headphone routing not implemented"
        : "Audio offline · playback is paused";
    const info = document.querySelector(".info-dialog");
    if (info && !info.dataset.native) {
      info.dataset.native = "true";
      info.innerHTML =
        '<h2>Deck Craft · native audio foundation</h2><p>Five layouts share one four-deck session. Local files are decoded and played by a separate Rust engine using Rodio and CPAL through the default Linux audio device.</p><p>Play, pause, seek, manual cue points, channel levels and the A/B crossfader use native audio. Imported waveforms come from decoded PCM; BPM, key, beat grids, time stretching, loops, EQ, effects, meters, controller support and headphone routing are not implemented yet.</p><p>No network service or music upload. Restored transport is always paused. Device latency has not been benchmarked.</p><button class="dialog-close" data-action="close-info">Back to the decks</button>';
    }
    const mixerInfo = document.querySelector(".mixer-dialog>p");
    if (mixerInfo) mixerInfo.textContent = "Native levels and A/B crossfader · EQ, FX and headphone cue not implemented";
    const about = document.querySelector(".footer-info");
    if (about) about.textContent = "About / audio";
    this.paintClock();
  }
  async reconnect() {
    for (const id of DECK_IDS) ++this.owners[id];
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.initialized = false;
    try {
      await this.call({ type: "reconnect" });
      await this.initialize();
    } catch (error) {
      this.say(error.message);
    }
  }
}
