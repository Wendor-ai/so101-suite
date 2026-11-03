---
name: debug-hardware
description: Debug an SO-101 arm or camera that does not work, in a fixed order - Test motors, then the Inspector, then so101 doctor. Use when asked "the arm does not move", "a motor does not answer", "motor not found", "debug the hardware", "why is the camera black", "what is wrong with my setup", "troubleshoot", or when a user pastes an error.
---

# Debug hardware

People find invisible hardware scary. Three tools make it visible. **Always in this order:** Test motors, Inspector, `so101 doctor`. Cheap and read-only first; anything that moves a motor only when the person asks.

**Never open a serial port yourself** (no `screen`, no `python -c` with `scservo_sdk`, no `scripts/*.sh`): the running app's `Arm` thread owns the port, and a second opener breaks both. Work through the app's API, or `so101 doctor`, which reads the running app and never opens a port. Never run tests against real ports (`SO101_NO_REAL_PORTS=1`).

## 1. Test motors (`#/test`, or the API)

Ask the app, motor by motor. `$APP` is the running app's address; practise on a demo server (`uv run so101 start --demo --no-browser --port 8150`, never 8000).

```bash
curl -s -X POST $APP/api/suite/motors -H 'Content-Type: application/json' -d '{"action":"scan","role":"follower"}'
curl -s -X POST $APP/api/suite/motors -H 'Content-Type: application/json' -d '{"action":"ping","role":"follower","id":3}'
```

- `scan` (read-only): which IDs answer, at what speed. Expect `[1,2,3,4,5,6]`. Missing IDs mean the cable before the first missing motor, or a duplicate ID.
- `ping` (read-only, never moves): `position`, `load_pct`, `temp_c`, `volt`, `ms` for one motor.
- `wiggle` (about 10 degrees there and back, ends in the torque state it started in) **only when the person asks**, after telling them to hold the arm or rest it on the table: `{"action":"wiggle","role":"follower","id":6}`. It is refused (409) during calibration, teleop, pick and place, or another test. The result says "moved N degrees. It works." or "did not move".
- `set_id` only with exactly one motor plugged in (otherwise refused with the count).

In the UI: **Check all motors** pings every ID, then wiggles each in turn and gives a report per motor.

## 2. Inspector (`#/inspector`, or the trace API)

Off by default; it records in memory only.

```bash
curl -s -X POST $APP/api/suite/trace -H 'Content-Type: application/json' -d '{"enabled": true, "clear": true}'
# reproduce the problem (ask the person, or repeat the failing call), then:
curl -s "$APP/api/suite/trace?kinds=bus,log&limit=200" | python3 -m json.tool | head -80
curl -s "$APP/api/suite/trace/export?format=text" | grep -i "FAIL\|ERR" | head
curl -s -X POST $APP/api/suite/trace -H 'Content-Type: application/json' -d '{"enabled": false, "clear": true}'
```

Read `bus` items (`op`, `id`, `reg`, `value`, `ok`, `err`: "no answer (timeout)", "corrupt reply", "motor fault: overload"), `http` items (an API call that returned 4xx/5xx) and `log` items. Register meanings: `so101/registers.py`. **Turn recording off and clear it when done.** In the UI use **Copy as issue report**.

## 3. `so101 doctor`

```bash
uv run so101 doctor                 # reads the app on port 8000
uv run so101 doctor --port 8150     # another port
uv run so101 doctor --json          # for you to parse
```

The checklist as text: Python, uv, serial permission, adapter found, roles named, each arm connected / motors answer (IDs 1-6) / calibrated, camera found / picture / mapped, assembled, plus the **next** thing to do. With the app stopped it only lists plugged-in adapters (`--probe` also opens cameras: only with the app stopped). `GET $APP/api/suite/diagnostics` is the plain-text report that is safe to paste (no serial numbers, no IPs).

## With the MCP tools

If the `so101` MCP server is connected (`docs/MCP.md`), the same three steps are tools: `so101_status` first, `so101_ping_motor` (read-only) and `so101_wiggle_motor` (only with `--allow-motion`, and only when the person asks), `so101_trace` (never turns recording on: ask the person to switch it on in the Inspector), `so101_checklist` and `so101_diagnostics`.

## Then

1. Map the symptom to `docs/TROUBLESHOOTING.md` (and the illustrated entries in `app/suite/js/content/troubleshooting.js`). Typical causes in order: power supply not plugged in; USB cable is charge-only; a 3-pin cable not clicked in; Waveshare jumpers not on **B**; two motors with the same ID; Linux user not in `dialout`; another program holds the port; macOS camera permission; camera in use.
2. Give the person **one action at a time** with a visible check and an "if not" (`write-physical-instructions`). Never ask them to hold a pose while you think.
3. If it is a new symptom, add it to `app/suite/js/content/troubleshooting.js` (`id`, `symptom`, `tags`, `causes: [{test, fix}]`, one action each) and to `docs/TROUBLESHOOTING.md`.
4. Report what you saw: the doctor output, the failing `ping`/`scan` results, and what you could not test. Do not paste photos with serial numbers or network addresses.

## Safety reminders

- Hot or buzzing motor: press **STOP** (it holds; Release makes the arm limp and it drops). The guard stops autonomous moves at 70% load (85% wrist roll) for 3 reads, or at 68 degrees C.
- Closing or restarting the app does not release the motors: a stiff arm is normal until someone presses Release (hold the arm first).
