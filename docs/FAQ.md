# FAQ

Short answers to the questions people ask first. If yours is not here, open an issue.

## Getting started

**Do I need an arm to try it?** No. Run `uv run so101 demo` for the real app with simulated arms and cameras, or use the live demo on the website. The Learn section explains every part of the arm in plain words.

**Does it cost anything?** The software is free and open source under the AGPL-3.0-or-later licence. The robot hardware is separate; this project does not sell or recommend parts. See [HARDWARE.md](HARDWARE.md) for the official sources.

**Do I need to know how to code?** No. You run one command and the app opens in your browser. Every screen says what to do next, and every unfamiliar word has a short explanation. If you do like code, it is plain Python and plain JavaScript.

**Which computers does it run on?** macOS and Linux (including Raspberry Pi) have been run on real hardware. Windows has a setup script but is **untested**: if it fails, please open an issue with the output of `uv run so101 doctor`.

**Do I need to install Python?** No. `./setup.sh` installs [uv](https://docs.astral.sh/uv/), and uv installs Python 3.12 and every package into the project folder. The project supports Python 3.10 to 3.13.

**Does it work offline?** After installing, yes. The app has no CDN or web fonts, and three.js is included. Installing needs the internet once.

**Do I need both a leader and a follower arm?** No. The follower does the work. The leader is the arm you move by hand to drive it, and it is optional: the checklist skips it when it is not connected.

## Privacy and safety

**Does it send my data anywhere?** No. The app runs on your computer, has no accounts and no telemetry. The Inspector records only in memory, only when you switch it on, and nothing is sent anywhere. "Copy diagnostics" leaves out serial numbers, hostnames and IP addresses, and shows your home folder as `~`, and you choose where to paste it.

**Can other people on my network control my arm?** No. The app has **no password**, so by default it listens on this computer only (`127.0.0.1`). To let a Raspberry Pi screen or another device open it, start it with `uv run so101 start --host 0.0.0.0`, and only on a network you trust. See [SECURITY.md](../SECURITY.md).

**Will it move my arm by itself?** No. The arm moves only when you ask, after a sentence that says what will move and an inline confirmation. Demo mode never opens a real serial port.

**What does STOP do?** It holds the arm where it is. It does not make it limp. Release makes it limp, so hold the arm first. Closing or restarting the app does not release the motors either.

## Using it

**Where are my settings and my calibration?** Settings and the camera list are in `~/.so101/config.json`. Calibrations are in `~/.cache/huggingface/lerobot/calibration/` (the LeRobot location). See [CALIBRATION.md](CALIBRATION.md) and the "Where state lives" table in [AGENTS.md](../AGENTS.md).

**Why does every joint read 0 in the middle?** It is LeRobot's convention: 0 is the middle of the range you recorded, not "the arm looks straight". You can show degrees or the -100 to +100 scale in Settings.

**Can I move my calibration to another computer?** Yes. Copy your own `my_follower.json` and `my_leader.json` into the repo's `calibration/` folder and run `scripts/install_calibration.sh` on the other computer. Never copy somebody else's calibration onto your arm: every arm is different.

**How do I add a second camera, or a Raspberry Pi camera?** Cameras page, Add a camera: pick a detected USB camera, or type a network address such as `http://<pi>:8000/raw.mjpg`. Changes apply when the app restarts. See [HARDWARE.md](HARDWARE.md).

**Why port 8000? What if it is taken?** 8000 is the default of the classic dashboard. If it is taken, `uv run so101 start --port 8001`.

**What is the classic dashboard?** The validated control screen (3D twin, leader to follower, pick and place) at `/dashboard`. The Control page of the Suite embeds it. Its API is unchanged.

**Can I train AI policies with it?** Recording and training are [LeRobot](https://github.com/huggingface/lerobot)'s job. The Suite gets your arm built, calibrated and working, and the repo keeps optional helper scripts (`scripts/04` to `07`, with `uv sync --extra lerobot`).

**Does it work with other arms?** It is built for the SO-101: six STS3215 motors with IDs 1 to 6. Other arms are untested.

## For developers

**How do I extend it?** Add a [module](MODULES.md) (a folder in `modules/`), a Learn article, or a page. [AGENTS.md](../AGENTS.md) and the skills in `.claude/skills/` walk through each. Work in demo mode so you never touch real hardware.

**Why `uv`?** It installs Python itself, is fast, and is the same command on every OS.

**Why AGPL-3.0?** Forks are free but must stay open source, including when someone runs a modified copy as an online service. It is compatible with the Apache-2.0 and MIT parts the project uses (see [NOTICE.md](../NOTICE.md)). This is a summary, not legal advice.

**Is this the official SO-101 or LeRobot software?** No. It is an independent community project, not affiliated with or endorsed by Hugging Face (LeRobot), The Robot Studio (SO-ARM100) or Feetech.

**How do I uninstall it?** Delete the project folder. Your settings are in `~/.so101/`, and your calibrations in `~/.cache/huggingface/lerobot/calibration/`: keep the calibrations if you still use LeRobot. The installer put `uv` in `~/.local/bin`; remove that too if you do not use it elsewhere.
