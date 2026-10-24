# Security and publication safety

Never submit real credentials or private infrastructure details in an issue, pull request, image or log. Use GitHub's private vulnerability reporting for sensitive reports when available; otherwise open an issue requesting a private contact without including exploit details or secrets.

Public source must exclude access tokens, passwords, keys, certificates used for private services, private endpoints, network topology, local operational state, personal music and other projects' files. Use only synthetic fixtures in tests and prototypes. Do not put real secrets in `.env.example`.

Before publication, review every tracked file and all reachable commit history, run the local publication checks, and inspect the exact staged diff. Publish only the intended branch, never `--all` or `--mirror`. If a real credential is exposed, revoke/rotate it immediately: removing a file or rewriting history does not revoke it.

The initial designs are offline mockups. No audio files, browser storage, analytics, external scripts, network requests or device access are used.
