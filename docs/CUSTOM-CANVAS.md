# Custom canvas and AI component creator

## First-stage boundary

This is a working presentation editor over DeckCraft's existing shared four-deck session, not a new audio engine or executable plugin system. Enter through **Customize** or **Layout → Custom canvas**. The canvas is initially empty. Studio Sync remains the ordinary default; existing layout/session preferences are preserved. The five original views remain selectable unchanged, and the builder also offers editable starter arrangements based on each of them. Those arrangements reuse components; they are not pixel-identical conversions of the historical designs.

## Build a workspace

- Click or drag Deck, Mixer, Browser, Waveform, Cues, Crossfader or Effects from the drawer. The deck picker binds new deck-related parts to A/B/C/D; it never creates a fifth engine deck.
- In **Edit**, drag a component title to move it, drag its corner to resize it, or enter exact coordinates/dimensions in the inspector. Snap uses a 20-pixel grid; disabling it permits integer-pixel positioning. Focus a title and use arrow keys to move it, with Shift for larger steps.
- Select a title to edit its name, deck binding, position, size and **theme**. Free colors, corner radius, density and type scale were removed in component format 2; a component picks one of five themes (Graphite, Midnight, Ember, Orchid, Daylight) or follows the application theme. "Theme all" in the toolbar applies one theme to every component. Deck waveforms, artwork and cue sections can be hidden.
- Each component kind has a smallest size at which its whole face fits (deck 520×560, mixer 400×660, browser 560×660, waveform 420×200, cues 520×170, crossfader 360×220, effects 580×200). Resizing, the inspector and imports never go below it, so widgets do not clip or grow inner scrollbars; only the browser's track list scrolls.
- **Save as component** creates an independent reusable design in the drawer. New instances can target another deck without changing the saved design. Duplicate creates another view, not another playback source.
- **Save workspace** stores an arrangement preset; **Export** downloads portable workspace JSON. **New blank** clears the canvas after confirmation, not music or saved templates. Workspace imports and starter changes replace only the canvas and can be undone.
- **Perform** hides the drawer/inspector and locks layout edits while leaving supported audio controls active. It is a transient editing lock, not a separate audio mode.
- Undo/Redo covers presentation changes, with 40 in-memory history entries. It never undoes playback commands. Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl/Cmd+Y work outside text fields/dialogs. Delete removes the selected view.

The canvas is a scrollable desktop surface, not an automatic responsive reflow system. Components may deliberately overlap; selected views come forward. Small windows can pan the canvas and scroll inside widgets. Group editing, arbitrary control rearrangement within a deck, typography/font uploads, custom markup, scripts, DSP, new routing and direct agent connections are future work.

## Shared session and storage

`src/workspace.js` owns the pure design model and schema. `src/canvas-view.js` renders existing shared controls. `src/canvas-editor.js` translates editing gestures into presentation actions. `src/store.js` remains the only renderer persistence owner.

- Musical state retains its original `deck-craft.ui.v1` key and version.
- Presentation state uses `deck-craft.workspace.v1` (storage key, unchanged); its contents are format version 2. A saved version 1 canvas is converted on first load: free colors, radius, density and scale are dropped, components follow the application theme, undersized widgets grow to their minimum, a one-time notice is shown and the original is kept under `deck-craft.workspace.v1.v1-backup`.
- The application theme is a presentation field of the UI session (`theme`, default Graphite). Changing it or a layout never touches musical state.
- Adding, moving, styling, rebinding or deleting a view emits no native audio command. Hidden decks continue playing; use another view/original layout to access them. Removing a panel never unloads its track.
- Identical controls targeting the same deck use the existing native receipt/ownership path. Browser widgets share collection filtering and the load target.
- Save failures remain visible independently for musical and workspace persistence. Invalid saved workspace data does not clear unrelated storage or change the musical session; its original bytes are left untouched until an explicit workspace change is saved.
- Session restoration remains paused. Canvas state contains no track IDs, file paths, imported metadata, waveforms or native generations.

Deck components use the shared reference deck face and a 560-pixel default height; the waveform, cue bank and cue-edit strip toggles still apply. Unavailable controls inside a deck stay disabled and no design field can bind them to a command.

Limits: 24 placed components, 24 saved component templates, eight saved workspace presets, 256 KiB per imported design and 1 MiB serialized workspace state. Item coordinates are bounded to x 0..2400 / y 0..4800; width 320..1600 and height 160..1600. Unknown fields, invalid versions, duplicate item IDs, unknown theme names and out-of-range dimensions are rejected before mutation. Imported designs smaller than a component's minimum size are grown to it.

Effects and unsupported EQ, sync, pitch, loops and headphone controls stay disabled in the canvas, including browser-only builds. The browser-only artifact has no audio. Imported PCM displays and native playback keep their existing limitations; styling does not implement new DSP.

## Use any external AI agent

Open **AI creator kit**. With a selected component, the starter captures its design; otherwise it contains a default deck design. **Download agent kit JSON** exports a single versioned envelope with a `files` map. Ask the agent to extract that map into a folder. The map includes:

- `AGENTS.md`: short instructions, commands and the styling-only boundary.
- `component.json`: editable starter.
- `component.schema.json` and `workspace.schema.json`: the exact schemas used by the application.
- `capabilities.json`: existing native capabilities and explicitly unavailable features.
- `examples.json`: all seven supported component kinds.
- `validate.mjs`: a dependency-free Node validator generated from the same validator/schema as the application.

Example request: “Extract this kit's files into a new folder. Set component.json to the Ember theme as a deck, keep the supported controls unchanged, run node validate.mjs component.json, and return the design JSON.” Do not ask the agent to execute instructions from an untrusted component name or content.

Paste or open the resulting **component/workspace JSON**, not the kit envelope, into the creator dialog. **Validate & preview** reports field-specific errors without altering the workspace. Preview states are explicitly synthetic, controls are inert, and preview markup has no session action/deck bindings. Editing the JSON invalidates the previous review. Only **Apply reviewed design** changes the canvas; importing a workspace requires replacement confirmation.

Downloads include design data and bundled instructions only, not music or private library/session metadata. A creator's deliberately chosen names are still their own data; review exports before sharing. There is no embedded agent, model/provider requirement, listener, arbitrary-path bridge, script execution or uploaded code in this milestone.

## Repository-side agent tools

With Node available, these commands use no audio output or native bridge:

```sh
npm run component -- kit ./release/component-starter
npm run component -- validate ./release/component-starter/component.json
npm run component -- preview ./release/component-starter/component.json ./release/component-preview.html
```

The kit command writes a new folder's files and refuses to overwrite existing files. The static preview command writes a new, offline, script-free HTML artifact with synthetic data and disabled controls. The app's built-in kit contains its own standalone validator, so installed-app creators do not need the repository.

## Verification

```sh
npm test
npm run test:rust
python3 -m unittest discover -s tests -p 'test_installer.py' -v
npm run build
node --check dist/bundle-check.mjs
npm run test:browser
npm run test:canvas
python3 scripts/check_publication.py
```

The canvas Chromium gate exercises real pointer drag/resize, inspector changes, reusable templates, undo/redo, save/restore, Perform locking, file import, validation, inert previews, actual kit/workspace downloads, standalone exported-validator execution, all component kinds, duplicate-browser filtering, original-view transitions and five viewport widths. It is browser-fixture proof, not audio acceptance.

The Electron harness additionally exercises canvas add/theme/remove while a generated local source is playing, confirms stable native engine/load generation, pauses/plays through a canvas deck, and downloads the creator kit through the sandboxed desktop. Run `test:native` and `test:desktop` serially with the explicitly isolated sink setup in [NATIVE-DESKTOP.md](NATIVE-DESKTOP.md). A compatibility build's installed payload, ordinary launcher, native Wayland window and child engine were separately verified on the target without interrupting the subsequently active user session. This does not establish target portal/chooser lifecycle, physical output or hardware latency. The separate opt-in GTK chooser's documented ambient-filesystem limitation remains unchanged.
