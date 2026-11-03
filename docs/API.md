# HTTP API

Everything the web app does is a plain web call, so a script or an AI agent can do the same. This page lists every route, with the request and the answer. Examples were run against the demo (`uv run so101 start --demo --no-browser --port 8150`).

## The basics

- **Base address:** the app's own address, `http://localhost:8000` by default (`--port` changes it). The examples use `$APP`: `APP=http://localhost:8150`.
- **JSON in, JSON out.** Send `Content-Type: application/json` with a JSON **object** (at most 1,000,000 bytes). Exceptions: snapshots are JPEG, diagnostics is plain text, streams are `multipart/x-mixed-replace`.
- **Errors** are `{"error": "<a sentence a person can act on>"}` with a 4xx or 5xx status. `400` bad request, `404` not found or nothing connected, `409` refused because it is unsafe right now (a job, teleop or calibration is running), `413` too big, `500` something broke inside (the details go to the server's stderr).
- **No authentication and no CORS headers.** Anyone who can reach the port can use the API, including moving the arm. `so101 start` listens on `127.0.0.1` (this computer only) by default; pass `--host 0.0.0.0` to let other devices open it, on a network you trust. The older `python app/server.py` dashboard still listens on every interface. See [SECURITY.md](../SECURITY.md).
- **Demo mode** answers the same routes with simulated hardware.
- The in-browser mock (`app/suite/js/mock/backend.js`) implements the Suite routes below; keep both in step.
- **MCP:** `so101 mcp` wraps these routes as tools for AI clients (Claude Code, Claude Desktop, Cursor); see [MCP.md](MCP.md).

Two families of routes exist. The **Suite API** (`/api/suite/*`, `/api/m/*`) is new, documented, and consistent. The **legacy dashboard API** (`/api/state`, `/api/calib/*`, `/api/pp/*`, `/api/teleop/*`) is what the validated dashboard uses; it keeps working unchanged.

## Quick recipes

```bash
APP=http://localhost:8150
curl -s $APP/api/suite/checklist | python3 -m json.tool          # what is connected, what is left
curl -s -o table.jpg $APP/api/suite/snapshot/0.jpg                # look at the table (camera 0)
curl -s $APP/api/suite/diagnostics                                # plain text report, safe to paste
curl -s -X POST $APP/api/suite/motors -H 'Content-Type: application/json' \
     -d '{"action":"ping","role":"follower","id":3}'              # read-only: never moves the motor
```

## Suite API

### `GET /api/suite/info`

```json
{"version": "0.1.0", "license": "AGPL-3.0-or-later", "demo": true, "repo": "https://github.com/Wendor-ai/so101-suite",
 "modules": 1, "onboarded": false, "first_calibration_needed": true, "uncalibrated": ["follower", "leader"],
 "trace": {"enabled": false, "raw": false}}
```

`onboarded` decides where `/` lands. `first_calibration_needed` is true while a connected arm has no calibration and the one-time offer has not been shown.

### `GET /api/suite/platform`

`PlatformInfo`: `{os: "macos"|"linux"|"windows", os_version, arch, is_pi, pi_model, python, uv, in_dialout: bool|null, serial_examples: [str], camera_backend, notes: [str]}`. `in_dialout` is `null` on macOS and Windows. The demo reports `null` in the checklist.

### `GET /api/suite/ports`

`{"ports": [PortInfo]}` where `PortInfo = {path, description, vid, pid, serial, manufacturer, likely_servo_board, role, owned_by_app, key, location}`. `key` is the stable identity (USB serial number, else `vid:pid@location`, else the path). `role` is `"follower"`, `"leader"` or `null`. `owned_by_app` means the running app already has a thread on that port. Listing never opens a port.

### `GET /api/suite/cameras`

```json
{"cameras": [{"id": "cam0", "name": "Camera 1", "source": "demo://camera/0", "kind": "usb", "index": 0, "ok": true, "fps": 13.0,
              "err": "", "age": 0.0, "pending": false, "calibrated": false}],
 "detected": [{"source": "demo://camera/2", "kind": "usb", "name": "Demo camera 3", "width": 640, "height": 480, "in_use": false, "err": ""}],
 "restart_needed": false, "origin": "auto"}
```

`cameras` are the configured ones (running first, then saved ones that need a restart: `pending: true`). `detected` are cameras the computer can see that are not added yet (`?refresh=1` forces a fresh probe, which opens devices). `origin` is `"cli"` (started with `--camera`, `--camera-url` or `CAMERA_URL`), `"store"` (saved list) or `"auto"`. `index` is the number to use in the snapshot URL.

### `POST /api/suite/cameras`

`{action: "add"|"remove"|"rename", source?, id?, name?, force?}`.

- `add`: `source` is a detected `source` (a number such as `0`, a device path, or a URL such as `http://192.168.1.20:8000/raw.mjpg`). It is probed first (unless `force: true`); a failure is a `400` with the reason. Names default to the detected name.
- `remove` and `rename` find the camera by `id` (or by `source`). `rename` needs `name`.
- Answer: `{ok: true, cameras: [...], restart_needed: bool}`. Adding or removing needs a restart to take effect (`POST /api/suite/restart`); renaming does not. When the app was started with `--camera`, `--camera-url` or `CAMERA_URL`, add and remove answer `409`.

### `GET /api/suite/snapshot/<i>.jpg`

One JPEG frame of camera `i` (numbered from 0; `i` is `index` in the camera list). `?annotated=1` returns the picture with the vision overlay (bowl rim, keychain marks); the default is the raw frame. Header `X-Camera-Ok: 1` means a real picture. When the camera has no picture the answer is still a JPEG, a grey card that says why, with `X-Camera-Ok: 0` and `X-Camera-Error`. An unknown `i` is a `404` JSON error. Pictures are requested at 640 x 480.

### `GET /api/suite/checklist`

`{"items": [CheckItem], "summary": {"ok": 11, "total": 14, "next": "follower_calibrated"}}`. `CheckItem = {id, group: "computer"|"arms"|"cameras"|"calibration"|"extras", title, status: "ok"|"todo"|"warn"|"fail"|"skip", detail, fix: null | {label, page}}`. `fix.page` is one of `assemble`, `motors`, `calibrate`, `cameras`, `setup`. `total` does not count `skip` items; `next` is the id of the first item that is neither `ok` nor `skip`. The ids, in order: `python`, `uv`, `serial_permission`, `adapter_found`, `arm_roles`, `follower_connected`, `follower_motors`, `follower_calibrated`, `leader_connected`, `leader_motors`, `leader_calibrated`, `camera_found`, `camera_working`, `camera_mapped`, `assembly_done`. The rules are in the docstring of `so101/checklist.py`.

### `GET /api/suite/progress` and `POST /api/suite/progress`

Manual ticks, `{key: bool}`. `POST {"key": "assembly.done", "value": true}` (or a whole object of ticks). Keys are lowercase letters, digits, `.`, `_`, `-`; values must be booleans. Keys the checklist reads: `assembly.done`, `cameras.skipped`. Answer: all ticks.

### `POST /api/suite/onboarded`

`{"value": true|false}` -> `{"onboarded": bool}`. Sets where `/` lands (`true`: `/dashboard`; `false`: `/suite/`).

### `GET/POST /api/suite/identify`

Finds which USB adapter is which arm by unplug and replug. `POST {"action": "start", "role": "follower"|"leader"}` begins; `POST {"action": "cancel"}` stops; `GET` polls. Answer: `{state: "idle"|"unplug"|"replug"|"done"|"error", message, port, role}`. The message is the next instruction for the person. It times out after 60 seconds. Starting with no adapter plugged in gives `state: "error"`.

### `POST /api/suite/role`

`{"port": "<path or key>", "role": "follower"|"leader"}`. Binds an adapter to a role; another adapter holding that role gets the opposite one (a swap). Answer `{ok: true, ports: [...]}`. `409` while a calibration, job, teleop or test runs; `404` if the adapter is not plugged in.

### `POST /api/suite/motors`

`{action: "scan"|"set_id"|"ping"|"wiggle", role?|port?, id?}`. The arm is found by `role` (`follower`/`leader`) or by `port` (path or key).

| action | What it does | Answer |
|---|---|---|
| `scan` | Read-only. Asks IDs on the bus at the usual speeds, 1 Mbit/s first | `{ok, ids: [1..6], baud, port, message}` |
| `ping` | Read-only. Asks one motor where it is. Never moves it | `{ok, id, joint, position, load_pct, temp_c, volt, ms, message}` |
| `wiggle` | A small, slow move of about 10 degrees there and back; ends in the torque state it started in | `{ok, id, joint, moved_deg, peak_load_pct, message}` |
| `set_id` | Writes a new ID (`id`: 1-252, the SO-101 uses 1-6) and sets 1 Mbit/s. **Refused unless exactly one motor answers** | `{ok, changed, old_id, new_id, baud, message}` |

Refusals are `409` with a sentence, for example `"6 motors answer (IDs 1, 2, 3, 4, 5, 6). Plug in only the one motor you want to set, unplug the others, and try again."`. All four are refused during calibration, teleop, a pick and place job, or another test. `404` when no arm is connected; `400` for a missing or bad `id`.

### `GET /api/suite/modules`

`{"modules": [{id, name, description, version, author, license, requires, pages: [{id, title, icon, script}], backend, path: "modules/<id>", error, enabled}]}`. A broken module has `error` set and `enabled: false`. See [MODULES.md](MODULES.md).

### `ANY /api/m/<id>/<path>`

Forwarded to the module's `backend.py`. Errors: `404` unknown module, `503` module has an error, `403` module switched off, `404` module has no backend, `500` the backend raised or returned the wrong shape.

### `GET/POST /api/suite/settings`, `GET /api/suite/defaults`

`GET` returns `{"ui": {...}, "safety": {...}, "adv": {...}}` (defaults plus the user's changes). `POST` merges: `{"ui": {"theme": "dark"}}` or `{"ui.theme": "dark"}`. Only those three groups exist. The value must have the same type as its default. In `safety` only `confirm_before_move` and `speed_preset` can be written; the limits (`load_limit_pct`, `temp_limit_c`, ...) answer `400`. Allowed words: `ui.theme` `auto|dark|light`, `ui.guide` `beginner|expert`, `ui.units` `deg|lerobot`, `ui.textSize` `small|normal|large`, `safety.speed_preset` `gentle|normal`, `adv.logLevel` `info|debug|warn`. Values are stored in `~/.so101/config.json`. `GET /api/suite/defaults` returns `{"defaults": {...}, "effective": {...}}`. Every default is described in [DEFAULTS.md](DEFAULTS.md).

### `GET /api/suite/diagnostics`

`text/plain`: platform, versions, ports, arms, cameras, checklist, modules, Inspector state, data folder. No serial numbers, hosts or IPs; home folders are shown as `~`. This is what "Copy diagnostics" copies.

### `GET/POST /api/suite/trace`, `GET /api/suite/trace/export`

The Inspector. Recording is **off by default**.

- `GET /api/suite/trace?since=<seq>&kinds=bus,http,log,raw&limit=500` -> `{enabled, raw, seq, dropped, items: [...], max}`, newest last. `since` returns only newer items; without it you get the newest `limit` (at most 20,000).
- `POST /api/suite/trace` `{enabled?, raw?, clear?, max?}` turns recording on or off, raw bytes on or off, clears, or resizes (100 to 100,000 entries; default 5,000).
- `GET /api/suite/trace/export?format=json|ndjson|text` downloads the buffer.

Every item has `seq, t` (epoch seconds), `kind`, `ok`, `ms`. Kinds: `bus` `{port, op: "ping"|"read1"|"read2"|"write1"|"write2", id, addr, reg, value, err}`; `raw` `{port, dir: "tx"|"rx", hex}` (only while raw is on); `http` `{method, path, status, size}` (the Inspector's own polling and static files are not recorded); `log` `{level: "info"|"warn"|"error", source, msg}`. Entries hold only motor IDs, register numbers, values, API paths and status codes.

### `POST /api/suite/restart`

Replaces the server process with a fresh copy (`{"ok": true, "restarting": true}`, then the connection drops for a few seconds). Refused with `409` while a job, teleop, calibration or test runs. Motors keep their torque.

### Demo only: `POST /api/demo/connect`, `POST /api/demo/usb`

`404` unless started with `--demo`. `connect` `{port, ids: [1,2,3]}` simulates which motors are plugged into an adapter (`port` is `demo://follower` or `demo://leader`); `usb` `{port, plugged: bool}` simulates unplugging and replugging an adapter. Used by the Motor IDs walk-through.

## Legacy dashboard API

These routes are unchanged from the validated dashboard. **They return `{}` with status 200 even when the action was refused**; the reason is in `GET /api/state` (`pp.status`, `arms[].calib.error`, `arms[].notice`). Always read the state after a call.

### `GET /api/health`

`{ok: true, t, arms, job: bool, teleop: bool}`. What the supervisor polls.

### `GET /api/state`

Refreshed by the UI every 500 ms. Top-level keys: `camera, camera_age, camera_err, camera_fps, camera_src` (camera 1), `cameras` (`[{ok, age, fps, err, src}]`), `viz`, `pp`, `teleop`, `arms`.

- `arms[]`: `{port, role, role_confirmed, online, calibrated, has_default, cal, notice, volt, wiggling, err, calib, faults, joints}`. `cal` is `{joint: [range_min, range_max]}` or `null`. `joints` is `[{id, name, pos, load, temp}]` with `name` in `shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper`; `pos` is the raw 0-4095 position, `load` is signed in 0.1% of maximum torque (700 = 70%), `temp` is degrees C. `calib` is `{step: "idle"|"center"|"sweep"|"done", role, id, ranges, saved, error}`.
- `pp` (pick and place): `limp, running, mode, taught, fit_mm, cam_cal, cams, ready, why, why_bowl, status, log, zones, kc_mm, bowl_mm, tilt, params, ...`.
- `teleop`: `{on, msg, hz, blocked, synced, why, both}`.

### `POST /api/calib/<armIndex>/<action>`

`armIndex` is the position of the arm in `GET /api/state` `arms` (0-based; look the role up there, the order can change). Actions: `start` (arm goes limp, limits reset), `center` (record the current pose as the centre: hold the arm in the centred pose first), `finish` (save; refused with `arms[i].calib.error` while a joint other than wrist roll has moved less than 150 ticks), `cancel`, `restore` (write the `.default` calibration back to the motors), `set_default`. The state machine is `idle -> center -> sweep -> done`. See [CALIBRATION.md](CALIBRATION.md).

### `POST /api/pp/<action>` (pick and place and camera mapping)

All take a JSON body and return `{}`. Read `pp.status` after.

| action | Body | Meaning |
|---|---|---|
| `release` | | Arm limp (torque off). **It drops unless held** |
| `stop` | | Cancel a job and teleop; the arm holds position |
| `reset` | | Cancel everything, hold, clear every stuck flag |
| `teach` | `{u, v}` | Camera mapping: the arm must be limp. Records the gripper tip's table position against pixel `(u, v)` of camera 1 (640 x 480). Needs a calibrated, connected follower and a tip that moved at least 15 mm since the last spot |
| `undo`, `clear` | | Remove the last taught spot, or all of them |
| `auto` | `{on: bool}` | Hands-free mapping: saves a spot when the arm is held still on the keychain |
| `zone` | `{name: "tray" or "bowl", u, v}` | Set a zone by pixel |
| `run` | `{mode: "hover", "bowl", "goal" or "loop", cycles}` | Start pick and place (refused with a reason in `pp.status`/`pp.why` unless ready) |
| `goto`, `probe` | `{x, y, z}` / `{x, y}` in mm | Move the tip, or touch the table |
| `grip` | `{pct}` | Gripper 0 (closed) to 100 (open) |
| `param` | `{k, v}` | Tuning value |
| `vertical`, `align`, `autocal` | | Tilt trim and model alignment (see [LEARNINGS.md](LEARNINGS.md) sections 9, 12, 15) |

### Other legacy routes

`POST /api/teleop/start` and `POST /api/teleop/stop` (leader drives follower; needs both arms calibrated), `POST /api/wiggle/<armIndex>`, `POST /api/nudge/<armIndex>/<name>`, `POST /api/viz`, `POST /api/role/<armIndex>` `{role}`. Streams: `GET /stream/<i>.mjpg` (with overlay) and `GET /raw/<i>.mjpg` (raw), plus the older `/stream.mjpg`, `/raw.mjpg`, `/stream2.mjpg`, `/raw2.mjpg`. A Raspberry Pi serving cameras for another computer uses `/raw.mjpg` and `/raw2.mjpg`.

## Static paths

`/` (redirect), `/dashboard` (classic UI), `/suite/` (the web app), `/suite/vendor/*`, `/suite/assets/*`, `/suite/modules/<id>/<file>`.
