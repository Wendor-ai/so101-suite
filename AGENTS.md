# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor and others) working in this repository. Humans: see [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

SO-101 Suite is a free, open-source (AGPL-3.0-or-later), beginner-friendly software suite for the SO-101 robot arm. Someone clones it, runs one command, and a web app walks them from an unopened box to a calibrated, working arm, explaining each part and step. It must feel like finished software, not a pile of scripts. The person using it may never have coded: every screen says the next step in plain words.

Stack: Python 3.10-3.13 (stdlib HTTP server, `scservo_sdk` for the Feetech STS3215 motors, OpenCV, NumPy, pySerial) and a plain HTML/CSS/ES-module web app. **No build step, no npm, no CDN for the app.** The website in `site/` is the only place with Node tooling.

## Commands

Run everything from the repo root. `uv` is the only tool you need to install.

```bash
./setup.sh                                  # macOS/Linux/Pi: install + detect + open the app (.\setup.ps1 on Windows)
uv sync --extra dev                         # development environment (adds pytest)
uv run so101 start                          # the app on http://localhost:8000 (never use 8000 yourself, see rules)
uv run so101 start --demo --no-browser --port 8150    # simulated arms and cameras: what agents should run
uv run so101 demo --no-browser --port 8150            # same thing
uv run so101 doctor [--json] [--demo] [--port N]      # the checklist as text/JSON; reads a running app, never opens a port
uv run so101 detect [--demo] [--no-cameras]           # what this computer can see (OS, adapters, cameras)
uv run so101 env [--shell]                          # which .env files were found and which names they set (never values); --shell prints export lines for scripts/
uv run so101 mcp [--url http://127.0.0.1:8150] [--allow-motion]   # MCP server (stdio) for AI clients; talks to the running app; read-only unless --allow-motion
SO101_NO_REAL_PORTS=1 uv run pytest -q                # Python tests (about 240 tests)
node --test "tests/js/*.test.mjs"                     # tests of the in-browser mock backend (quote the glob: a bare directory fails on Node 22)
cd site && pnpm install && pnpm build && pnpm check   # website (Node 22.12+); `pnpm check` finds broken links and missing alt text
```

There is no linter or formatter configured; do not add one in passing. The checks are the tests, `pnpm check`, and clicking through the demo.

## Repo map

| Path | What it is |
|---|---|
| `so101/` | Pure-Python package. `cli.py` (the `so101` command), `mcp.py` (the MCP server, see `docs/MCP.md`), `suite_api.py` (all `/api/suite/*`, `/suite/*`, `/api/m/*` routes), `checklist.py` (what is connected / what is left), `ports.py`, `cameras.py`, `platform_info.py`, `roles.py`, `store.py`, `defaults.py`, `modules.py`, `demo.py` (fake motor bus and cameras), `trace.py` (Inspector data), `registers.py` |
| `app/server.py` | The classic dashboard server: `Arm` threads own the serial ports, `Camera` threads, calibration state machine, teleop, and the legacy `/api/state`, `/api/calib/*`, `/api/pp/*` routes |
| `app/pickplace.py`, `vision.py`, `kin.py` | Pick and place engine and guards, keychain and bowl detection, kinematics from the official URDF |
| `app/suite/` | The web app. `index.html`, `css/`, `js/main.js`, `js/pages/<id>.js`, `js/content/*.js` (Learn, glossary, assembly, troubleshooting), `js/mock/*` (in-browser fake backend), `js/README.md` (the page contract) |
| `app/index.html` | The classic dashboard UI, served at `/dashboard`; embedded by the Control page |
| `app/vendor/`, `app/assets/` | three.js (vendored, works offline) and the SO-101 URDF and STL meshes |
| `modules/<id>/` | Drop-in modules: `module.json`, optional `backend.py`, optional `ui.js`. Start from `modules/hello` |
| `defaults/so101.defaults.json` | Factory defaults. User changes live in `~/.so101/config.json` |
| `tests/` | `test_*.py` (pytest), `js/mock.test.mjs` (node:test), `checklist_cases.json` (shared by both) |
| `site/` | Astro website and the no-install demo; copies `app/suite` into itself at build time |
| `scripts/` | LeRobot workflow scripts (`01`-`08`), `supervise.sh`, Raspberry Pi kiosk helper, calibration installer |
| `docs/` | `ARCHITECTURE`, `API`, `MCP`, `MODULES`, `TROUBLESHOOTING`, `HARDWARE`, `DEFAULTS`, `CALIBRATION`, `FAQ`, `ROADMAP`, `LEARNINGS`; `docs/design/` (IA, physical instructions) and `docs/superpowers/` are design records |
| `.claude/skills/`, `.cursor/rules/`, `examples/mcp/` | Agent skills, Cursor rules, example MCP client configs |

## HARD RULES

These come from real failures on real hardware (`docs/LEARNINGS.md`). Do not relax them.

1. **Never open a real serial port from a test or while developing.** Tests run with `SO101_NO_REAL_PORTS=1` (enforced in `app/server.py`: arms refuse to connect and port scanning returns nothing). Use demo mode (`--demo`) for anything that needs arms. Demo installs a fake `scservo_sdk` before the real one is imported and sandboxes `HOME`. Never run `so101 start`, `so101 setup` or `scripts/*.sh` against a real arm unless the owner asked you to.
2. **Never start a server on port 8000.** The owner's live dashboard may be running there. Use a free high port (for example 8150), pass `--no-browser`, and stop what you start.
3. **One owner per serial port.** The `Arm` thread owns its port. New code must never open a port that `owned_by_app` is true for. Writing a motor ID is refused unless exactly one motor answers on that bus.
4. **The arm moves only when the person asked**, after a plain sentence saying what will move, confirmed inline (`askYes`). Nothing moves on page load, on a timer, or from a "test".
5. **Gripper perpendicular.** A thin object can only be pinched with both finger tips at table level; a 10 degree tilt lifts one jaw about 1 cm. The IK is strict (3 mm, 3 degrees) or reports "out of reach".
6. **Never carry on after a failed grasp.** "Holding" means finger gap (>= 150 ticks beyond closed-on-nothing), not load. Verify after closing, after lifting, during every carry, and before release. Never "continue" silently.
7. **Never stuck.** Every state needs a way out: job watchdog, an always-available Reset, a bus lock with a timeout, a supervisor. Do not add a wait that can last forever or a state with all buttons disabled.
8. **The bowl is an obstacle** (3 in = 76 mm tall): keep-out from its fitted rim, lift to rim + 5 cm near it, travel at >= rim + 2 cm. The same rule protects teleoperation.
9. **Load and temperature guard on every autonomous move:** stop and hold at >= 70% torque (wrist roll 85%) for 3 reads in a row, or at the temperature limit. Ignore temperature jumps > 10 degrees C unless repeated 3 times.
10. **Zero is the middle of the calibrated range** (`(raw - (min + max) / 2) * 360 / 4095`), never "the centred pose". Sanity-check forward kinematics on a live pose.
11. **No browser pop-ups** (`alert`, `confirm`, `prompt`): use `askYes` and `toast`. **Every disabled button says why** next to it. **Nothing fails silently:** a black camera box is a bug, show the reason. Never rebuild the DOM on every 500 ms tick.
12. **Physical instructions are numbered, one action each, only name buttons that exist, with a visible check and an "if not".** See `.claude/skills/write-physical-instructions/SKILL.md`.
13. **Tests before hardware.** Test algorithms offline on recorded data or in demo mode first.
14. **Never use the Mac microphone** or any other sensor the task did not ask for. Voice features belong on a Raspberry Pi.
15. **Secrets live in `.env` only** (git-ignored). Never commit keys, tokens, serial numbers, IPs, usernames, photos, `calibration/*.json` or anything from `~/.so101/`. The code redacts serial numbers and home folders in diagnostics: keep it that way.
16. **Stay inside your lane:** do not change `app/pickplace.py` behaviour validated on hardware without a test and a reason. Camera changes apply by restarting the app (`os.execv`), not hot-plugging.
17. **Never move to a guess.** If the two cameras disagree by more than 30 mm (`CAM_AGREE`), or a camera has moved more than 12 mm on the table (`CAM_MOVED_MM`), refuse and say why (`cam_problem()` in `app/pickplace.py`).
18. **Never close the gripper on top of the item.** If a descent stops more than 4 mm above the table, the fingertips are resting on the keychain: go up and retry along its axis.
19. **Hot, silent and ignored motors stay off.** Teleop refuses to start while a follower motor is near the temperature limit (`HOT_C`) or the wrist rolls are far apart (`ROLL_GAP_DEG`); a motor the person chose to ignore (`IGNORED` in `app/server.py`) is left limp and never driven. Problems are data (`Arm.problems()`), shown as callouts on the 3D arm.

## How to extend it (use the skills)

| Job | Skill | Main files |
|---|---|---|
| Add a module | `.claude/skills/add-module` | `modules/<id>/module.json`, `backend.py`, `ui.js` |
| Add a page | `.claude/skills/add-page` | `app/suite/js/pages/<id>.js`, `router.js` (`FILES`), `shell.js` (`NAV`), `css/pages/<id>.css` |
| Add or fix a camera | `.claude/skills/add-camera` | `so101/cameras.py`, `so101/suite_api.py`, `app/suite/js/pages/cameras.js` |
| Teach the camera where the table is | `.claude/skills/calibrate-camera-by-clicking` | snapshot URL + `/api/pp/teach` |
| Calibrate an arm | `.claude/skills/calibrate-arm` | `/api/calib/<i>/*` |
| Something is wrong with hardware | `.claude/skills/debug-hardware` | Test motors, Inspector, `so101 doctor` |
| Write beginner-friendly copy | `.claude/skills/explain-for-beginners` | `app/suite/js/content/*.js` |
| Run the demo and tests | `.claude/skills/run-demo-and-tests` | |
| Tell a person to touch hardware | `.claude/skills/write-physical-instructions` | `app/suite/js/steps.js` |
| Add a Learn article | `.claude/skills/add-learn-article` | `app/suite/js/content/learn.js`, `glossary.js` |

The UI contract (12 rules, helpers, `ctx`) is `app/suite/js/README.md`. Terminology: **Leader arm / Follower arm** (never master/slave), **Motor ID**, **Joint**, **Jaw**, **Calibrate**, **Camera mapping**, **Module**, **Demo mode**, **Wiggle**, **Ping**, **Bus**, **Inspector** (`docs/design/information-architecture.md` section 7). Voice: second person, present tense, short; verbs first.

## The API at a glance

JSON over HTTP on the app's port. No authentication. Errors are `{"error": "<a sentence>"}` with a 4xx/5xx status. Full reference: [docs/API.md](docs/API.md). The same calls are available to MCP clients through `so101 mcp` ([docs/MCP.md](docs/MCP.md)): it can look at cameras, read status, the checklist and the Inspector, and record calibration clicks; motion tools (a motor wiggle, calibration steps, and `so101_rest_arm`, which lowers the arm and then makes it limp) exist only with `--allow-motion`, and it can never start pick and place, write motor IDs or switch torque off on a raised arm.

| Call | Use |
|---|---|
| `GET /api/suite/checklist` | `{items, summary:{ok,total,next}}`: what is connected and what is left |
| `GET /api/suite/info`, `/platform`, `/ports`, `/cameras`, `/modules`, `/diagnostics` | what the app sees (diagnostics is plain text, safe to paste) |
| `GET /api/suite/snapshot/<i>.jpg` | one JPEG frame from camera i (look at the table) |
| `POST /api/suite/motors` `{action:"scan"\|"ping"\|"wiggle"\|"set_id", role\|port, id}` | motor tools; refused with 409 and a sentence when unsafe |
| `GET/POST /api/suite/settings`, `GET /api/suite/defaults` | whitelisted settings, factory defaults |
| `GET/POST /api/suite/trace` | Inspector buffer (off by default) |
| `GET /api/state` | live arms, joints, calibration step, pick and place state |
| `POST /api/calib/<armIndex>/<start\|center\|finish\|cancel>` | calibration state machine |
| `POST /api/pp/<release\|teach\|clear\|stop\|reset\|...>` | pick and place engine; always returns `{}`, read errors from `/api/state` `pp.status` |
| `ANY /api/m/<id>/<path>` | a module's backend |

## Detection, per OS

- **Serial ports** (`so101/ports.py`, `app/server.py` `scan_arms`): macOS `/dev/tty.usbmodem*` and `/dev/tty.wchusbserial*` (`/dev/cu.*` is mapped to `tty`; Bluetooth and debug ports are dropped); Linux `/dev/ttyACM*` and `/dev/ttyUSB*`; Windows `COM*`. A port is a *likely servo board* by USB vendor id (WCH 1a86, Silicon Labs 10c4, FTDI 0403). Each adapter has a stable `key` (USB serial number, else `vid:pid@location`, else the path); roles (follower/leader) are stored by key, not path.
- **Cameras** (`so101/cameras.py`): Linux `/dev/v4l/by-path/*-usb-*-video-index0` (fallback `/dev/video*` USB nodes), never `/dev/videoN` as an identity; macOS AVFoundation indices 0-4 with names from `system_profiler`; Windows DirectShow indices 0-4; network cameras are `http(s)` MJPEG or JPEG URLs. Detection opens devices, so results are cached 30 s and sources the app already uses are never reopened.
- **Platform** (`so101/platform_info.py`): Raspberry Pi from `/proc/device-tree/model`; Linux serial permission is membership of `dialout` or `uucp`; macOS and Windows report `null`.

## Where state lives

| What | Where |
|---|---|
| Settings, camera list, progress ticks | `~/.so101/config.json` (override the folder with `SO101_HOME`) |
| Legacy dashboard state | `~/.so101_roles.json`, `~/.so101_viz.json`, `~/.so101_pickplace.json` (camera mapping, zones, tuning), `~/.so101_lastrun.log` |
| Arm calibration (LeRobot-compatible) | `~/.cache/huggingface/lerobot/calibration/robots/so_follower/my_follower.json` and `.../teleoperators/so_leader/my_leader.json`, plus a `.default.json` restore point each. Root override: `HF_LEROBOT_CALIBRATION`; ids: `FOLLOWER_ID`, `LEADER_ID` |
| Demo mode | A private sandbox `HOME` under `<data dir>/demo/home`; nothing real is touched |
| Your own backups | `calibration/` (git-ignored) |
| Machine-specific settings (ports, camera addresses, names) | `.env` (git-ignored; template `.env.example`; reader `so101/envfile.py`; not read in demo mode or tests) |

Other environment variables: `SO101_NO_REAL_PORTS`, `SO101_DEMO=1`, `CAMERA_URL`, `CAMERA_INDEX`, `CAMERA2`, `SO101_REMOTE`.

## Demo mode and the in-browser mock: keep both in step

- **Server demo** (`so101/demo.py`, `--demo`): the real server with a simulated STS3215 bus, two arms and three synthetic cameras. Used by tests and by you.
- **Browser mock** (`app/suite/js/mock/*`, `?demo=1`): the same Suite API implemented in JavaScript, so the website demo needs no backend. It is also the fallback when no backend answers.
- When you change an API response, the checklist rules or a default, change **both** and the shared fixtures. `tests/checklist_cases.json` is read by `tests/test_checklist.py` and by `tests/js/mock.test.mjs`, which also runs the Python `build()` and compares. `defaults/so101.defaults.json` is mirrored in `app/suite/js/mock/defaults.js`.
- Mock query flags: `?demo=1`, `?scenario=fresh|ready|nothing`, `?seed=7`, `?os=linux|windows`.

## Definition of done

- [ ] `SO101_NO_REAL_PORTS=1 uv run pytest -q` and `node --test "tests/js/*.test.mjs"` are green; `pnpm build && pnpm check` if you touched `site/` or anything it copies.
- [ ] You ran the demo and **clicked through** the change at 1280 px and 360 px, dark and light, with no console errors (use the browser tools, not just reading the code).
- [ ] Every button you named in text exists with that exact label; every disabled button says why.
- [ ] Docs updated (`docs/*.md`, `app/suite/js/README.md`, the skill) and both backends (server and mock) agree.
- [ ] No personal data: no usernames, home paths, IPs, serial numbers, keys, photos.
- [ ] You said what you could not test (real hardware, Windows).

## Commit style

Small commits, each one thing. Subject line: a short imperative sentence (about 70 characters) saying what changed; body: why, and what was verified. No ticket prefixes needed. Never commit `.env`, `calibration/*.json`, `~/.so101` data, `.venv`, `site/node_modules`, `site/dist`.

## Arm state and people (a standing rule from real failures)

- **Never ask a person to touch, hold, place or move anything near the arm while it is stiff** (torque on, holding, moving, or able to move). A stiff arm hurts, pinches and moves when software says so.
- **Make it limp first, lowered.** Use `Release arm` in the dashboard (`POST /api/pp/rest`): it lowers the arm onto the table and only then lets go, so nothing drops and nobody has to hold it. Bare `POST /api/pp/release` or starting a calibration turns torque off at once and can drop a raised arm: do not use them to prepare a person's step.
- Check the real state (`pp.limp` in `/api/state`) before giving the instruction, say the state in the first line ("the arm is limp now"), and tell the person "hands off" before the motors switch on again.
- Never write "hold the gripper with one hand" in a card, button or confirmation. Asking people to keep clear, or to press a button on screen, is fine. Moving a **limp** arm by hand is fine.
- Never move to a guess: if two cameras disagree by more than 30 mm, or a camera has moved, refuse and say why. Arm motion needs the person's go-ahead (hands clear) unless they have said to go ahead.
