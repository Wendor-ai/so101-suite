# Troubleshooting

Something does not work? Start with the three tools below, in this order. They show you what is wrong, usually with a sentence that says what to do. The app also has an illustrated **Help** page (`#/help`) with the same symptoms and step-by-step fixes.

## Three tools, in this order

1. **Test motors** (`#/test`, in the Debug group). Press **Check all motors**: it pings every motor (read-only) and wiggles each one a little, then gives a report per motor with what you should see and what to check if not. **Ping** never moves a motor. **Wiggle** moves a joint about 10 degrees and back, only when you ask, and never during calibration, teleop or a pick and place job. Hold the arm or rest it on the table first.
2. **Inspector** (`#/inspector`). Switch **Record** on, repeat the thing that fails, and read what the app and the motors said to each other. **Errors only** shows what failed; **Copy as issue report** puts it on your clipboard. Recording is off by default and stays in memory on your computer.
3. **`uv run so101 doctor`** in a terminal. The same checklist as the Setup page, as text. Add `--json` for a machine-readable version. It reads the running app (`--port N` if it is not on 8000) and never opens a serial port. **Copy diagnostics** (on the Help page, and in Settings) is the same idea and is safe to paste into an issue: no serial numbers, no IP addresses, home folders shown as `~`.

## Symptoms

### The app finds no USB adapter

- Plug the **USB cable** from the motor controller board into the computer **and** plug the board's **power supply** into the wall. Both are needed.
- Some USB cables only charge. Try another cable, and plug straight into the computer, not a hub.
- macOS: in Terminal run `ls /dev/tty.usb*` (the adapter shows as `/dev/tty.usbmodem...` or `/dev/tty.wchusbserial...`). Linux and Raspberry Pi: `ls /dev/ttyACM* /dev/ttyUSB*`. Windows: Device Manager, Ports (COM and LPT), look for a USB Serial or CH340/CH343 device, and install the CH343 driver from its maker if it is missing.
- `uv run so101 detect --no-cameras` lists what the computer can see.

### "Permission denied" (Linux and Raspberry Pi)

Your user must be allowed to open serial ports. Run once, then log out and back in:

```bash
sudo usermod -aG dialout $USER
```

On some distributions the group is `uucp`. For USB cameras the camera page may ask for `sudo usermod -aG video $USER` the same way.

### "Port busy" or "device or resource busy"

Only one program can use a serial port at a time. Stop any other copy of the app, the old dashboard, `lerobot-calibrate`, `lerobot-teleoperate` or a script that uses the same arm. `lsof /dev/ttyACM0` (use your port) shows who holds it.

### No motors answer

1. Is the power supply pushed into the board and the wall plug in?
2. Is every 3-pin cable clicked in all the way, at both ends?
3. On a Waveshare board, are both jumper caps on the pins marked **B**?
4. Brand-new motors all ship as ID 1. With several chained together they all answer at once and nothing can be read. Plug in **one** motor and give it its ID on the **Motor IDs** page.
5. Motors from another robot may use a different speed. The Motor IDs step sets the speed as well as the ID.

The app scans at these speeds, 1 Mbit/s first: 1,000,000, 500,000, 250,000, 128,000, 115,200, 76,800, 57,600 and 38,400 baud.

### Only some motors answer

The chain is board, 1, 2, 3, 4, 5, 6. If 4, 5 and 6 are missing, the cable between motor 3 and motor 4 is the suspect: unplug and replug both ends. Two motors with the same ID look like one missing motor: plug each in alone and set its ID.

### Set ID is refused

The app only writes an ID when **exactly one** motor answers. The sentence next to the button says how many did. It is also refused during a calibration, a job or a test. See `docs/API.md`, `POST /api/suite/motors`.

### Calibration will not save

"Move these joints through their full range: ..." means those joints moved less than 150 ticks (about 13 degrees) since you pressed Centre. Sweep each named joint through its whole travel, slowly, then save. Wrist roll is saved as a full turn and is exempt. See [CALIBRATION.md](CALIBRATION.md).

### The camera picture is black, missing or "in use"

The Cameras page shows the reason in a sentence; the snapshot URL (`/api/suite/snapshot/<i>.jpg`) returns a grey card with the same reason.

- **In use:** another program has the camera (a video call, a browser tab, a second copy of the app). Close it.
- **macOS blocked it:** allow your terminal in System Settings, Privacy & Security, Camera, then restart the app.
- **Windows:** check Settings, Privacy & security, Camera.
- **Linux:** the device file is missing (replug, try another USB port), or you are not in the `video` group.
- Two identical USB cameras swapping places after a restart: on Linux the app uses the stable `/dev/v4l/by-path/...` names, not `/dev/videoN`.
- Camera changes (add, remove) take effect when the app **restarts**: press **Apply changes (restarts the app)** on the Cameras page, or use Restart the app in Settings, Advanced.

### A motor is hot, buzzes, or stops answering

Press **STOP**, find what blocks the joint (the table, a cable, an end stop), and free it. Every automatic move stops and holds at 70% torque (85% for wrist roll) for three readings in a row, or at 68 degrees C. A single temperature reading that jumps by more than 10 degrees is ignored as a glitch. A motor that tripped its own overload protection is re-armed at its present position (up to four times a minute); if it keeps happening, something is blocking it. The wrist roll strains against its cable: give it slack. If a motor stays hot, unplug the power supply for a minute.

### The arm feels stiff after the app closed or restarted

Closing or restarting the app **does not release the motors**, so the arm keeps holding. That is on purpose: it does not drop. To make it limp, press **Release arm** in Control: the arm lowers itself onto the table and only then lets go, so you do not have to hold it. Keep your hands clear until it says it is limp.

### The page says "Lost connection to the app" or "reconnecting"

The app stopped. Look at the terminal where you started it. Start it again with `uv run so101 start`. For a machine that should always run it, `scripts/supervise.sh` restarts the server if it crashes or stops answering `/api/health`. If you used **Restart the app**, wait a few seconds: the page reconnects by itself.

### "Could not start on port 8000"

Another copy of the app (or the old dashboard) is already running there. Open `http://localhost:8000`, or start on another port: `uv run so101 start --port 8001`.

### The wrong arm moves, or Leader and Follower are swapped

Two identical adapters look the same to the computer. On **Motor IDs**, press **Find my follower arm** or **Find my leader arm** and follow the unplug and replug steps, or use **Swap Leader and Follower** in Settings, Devices. Roles are stored by the adapter's USB identity, not its port name, so they survive replugging.

### Pick and place misses, or the gripper closes on nothing

Read the step log in Control (and `~/.so101_lastrun.log`). The usual causes are the camera mapping (teach more spots, then test one), a gripper that is not vertical (the model's idea of straight down can be several degrees off; LEARNINGS section 9 says how it is corrected), or something on the table moved. The app never carries on after a failed grasp; it goes back up and retries up to four times. See [LEARNINGS.md](LEARNINGS.md) sections 8, 9 and 13.

### Install problems

- "Python too new": the project needs Python 3.10 to 3.13. `uv` installs and uses 3.12 for you; run `./setup.sh` (or `.\setup.ps1`) again.
- "No space left on device": free disk space. Keep more than 5 GB free; a full disk breaks everything, including macOS's own permission storage. `uv cache clean` is safe. On a small Raspberry Pi, `/tmp` is in memory and tiny: point `TMPDIR` at a folder on disk, and do not install LeRobot there.
- "Operation not permitted" on files in `Documents` (macOS): macOS privacy can revoke a protected folder from your terminal or editor. Allow it again in System Settings, Privacy & Security, Files and Folders, or keep the project outside Documents.
- Windows has not been tested. If something fails, open an issue with the output of `uv run so101 doctor`.

## Still stuck?

Open an issue (there is a **Hardware help** template) and paste: the output of `uv run so101 doctor`, what you expected, what happened, and, if it is about the arm talking to the motors, the Inspector's **Copy as issue report**. Do not paste photos with serial numbers or your network addresses.
