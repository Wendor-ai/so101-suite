# Modules

A module is a folder in `modules/` that adds a page, an API route, or both. Drop it in and the app finds it. The smallest one is `modules/hello`: copy it to start your own.

## The shape of a module

```
modules/<id>/
  module.json    what it is and what it adds (required)
  backend.py     answers /api/m/<id>/<path>   (optional)
  ui.js          a page, served at /suite/modules/<id>/ui.js   (optional)
  README.md      one paragraph for humans
```

### `module.json`

```json
{
  "id": "hello",
  "name": "Hello module",
  "description": "The smallest possible module: one page and one tiny backend.",
  "version": "1.0.0",
  "author": "SO-101 Suite contributors",
  "license": "AGPL-3.0-or-later",
  "requires": [],
  "pages": [{ "id": "hello", "title": "Hello", "icon": "hand", "script": "ui.js" }],
  "backend": "backend.py"
}
```

| Field | Rule |
|---|---|
| `id` | Required. Lowercase letters, digits and underscores, starting with a letter, 2 to 32 characters. **Must equal the folder name** |
| `name`, `description`, `version`, `author`, `license` | Text. `name` defaults to the id, `version` to `0.0.0` |
| `requires` | A list of notes about what it needs (for example `"camera"`). Informational: it is kept in the manifest and not enforced |
| `pages` | A list of `{id, title, icon, script}`. `script` is a plain file name in the module folder (no `/`) |
| `backend` | `"backend.py"` (a `.py` file that exists in the folder) or `null` |

A folder that starts with `.` or `_` is ignored. A module with a problem (no `module.json`, bad JSON, wrong id, missing backend file) is **listed with its error** on the Modules page and never stops the app.

### `backend.py`

```python
def handle(method, path, body, ctx):
    if path == "greet":
        return 200, {"message": "Hello!", "arms_connected": sum(1 for a in ctx.arms.values() if a.online)}
    return 404, {"error": "This module has no '%s' route." % path}
```

- It is called for every `GET/POST/PUT/DELETE /api/m/<id>/<path>`. `path` is what comes after the id, `body` is the JSON object (`{}` when there is none).
- Return `(status, payload)`: an integer and anything JSON can hold. Anything else is a 500 with a sentence. If you raise, the app answers 500 with `The module '<id>' had an error: ...`; the traceback goes to stderr.
- `ctx` is the running app: `ctx.arms` (dict of `Arm` threads, each with `.role`, `.online`, `.ids`, `.pos`, `.state()`), `ctx.cams` (the cameras), `ctx.PP` (pick and place, `None` in camera-only mode), `ctx.TELE`, `ctx.store` (the JSON config store, `get`/`set` with dotted keys), `ctx.demo`.
- The file is imported **once**, on first use. **Restart the app after you change `backend.py`.** `module.json` and UI files are read again on every request.

### `ui.js`

```js
export default {
  id: 'hello', title: 'Hello', icon: 'hand', group: 'modules',
  render(root, ctx, route) {                       // root: an empty element; ctx: the app (see app/suite/js/README.md)
    root.append(/* plain DOM or the helpers from ../../js/ui.js */);
    return () => { /* optional cleanup: unsubscribe, destroy views */ };
  },
};
```

The page opens at `#/m/<id>` (or `#/m/<id>/<page id>` when a module has several pages, which get tabs). A module can also export a plain function instead of an object. Call its backend with `ctx.api.post('/api/m/<id>/<path>', body)`; errors arrive as an `ApiError` with a human sentence. Served file types: `.js .css .json .svg .png`, only from inside the module folder.

Module pages follow the same rules as built-in pages: no browser pop-ups, every disabled button says why, never rebuild the DOM on every tick, clean up. Read `app/suite/js/README.md`.

## Rules for module authors

A module runs **inside the app's process with full access**. Treat it like any code you run: read a module before you install it.

- **Never open a serial port yourself.** The `Arm` threads own the ports. Use `ctx.arms`, or call the app's own routes.
- **Never move the arm unless the person asked**, after a sentence that says what will move. Prefer calling the app's guarded routes (`/api/suite/motors`, `/api/pp/*`) over writing to motors.
- **Never fail silently** and never block: do slow work in a thread and report progress.
- **Keep personal data out:** no usernames, paths, serial numbers or keys in files or responses.
- Use the project's words: Leader arm, Follower arm, Motor ID, Jaw, Module.

## Turning a module off

To switch off one module on the server, add its id to `adv.disabledModules`: `curl -X POST $APP/api/suite/settings -H 'Content-Type: application/json' -d '{"adv": {"disabledModules": ["hello"]}}'`. A switched-off module answers `403` and its page says it is off. Settings, Advanced also has an **Allow modules** switch (`adv.modulesEnabled`): it makes the Modules page show every module as off, but it is a display setting, the server does not enforce it.

## Test a module

Without starting the app, with the same helpers the project's tests use:

```python
from so101 import modules
mods = modules.discover("modules")                      # a folder with your module in it
m = next(x for x in mods if x.id == "my_module")
assert m.error is None
status, payload = modules.dispatch(m, "GET", "greet", {}, ctx=my_fake_ctx)   # ctx can be any object with the attributes you use
```

Then run the app in demo mode (`uv run so101 start --demo --no-browser --port 8150`), open `http://localhost:8150/suite/#/modules`, and click through your page. `tests/test_modules.py` shows more patterns. Use the `add-module` skill if you work with an AI agent.

## Sharing a module

Open a pull request that adds `modules/<id>/` with a README and, if it has logic, a test. Keep the licence AGPL-3.0-or-later (or compatible) so the project can ship it. The website's `/modules` page lists every `modules/*/module.json` at build time.
