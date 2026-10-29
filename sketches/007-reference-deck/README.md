# Reference-matched deck proof

Open `index.html` directly in a browser. This is a self-contained, offline visual proof of one shared deck, not a replacement application or native integration.

## Version 3

`index.html` is now the third pass. Its waveform is generated from deterministic seeded vector columns: darker, more saturated red-orange attacks, magenta/violet tails, ragged grain and dropouts, a multicolor intro and saturated overview zones sampled from the supplied reference's observed hue families. It is still a **design palette on a synthetic fixture**, not audio or frequency analysis. The surface also gains a subtle deck-identity highlight, deeper waveform wells, a played-region shade, glowing playhead, beveled Play and cue buttons, and stronger typography.

`index-v1.html` and `index-v2.html` are preserved unchanged for comparison. No version is applied to the running application.

## Refined pass

The active `index.html` keeps the reference composition and improves visual clarity: heavier labels/readouts, continuous three-layer SVG waveform contours with 4,096 samples per layer, a slightly taller detailed waveform, consistent vector toolbar icons, clearer cue flags and restrained control edges. The waveform remains a deterministic synthetic illustration, not new audio analysis. No bitmap upscaling or external font/CDN is used.

`index-v1.html` preserves the first reviewed proof byte-for-byte. This refinement does not apply either version to the running application. The private delivery includes a 2× pixel-density close-up so the vector detail can be inspected without the earlier screenshot's resolution limit.

## Direction

Use a compact, flat operating surface: track information above a dominant waveform, a narrow full-track overview below it, a right-edge pitch slider, then the transport/loop row, eight cue positions and a slim cue-editing toolbar. Preserve Deck Craft branding and the established A/B/C/D identities. There is one proposed treatment, not a new competition between layouts.

The user's deck and transport screenshots are private reference inputs. The source proof does not embed or publish them. A private review copy can insert data-URL images at `PRIVATE_REFERENCES`; the comparison automatically exposes a side-by-side view. No reference image is fetched from a network.

## Preview behavior

- Loaded, Playing appearance and Empty presets intentionally reset the in-memory fixture.
- Play changes appearance only; there is no timer, sound, native bridge or auto-advancing clock.
- The overview permits mock seeking. Cues 1–3 jump; Shift-click slots 1–4 to store a mock position.
- Width and comparison changes preserve preview state.
- All other controls are disabled, including cue slots 5–8. The current app's model only supports four manual cues.
- Multicolor waveform shapes, timing, BPM and artwork are explicitly synthetic. The detailed waveform is an illustration, not a real scrolling/zoomed view of decoded audio.
- The page reads/writes no application persistence and imports no private library or local music.

## Scope and next checkpoint

Approval to build this proof is not approval of its final appearance, new audio features or installation. Review it alongside both supplied references before applying the shared treatment to the existing five layouts and customizable canvas. The application, native engine and historical designs remain unchanged.

Actual frequency analysis, higher-resolution scrolling waveform data, tempo/beat analysis, sync/master, pitch, CUP/FLX/REV, loops, eight functional cues, cue-type editing and controller mapping remain separate implementation work. Unsupported functions must not be represented as operational.

## Verification

Exercise the page in Chromium at desktop/reference and compact widths, plus narrow mobile widths. Check all preview controls, no clock movement while showing playing, disabled unsupported controls, state preservation when changing presentation, no overflow or console exceptions, and inspect screenshots. The tiny desktop controls intentionally match a dense desktop deck; this is not a touch-optimized performance surface.

Executed: 16 viewport/width-mode combinations passed containment checks. Real Chromium pointer Play/Cue, mock seek/store, all presets and state preservation passed; the clock stayed static, with no browser errors or HTTP requests. Desktop comparison, close-up and narrow screenshots were visually inspected. The application regression suites, Node/Rust/installer tests, build/bundle syntax and publication checks also pass. Native signal capture and target-machine audio acceptance were not rerun: no application or native behavior changed.

The refined pass additionally verifies the sample count and finite path geometry of all waveform layers, heavier computed font weights, the vector control icons and a genuine device-pixel-ratio-2 screenshot. The initial proof's preserved hash matches its original bytes. Both revisions remain explicitly no-audio fixtures.
