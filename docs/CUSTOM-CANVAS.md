# Custom canvas and AI component creator

## First-stage boundary

The builder edits presentation over Deck Craft's existing shared four-deck session. Open **Build** in the application header. A new canvas is initially empty; **Console** and **Two decks** starter arrangements reuse the current shared components. **Perform** returns to the main console without changing the audio session. Historical design files remain preserved separately.

## Build a workspace

- Click or drag Deck, Mixer, Browser, Waveform, Cues, Crossfader or Effects from the drawer. The deck picker binds new deck-related parts to A/B/C/D; it never creates a fifth engine deck.
- In **Edit**, drag a component's title bar to move it and grab any of its **eight handles** (four sides and four corners) to resize it. See *Selecting, moving and resizing* below. There is no properties inspector and no numeric position/size fields; the canvas takes that width.
- Component internals are not edited in the builder at this stage. Name, deck binding and visible sections come from the **Bind new deck parts to** picker, starters, saved components and reviewed JSON imports, and existing saved values are kept exactly as they are. Free colors, corner radius, density and type scale were removed in component format 2; a component picks one of the three themes (Night, Ember, Studio) or follows the application theme. The toolbar's **Theme all** applies one theme to every component.
- Each component kind has a smallest size at which its whole face fits (deck 480×380, mixer 460×420, browser 560×420, waveform 420×160, cues 440×170, crossfader 360×160, effects 580×200). Resizing (pointer or keyboard) and imports never go below it, so widgets do not clip or grow inner scrollbars; only the browser's track list scrolls.
- A selected component shows three compact actions in its title bar. **Save** creates an independent reusable design in the drawer. New instances can target another deck without changing the saved design. Duplicate creates another view, not another playback source.
- **Save workspace** stores an arrangement preset; **Export** downloads portable workspace JSON. **New blank** clears the canvas after confirmation, not music or saved templates. Workspace imports and starter changes replace only the canvas and can be undone.
- **Perform** hides the drawer, resize handles and component actions and locks layout edits while leaving supported audio controls active. It is a transient editing lock, not a separate audio mode.
- Undo/Redo covers presentation changes, with 40 in-memory history entries. It never undoes playback commands. Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl/Cmd+Y work outside text fields/dialogs. Delete removes the selected view.

The canvas is a scrollable desktop surface, not an automatic responsive reflow system. Components may deliberately overlap; selected views come forward. Small windows can pan the canvas and scroll inside widgets. Group editing, arbitrary control rearrangement within a deck, typography/font uploads, custom markup, scripts, DSP, new routing and direct agent connections are future work.

## Selecting, moving and resizing

- Pressing anywhere on a component selects it (a clear outline); pressing bare canvas clears the selection. Selecting never changes the layout, history or audio, and the component's own controls keep working normally in Edit mode.
- Drag the **title bar** to move. Every component has **eight resize handles**: top, bottom, left and right edges and all four corners. Handles are subtle on hover, clear on the selected component and bright under the pointer; the cursor is `ns-resize`, `ew-resize`, `nwse-resize` or `nesw-resize` to match the grabbed edge. While dragging, a small badge shows the size (or position), plus "smallest size" when a limit is reached.
- The edge opposite the one you grab never moves. Dragging a top or left edge keeps the bottom or right edge in place; a corner keeps the diagonal corner in place. The grabbed edge snaps to the 20-pixel grid (exact pixels with **Snap** off), then stops at the component's smallest whole-face size, the 1600-pixel maximum or the canvas origin. At a limit nothing jumps: results are computed from the total pointer travel, so moving back inside the limit follows the pointer again. Canvas scrolling during a drag is included.
- A gesture is one history entry, committed on release. A click, a drag that ends where it began or a fully clamped drag adds nothing. **Escape**, a lost pointer or window focus loss cancels the drag and restores the saved layout without touching undo/redo.
- Keyboard: focus a title and use the arrow keys to move (Shift for larger steps); **Alt+arrow** resizes from the bottom-right corner with the same limits. Delete removes the selected view.
- **Duplicate**, **Save** (reusable component) and **Remove** are the only contextual actions. Removing a view never unloads a track. Exporting a single component's JSON is available from **AI creator kit → Download starter component**, which uses the selected component.
- None of this reads or writes musical state. In **Perform** there are no handles or actions, and pointer, Delete and Alt+arrow edits are ignored.

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

Native canvas decks share the same tempo, pitch lock, explicit master and detected-grid beat sync as the console. The mixer component shows the shared gain, three-band full-kill EQ, sweep-filter, meter and crossfader-assignment controls for all four decks: real native controls in the desktop app, disabled with an explanation in the in-browser audio backend (which has channel levels and the crossfader only) and plain UI settings in the audio-less browser artifact. Effects, loops and headphone routing remain disabled. Synthetic creator previews have no audio. The browser artifact plays local files through its own browser engine (see `docs/BROWSER-AUDIO.md`) when the browser supports it and is otherwise UI-only. Grid-analysis, time-stretch quality and target-machine acceptance limits are the same as the ordinary native views. Styling itself never adds new DSP or command bindings.

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

The canvas Chromium gate exercises real pointer move and resize from all eight handles on every component kind (directional cursors, anchored north/west edges, smallest size, canvas origin, one undo per gesture, Escape cancel, Alt+arrow resizing, contextual Duplicate/Save/Remove, Perform locking, and the absence of the inspector), reusable templates, undo/redo, save/restore, Perform locking, file import, validation, inert previews, actual kit/workspace downloads, standalone exported-validator execution, all component kinds, duplicate-browser filtering, original-view transitions and five viewport widths. It is browser-fixture proof, not audio acceptance.

The Electron harness additionally exercises canvas add/theme/remove while a generated local source is playing, confirms stable native engine/load generation, pauses/plays through a canvas deck, and downloads the creator kit through the sandboxed desktop. Run `test:native` and `test:desktop` serially with the explicitly isolated sink setup in [NATIVE-DESKTOP.md](NATIVE-DESKTOP.md). A compatibility build's installed payload, ordinary launcher, native Wayland window and child engine were separately verified on the target without interrupting the subsequently active user session. This does not establish target portal/chooser lifecycle, physical output or hardware latency. The separate opt-in GTK chooser's documented ambient-filesystem limitation remains unchanged.
