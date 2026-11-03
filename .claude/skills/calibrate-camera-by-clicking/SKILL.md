---
name: calibrate-camera-by-clicking
description: Teach a camera where the table is by clicking on its picture, driven through the HTTP API (snapshot URL plus the teach endpoint) the same way the Cameras page does it. Use when asked to "calibrate the camera", "map the table", "teach the camera", "click-to-calibrate", "camera mapping", or "do the camera calibration with an AI".
---

# Calibrate a camera by clicking (via the HTTP API)

The camera mapping turns a pixel in camera 1's picture (640 x 480) into a place on the table. You teach it by pairing **where the follower's gripper tip is** (read from the motors) with **which pixel shows that tip**. A person moves the arm by hand; you look at the picture and say where the tip is. Concept and lessons: `docs/CALIBRATION.md` and `docs/LEARNINGS.md` section 1.

**You never move the arm yourself.** The arm must be limp, resting on the table, before any person is asked to touch it: a stiff arm hurts, pinches and moves when software says so. Use `rest` (it lowers the arm, then lets go); never the bare `release`, which can drop a raised arm.

## Preconditions (check with the API, do not assume)

```bash
APP=http://localhost:8150        # the app's address; a demo server for practice
curl -s $APP/api/state | python3 -c "import sys,json; d=json.load(sys.stdin); a=[x for x in d['arms'] if x['role']=='follower'][0]; print('online',a['online'],'calibrated',a['calibrated']); print('busy', d['pp']['running'], d['teleop']['on']); print('camera0', d['cameras'][0])"
```

Need: follower `online` and `calibrated` (else `calibrate-arm`), camera 0 `ok` (else `add-camera`/troubleshooting), nothing running. If the person has not agreed to make the arm limp, stop and ask.

## Procedure

1. **Tell the person to keep their hands clear**, in numbered one-action steps (see `write-physical-instructions`): "1. Take your hands off the arm. 2. Tell me when they are clear." Wait for a yes. Then make it limp (next step); only after `pp.limp` is true ask them to touch it.
2. **Lower the arm and make it limp:** `curl -s -X POST $APP/api/pp/rest` (needs a calibrated, online follower; the arm lowers onto the table, then goes limp). Poll `/api/state` until `pp.limp == true`; if `pp.status` says it was refused, the arm is still STIFF: tell the person not to touch it and stop.
3. **Ask the person to close the jaws and touch the tip to a spot on the table, and hold still.** Spread the spots out: near, far, left, right (at least 3, ideally 4 or more). A spot must be **15 mm or more** from the previous one.
4. **Look:** `curl -s -o table.jpg $APP/api/suite/snapshot/0.jpg` (add `?annotated=1` for the overlay). Open `table.jpg` and find the pixel `(u, v)` where the **jaw tips touch the table**. From above the gripper body hides the tip: click where the tips meet the table, not the middle of the hand. If you cannot see it, say so and ask the person to move it into view; never guess.
5. **Teach it:**
   ```bash
   curl -s -X POST $APP/api/pp/teach -H 'Content-Type: application/json' -d '{"u": 320, "v": 240}'
   ```
   The answer is always `{}`. **Read the result:**
   ```bash
   curl -s $APP/api/state | python3 -c "import sys,json; p=json.load(sys.stdin)['pp']; print(p['taught'], p['fit_mm'], p['status'])"
   ```
   `taught` must have grown by one. If not, `status` says why: "the arm is not limp", "the gripper tip hasn't moved since the last point: move it to a NEW spot", "follower arm not online/calibrated". Report that sentence and fix it; do not resend blindly.
6. **Repeat** steps 3 to 5 for each spot, telling the person "Spot 2 of 4: put the tip on a new spot, hold still, tell me when it is there". Give a progress cue every time.
7. **After 3 spots** the mapping works but `fit_mm` is 0.0 (three points always fit exactly: it proves nothing). **Teach a 4th spot** and read `fit_mm`: about 5 mm or less is good, 10 mm or more is rough (undo the worst spot with `POST /api/pp/undo`, or `POST /api/pp/clear` and start again).
8. **Hands-free alternative:** `POST /api/pp/auto {"on": true}`: the app saves a spot whenever the person holds the tip still on the keychain (`pp.auto.msg` says what it waits for); turn it off with `{"on": false}` when done.
9. **Finish:** tell the person they may let go **only after** you confirm the last spot is saved ("Got it, you can let go"). Do not leave them holding a pose while you think. The arm stays limp until a person presses **Release arm**/**Stop** in Control or you call `POST /api/pp/stop` (holds position).

## With the MCP tools instead of curl

If the `so101` MCP server is connected (`docs/MCP.md`; `uv run so101 mcp --url <app address>`), use `so101_status` (preconditions), `so101_snapshot` (`camera: 0`, `annotated: true` draws the overlay), `so101_teach_point` (`u`, `v`), `so101_undo_point`, `so101_clear_points` and `so101_stop`. They map one to one onto the calls above, never move the arm, and pass the app's refusal sentences back to you: report them, do not work around them. Camera numbers start at 0.

## Verify

- `pp.taught >= 3` (4 or more is better), `pp.fit_mm` reported honestly, `pp.cams[0].cal == true`.
- Open `$APP/suite/#/cameras` (a person can use **Start mapping the table**, **Undo last spot**, **Clear all**, **Done** for the same job): the map badge reads "Mapped".
- Note for the report: `GET /api/suite/checklist` item `camera_mapped` reads the **full camera model** (`pp` models), which only the automatic clamped-keychain calibration or the alignment tools set; a click-taught mapping alone may still show `todo` there. Say what you observed rather than claiming success.

## In demo mode

The demo hand moves a limp arm, so you can run the whole flow: calibrate the follower first (`calibrate-arm`), then rest the arm (`/api/pp/rest`) and teach; the demo's synthetic picture is a table with a bowl and a red keychain, not a real gripper, so use it to check the mechanics, not the pixel judgement.
