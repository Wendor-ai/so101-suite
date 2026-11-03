# Configuration

Almost nothing needs configuring: the app finds your arms and cameras by itself. This page is for the times you want to force a choice, point at another computer, or run the command-line scripts. Everything that belongs only to **your** setup (ports, camera addresses, account names) goes in one git-ignored file, so it can never end up in a commit.

## The `.env` file

```bash
cp .env.example .env      # then remove the "#" in front of the lines you want and edit them
uv run so101 env          # shows which .env files were found and which names they set (never the values)
```

`.env.example` is committed and has nothing switched on, so copying it changes nothing until you edit it. **`.env` is never committed**: it is in `.gitignore`, and so is any `.env.something` file.

The app reads `.env` when it starts, in this order. A name that is already set is never changed by a later source:

1. **The real environment.** `FOLLOWER_ID=other uv run so101 start` always wins over the file.
2. The file named by `SO101_ENV_FILE`, if you set it.
3. `.env` in the repo folder.
4. `.env` in your data folder (`~/.so101/.env`, or `$SO101_HOME/.env`).

A line looks like `NAME=value`. You can write `export NAME=value`, put a value in quotes, add a comment after a space and `#`, and use `$OTHER_NAME` or `${OTHER_NAME}` for a name set earlier. Lines it does not understand are skipped.

The `.env` file is **not read in demo mode** (`so101 start --demo`, `so101 demo`), so a real camera address can never show up in a demo or a screenshot.

The shell scripts in `scripts/` read the same file through `so101 env --shell`, and fall back to the factory ports (`/dev/ttyACM0` and `/dev/ttyACM1`) when you set nothing.

## The settings

| Name | Used by | What it does |
|---|---|---|
| `FOLLOWER_ID`, `LEADER_ID` | app, scripts | The names of the saved calibrations (default `my_follower`, `my_leader`). |
| `HF_LEROBOT_CALIBRATION` | app | Where LeRobot keeps calibration files (default `~/.cache/huggingface/lerobot/calibration`). |
| `CAMERA_INDEX`, `CAMERA2` | app, scripts | Force the first and second local camera: a number, or on Linux a device path such as `/dev/v4l/by-path/...`. Leave them out to let the Cameras page find them. |
| `CAMERA_URL` | app | Cameras served by another computer, for example a Raspberry Pi: `http://<pi-address>:8000/raw.mjpg`, several separated by commas. |
| `SO101_REMOTE` | app | Mirror the arms of another running copy of the app. |
| `SO101_URL` | `so101 mcp` | Where the running app is (default `http://127.0.0.1:8000`). |
| `SO101_HOME` | app | Where your settings, roles and progress are stored (default `~/.so101`). |
| `FOLLOWER_PORT`, `LEADER_PORT` | scripts | The serial ports for the LeRobot command-line scripts. macOS `/dev/tty.usbmodemXXXX`, Linux and Raspberry Pi `/dev/ttyACM0`, Windows `COM3`. |
| `HF_USER`, `DATASET_REPO`, `TASK` | scripts | Hugging Face names and the task text for recording and training. |

Settings you change in the app (theme, safety limits, the camera list) are not environment variables: they live in `~/.so101/config.json` and are written by the Settings page. The factory values are in `defaults/so101.defaults.json` (see [Defaults](DEFAULTS.md)).

## What never goes in the repo

Keys, tokens, passwords, serial numbers, IP addresses, user names, photos of your room, and your calibration files stay on your computer. Put addresses and names in `.env`; log in to Hugging Face with its own tool (`huggingface-cli login`) instead of writing a token anywhere. The app removes serial numbers and your home folder from anything it asks you to paste into a bug report. If you ever commit one by mistake, change the secret first, then ask for help removing it from the history.

## Examples

**A Raspberry Pi that only serves the cameras** (`.env` on the Pi):

```bash
CAMERA_INDEX=/dev/v4l/by-path/<first camera's path>
CAMERA2=/dev/v4l/by-path/<second camera's path>
```

Then run `scripts/supervise.sh --port 8000 --camera-only`. Find the paths with `ls /dev/v4l/by-path/`.

**The computer with the arms, using the Pi's cameras** (`.env` on that computer):

```bash
CAMERA_URL=http://<pi-address>:8000/raw.mjpg,http://<pi-address>:8000/raw2.mjpg
```
