// Presentation profiles for the two real audio backends. The shared session UI
// (NativeSession) reads strings and capability wording from the active profile
// so that browser playback is never labelled as the Rust/ALSA engine, and vice versa.

const megabytes = bytes => Math.max(1, Math.round(bytes / 1048576));
const NATIVE_INFO = '<h2>Deck Craft · native audio foundation</h2><p>One four-deck session drives every view. Local files are decoded and played by a separate Rust engine using Rodio and CPAL through the default Linux audio device.</p><p>Play, pause, seek, manual cue points, channel levels, per-deck gain, three-band full-kill EQ, the sweep filter, native stereo peak meters and the L/THRU/R crossfader assignments use native audio. Imported waveforms come from decoded PCM; BPM and constant beat grids are detected offline. Tempo (±8%), pitch lock and beat-phase sync are processed in the engine, before the channel strip. Key, loops, effects, controller support and headphone routing remain unavailable.</p><p>No network service or music upload. Restored transport is always paused. Device latency has not been benchmarked.</p><button class="dialog-close" data-action="close-info">Back to the decks</button>';
const BROWSER_INFO = '<h2>Deck Craft · browser audio</h2><p>One four-deck session drives every view. Local files you select are played by this browser through one media element per deck and Web Audio gains, on this device. This is the browser backend, not the Rust engine used by the desktop app; neither device latency nor the Omarchy target has been verified for it.</p><p>Play, pause, seek, manual cue points, channel levels and the A/B crossfader follow the browser media clock. Waveforms, BPM, beat grids and embedded artwork are analyzed in your browser. Tempo (±8%) and beat-phase sync set the media element speed; pitch lock uses the browser’s preserve-pitch support and is disabled where it is missing. Gain, EQ, the sweep filter, meters and crossfader assignments exist only in the desktop engine and stay disabled here; key, loops, effects, controller support and headphone routing are unavailable.</p><p>Files are never uploaded and there is no server or account. They stay in this browser: imported files are kept in size-limited browser storage when it is available (otherwise for this session only), and restored transport is always paused.</p><button class="dialog-close" data-action="close-info">Back to the decks</button>';
export const NATIVE_PROFILE = Object.freeze({
  id: 'native',
  // Gain, three-band EQ and the sweep filter run in the Rust channel strip. Band kills and L/THRU/R assignment also need the engine's capability flags.
  advancedMixer: true,
  engineLabel: ready => (ready ? 'NATIVE AUDIO' : 'OUTPUT OFFLINE'),
  status(session) {
    const ready = session.status.ready;
    return session.busy.size
      ? 'Loading local audio…'
      : ready
        ? 'Audio ready · default Linux output · ' + (session.status.output?.sampleRate || '—') + ' Hz · load a local track, then press Play'
        : session.status.error === 'audio_engine_unavailable'
          ? 'Audio engine could not start · check your desktop installation. Library import remains available.'
          : 'Audio output unavailable · check your device and reconnect. You can still organize your library.';
  },
  mobileNotice: 'NATIVE FILE PLAYBACK · EQ / FILTER / TEMPO LIVE · FX PENDING',
  settingsNote: 'NATIVE FILE PLAYBACK · FX / LOOPS / HEADPHONE ROUTING PENDING',
  mixerUnsupported: 'This audio engine needs updating for gain, EQ, filter, band kills and assignments.',
  railBottom: 'Local audio only · no uploads',
  footer: ready => (ready ? 'Native audio · local files · gain / full-kill EQ / filter / meters · tempo / pitch lock / beat sync live · FX / loops / headphone routing not implemented' : 'Audio offline · playback is paused'),
  info: NATIVE_INFO,
  mixerInfo: 'FX and headphone cue are not implemented · gain, EQ, filter and levels are live in the console mixer',
  errors: {},
});

export const BROWSER_PROFILE = Object.freeze({
  id: 'browser',
  // The browser engine implements channel levels and the crossfader only.
  advancedMixer: false,
  engineLabel: ready => (ready ? 'BROWSER AUDIO' : 'AUDIO OFFLINE'),
  status(session) {
    const { ready, output, storage, error } = session.status;
    if (session.busy.size) return 'Loading local audio…';
    if (!ready) return 'Browser audio could not start · reload the page or use Reconnect audio. You can still organize your library.';
    const running = output?.state === 'running';
    const where = storage?.persistent ? `kept in this browser ${megabytes(storage.usedBytes)} of ${megabytes(storage.limitBytes)} MB` : 'this session only';
    const gate = error === 'audio_output_suspended' ? 'output was suspended and stopped playback; press Play to resume' : running ? 'output running' : 'output starts on your first click or key press';
    return `Browser audio · ${output?.sampleRate || '—'} Hz · ${gate} · files stay on this device (${where}) · load a local track, then press Play`;
  },
  mobileNotice: 'BROWSER FILE PLAYBACK · LEVELS / CROSSFADER / TEMPO · NO EQ',
  settingsNote: 'BROWSER FILE PLAYBACK · GAIN / EQ / FILTER / METERS DESKTOP-ONLY',
  mixerUnsupported: 'Not available in the browser audio engine: it has channel levels and the crossfader only.',
  railBottom: 'Files stay in this browser · no uploads',
  footer: ready => (ready ? 'Browser audio · files stay on this device · levels / crossfader / tempo / pitch lock / beat sync · gain / EQ / filter / meters / FX / headphone routing not available' : 'Audio offline · playback is paused'),
  info: BROWSER_INFO,
  mixerInfo: 'Browser audio has channel levels and the crossfader only · gain, EQ, filter, meters, FX and headphone cue are not available',
  errors: {
    audio_output_unavailable: 'This browser could not start audio output. Reload the page or use Reconnect audio.',
    audio_context_blocked: 'The browser is blocking audio output. Click Play again, or use Reconnect audio.',
    autoplay_blocked: 'The browser blocked playback until you interact with the page. Press Play again.',
    playback_failed: 'The browser could not start playback of this file.',
    pitch_lock_unsupported: 'This browser cannot keep pitch while changing tempo. Turn pitch lock off to change tempo.',
    file_unavailable: 'This file is not stored in this browser any more (it was session-only or browser storage was cleared). Select it again.',
    unsupported_or_corrupt_audio: 'This browser could not play or decode this file. WAV, MP3, Ogg Vorbis, FLAC and AAC/M4A support varies by browser.',
    unsupported_duration: 'This file is empty or longer than the browser limit of 20 minutes.',
    file_too_large: 'This file is larger than the 64 MB browser limit.',
    storage_limit_reached: 'Browser storage and the session file limit are full. Remove tracks from the library first.',
    library_capacity: 'The browser library is full. Remove tracks first.',
    gesture_required: 'The browser needs a fresh click or key press to open the file chooser. Try again.',
    file_picker_unavailable: 'This browser cannot open a file chooser here.',
    sync_alignment_failed: 'Sync could not align the beat phase. Try again once both decks are playing steadily.',
  },
});

export function backendProfile(bridge) {
  return bridge?.backend?.id === 'browser' ? BROWSER_PROFILE : NATIVE_PROFILE;
}
