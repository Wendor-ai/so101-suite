# Architecture

How SO-101 Suite is built, in one read. The short version: one small Python process talks to the motors and cameras and serves a plain web app; the same web app can also run in a browser with a fake backend, which is how the website demo works.

## The big picture

```
 browser (app/suite, plain ES modules)            website demo (site/)
        |  fetch JSON every 500 ms                      |  same files, js/mock/* answers instead
        v                                               v
 +----------------------------------------------------------------+
 |  app/server.py  (stdlib ThreadingHTTPServer, one process)      |
 |    H.do_GET / do_POST -> so101.suite_api.handle()  (new routes)|
 |                       -> legacy routes (/api/state, /api/pp/*) |
 |  threads:  Arm x N (one per serial port, 10 Hz poll)           |
 |            Camera x N     Teleop (120 Hz)    scan_arms         |
 |            PickPlace jobs + watchdog                           |
 +------+---------------------------+-----------------+-----------+
        | scservo_sdk                | OpenCV          | modules/<id>/backend.py
        v                            v                 v
   STS3215 motors on a USB      USB or network     your code, in-process
   serial adapter (real or      cameras (real or
   simulated by so101.demo)     synthetic)
```

## Layers

**`so101/`: pure Python logic, importable and unit-tested.** It never imports `app/server.py` at import time (`cli.load_server()` does it on demand). Each file has one job:

| File | Job |
|---|---|
| `paths.py` | Where the repo, `app/`, `modules/`, defaults and the user's data folder (`~/.so101`, or `SO101_HOME`) are |
| `store.py` | JSON config with dotted keys (`ui.theme`). Writes are atomic; a corrupt file is moved to `config.json.bad`, never fatal |
| `defaults.py` | `defaults/so101.defaults.json` plus the user's changes; `get("safety.load_limit_pct")` |
| `platform_info.py` | `detect()`: OS, Raspberry Pi model, Python, uv, serial-group membership. Everything that touches the machine is injectable so Linux, Windows and Pi are tested on a Mac |
| `ports.py` | `list_ports()`: serial ports per OS, "likely servo board", a stable `key` per adapter |
| `roles.py` | Which adapter is the follower and which the leader, stored by `key` |
| `cameras.py` | `list_cameras()`, `probe_source()`, `probe_url()`: find cameras and say in a sentence why one does not work |
| `checklist.py` | `build(snapshot)`: a pure function from plain JSON to the "what's connected / what's left" items |
| `modules.py` | Discover `modules/*/module.json`, load backends safely, dispatch `/api/m/<id>/...` |
| `demo.py` | The fake motor bus, fake `scservo_sdk`, simulated adapters and synthetic cameras |
| `trace.py`, `registers.py` | The Inspector's in-memory buffer; the STS3215 register map in plain words |
| `suite_api.py` | Every `/api/suite/*`, `/api/demo/*`, `/api/m/*`, `/suite/*`, `/stream/<i>.mjpg` route |
| `cli.py` | the `so101` command: `start`, `setup`, `doctor`, `detect`, `demo`, `mcp`, `version` |
| `mcp.py` | The MCP server (`so101 mcp`, stdio) for AI clients. It only talks to the running app over HTTP and never opens a serial port; see [MCP.md](MCP.md) |

**`app/server.py`: the classic dashboard server.** It owns the hardware: an `Arm` thread per serial port (reads every motor's position in one packet each cycle, and status, load and temperature about 10 times a second), a `Camera` thread per camera, the calibration state machine, leader-to-follower teleoperation (`Teleop`, 120 Hz by default), and the pick and place engine from `app/pickplace.py`. Its legacy routes (`/api/state`, `/api/calib/*`, `/api/pp/*`, `/api/teleop/*`) are unchanged so the validated dashboard keeps working. `setup(argv)` binds the HTTP port **first**, so if the port is taken nothing else starts and no serial port is opened twice.

**`app/suite/`: the web app.** Plain HTML, CSS and ES modules; no build step, no npm, no CDN (three.js is vendored, so it works offline). Hash routes (`#/calibrate`) so it is a static bundle. `js/main.js` decides live backend or mock, `js/state.js` runs one polling loop that every page subscribes to, `js/router.js` lazy-loads `js/pages/<id>.js`. The page contract is `app/suite/js/README.md`.

**`app/suite/js/mock/`: the in-browser backend.** It implements the same Suite API in JavaScript (a simulated arm, checklist, trace, settings). The page falls back to it when no backend answers, or when `?demo=1` is set. The website's `/demo` is the real app plus this mock, so what visitors try is what ships.

**`site/`: the website** (Astro, static). At build time it copies `app/suite`, `app/vendor` and `app/assets` into `public/app`, and reads Learn, glossary and `docs/*.md` from this repo.

## One request, end to end

`H.do_GET` (and POST, PUT, DELETE, HEAD) first calls `suite_api.handle(...)`. It returns `True` when it owns the path (`/`, `/dashboard`, `/suite/*`, `/api/suite/*`, `/api/demo/*`, `/api/m/*`, `/stream/<i>.mjpg`, `/raw/<i>.mjpg`) and `False` otherwise, and then the legacy routes run. Responses are JSON; a refusal is `{"error": "<a sentence a beginner can act on>"}`; an unexpected exception becomes a 500 with a sentence, and the traceback goes to stderr, never to the user.

Static paths: `/` redirects to `/suite/` until `ui.onboarded` is true, then to `/dashboard`. `/suite/*` serves `app/suite/*`; `/suite/vendor/*` serves `app/vendor/*`; `/suite/assets/*` serves `app/assets/*`; `/suite/modules/<id>/<file>` serves a module's own `.js .css .json .svg .png` files. Paths with `..` or a leading dot are refused.

## From hardware to checklist

`suite_api.build_snapshot()` collects a plain-JSON snapshot (platform, ports, one entry per role, cameras, progress ticks). `checklist.build(snapshot)` turns it into items with a status (`ok`, `todo`, `warn`, `fail`, `skip`), a sentence and a fix `{label, page}`. The same function is ported to `app/suite/js/mock/checklist.js`; `tests/checklist_cases.json` holds the cases both implementations must pass. `so101 doctor` and the Setup page both show this list.

## Serial ports: one owner at a time

A serial port can have one owner. The `Arm` thread owns its port and holds a lock (`TLock`, 3 s timeout: a stuck transfer becomes an error, not a frozen app). Anything that needs the bus (motor scan, set ID, ping, wiggle) goes through the `Arm` and is **refused with a sentence** while a calibration, teleop, pick and place job or another test is running. `PortInfo.owned_by_app` tells the rest of the code a port is taken. Motor IDs are only written when exactly one motor answers.

## Demo mode

`so101.demo.install()` is called **before** `scservo_sdk` is imported. It puts a fake `scservo_sdk` into `sys.modules` that talks to an in-memory bus of STS3215 motors, makes `ports.list_ports()` and `cameras.list_cameras()` return only simulated devices (`demo://follower`, `demo://leader`, `demo://camera/N`), and points `HOME` and `SO101_HOME` at a private sandbox so nothing it writes can touch real files. Torque-off motors are moved by a simulated "hand", so calibration and leader-to-follower can be shown. It cannot open a real device. `app/server.py` also refuses real ports when `SO101_NO_REAL_PORTS` is set, which is how tests are kept safe.

## Modules

A folder in `modules/` with a `module.json` (and optionally `backend.py` and `ui.js`). The backend is loaded into the server process on first use and called as `handle(method, path, body, ctx)`; a module that fails to load is listed with its error and never stops the app. See [MODULES.md](MODULES.md).

## State on disk

`~/.so101/config.json` (settings, camera list, progress), the legacy `~/.so101_*.json` files, and the LeRobot-compatible calibration files under `~/.cache/huggingface/lerobot/calibration/`. Details in [AGENTS.md](../AGENTS.md#where-state-lives) and [CALIBRATION.md](CALIBRATION.md). Nothing leaves the machine: no accounts, no telemetry.

## Restarting

Camera changes apply by restarting, not by hot-plugging. `POST /api/suite/restart` replaces the process with `os.execv` using the exact command line that started it. It is refused while a job, teleop or calibration runs. The motors **keep their torque** across a restart and the new process reads the real torque state on start, so the arm does not drop. The UI waits and reconnects.

## The Inspector

`so101/trace.py` wraps the SDK's packet handler and records decoded bus operations, API calls and log lines into bounded in-memory rings (default 5,000 events plus a second ring for healthy repeating polls, so a 10 Hz poll cannot flush the interesting events). It is **off by default**; while off, each call costs one boolean check. Entries hold only motor IDs, register numbers, values, API paths and status codes, with the home folder shown as `~`. Nothing is written to disk.

## Decisions worth knowing

- **Stdlib HTTP server, no framework:** works on a Raspberry Pi with nothing to install, and the legacy dashboard already used it.
- **No build step for the app:** a beginner (or an AI agent) can read and change any file and reload.
- **`uv`:** installs Python itself, is fast, and is the same command on every OS. The core install has no PyTorch; LeRobot is an optional extra.
- **AGPL-3.0-or-later:** forks are free but stay open, including when run as a hosted service.
- **Legacy and new live side by side:** new logic in `so101/` with unit tests, small hooks in `app/server.py`, so the pick and place behaviour validated on real hardware is not disturbed.

See also: [API.md](API.md), [DEFAULTS.md](DEFAULTS.md), [LEARNINGS.md](LEARNINGS.md).
