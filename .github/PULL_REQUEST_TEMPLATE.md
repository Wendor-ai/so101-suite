<!-- Thank you for helping. Small pull requests that do one thing are easiest to review. -->

## What this changes and why

<!-- One or two sentences. Link an issue if there is one. -->

## How you checked it

- [ ] `SO101_NO_REAL_PORTS=1 uv run pytest -q` is green
- [ ] `node --test "tests/js/*.test.mjs"` is green
- [ ] I ran the demo (`uv run so101 demo`) and clicked through the change at 1280 px and 360 px, dark and light, with no console errors
- [ ] `cd site && pnpm build && pnpm check` passes (only needed if I touched `site/`, `app/suite/`, `docs/` or `modules/`)

## Rules from AGENTS.md

- [ ] Nothing opens a real serial port in tests; hardware is only used in demo mode or on purpose
- [ ] The arm only moves when the person asked, and the page says what will move first
- [ ] No browser pop-ups; every disabled button says why; nothing fails silently
- [ ] The server demo and the in-browser mock agree (and `tests/checklist_cases.json` if the checklist changed)
- [ ] Docs updated (`docs/`, `app/suite/js/README.md`, skills) where behaviour changed
- [ ] No personal data: no usernames, home paths, IP addresses, serial numbers, keys or photos
- [ ] My changes are licensed under AGPL-3.0-or-later like the rest of the project

## What I could not test

<!-- Real hardware? Windows? Say so plainly: that is useful, not a failure. -->
