# Changelog

All notable changes to SO-101 Suite. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.1.0] - 2026-11-01

First public release.

### Added
- One-command setup (`./setup.sh`, `setup.ps1`) and the `so101` command (`start`, `setup`, `doctor`, `detect`, `demo`, `mcp`).
- Auto-detection of the operating system, Raspberry Pi, serial ports, USB servo adapters, motors (IDs 1 to 6) and cameras.
- A live "what's connected, what's left" checklist that always names the next step.
- Guided Motor IDs (before assembly), Assemble, Calibrate (every joint reads 0 at the middle of its range), Cameras (add, view, calibrate by clicking on the picture).
- Test motors (Ping and a small, safe Wiggle per motor, "Check all motors") and an Inspector (recording of motor bus traffic, API calls and logs, like a browser's Network tab).
- Learn section with a 3D arm, glossary, troubleshooting, command palette (Cmd/Ctrl+K), settings, light and dark themes.
- Modules: drop a folder into `modules/` and the app finds it.
- Demo mode with simulated arms and cameras, and a no-backend demo that runs in the browser.
- Defaults in `defaults/so101.defaults.json`; the first calibration is saved as the restore point.
- AGENTS.md, skills, an HTTP API and an MCP server for AI agents.
- Pick and place, leader-to-follower control and the 3D dashboard (from the earlier project) under `/dashboard`.
- An arm problems panel on the dashboard: missing, hot, pushing or faulty motors show as callouts on the 3D arm with a `How to fix`; six silent motors are one problem, not six.
- `Check joints…` (one joint or all, from the middle of each range), `Limp now` (works even when the arm does not answer), `Ignore this motor` (keep working without a failed one) and a guard that keeps hot motors off and refuses a leader and follower wrist roll that are far apart.
- Pick and place refuses to move to a guess: cameras that disagree by more than 30 mm, or a camera that has moved more than 12 mm on the table, stop it with the reason.
- A `.env` file (git-ignored) for ports, camera addresses and names: `.env.example`, `so101 env`, and [docs/CONFIGURATION.md](docs/CONFIGURATION.md). It is never read in demo mode or in the tests.
- A test that fails CI if a private file or a private-looking value (home-network address, e-mail, USB serial number, home folder, token) is ever committed.
- Leader to follower: an `Align arms…` box (match both arms in the same pose, re-measure the trigger's closed and open readings, a live per-joint difference), a smoothness slider, and a 120 Hz loop that reads the leader in one packet and writes the follower in one.
- Pick and place: an automatic grey-cylinder loop (`Cylinders -> bowl`, with a dry run) and an object finder that follows a cylinder with the hand camera (`Find & follow cylinder`, OpenCV only), plus look and search moves.
- An `ignore_heat` switch (temperatures stay visible but stop blocking, warning or stopping anything; the motors' own protection is unchanged).

### Changed
- Positions of all motors are read in one packet every cycle, so the 3D arm follows the real one smoothly; the heavy `/api/state` is cached for 120 ms (any write clears it) and polled less often.
- Teleop copies the arm joints 1:1 (one tick is the same angle on both arms) instead of stretching the leader's swept range onto the follower's, which had turned the follower too far after an incomplete sweep.
- A temperature that cannot be re-read for 3 seconds is dropped instead of kept, so a stale value cannot block teleop; an arm whose USB port vanished for good is forgotten.
- A table scan refuses a map built from detections that are not credible (for example from a black camera picture) and keeps the old one.
- `config.sh` is replaced by `.env`; the scripts in `scripts/` read it through `so101 env --shell`.
- The Raspberry Pi kiosk script no longer hardcodes one machine's camera paths: set `CAMERA_INDEX` and `CAMERA2` in the Pi's `.env`.
