// SO-101 Suite: troubleshooting. Symptom -> tests -> fixes.
// Every test and fix that touches hardware is one action with a visible result.
// "Flush" means: the plug sits level with the socket opening and does not go in any further.
export default [
  {
    id: "no-port-macos",
    symptom: "The app finds no USB port (macOS)",
    tags: ["port", "usb", "macos", "serial", "no port", "not found", "tty.usbmodem"],
    causes: [
      {
        test: "Open the Terminal app, type ls /dev/tty.usb* and press Enter. Look for a line that starts with /dev/tty.usbmodem.",
        fix: "If a line appears, your Mac sees the board. Go back to the app, reload the Motor IDs page and start the identify routine again. If the answer is 'No such file', go on to the next test."
      },
      {
        test: "Look at the USB cable. Some USB cables only charge and carry no data. Swap in a different USB-C cable, push it into the board and the Mac until it stops, then run ls /dev/tty.usb* again.",
        fix: "If a line appears now, the first cable was charge-only. Put a sticker on it so you do not use it again."
      },
      {
        test: "Look at the power supply: is it pushed into the board's power socket until it stops, and is the wall plug in? The official guide uses both the power supply and USB.",
        fix: "Push the power plug into the board until it stops, then pull the USB cable out of the board, count one-thousand-one to five, and push it back in. Run the ls test again."
      },
      {
        test: "Look at where the USB cable ends: a hub or a dock? Plug the cable straight into a USB socket on the Mac.",
        fix: "If the port now appears, the hub or dock was the problem. Keep the cable plugged straight into the Mac."
      }
    ]
  },
  {
    id: "no-port-linux",
    symptom: "The app finds no USB port (Linux or Raspberry Pi)",
    tags: ["port", "usb", "linux", "raspberry pi", "ttyACM", "no port", "not found"],
    causes: [
      {
        test: "Open a terminal, type ls /dev/ttyACM* and press Enter. Look for /dev/ttyACM0 (a second board shows as /dev/ttyACM1).",
        fix: "If you see a line, Linux sees the board; if the app still says no port, read the permission entry below. If you see 'No such file', go on to the next test."
      },
      {
        test: "Pull the USB cable out of the board, push it back in until it stops, then run the ls test again. Run dmesg | tail and look for a line that mentions ttyACM.",
        fix: "If dmesg shows nothing new when you plug in, Linux gets no signal from the board: swap the USB cable (some only charge) and try another USB socket on the computer."
      },
      {
        test: "Look at the power supply: is it pushed into the board's power socket until it stops, and is the wall plug in?",
        fix: "Push the power plug in until it stops, then repeat the ls test."
      },
      {
        test: "On a Raspberry Pi, look at where the cable ends: an unpowered hub? Plug the cable straight into one of the Pi's USB sockets.",
        fix: "Use a USB socket on the Pi itself, or a hub that has its own power supply."
      }
    ]
  },
  {
    id: "no-port-windows",
    symptom: "The app finds no USB port (Windows)",
    tags: ["port", "usb", "windows", "COM", "driver", "no port", "not found"],
    causes: [
      {
        test: "Right-click the Start button, choose Device Manager, then open the Ports (COM and LPT) group. Look for an entry that ends with a COM number, such as COM3.",
        fix: "If you see a COM entry, Windows sees the board. Reload the app's Motor IDs page and start the identify routine again."
      },
      {
        test: "In Device Manager, look for an entry named Unknown device, or one with a yellow warning triangle, that appears when you plug the board in and goes away when you unplug it.",
        fix: "Windows has no driver for the board's USB chip. Install the USB serial driver from your board's product page (check the official guide and your board's page for which one), then pull the USB cable out and push it back in."
      },
      {
        test: "Swap in a different USB cable, push it into the board and the computer until it stops, and look at the Ports group again.",
        fix: "If the COM entry appears now, the first cable was charge-only."
      }
    ]
  },
  {
    id: "permission-denied-linux",
    symptom: "'Permission denied' when opening the port (Linux)",
    tags: ["permission", "denied", "linux", "dialout", "ttyACM", "usermod", "chmod"],
    causes: [
      {
        test: "Type groups in a terminal and press Enter. Look for the word dialout in the list.",
        fix: "If dialout is missing, type sudo usermod -aG dialout $USER and press Enter. Then log out and log in again (or restart the computer). Type groups again: dialout is now in the list. A few Linux versions call the group uucp instead."
      },
      {
        test: "You need a fix right now, without logging out. Type sudo chmod 666 /dev/ttyACM0 (use your own port name) and press Enter.",
        fix: "This is the quick fix from the official guide. It lasts only until you pull the USB cable out of the board, so do the dialout fix above for good."
      }
    ]
  },
  {
    id: "port-busy",
    symptom: "'Port busy' or 'device or resource busy'",
    tags: ["port", "busy", "in use", "lsof", "one program", "serial"],
    causes: [
      {
        test: "Only one program at a time can use a port. Look at every terminal window and app window: is another one running lerobot-calibrate, lerobot-teleoperate, a dashboard, or a script for this arm?",
        fix: "Click into that terminal window and press the Ctrl and C keys together once. You will see its prompt return. Then try again in the app."
      },
      {
        test: "On macOS or Linux, type lsof followed by a space and your port name (for example lsof /dev/ttyACM0) and press Enter. The last column shows the program that holds it.",
        fix: "Quit that program the normal way. If the list is empty, pull the USB cable out of the board, count one-thousand-one to five, push it back in, and try again."
      }
    ]
  },
  {
    id: "motors-not-found",
    symptom: "No motors answer (0 motors found)",
    tags: ["motors", "not found", "no answer", "0 motors", "ids", "scan", "power"],
    causes: [
      {
        test: "Look at the power supply: is it pushed into the board's power socket until it stops, and is the wall plug in? The power cable can come loose while you handle the board.",
        fix: "Push the power plug in until it stops. If your board has a power light, you will see it light up."
      },
      {
        test: "Look at both ends of the 3-pin cable between the board and the first motor: does each plug sit flush with its socket opening?",
        fix: "Push each plug in until it sits flush. Scan again; you should see 1 or more motors answer."
      },
      {
        test: "On a Waveshare board, look at the two small jumper caps. Do both sit on the pins marked B?",
        fix: "See the entry about the Waveshare jumpers below, and press both caps onto B."
      },
      {
        test: "If the motors are brand new, they all ship as ID 1. With several chained together they answer at once and nothing can be read.",
        fix: "Pull all motors out of the board, plug in exactly ONE motor with one 3-pin cable, and set its ID, one motor at a time. The Motor IDs page guides you."
      },
      {
        test: "If the motors come from another robot, they may talk at a different speed (baud rate), so the board hears only noise.",
        fix: "Plug in exactly ONE motor and run the Motor IDs step for it. That step sets the speed as well as the ID."
      }
    ]
  },
  {
    id: "some-ids-missing",
    symptom: "Only some motor IDs answer (for example 1, 2, 3 but not 4, 5, 6)",
    tags: ["motors", "ids", "missing", "chain", "cable", "some motors"],
    causes: [
      {
        test: "Write down the lowest ID that does NOT answer, call it N. The chain is board, 1, 2, 3, 4, 5, 6, so the cable between motor N minus 1 and motor N is the suspect.",
        fix: "Pull both plugs of that cable out, then push them back in until each sits flush with its socket opening. Scan again; the missing motors answer."
      },
      {
        test: "Two motors may have the same ID, so one seems to be missing. The list shows one motor fewer than you expect.",
        fix: "Pull every motor out of the board. Plug in exactly ONE motor with one 3-pin cable, and set its ID. Repeat for each motor that is wrong."
      },
      {
        test: "Look for a cable that is bent sharply or squeezed between two printed parts.",
        fix: "Move that cable so it lies loose, then swap it for another 3-pin cable and scan again."
      }
    ]
  },
  {
    id: "set-id-refused",
    symptom: "The Set ID button is greyed out or refuses",
    tags: ["motor id", "set id", "refused", "greyed", "one motor", "disabled"],
    causes: [
      {
        test: "Read the line next to the button. It says how many motors answered. The app only writes an ID when exactly ONE motor answers.",
        fix: "If it says 2 or more: pull all motors out of the board, then plug in only the motor you want to name, with one 3-pin cable. You will see the count change to 1."
      },
      {
        test: "If the line says 0 motors answered, no motor is connected, or nothing is powered.",
        fix: "See the entry 'No motors answer'. Push every plug in until it sits flush, check the power supply and the two jumpers on B."
      },
      {
        test: "The line says a calibration or a job is running.",
        fix: "Finish or cancel it first. The app never writes an ID while something else is using the arm."
      }
    ]
  },
  {
    id: "power-light-off",
    symptom: "The board's power light is off, or nothing turns on",
    tags: ["power", "led", "light", "supply", "board", "dead"],
    causes: [
      {
        test: "Look at the power plug in the board: is it pushed in until it stops? Look at the wall plug: is it in, and is the wall socket switched on?",
        fix: "Push both plugs in until they stop. Try another wall socket to be sure. You will see the board's power light, if it has one, come on."
      },
      {
        test: "Look at the label on the power supply and check it is a supply for your board and motors (see 'Wrong power supply' below).",
        fix: "If it is the wrong kind, unplug it at once and use the right one. Do not guess."
      },
      {
        test: "Everything is plugged in, but the board stays dark with a power supply that you know works.",
        fix: "The board may be faulty. Ask in the official LeRobot Discord, with a photo of the board."
      }
    ]
  },
  {
    id: "wrong-supply",
    symptom: "Motors are weak, keep restarting, or you may have used the wrong power supply",
    tags: ["power", "voltage", "5V", "12V", "7.4V", "supply", "weak", "restart"],
    causes: [
      {
        test: "Read the voltage on the label of each power supply. Compare it with the motor version of the arm it feeds: the official list pairs 7.4V motors with a 5V supply, and a 12V motor version needs a 12V supply rated 5A or more. The leader arm is always the 7.4V kind.",
        fix: "Use the supply that matches. If you ever plugged a 12V supply into an arm with 7.4V motors, unplug it right away, let the motors cool, and ask in the official Discord before powering again."
      },
      {
        test: "Look at the voltage number the app shows for each motor while the arm moves. Does it fall a lot when a joint moves?",
        fix: "A supply that is too weak, or a loose plug, sags under load. Push the power plug in until it stops, and try a stronger supply of the same voltage."
      }
    ]
  },
  {
    id: "waveshare-jumpers",
    symptom: "A Waveshare board is plugged in but no motors answer",
    tags: ["waveshare", "jumper", "channel B", "usb", "board", "motors"],
    causes: [
      {
        test: "Look at the board: find the two small plastic jumper caps near the USB side. Do both sit on the pins marked B (USB)?",
        fix: "Pull a cap off with your fingernails and press it down onto the pins marked B, until it sits flat. Do the same for the other cap. Scan again; you should see the motors answer."
      }
    ]
  },
  {
    id: "twitch-jitter",
    symptom: "The arm twitches or jitters",
    tags: ["twitch", "jitter", "shake", "vibrate", "power", "cable", "noise"],
    causes: [
      {
        test: "Power supply or plug problem: while the arm twitches, look at the power plug in the board. Push it sideways with one fingertip, with the force you use to press a doorbell. Does the twitching change?",
        fix: "If it changes, the plug is loose or the supply is weak. Push the plug in until it stops, or try another supply of the same voltage."
      },
      {
        test: "Loose 3-pin cable: look along the chain, board then motor 1 to 6, and check each plug.",
        fix: "Push every plug in until it sits flush with its socket opening."
      },
      {
        test: "Two programs may be sending commands to the same arm. Look for another terminal window or app window that is running something for this arm.",
        fix: "Click into the other window and press Ctrl and C together once, so that only one program talks to the arm."
      },
      {
        test: "On the leader arm, a trembling hand shows up as twitching on the follower.",
        fix: "Rest the wrist of your hand on the table while you hold the handle with your fingers."
      },
      {
        test: "A joint holding against gravity may shiver a tiny bit. This is normal when it is small and the arm holds its position.",
        fix: "Nothing to fix. If it shakes a lot, look at the load and temperature readouts and see 'A motor is hot' below."
      }
    ]
  },
  {
    id: "wrong-direction",
    symptom: "A joint moves the wrong way, or the wrong joint moves",
    tags: ["direction", "reversed", "wrong joint", "ids", "calibration", "gripper"],
    causes: [
      {
        test: "First check that the page says the arm is limp. If the follower is stiff, do not touch it: press Release arm (it lowers the arm onto the table, then lets go) and wait until it says limp. Then move ONE joint by about a hand-width, and look at which bar moves in the app. Does a different joint's bar move?",
        fix: "If a different bar moves, two motor IDs are swapped. Set the IDs again, one motor at a time, with the Motor IDs page."
      },
      {
        test: "The right bar moves but in the wrong direction. Check on the Calibrate page which arm you calibrated, and that the arm is the one the app calls Leader or Follower.",
        fix: "A calibration made for the other arm gives wrong numbers. Calibrate this arm again from the start."
      },
      {
        test: "Compare how the joint is built with the official step video for that joint: is the horn on the side the video shows?",
        fix: "If a motor is mounted the wrong way round, unscrew its part, turn the motor to match the video, and calibrate again."
      },
      {
        test: "For the gripper: on the owner's arm 0 is closed and 100 is open. Squeeze the leader's trigger slowly and look at which way the gripper bar moves.",
        fix: "Check the direction with the real gripper before you trust it, and calibrate again if it is the other way round."
      }
    ]
  },
  {
    id: "calibration-joint-not-moved",
    symptom: "Calibration says a joint did not move",
    tags: ["calibration", "joint", "not moved", "range", "sweep", "span"],
    causes: [
      {
        test: "Look at that joint's bar on the Calibrate page. Are its minimum and maximum markers still close to the middle?",
        fix: "Move that joint slowly from one end stop all the way to the other end stop and back, as slowly as lowering a cup onto a saucer. You will see the markers spread out and a tick appear."
      },
      {
        test: "Turn the joint by hand and watch its bar. If the bar never moves, that motor is not answering.",
        fix: "Push the plugs on both sides of that motor in until they sit flush, and scan the motors again."
      },
      {
        test: "The joint resists strongly when you try to move it, which means its torque is still on.",
        fix: "Do not force it. Let go, press Cancel on the Calibrate page, and check that the page says the arm is limp before you start again. If the follower is stiff, press Release arm first: it lowers the arm onto the table, then lets go."
      },
      {
        test: "It is the wrist roll. The wrist roll is recorded as a full turn and does not need an end-to-end sweep.",
        fix: "Leave the wrist roll alone and continue with the other joints."
      }
    ]
  },
  {
    id: "camera-black",
    symptom: "The camera picture is black",
    tags: ["camera", "black", "no picture", "blank", "video"],
    causes: [
      {
        test: "Read the reason the app shows on the camera box. It says one of: not allowed, in use by another program, or unplugged.",
        fix: "Follow the matching entry below. A black box with no reason is a bug: please report it with 'Copy diagnostics' on the Help page."
      },
      {
        test: "Another program may be using the camera: a video-call app, a browser tab, or another copy of this app.",
        fix: "Quit those programs, then reload the Cameras page. You will see the picture come back."
      },
      {
        test: "Look at the camera's USB cable: pull it out, count one-thousand-one to five, and push it into a different USB socket until it stops.",
        fix: "If the picture returns, the first socket or the cable was the problem. Do not run two cameras through one small hub."
      },
      {
        test: "For a Raspberry Pi camera: type the Pi's camera address into your web browser's address bar and press Enter.",
        fix: "If the browser also shows nothing, the camera server on the Pi is not running. Restart it on the Pi. If the browser shows the picture, restart this app."
      }
    ]
  },
  {
    id: "camera-in-use",
    symptom: "The camera says it is in use",
    tags: ["camera", "in use", "busy", "zoom", "browser"],
    causes: [
      {
        test: "Look for video-call apps (Zoom, Meet, Teams), browser tabs that use the camera, and a second copy of this app.",
        fix: "Quit each of them. On macOS, the green dot at the top of the screen goes away when no app uses a camera."
      },
      {
        test: "A previous run of this app may still be alive in the background.",
        fix: "Quit the app from its terminal window with Ctrl and C pressed together once, then start it again."
      }
    ]
  },
  {
    id: "camera-macos-permission",
    symptom: "The camera is blocked on macOS",
    tags: ["camera", "macos", "permission", "privacy", "not allowed", "denied"],
    causes: [
      {
        test: "Open System Settings, then Privacy and Security, then Camera. Look for the program that started the app (for example Terminal) in the list.",
        fix: "Switch its toggle on. Then quit the app and start it again. macOS asks only once, so if you pressed Don't Allow earlier, the toggle is off."
      },
      {
        test: "The program is not in the list.",
        fix: "Start the app again from that program and answer Allow when macOS asks. The request has to come from the main part of the app, and the app does that for you."
      }
    ]
  },
  {
    id: "camera-missing-linux",
    symptom: "No camera shows up (Linux or Raspberry Pi)",
    tags: ["camera", "linux", "raspberry pi", "video", "v4l2", "no camera", "missing"],
    causes: [
      {
        test: "Type ls /dev/video* in a terminal and press Enter. Pull the camera's USB cable out, push it back in until it stops, and run the command again. Does a new /dev/video line appear?",
        fix: "If a line appears, the camera works: reload the Cameras page. If nothing appears, swap the USB cable and the USB socket."
      },
      {
        test: "Type v4l2-ctl --list-devices and press Enter. If the command is not found, type sudo apt install v4l-utils first.",
        fix: "The list shows every camera and its /dev/video name. Add the camera by that name."
      },
      {
        test: "Type groups and look for the word video.",
        fix: "If video is missing and you get a permission error, type sudo usermod -aG video $USER, then log out and log in again."
      }
    ]
  },
  {
    id: "camera-order-swaps",
    symptom: "Two identical cameras swap places after a restart",
    tags: ["camera", "order", "swap", "by-path", "v4l2", "two cameras", "raspberry pi"],
    causes: [
      {
        test: "Type ls /dev/v4l/by-path/ in a terminal and press Enter. You will see long names that depend on which USB socket each camera is in.",
        fix: "Add each camera by its /dev/v4l/by-path/...-video-index0 name instead of /dev/video0 or /dev/video1. Plug each camera into the same USB socket every time."
      }
    ]
  },
  {
    id: "overload-hot-motor",
    symptom: "A motor is hot, buzzes, or stops answering",
    tags: ["overload", "hot", "temperature", "buzz", "stall", "protection", "load", "motor"],
    causes: [
      {
        test: "Look at the load and temperature readouts for that motor in the app. Is the load high and staying high while the joint is not moving?",
        fix: "Press STOP. Look for something blocking the joint: the table, a cable, an end stop, or another part. Move that thing away, then try again."
      },
      {
        test: "It is the wrist roll, and its load goes very high when it turns.",
        fix: "The wrist roll motor strains against its own cable. Give the cable more slack, and keep the roll fixed during pick and place."
      },
      {
        test: "The temperature jumped by more than 10 degrees in one reading, then went back.",
        fix: "That is a bad reading, not a real one. The app ignores such jumps unless they happen three times in a row."
      },
      {
        test: "The motor stopped answering after pushing hard. Its own overload protection switched it off to save it.",
        fix: "The dashboard tries to switch it back on at its present position, up to four times a minute. If it keeps happening, something is blocking the joint: free it. Unplug the power supply and count to 60 before you plug it in again."
      }
    ]
  },
  {
    id: "gripper-no-grip",
    symptom: "The gripper closes but does not hold the object",
    tags: ["gripper", "grip", "grasp", "jaw", "pick", "perpendicular", "tilt", "pushes up"],
    causes: [
      {
        test: "The moving jaw may push the whole gripper up. Watch the gripper from the side as the jaw closes on the table: does the gripper rise or tilt when the jaw touches?",
        fix: "Raise the grab height: open Tune on the dashboard and increase 'Grab height above table' by 3 mm (the thickness of two coins stacked). The app also raises it by itself after each detected push."
      },
      {
        test: "The gripper is not perpendicular. Look at it from the side: do both jaw tips sit at the same height above the table?",
        fix: "Press Release arm and wait until the page says the arm is limp (it lowers the arm onto the table first, so nothing drops). Then hold the limp gripper straight down with both jaw tips flat on the table and press Set vertical in Tune. A tilt of 10 degrees lifts one jaw about 1 cm."
      },
      {
        test: "The app decides a hold by the gap between the jaws, not by the load. A gripper closed on nothing also reads a high load.",
        fix: "If the app says the grip failed, believe it. Check that the object lies flat on the table and is not under a jaw, then try again."
      }
    ]
  },
  {
    id: "pickplace-misses",
    symptom: "Pick and place misses the object",
    tags: ["pick and place", "miss", "camera", "mapping", "calibration", "bowl", "accuracy"],
    causes: [
      {
        test: "The camera mapping may be wrong. Run the leave-one-out check: hide each point in turn and see how far the hidden point lands. Is any point more than 2 cm off?",
        fix: "Teach the mapping again with 3 or more points spread over the whole work area, with more points if you can. A fit with 3 points always looks perfect, so rely on the leave-one-out check."
      },
      {
        test: "A camera may have been bumped since the mapping was taught. Look at the camera picture: is the table edge where it used to be?",
        fix: "Fix the camera to its stand or clamp with a tight screw, then teach the mapping again."
      },
      {
        test: "The gripper may hide the object when the camera looks for it. The visible red can sit up to about 10 cm from the real centre.",
        fix: "The app should not detect while the gripper is over the object. If you see this, use two cameras or park the arm away from the object while the camera looks."
      },
      {
        test: "Run the Hover test and look at where the gripper stops above the object.",
        fix: "If it stops above the object, the mapping is fine and the problem is lower down: check the table height and the grab height. If it stops far to one side, teach the mapping again."
      },
      {
        test: "Other red things in the picture, or very dim light, can confuse the colour detection.",
        fix: "Remove other red objects from the camera's view and add light."
      }
    ]
  },
  {
    id: "dashboard-reconnecting",
    symptom: "The dashboard says 'reconnecting'",
    tags: ["dashboard", "reconnecting", "server", "offline", "restart", "stuck"],
    causes: [
      {
        test: "Look at the terminal window where you started the app: is it still running and printing lines?",
        fix: "If the window is closed or shows a prompt, start the app again with the same command. The app restarts itself in a few seconds if it crashes and a supervisor is running."
      },
      {
        test: "Wait ten seconds. A camera or the server may be restarting.",
        fix: "If it is back, nothing to do. A lost camera should show a message and reconnect by itself."
      },
      {
        test: "After a restart the arm feels stiff, because restarting does not release the motors.",
        fix: "Do not touch the arm. Press Release arm: it lowers the arm onto the table first and then goes soft. Wait until the page says the arm is limp, then move it by hand."
      }
    ]
  },
  {
    id: "disk-full",
    symptom: "'No space left on device', or the app and your computer act strangely",
    tags: ["disk", "full", "space", "ENOSPC", "storage", "tmp", "cache"],
    causes: [
      {
        test: "Check your free disk space: on macOS open System Settings, General, then Storage. Do you have more than 5 GB free?",
        fix: "Free space until you have more than 5 GB. A full disk breaks even macOS's own permission storage. Only clear caches that can be rebuilt, for example type uv cache clean. Never delete your own files without looking."
      },
      {
        test: "On a Raspberry Pi 2 GB, /tmp lives in memory and is tiny, so pip may fail with 'No space left'.",
        fix: "Point TMPDIR at a folder on the disk before you install, and do not install LeRobot there without a CPU-only PyTorch build. Run the Pi as a camera-only server."
      }
    ]
  },
  {
    id: "python-too-new",
    symptom: "Install fails because Python is too new",
    tags: ["python", "version", "install", "3.14", "uv", "venv", "lerobot"],
    causes: [
      {
        test: "Type python3 --version in a terminal and press Enter. Is it 3.14 or newer? LeRobot works with Python 3.12; 3.14 is too new.",
        fix: "Let uv pick the right version: run the setup script again, or type uv venv --python 3.12 and install into that environment."
      }
    ]
  },
  {
    id: "stiff-after-restart",
    symptom: "The arm feels stiff even though the app is closed or restarted",
    tags: ["torque", "stiff", "limp", "restart", "release", "holding"],
    causes: [
      {
        test: "Closing or restarting the app does not release the motors. The arm may still be holding firmly.",
        fix: "Do not touch the arm. Start the app again and read the torque state it shows. If it says the arm is stiff, press Release arm: the arm lowers itself onto the table and then goes soft. Wait until it says limp, then you can move it by hand."
      },
      {
        test: "You need the arm limp and the app will not start.",
        fix: "Do not touch the arm, and do not unplug its power: a raised arm would drop. Keep your hands and your things away from it and open Help (the Help page or the project's issue page) before you do anything else."
      }
    ]
  },
  {
    id: "macos-files-blocked",
    symptom: "'Operation not permitted' on files in Documents (macOS)",
    tags: ["macos", "permission", "operation not permitted", "documents", "privacy", "TCC"],
    causes: [
      {
        test: "Open System Settings, Privacy and Security, Files and Folders (also look at Full Disk Access). Is the program that runs the app allowed to use Documents?",
        fix: "Switch the toggle on, then quit and restart the program. macOS can silently take this permission away."
      },
      {
        test: "It still fails.",
        fix: "Move the project folder out of Documents, for example to a folder in your home folder, and run the app from there."
      }
    ]
  },
  {
    id: "wrong-arm-moves",
    symptom: "The wrong arm moves, or Leader and Follower are swapped",
    tags: ["leader", "follower", "swapped", "role", "port", "identify", "wrong arm"],
    causes: [
      {
        test: "On Linux the port numbers (ttyACM0, ttyACM1) can swap between runs, so a port may belong to the other arm now.",
        fix: "Run the identify routine again on the Motor IDs page. When it tells you to unplug, pull the USB cable of the arm you want to name out of its board, count one-thousand-one to five, and push it back in when asked. Then give that port the right name."
      },
      {
        test: "Check the port names for each arm on the Settings page under Devices.",
        fix: "Swap the Leader and Follower names there if they are the wrong way round. Do not start teleoperation until both are right."
      }
    ]
  },
  {
    id: "follower-does-not-match",
    symptom: "The follower does not match the leader's pose",
    tags: ["teleoperation", "calibration", "mismatch", "leader", "follower", "offset"],
    causes: [
      {
        test: "Put both arms in the same pose by hand, looking from above so they point the same way with their elbows bent by about the same amount. Look at the numbers for each joint on the page: are they about the same on both arms?",
        fix: "If they differ a lot for a joint, calibrate both arms again. Move each joint through its full range on both arms; if you move it only part of the way, the middle ends up in the wrong place."
      },
      {
        test: "The gripper reads very differently on the two arms.",
        fix: "On the owner's arm 0 is closed and 100 is open. Calibrate the gripper on both arms again, with the jaws all the way open and all the way closed."
      }
    ]
  }
];
