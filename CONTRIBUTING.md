# Contributing to Deck Craft

Discuss substantial changes in an issue first. Describe the DJ workflow, user need, acceptance criteria and design trade-offs. Keep changes focused; include tests and before/after images for UI changes using synthetic data.

Do not include credentials, local deployment configurations, private hostnames/IP addresses, personal music libraries, session logs, recordings or screenshots of unrelated applications. Do not copy proprietary code, product artwork or branding. Disclose the source and license of any third-party material.

Design prototypes must remain clearly labelled; do not present simulated actions as working audio features. Test portable HTML offline, keyboard access, phone and desktop layouts, and all exposed interactions.

## Local checks

Run `python3 scripts/check_publication.py` from the repository root. Open `designs/deck-craft-comparison.html` and exercise all five selectors and their controls. Review the entire staged diff before any public push; ignore rules and pattern scanning are safeguards, not proof that no sensitive content exists.
