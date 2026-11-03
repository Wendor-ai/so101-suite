---
name: add-page
description: Add or change a built-in page of the SO-101 Suite web app (app/suite/js/pages/<id>.js, the router, the nav, the page CSS). Use when asked to "add a page", "add a screen", "add a tab to the nav", "change the Calibrate/Cameras/Setup page", or build UI for the Suite.
---

# Add a page

The app is plain ES modules with no build step. The page contract is `app/suite/js/README.md`; **read it first**, then `docs/design/information-architecture.md` (what a page is for, terminology section 7, voice section 8) and `docs/design/physical-instructions.md` if the page asks a person to touch anything.

## Procedure

1. **Decide the route id** (lowercase, for example `pose`). It becomes `#/pose`. If the feature is separable, make it a module instead (`add-module`).
2. **Create `app/suite/js/pages/<id>.js`:**

   ```js
   import { h, button, callout, pageHead, safe } from '../ui.js';
   export default {
     id: 'pose', title: 'Pose',
     render(root, ctx, route) {
       root.append(pageHead('Use', 'Pose', 'One short sentence about what this page does.'));
       const off = ctx.onChange(c => c.arm('follower')?.online, online => { /* update only what changed */ });
       return () => off();                    // always clean up: unsubscribe, camera views, twins
     },
   };
   ```

   `ctx` has `api`, `state` (live `/api/state`, every 500 ms), `checklist`, `info`, `settings`, `subscribe`, `onChange`, `arm(role)`, `go`, `setSetting`, `refresh`, `guide`, `units`, `moving`. Helpers in `js/ui.js`: `h icon rich toast askYes badge dot chip button actions ring callout copyBox empty skeleton term cameraView pageHead safe debounce loadCss svg`. Physical steps: `js/steps.js` (`stepCard preflight progressCue rightWrong`). 3D arm: `js/twin.js` (`mountTwin`).
3. **Register it:** add `<id>: '<id>'` to `FILES` in `app/suite/js/router.js`, and an entry to `NAV` in `app/suite/js/shell.js` (`{ id, label, icon, mobile? }`; use a group heading that exists: Get started, Use, Learn, Help, Debug). The command palette (`js/palette.js`) reads `NAV` by itself. If the page is a journey step, also update `stepStatus` in `shell.js`.
4. **CSS:** put page styles in `app/suite/css/pages/<id>.css` and load them with `loadCss(new URL('../../css/pages/<id>.css', import.meta.url).href)`. Reuse the classes in `css/components.css` first.
5. **Copy:** long text goes in `app/suite/js/content/*.js`, not in the page. Every term a beginner may not know is `term('motor-id', 'motor ID')` (add the glossary entry; see `add-learn-article`). Use `explain-for-beginners`.
6. **Backend:** if the page needs a new API, add it to `so101/suite_api.py` (`_api`) **and** to the mock in `app/suite/js/mock/backend.js` (`route`), keep the same response shape, and add tests on both sides (`tests/test_suite_api.py`, `tests/js/mock.test.mjs`). Document it in `docs/API.md`.
7. **Rules that bite** (each is a past failure, `docs/LEARNINGS.md` sections 4 and 14): never rebuild DOM on every tick and never while a button is pressed; no `alert/confirm/prompt` (`askYes`, `toast`); every disabled button says why (`button('Save', {why: '...'})`, group with `actions([...])`); wrap click handlers in `safe(fn)`; camera views show a reason, never a black box; the arm moves only after a sentence and `askYes`; relative asset URLs only, no CDN; real buttons and links, labels on icon buttons, AA contrast, works at 360 px with the keyboard.
8. **Click-test in demo mode:** `uv run so101 start --demo --no-browser --port 8150`, open `http://localhost:8150/suite/#/<id>`, or no backend at all: `?demo=1` (query flags `scenario=fresh|ready|nothing`, `seed=`, `os=`). Check 1280 px and 360 px, dark and light, empty state, error state, console clean. Every button you named in text must exist with that exact label.
9. **Run the tests:** `node --test "tests/js/*.test.mjs"` and `SO101_NO_REAL_PORTS=1 uv run pytest -q`. If the website copies it (it does: `site/` syncs `app/suite`), `cd site && pnpm build && pnpm check`.
10. **Docs:** update `app/suite/js/README.md` if the contract changed, and `docs/ARCHITECTURE.md` if the structure did. Stop your server.

Done when: page renders live and in the mock, tests green, a11y and responsive checked, no console errors, docs updated, no personal data.
