# Hardware

What the software expects from your SO-101, and where to find the parts and the build instructions. This project is software only: it does not sell, recommend or compare parts, and it gives no prices.

## Official sources

- Hardware designs, parts lists and 3D-printable files: the SO-ARM100 project, <https://github.com/TheRobotStudio/SO-ARM100>
- Assembly and software guide: LeRobot's SO-101 page, <https://huggingface.co/docs/lerobot/so101>

Use those for what to buy and how to build. The app's **Assemble** page follows the same order and links to the official videos.

## What the app expects

**One or two arms.** The **follower** is the arm that does the work. The **leader** is the arm you move by hand; it is optional, and the checklist skips it when it is not connected.

**Six motors per arm**, Feetech STS3215 serial bus servos, chained one after another on the same cable (the bus). Each motor has an ID, and the SO-101 uses these numbers from the base to the gripper:

| ID | Joint |
|---|---|
| 1 | shoulder pan |
| 2 | shoulder lift |
| 3 | elbow flex |
| 4 | wrist flex |
| 5 | wrist roll |
| 6 | gripper |

The factory speed is 1 Mbit/s (1,000,000 baud), and new motors ship with ID 1. That is why the **Motor IDs** page has you plug in one loose motor at a time. A position is a count from 0 to 4095 for one full turn (about 0.09 degrees per tick). Details: [DEFAULTS.md](DEFAULTS.md) (`serial`).

**One USB servo board per arm.** It joins the computer's USB port and the power supply to the motors, and shows up as its own serial port. The app recognises likely boards by their USB vendor id (WCH CH340/CH343 `1a86`, Silicon Labs CP210x `10c4`, FTDI `0403`). On macOS and Linux it tries every serial port that matches the names below; on Windows it only tries boards it recognises. On the Waveshare-style board the two jumper caps must sit on the pins marked **B** (USB), as the official guide says.

| System | Port names |
|---|---|
| macOS | `/dev/tty.usbmodem*`, `/dev/tty.wchusbserial*` |
| Linux, Raspberry Pi | `/dev/ttyACM*`, `/dev/ttyUSB*` |
| Windows | `COM3`, `COM4`, ... (may need the CH343 driver from its maker) |

Two identical boards look the same to the computer. The app asks you once to unplug and replug one, then remembers which is which by the board's USB identity (not its port name).

**Power.** Each arm's board needs its own power supply, and it must match the motor version: read the label on the supply and on the motors, follow the official parts list, and never swap supplies between arms without checking. Use a good 5 V supply on a Raspberry Pi.

## Cameras (optional, for pick and place)

- USB webcams, or a network camera that serves an MJPEG stream or JPEG pictures (for example a Raspberry Pi running this app with `--camera-only`, served at `http://<pi>:8000/raw.mjpg`).
- Pictures are requested at 640 x 480, 30 fps, MJPG. The pick and place vision and the camera mapping assume 640 x 480.
- Mount cameras **fixed on stands**, looking at the table. The mapping is learned for where the camera is; if you move it, teach the table again.
- One camera works alone. With two, the app calibrates both in one pass and fuses them.

## The table

The arm's base must be **clamped flat to the table**. The table plane then never moves relative to the arm, which pick and place relies on (it measures the table height by touching it). Keep 40 cm around the base clear. The default pick and place demo moves a red rectangular keychain from the table into a bowl; the bowl model assumes about 3 inches (76 mm) tall.

## Computers

| System | Status |
|---|---|
| macOS | Run on real hardware |
| Linux (including Raspberry Pi 5) | Run on real hardware |
| Windows | **Untested** |

A Raspberry Pi works as the computer the arm is plugged into, or as a lean camera-only server for another computer (`--camera-only`); it uses stable `/dev/v4l/by-path/...` names for identical cameras. With little memory, do not install the optional LeRobot extra there.

Next: [CALIBRATION.md](CALIBRATION.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
