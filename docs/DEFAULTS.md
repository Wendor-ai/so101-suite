# Defaults

Every factory default of the SO-101 Suite, in one file: [`defaults/so101.defaults.json`](../defaults/so101.defaults.json). Nothing in it is specific to one arm, because every arm is calibrated by its owner: there are no calibration numbers in the defaults, and a test fails if one slips in.

## How defaults and your changes combine

The effective value is the factory default with your changes on top. Your changes live in `~/.so101/config.json` (or `$SO101_HOME/config.json`) and are written by the Settings page or `POST /api/suite/settings`. Only the sections listed here are merged. See the effective values any time:

```bash
curl -s http://localhost:8000/api/suite/defaults | python3 -m json.tool     # {"defaults": ..., "effective": ...}
```

**Not every default is read at runtime.** Some are *mirrored*: the classic dashboard keeps its own copy as a constant (it was validated on real hardware), and `tests/test_defaults.py` fails if the two differ. Mirrored values document the behaviour and keep both sides honest; **editing them in `config.json` does not change what the dashboard does.** The tables say which is which. The in-browser mock keeps a copy too, `app/suite/js/mock/defaults.js`; a test checks it is deep-equal to the JSON file. Change the JSON first, then copy.

## `serial`: how the computer talks to the motors

| Key | Default | Meaning | Read at runtime? |
|---|---|---|---|
| `baud` | `1000000` | STS3215 motors ship at 1 Mbit/s; the app sets every motor to it when giving it an ID | Yes, from the factory file |
| `scan_baud_rates` | `1000000, 500000, 250000, 128000, 115200, 76800, 57600, 38400` | Speeds the motor scan tries, in this order, stopping at the first with answers | Yes, from the factory file |
| `motor_ids` | `shoulder_pan 1, shoulder_lift 2, elbow_flex 3, wrist_flex 4, wrist_roll 5, gripper 6` | The SO-101 numbering, base to gripper | Mirrored (`JOINTS` in `app/server.py`) |

## `calibration`: teaching an arm where the middle is

| Key | Default | Meaning |
|---|---|---|
| `mid_ticks` | `2047` | The motor position a calibrated middle pose is shifted to (via the homing offset) |
| `ticks_per_turn` | `4095` | Positions run 0 to 4095 for one full turn (about 0.09 degrees per tick) |
| `min_span_ticks` | `150` | A joint must move at least this far during the sweep (about 13 degrees) before the calibration can be saved |
| `wrist_roll_full_turn` | `true` | Wrist roll is saved as a full turn (0 to 4095) and is exempt from the span check |
| `follower_id`, `leader_id` | `my_follower`, `my_leader` | File names of the saved calibrations. Override with the environment variables `FOLLOWER_ID` and `LEADER_ID` |

All mirrored. Details and the file format: [CALIBRATION.md](CALIBRATION.md).

## `safety`: limits that keep the arm and motors safe

Loads are percent of a motor's maximum torque. The limits are built in and the settings API refuses to change them (`400`).

| Key | Default | Meaning |
|---|---|---|
| `load_limit_pct` | `70` | Autonomous moves and teleop stop and hold when a motor pushes at this load or more for 3 readings in a row |
| `wrist_roll_load_limit_pct` | `85` | The same, for wrist roll, which strains against its own cable |
| `temp_limit_c` | `68` | Stop at this temperature (one reading that jumps by more than 10 degrees is ignored as a glitch) |
| `teleop_hz` | `120` | How often the follower copies the leader |
| `teleop_slew_ticks`, `teleop_slew_sync_ticks` | `20`, `2` | Largest change per step while the follower catches up, and once it is in sync |
| `confirm_before_move` | `true` | **Your choice.** Ask inline before an arm move |
| `speed_preset` | `"gentle"` | **Your choice:** `gentle` or `normal` |

The limits are mirrored constants (`pickplace.py`, `Teleop` in `app/server.py`). `confirm_before_move` and `speed_preset` are stored and used by the web app. See [LEARNINGS.md](LEARNINGS.md) section 2 for why these numbers.

## `cameras`: how cameras are opened

| Key | Default | Meaning |
|---|---|---|
| `width`, `height` | `640`, `480` | The size requested. Pick and place vision and the camera mapping assume 640 x 480 |
| `fps` | `30` | Frames per second requested |
| `fourcc` | `"MJPG"` | Camera format requested |
| `jpeg_quality` | `75` | JPEG quality of the raw pictures the app serves (the annotated ones use 70) |
| `stale_after_s` | `2.5` | No new picture for this long means the app says the camera is lost |

Mirrored in the camera code. The saved camera list is *not* a default: it is `cameras.list` in your `config.json`.

## `server`: where the app listens

| Key | Default | Meaning |
|---|---|---|
| `host` | `"127.0.0.1"` | This computer only (safe: the app has no password). Use `--host 0.0.0.0` to let other devices on your network open it, for example a Raspberry Pi screen |
| `port` | `8000` | The address is `http://localhost:8000`. Use `--port N` for another |

Read at start-up from the factory file; use the command-line options to change them.

## `ui`: look and feel (yours to change)

| Key | Default | Allowed |
|---|---|---|
| `theme` | `"auto"` | `auto`, `dark`, `light` |
| `accent` | `"orange"` | `orange`, `blue`, `green`, `violet`, `pink`, `yellow` |
| `guide` | `"beginner"` | `beginner` (explanations inline) or `expert` |
| `units` | `"deg"` | `deg` (0 at the middle) or `lerobot` (-100 to +100 scale) |
| `textSize` | `"normal"` | `small`, `normal`, `large` |
| `reduceMotion` | `false` | true or false |
| `onboarded` | `false` | Once true, `/` opens the dashboard instead of the welcome page |
| `calibrationPrompted` | `false` | Set once the first-time "please calibrate" offer has been shown |

## `adv`: advanced switches

| Key | Default | Meaning |
|---|---|---|
| `rawLinks` | `false` | Reserved for showing raw API links; no page uses it yet |
| `modulesEnabled` | `true` | The "Allow modules" display switch |
| `logLevel` | `"info"` | `info`, `debug` or `warn`; reserved, no page uses it yet |
| `disabledModules` | `[]` | Module ids that are installed but switched off (enforced by the server) |
| `trace` | `false` | Start recording in the Inspector when the app launches |
| `traceRaw` | `false` | Also record raw packet bytes |
| `traceMax` | `5000` | How many Inspector entries are kept in memory |

## Changing a default

1. Edit `defaults/so101.defaults.json` (keep each section's `_doc`).
2. Copy the same change to `app/suite/js/mock/defaults.js`.
3. If the dashboard mirrors it, change the constant in `app/server.py` or `app/pickplace.py`, and run `SO101_NO_REAL_PORTS=1 uv run pytest -q tests/test_defaults.py` and `node --test "tests/js/*.test.mjs"`.
4. Update this page.
