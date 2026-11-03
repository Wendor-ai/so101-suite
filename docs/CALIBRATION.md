# Calibration

Calibration teaches an arm where each joint starts, stops and sits in the middle, so the leader and the follower read the same numbers in the same pose. This page covers the two calibrations in the Suite: the **arm calibration** (each joint's range) and the **camera mapping** (where the table is in a camera's picture).

## The rule: zero is the middle of the range

After calibration, **0 means the middle of the range you recorded for that joint.** It does not mean "the arm looks straight". This is LeRobot's convention, and the Suite shows it two ways (Settings, Units):

| Display | Formula | Notes |
|---|---|---|
| Degrees | `(raw - (range_min + range_max) / 2) * 360 / 4095` | 0 at the middle. The gripper is shown as 0 to 100 % open |
| LeRobot scale | `(raw - range_min) / (range_max - range_min) * 200 - 100` | -100 at the lowest point, 0 in the middle, +100 at the highest |

`raw` is the motor's position, a count from 0 to 4095 for one full turn. Once, someone "fixed" the zero to the exact middle of the motor scale (2047.5) and the gripper then pointed backwards at the base. Always sanity-check forward kinematics on a **live pose**: with the gripper held straight down on the table, the tool direction should be about (0, 0, -1) and the tip near table height. If it is not, the zero is wrong ([LEARNINGS.md](LEARNINGS.md) section 1).

## Calibrating an arm in the app

Open **Calibrate** (`#/calibrate`), or let `./setup.sh` open it: the app asks you to calibrate the first time it sees a connected arm without a calibration. Do the follower, then the leader. It takes about two minutes per arm.

1. **Get ready.** Read what will happen, then press **Start calibrating the follower arm** (or the leader). Calibration needs the arm **limp** (soft) so you can move each joint by hand. If the follower is stiff, the page first offers **Lower the arm and make it limp**: the arm lowers itself onto the table and only then lets go, so nothing drops and you never have to hold it. Wait for "The arm is limp now" before you touch it.
2. **Middle pose.** Put every joint in the middle of its travel (a picture shows it), keep holding it, and press **It's centred**. The app reads the pose and writes each motor's *homing offset* so this pose reads near the middle of the scale.
3. **Move every joint.** Slowly move each joint through its full range, both ends. Each joint has a bar with a 0 tick in the middle, the live value, and min and max markers that grow. A joint can be saved once it moved at least 150 ticks (about 13 degrees); a full reach is much more. **Wrist roll** turns freely and is saved as a full turn, so it needs no sweep.
4. **Saved.** Press **Save calibration**. The app writes the calibration file, shows its path, and the first calibration of each arm becomes its **default** (restore point). **Set as default** replaces the restore point with the current calibration; **Restore default** writes the default back to the motors.

If the sweep is too small the app says which joints to move: "Move these joints through their full range: shoulder_pan, shoulder_lift". Starting a calibration clears the motors' old limits, so if you cancel part-way, finish a calibration soon or press **Restore default**.

### Through the API (for scripts and agents)

The state machine is `idle -> center -> sweep -> done`. `armIndex` is the position of the arm in `GET /api/state` `arms`.

```bash
APP=http://localhost:8150
curl -s $APP/api/state | python3 -c "import sys,json; print([(i,a['role']) for i,a in enumerate(json.load(sys.stdin)['arms'])])"
curl -s -X POST $APP/api/calib/0/start     # arm goes limp: a person must hold it
curl -s -X POST $APP/api/calib/0/center    # the current pose becomes the centre
# move every joint through its full range (a person, or the demo's simulated hand), then watch:
curl -s $APP/api/state | python3 -c "import sys,json; print(json.load(sys.stdin)['arms'][0]['calib'])"
curl -s -X POST $APP/api/calib/0/finish    # saves; if a joint moved too little, calib.error says which
```

All `/api/calib/*` calls return `{}`; read the result in `arms[i].calib` (`step`, `ranges`, `saved`, `error`) and `arms[i].notice`. The other actions are `cancel`, `restore` and `set_default`. In demo mode a simulated hand moves one joint at a time once the arm is limp and centred, so the whole flow can be tried without hardware. Details: [API.md](API.md).

## The calibration file

LeRobot-compatible, written by the app and read by LeRobot:

| Arm | File |
|---|---|
| Follower | `~/.cache/huggingface/lerobot/calibration/robots/so_follower/my_follower.json` |
| Leader | `~/.cache/huggingface/lerobot/calibration/teleoperators/so_leader/my_leader.json` |

Each also has a `my_follower.default.json` or `my_leader.default.json` restore point. The root folder can be changed with `HF_LEROBOT_CALIBRATION`, and the file names with `FOLLOWER_ID` and `LEADER_ID` (defaults `my_follower`, `my_leader`). Content, one entry per joint:

```json
{
  "shoulder_pan": {"id": 1, "drive_mode": 0, "homing_offset": -37, "range_min": 1048, "range_max": 3047},
  "wrist_roll":   {"id": 5, "drive_mode": 0, "homing_offset": 12,  "range_min": 0,    "range_max": 4095}
}
```

(Numbers above are made up.) The same limits are written into each motor (position limits, registers 9 and 11) and the homing offset into register 31; the motors' saved settings are unlocked for the write and locked again after. **Every arm is different: never copy somebody else's calibration onto your arm.** The `calibration/` folder in the repo is a git-ignored place for *your own* backups; `scripts/install_calibration.sh` copies them to the right place on another computer (for example a Raspberry Pi).

## Camera mapping: teach the camera where the table is

Pick and place needs to turn a spot in a camera's picture into a place on the table. You teach it by **touching the table with the gripper tip** and **clicking the same spot in the picture**. You need a calibrated, connected follower first.

In the app (**Cameras**, then **Start mapping the table**): press **Lower the arm and make it limp** (wait until the page says the arm is limp), close the jaws, touch a spot with the jaw tips and hold still, then click that spot in the picture. **Undo last spot** and **Clear all** fix mistakes; **Done** closes the mapping. Do this for at least **3 spots** that are spread out; the app asks for a **4th** because with exactly three points the fit is always exactly 0 mm and tells you nothing. **Hands-free (Auto)** saves a spot each time you hold the tip still on the keychain. The page shows the **fit error** in millimetres: up to about 5 mm is good, 10 mm or more is rough. The tip must move at least 15 mm between spots.

Lessons that shaped this ([LEARNINGS.md](LEARNINGS.md) section 1): a 3-point fit proves nothing (check with leave-one-out); the gripper hides the keychain, so never detect it while the gripper is over it; judging the tip by eye in a top-down picture is unreliable; hand-held poses with the jaw tips flat on the table beat measuring centimetres.

### Through the API

```bash
curl -s -o table.jpg $APP/api/suite/snapshot/0.jpg                 # look at the table
curl -s -X POST $APP/api/pp/rest                                   # lowers the arm onto the table, THEN limp (never use /api/pp/release for this: it can drop a raised arm)
curl -s -X POST $APP/api/pp/teach -H 'Content-Type: application/json' -d '{"u": 320, "v": 240}'   # pixel of the spot the tip is touching
curl -s $APP/api/state | python3 -c "import sys,json; p=json.load(sys.stdin)['pp']; print(p['taught'], p['fit_mm'], p['status'])"
```

`u` and `v` are pixels in the 640 x 480 picture. The call returns `{}` even when refused; `pp.status` says why (for example "the gripper tip hasn't moved since the last point"). `POST /api/pp/undo` removes the last spot, `POST /api/pp/clear` all of them. The mapping is stored in `~/.so101_pickplace.json`.

### Has a camera moved?

The app keeps the picture each camera showed when its model was last set (`~/.so101_camref/camN.png`) and compares live pictures with it (ORB + RANSAC similarity) at start, every 15 seconds and at the start of a run. It judges the shift in millimetres on the table (`CAM_MOVED_MM = 12`), not in pixels, because a pixel means very different distances in different parts of the picture. A moved or disagreeing camera makes `ready()` say "Not picking: …" and the card shows why. These reference pictures show your room, so they stay on your computer and are never committed.

### Re-mapping

The Pick & Place card has `Remove the N old points (then Re-map starts fresh)`; the Re-map screen has `Undo last point` and `Remove all old points`. These table points are only camera 1's fallback map; they do not repair a moved camera model (`docs/LEARNINGS.md` section 16).

## Where the model can still be wrong

The model's idea of vertical can be several degrees off because joint zero is the middle of the *recorded* range. The pick and place engine has a pitch trim and a model alignment that fix this from hand-held poses without touching the camera mapping; the story is in [LEARNINGS.md](LEARNINGS.md) sections 9, 12 and 15. Read it before changing kinematics, calibration or the load guard.
