---
name: add-module
description: Add a drop-in module to SO-101 Suite (a folder in modules/ with module.json, an optional backend.py and an optional ui.js page). Use when asked to "add a module", "make a plugin or extension", "add a page with its own API", "show X in the app" as a separable feature, or "build on modules/hello".
---

# Add a module

A module is `modules/<id>/` with `module.json`, optionally `backend.py` (answers `/api/m/<id>/<path>`) and `ui.js` (a page at `#/m/<id>`). Reference: `docs/MODULES.md`; template: `modules/hello/`. Modules run **inside the app process with full access**: follow the hard rules in `AGENTS.md`.

## Procedure

1. **Read** `docs/MODULES.md` and the three files in `modules/hello/`. If the job needs core changes (a new built-in page, a new core API), stop and use `add-page` instead.
2. **Choose the id:** lowercase letters, digits, underscores, starts with a letter, 2 to 32 characters (`so101/modules.py` `ID_RE`). The folder name **must equal** the id. Folders starting with `.` or `_` are ignored.
3. **Copy the template:** `cp -r modules/hello modules/<id>`, then edit.
4. **`module.json`** fields: `id`, `name`, `description`, `version`, `author`, `license` (use `AGPL-3.0-or-later`), `requires` (informational list), `pages` (`[{"id","title","icon","script"}]`, `script` is a plain file name, no `/`), `backend` (`"backend.py"` or `null`).
5. **`backend.py`:** `def handle(method, path, body, ctx): ... return (status:int, payload)`. `ctx.arms` (dict of `Arm` threads: `.role .online .ids .pos .state()`), `ctx.cams`, `ctx.PP`, `ctx.TELE`, `ctx.store` (`get/set` dotted keys), `ctx.demo`. Return `404` with a sentence for unknown paths. Never raise on purpose; never open a serial port; never move the arm unless the person asked (call the app's guarded routes instead).
6. **`ui.js`:** `export default { id, title, icon, group: 'modules', render(root, ctx, route) { ...; return cleanup; } }`. Follow the 12 rules in `app/suite/js/README.md` (no pop-ups, disabled buttons say why, no DOM rebuild on every tick, clean up). Call the backend with `ctx.api.post('/api/m/<id>/<path>', body)`. Use the project's words: Leader arm, Follower arm, Motor ID, Jaw.
7. **`README.md`:** one paragraph for humans.
8. **Test (no hardware):** add `tests/test_module_<id>.py` using the pattern in `tests/test_modules.py` (`modules.discover(path)`, `modules.dispatch(m, "GET", "x", {}, ctx)` with a small fake ctx). Test the error path too (unknown route returns 404, not an exception).
9. **Run it in demo mode** (never port 8000): `uv run so101 start --demo --no-browser --port 8150`. Restart after every `backend.py` change (it is imported once). Then:
   - `curl -s http://localhost:8150/api/suite/modules` shows your module with `"error": null, "enabled": true`.
   - `curl -s -X POST http://localhost:8150/api/m/<id>/<path> -H 'Content-Type: application/json' -d '{}'`
   - Open `http://localhost:8150/suite/#/m/<id>` with the browser tools; click every control; check 1280 px and 360 px, dark and light, no console errors.
10. **Stop the server** you started (`lsof -ti :8150 | xargs kill`).

## Verify

```bash
SO101_NO_REAL_PORTS=1 uv run pytest -q tests/test_modules.py tests/test_module_<id>.py
```

Definition of done: module listed with no error; backend answers; page works in demo; test green; README written; no personal data (no usernames, paths, serial numbers, keys); you said what you could not test (real hardware).
