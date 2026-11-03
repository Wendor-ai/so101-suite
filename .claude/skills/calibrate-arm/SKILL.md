---
name: calibrate-arm
description: Calibrate an SO-101 arm (follower or leader) so every joint reads 0 at the middle of its range, in the app or through the /api/calib API; also set or restore the default calibration. Use when asked to "calibrate the arm", "calibrate the follower/leader", "set the zero", "recalibrate", "restore the default calibration", or "the arm reads wrong numbers".
---

# Calibrate an arm

Calibration teaches an arm where each joint starts, stops and sits in the middle. **0 = the middle of the range you record** (LeRobot's convention), never "the centred pose". Concept, formulas and the file format: `docs/CALIBRATION.md`.

**Safety first.** Starting a calibration makes the arm **limp**: it goes soft and drops unless a person holds it. On a real arm a **person** does the physical part (hold, centre, sweep every joint); you only press buttons or call the API after they say they are ready. Never start one on a real arm on your own initiative. Practise in demo mode.

## The easiest way: let the person use the app

`uv run so101 setup` (or `./setup.sh`) opens `#/calibrate?first=1` when a connected arm has no calibration. The page walks through: **Start calibrating the follower arm** -> hold the arm in the middle pose -> **It's centred** -> move every joint through its full range -> **Save calibration**. Afterwards: **Set as default** (replace the restore point), **Restore default**, **Calibrate this arm again**. Do the follower, then the leader.

## Procedure through the API (demo, or with the person's go-ahead)

Start a demo server on a free port (never 8000): `uv run so101 start --demo --no-browser --port 8150`, `APP=http://localhost:8150`.

1. **Find the arm and its index:** `curl -s $APP/api/state | python3 -c "import sys,json; print([(i,a['role'],a['online'],a['calibrated'],a['role_confirmed']) for i,a in enumerate(json.load(sys.stdin)['arms'])])"`. `armIndex` is the position in that list (it can change; look it up every time). The arm must be `online`, and its role confirmed (otherwise the calibration could be saved under the wrong name: use the Motor IDs page, "Find my follower arm").
2. **Check nothing is running:** `pp.running == false`, `teleop.on == false`, `arms[i].calib.step == "idle"`.
3. **Ask the person to hold the arm** (one numbered action, wait for a yes), then `curl -s -X POST $APP/api/calib/<i>/start`. `calib.step` becomes `center`.
4. **Centre:** the person holds the arm in the middle pose (every joint in the middle of its travel, as the picture on the Calibrate page shows). Then `POST $APP/api/calib/<i>/center`. `calib.step` becomes `sweep`; `calib.ranges` starts to grow.
5. **Sweep:** the person moves each joint slowly through its whole range, both ends (wrist roll is saved as a full turn and needs no sweep). In demo mode a simulated hand does it, about 20 seconds. Watch: `curl -s $APP/api/state | python3 -c "import sys,json; c=json.load(sys.stdin)['arms'][<i>]['calib']; print({j:r[1]-r[0] for j,r in c['ranges'].items()})"`. Each joint other than wrist roll needs a span of at least **150 ticks** (about 13 degrees); a real reach is much more.
6. **Save:** `POST $APP/api/calib/<i>/finish`. It returns `{}` even when refused: if a joint moved too little, `calib.error` says "Move these joints through their full range: ..." and the step stays `sweep`. On success `calib.step == "done"`, `calib.saved` is the file path, `arms[i].calibrated == true`.
7. **Defaults:** the first calibration becomes the restore point automatically (`has_default`). `POST /api/calib/<i>/set_default` replaces it with the current one; `POST /api/calib/<i>/restore` writes the default back to the motors (refused while calibrating or when the arm is offline; read `arms[i].notice`). `POST /api/calib/<i>/cancel` leaves a calibration (and returns to `idle`).
8. **Do the other arm** (leader), same steps.

## Verify

```bash
curl -s $APP/api/suite/checklist | python3 -c "import sys,json; print([(i['id'],i['status']) for i in json.load(sys.stdin)['items'] if 'calibrated' in i['id']])"   # both 'ok'
curl -s $APP/api/suite/info          # "uncalibrated": [] and "first_calibration_needed": false
```

Then check the numbers make sense: with the arm in the middle pose each joint should read near 0 on the Calibrate page. `so101 doctor` prints "first calibration: done".

## Rules

- The file is LeRobot-compatible and **personal to the arm**: never copy somebody else's calibration, never commit `calibration/*.json` or anything from `~/.so101` or `~/.cache/huggingface/lerobot/calibration/`.
- Calibration is the zero of everything else (kinematics, camera mapping): after recalibrating, the camera mapping may need to be retaught (`calibrate-camera-by-clicking`).
- Every API call here returns `{}`; always read `/api/state` afterwards. Never loop on `finish` without reading `calib.error`.
- If something looks wrong, use `debug-hardware` (Test motors first).
