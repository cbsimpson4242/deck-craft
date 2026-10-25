# Security and publication safety

Never submit real credentials or private infrastructure details in an issue, pull request, image or log. Use GitHub's private vulnerability reporting for sensitive reports when available; otherwise open an issue requesting a private contact without including exploit details or secrets.

Public source must exclude access tokens, passwords, keys, certificates used for private services, private endpoints, network topology, local operational state, personal music and other projects' files. Use only synthetic fixtures in tests and prototypes. Do not put real secrets in `.env.example`.

Before publication, review every tracked file and all reachable commit history, run the local publication checks, and inspect the exact staged diff. Publish only the intended branch, never `--all` or `--mirror`. If a real credential is exposed, revoke/rotate it immediately: removing a file or rewriting history does not revoke it.

The historical designs are offline mockups without browser storage. The current application UI uses versioned browser-local storage for the selected layout and shared session settings; it has no cloud/account sync. Storage errors are visible, corrupt values are validated, and restored UI transport is paused. No personal audio files, analytics, external scripts, network connections or device access are used. The portable build disables network connections through its content policy. Do not put secrets in browser snapshots or issue reports.
