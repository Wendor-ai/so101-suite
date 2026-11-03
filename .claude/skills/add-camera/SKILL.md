---
name: add-camera
description: Add a USB or network camera to a running SO-101 Suite app, find out why a camera shows no picture, or extend camera detection in code (so101/cameras.py). Use when asked to "add a camera", "connect the Raspberry Pi camera", "the camera is black", "camera not found", "support a new camera or OS", or "second camera".
---

# Add a camera

Two jobs: **A** put a camera into a running app (API), **B** change how cameras are detected (code). Camera changes apply by **restarting** the app (`os.execv`), not hot-plugging.

## A. Add a camera to a running app

Use a demo server for practice: `uv run so101 start --demo --no-browser --port 8150` (never 8000, stop it afterwards). For a real app use its address as `$APP`.

1. **List what exists:** `curl -s $APP/api/suite/cameras`. `cameras` = configured (with `ok`, `fps`, `err`, `index`, `calibrated`, `pending`), `detected` = visible but not added, `origin` = `cli | store | auto`, `restart_needed`.
2. **Pick the source:** a `source` from `detected` (an index such as `0`, a device path, or `demo://camera/2`), or a network address of an MJPEG stream or JPEG snapshot, for example `http://<pi>:8000/raw.mjpg` (a Raspberry Pi running the app with `--camera-only` serves `/raw.mjpg` and `/raw2.mjpg`). Open a network address in a browser first: it should show live video.
3. **Add it:**
   ```bash
   curl -s -X POST $APP/api/suite/cameras -H 'Content-Type: application/json' \
        -d '{"action":"add","source":"demo://camera/2","name":"Spare"}'
   ```
   The source is probed first (one picture is read). A failure is HTTP 400 with the reason in `error` (in use by another app, macOS blocked it, not on the network, not a picture). `409` means: already added, or the app was started with `--camera`, `--camera-url` or `CAMERA_URL`, which override the saved list (start it without them). `rename` and `remove` use `{"action":..., "id":"cam1"}`.
4. **Apply:** the answer has `restart_needed: true`. Tell the person the app will restart, then `curl -s -X POST $APP/api/suite/restart` (refused with 409 while a job, teleop, calibration or test runs; the motors keep their torque). Wait until `GET /api/suite/info` answers again.
5. **Verify with your own eyes:** `curl -s -o cam.jpg -D - $APP/api/suite/snapshot/<index>.jpg | head` must show `X-Camera-Ok: 1`; open `cam.jpg` and describe what you see. `X-Camera-Ok: 0` means a grey card with the reason (`X-Camera-Error`); fix that before anything else (`docs/TROUBLESHOOTING.md`, camera sections).
6. **Next step:** teach the camera where the table is: `calibrate-camera-by-clicking`.

## B. Change detection or the API in code

Files, in order:

1. `so101/cameras.py`: `list_cameras()` (Linux `/dev/v4l/by-path/*-usb-*-video-index0`, fallback `/dev/video*`; macOS and Windows probe indices 0 to 4; names via `system_profiler` on macOS), `probe_source()` and `probe_url()` (never raise: `err` is a sentence a beginner can act on), `conv_source()`, `default_opener()` (V4L2 for paths, DirectShow for Windows indices), `SysFs` (the filesystem questions, injectable).
2. `so101/suite_api.py`: `cameras_view()`, `detected_cameras()` (cached 30 s: probing opens devices), `api_cameras_post()`, `_snapshot_jpeg()`, `/stream/<i>.mjpg`.
3. `app/server.py`: `Camera` threads (`_run_local`, `_run_url`, `_run_demo`), `pick_cameras()` (command line > saved list > first camera found). macOS camera permission must be requested from the **main thread**.
4. `app/suite/js/pages/cameras.js` (UI) and `app/suite/js/mock/backend.js` (`postCameras`, `camerasView`): keep both in step with the real API.
5. `tests/test_cameras.py`: tests inject `opener`, `sysfs`, `names` and `platform_os`, so every OS is tested on any machine (see `FakeOpener`, `FakeSysFs`). Add a test for each new message.
6. Docs: `docs/API.md` (cameras), `docs/TROUBLESHOOTING.md`.

Rules: detection must not reopen a source the app already uses (`in_use`); a camera problem is a sentence, never a black box or a stack trace; Linux identity is by-path, never `/dev/videoN`; network probes time out fast and say whether the host or the picture is the problem.

## Verify

```bash
SO101_NO_REAL_PORTS=1 uv run pytest -q tests/test_cameras.py tests/test_suite_api.py
node --test "tests/js/*.test.mjs"
```

Then click through the Cameras page in demo mode (`#/cameras`: add the "Demo camera 3" and check that it shows as waiting for a restart). Known issue: restarting a *demo* server currently starts the demo from a fresh state, so the added camera (and any calibration) is lost; you cannot verify the added camera's picture in demo mode yet. Say so in your report.
