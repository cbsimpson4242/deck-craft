# Security and publication safety

Never submit credentials, private infrastructure details, actual music, runtime databases or operational logs in an issue, pull request, image or artifact. Prefer GitHub private vulnerability reporting for sensitive reports; otherwise request a private contact without including the sensitive material.

## Public-source boundary

Exclude access tokens, passwords, private keys, service certificates/endpoints, topology, personal music, account/browser state and other projects' files. Tests use generated audio and synthetic metadata. Review every intended file and reachable commit, run publication checks and inspect exact staged bytes. Publish only the intended branch, never `--all` or `--mirror`. Revoke/rotate exposed credentials; history editing alone does not revoke them.

## Native desktop boundary

The renderer is sandboxed and context-isolated, has no Node/process/Electron API, and loads one private app origin with a hash-authorized script policy. External requests, navigation, popups, webviews and permissions are denied. There is no project HTTP server, remote control listener, telemetry, cloud library or upload path.

The main process owns the native file chooser and allowlisted semantic IPC. Only its own intended main frame may call it. Renderer code cannot supply a filesystem path, shell command or arbitrary native command. Selected sources receive opaque IDs; source paths are kept in the private user-local library, not exposed through renderer metadata.

The Rust child receives only necessary operational environment values. Source file type/identity is checked before decoding; nonblocking opens avoid FIFO substitution hangs. Input size/duration/channel/rate and command/frame limits are enforced. Channel-strip commands (`gain`, `hi`, `mid`, `low`, `filter`) are exact `{type, deck, value}` shapes with a finite value in 0…100; the strip adds no file, path, network or arbitrary-code surface. Stale generations and sequence numbers cannot overwrite current transport. Failure/disconnection is visible and never automatically replays music. Saved sessions restore paused.

The source registry is mode 0600, written atomically under mode-0700 application storage. Local renderer snapshots contain layout/session settings and opaque track IDs, not credentials. File basenames, cues and PCM-derived peaks can still be private music metadata: do not include your app-data directory in bug reports. Missing, changed and unsupported files are rejected; unrelated files are not deleted to recover state.

Native file/folder selection is owned by the main process; multi-file import never accepts a path from renderer IPC. Directory traversal, candidate count, decoder time and output size are bounded, and directory symlinks are not followed. A separate one-shot native inspection mode reads identity-bound selected sources without opening an audio device or taking a deck. Its diagnostics and source paths are not forwarded. Crate/playlist names, membership and order are private registry data under the same byte limit. Removing collection membership or a library entry only changes the registry, never the selected music file. Collection changes/removals roll back on failed save; sources currently loaded/loading in decks cannot be forgotten.

## Custom canvas and creator boundary

Imported components/workspaces are bounded, versioned JSON, not executable plugins. Exact schemas reject unknown fields, code, arbitrary HTML/CSS, URLs, native command bindings, invalid colors/dimensions and duplicate item IDs. Plain-text names are escaped before rendering. Creator previews use labeled synthetic fixtures with disabled controls and no session action bindings. JSON changes invalidate review; applying an imported workspace requires explicit replacement confirmation. The component system adds no listener, renderer Node access or arbitrary-path API.

Workspace designs are saved separately from musical state by the existing renderer store. Removing/rebinding a view never unloads its source or changes audio routing. Exported kits/designs contain layout/style data and bundled documentation only, not private music/library/session metadata. Creator-selected names may still be personal; review exports before sharing. Imported data should be treated as untrusted by external agents too.


## Installer and build boundary

No sudo, OS package installation, service creation, OS-volume change, music deletion or automatic running-app restart occurs. The small installer fetches a pinned official Electron release via HTTPS and verifies its checksum; an exact ZIP may be supplied offline. It validates payload paths/hashes, preserves runtime/dependency notices, refuses unrelated launchers and uses versioned user-local releases with rollback. Packaging copies only explicit reviewed runtime source/assets, never a working directory's ignored logs, recordings or user state.

The browser artifact (`dist/deck-craft.html`) has network connections disabled and no upload path. In a supporting browser it plays only local files chosen through the browser file chooser, using the browser's own audio engine; see the browser audio boundary below. Otherwise it is UI-only. The native app uses local audio device access; OS-mounted network files still use the selected filesystem. Hardware latency/professional reliability and the target machine's portal/output behavior require separate live acceptance.


## Offline track analysis and artwork

Beat analysis and artwork extraction run on workers or the bounded one-shot inspector, never on the device callback. The inspector is time-limited and its output is capped; it receives only a main-process-owned identity-bound selected file. Embedded JPEG/PNG is size/dimension bounded, decoded and re-encoded into a small metadata-free PNG. The renderer accepts only bounded PNG data images, never file paths or external artwork URLs. Grid metadata, thumbnails and measured BPM stay in the private registry under its existing shared byte budget.

Tempo, pitch-lock, master and sync use exact semantic commands with bounded values and unknown-field rejection. Native acknowledged settings and source-frame clocks remain authoritative; stale renderer operations do not invent transport or automatically replay after failure.

## Browser audio boundary

The in-browser backend (`docs/BROWSER-AUDIO.md`) reads local File/Blob objects and plays them through media elements and Web Audio on the user's device. It adds no listener, server, account, upload, remote decode, renderer Node access or native-command path; `connect-src 'none'` stays, and the only added CSP source is `media-src blob:` for local object URLs. The native desktop window keeps its own `media-src 'none'` header and never starts this backend. Files are stored only as Blobs in this browser's IndexedDB within fixed limits (file size, duration, batch, library bytes), cleared by removing library entries or browser data, and marked session-only when storage is unavailable or full. File names, waveforms and thumbnails can still be private music metadata: do not include browser storage in bug reports. A plain-HTTP preview served on a LAN is unauthenticated and unencrypted; serve only builds you are willing to expose, never music, and remember that anything on that network can request the page. Embedded artwork is sniffed, size/dimension-bounded and re-encoded locally; remote artwork links are ignored.

Mixer routing is limited to semantic left/right/thru assignment. Native stereo peak telemetry is finite and bounded before entering the renderer. Paused/offline meters are silent; band kill adds no executable bindings or file paths.

Browser audio never receives mixer, gain, EQ, filter or routing commands: its bridge implements channel levels, the crossfader, tempo, sync and import only, and unsupported strip commands are rejected by the renderer before they reach it.
