# Contributing to Deck Craft

Discuss substantial changes in an issue first. Describe the DJ workflow, user need, acceptance criteria and design trade-offs. Keep changes focused; include tests and before/after images for UI changes using synthetic data.

Do not include credentials, local deployment configurations, private hostnames/IP addresses, personal music libraries, session logs, recordings or screenshots of unrelated applications. Do not copy proprietary code, product artwork or branding. Disclose the source and license of any third-party material.

Design prototypes must remain clearly labelled; do not present simulated actions as working audio features. Test portable HTML offline, keyboard access, phone and desktop layouts, and all exposed interactions.

## Local checks

Run `npm test`, `npm run build`, `node --check dist/bundle-check.mjs`, `npm run test:browser` (Chromium required) and `python3 scripts/check_publication.py` from the repository root. Open `dist/deck-craft.html` and exercise all five layouts with a changed session, then reload and verify the saved preference. Check preserved C/D in two-deck views and inspect expanded controls at desktop/phone sizes. Historical comparisons are design evidence, not the application's entry point. Review the entire staged diff before any public push; ignore rules and pattern scanning are safeguards, not proof that no sensitive content exists.
