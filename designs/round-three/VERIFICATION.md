# Round 03 verification

## Frozen references

The selected Round 02 Signal and Studio HTML files remain unchanged. SHA-256 values in `references.json` are checked against both the source and embedded/downloaded documents. Five numbered entries are new; the two Originals controls are reference payloads, not additional new designs.

## Browser evidence

- All five new desktop compositions and responsive phone arrangements were visually inspected in Chromium. Refinements include corrected cue-bank widths, removal of unused card space, consistent deck-pair colors and visible clocks in narrow deck lanes.
- Final standalone checks covered all five studies at 1440px, 1280px, 390px and 360px widths: twenty design/viewport cases with no observed script errors or page-level horizontal overflow.
- Exercised exposed transport/cue/Sync, loop length, pads, search, no-results, metadata loading, alignment-title updates, crate filters, grid visibility, detail zoom, cue disclosures, deck-pair switching, mixer opening/closing, knob/pitch feedback, row density and Prepare/Perform switching. Controls not exposed in a study are not counted as implemented features.
- The portable package was separately exercised at 1440px, 390px and 360px outer widths: twenty-one document/viewport cases, including both unchanged references. Every selector rendered the expected title and embedded Play/search interactions worked.
- Phone layout toggling rendered each packaged document at a 390px inner viewport without horizontal page overflow. Header button bounds were checked against their containing header, not only against the document width.
- Focus enter/exit and intentional full-size/pan mode were exercised at all three comparison widths.
- Seven individual downloads matched their exact standalone source bytes and manifest SHA-256 values: five new studies plus two frozen references.
- `scripts/check_publication.py` covers all fifteen studies across three rounds and two unchanged reference payloads. It checks exact embedded bytes, reference hashes, inline JavaScript syntax, project SVG/T3 icon references and conservative privacy patterns.

## Evidence limits

Browser emulation is not physical-device or native-app acceptance. Most functional checks activated the real DOM handlers programmatically; pointer, keyboard and touch interactions are not exhaustively tested. These are synthetic visual prototypes, not audio, DSP, latency, controller or hardware evidence. Loading updates metadata/artwork, but the waveform remains a synthetic layout fixture. Passing browser checks does not establish that a new proposal is aesthetically preferred; user review is still required.
