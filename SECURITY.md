# Security and publication safety

Never submit credentials, private infrastructure details, actual music, runtime databases or operational logs in an issue, pull request, image or artifact. Prefer GitHub private vulnerability reporting for sensitive reports; otherwise request a private contact without including the sensitive material.

## Public-source boundary

Exclude access tokens, passwords, private keys, service certificates/endpoints, topology, personal music, account/browser state and other projects' files. Tests use generated audio and synthetic metadata. Review every intended file and reachable commit, run publication checks and inspect exact staged bytes. Publish only the intended branch, never `--all` or `--mirror`. Revoke/rotate exposed credentials; history editing alone does not revoke them.

## Native desktop boundary

The renderer is sandboxed and context-isolated, has no Node/process/Electron API, and loads one private app origin with a hash-authorized script policy. External requests, navigation, popups, webviews and permissions are denied. There is no project HTTP server, remote control listener, telemetry, cloud library or upload path.

The main process owns the native file chooser and allowlisted semantic IPC. Only its own intended main frame may call it. Renderer code cannot supply a filesystem path, shell command or arbitrary native command. Selected sources receive opaque IDs; source paths are kept in the private user-local library, not exposed through renderer metadata.

The Rust child receives only necessary operational environment values. Source file type/identity is checked before decoding; nonblocking opens avoid FIFO substitution hangs. Input size/duration/channel/rate and command/frame limits are enforced. Stale generations and sequence numbers cannot overwrite current transport. Failure/disconnection is visible and never automatically replays music. Saved sessions restore paused.

The source registry is mode 0600, written atomically under mode-0700 application storage. Local renderer snapshots contain layout/session settings and opaque track IDs, not credentials. File basenames, cues and PCM-derived peaks can still be private music metadata: do not include your app-data directory in bug reports. Missing, changed and unsupported files are rejected; unrelated files are not deleted to recover state.

Native file/folder selection is owned by the main process; multi-file import never accepts a path from renderer IPC. Directory traversal, candidate count, decoder time and output size are bounded, and directory symlinks are not followed. A separate one-shot native inspection mode reads identity-bound selected sources without opening an audio device or taking a deck. Its diagnostics and source paths are not forwarded. Crate/playlist names, membership and order are private registry data under the same byte limit. Removing collection membership or a library entry only changes the registry, never the selected music file. Collection changes/removals roll back on failed save; sources currently loaded/loading in decks cannot be forgotten.

## Installer and build boundary

No sudo, OS package installation, service creation, OS-volume change, music deletion or automatic running-app restart occurs. The small installer fetches a pinned official Electron release via HTTPS and verifies its checksum; an exact ZIP may be supplied offline. It validates payload paths/hashes, preserves runtime/dependency notices, refuses unrelated launchers and uses versioned user-local releases with rollback. Packaging copies only explicit reviewed runtime source/assets, never a working directory's ignored logs, recordings or user state.

The portable browser artifact remains UI-only, with network connections disabled. The native app uses local audio device access; OS-mounted network files still use the selected filesystem. Hardware latency/professional reliability and the target machine's portal/output behavior require separate live acceptance.
