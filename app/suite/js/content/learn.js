// SO-101 Suite: Learn articles.
// body items: "paragraph" | {list:[..]} | {callout:{kind:"tip"|"warn"|"safety"|"why", text}} | {steps:[..]}
// Strings may use only the inline tags <b>, <i>, <code>. Hash links (#/...) are routes inside the app.
const OFFICIAL = "https://huggingface.co/docs/lerobot/so101";
const SO_ARM = "https://github.com/TheRobotStudio/SO-ARM100";

export default [
  {
    id: "meet-your-arm",
    title: "Meet your arm",
    level: "start",
    minutes: 5,
    summary: "Name every part of your SO-101 and learn which motor moves what. A finger is really a jaw: you have two, not five.",
    body: [
      "Your SO-101 kit makes <b>two arms</b>. The <b>follower</b> does the work. The <b>leader</b> is the one you hold and move by hand, and the follower copies it. Each arm has six motors, and each motor drives one joint.",
      "A <b>joint</b> is a place where the arm bends or turns. Going up from the table, the six joints are:",
      {
        list: [
          "<b>Shoulder pan</b> (motor 1): turns the whole arm left and right, like shaking your head no.",
          "<b>Shoulder lift</b> (motor 2): tips the upper arm forward and back, like raising your arm.",
          "<b>Elbow flex</b> (motor 3): bends the forearm at the elbow.",
          "<b>Wrist flex</b> (motor 4): nods the hand up and down.",
          "<b>Wrist roll</b> (motor 5): twists the hand like a doorknob.",
          "<b>Gripper</b> (motor 6): opens and closes the jaws."
        ]
      },
      "Between the joints are printed pieces: the base, the shoulder, the upper arm, the forearm, the wrist, and the hand (we call it the gripper body). Each piece carries the motor of the <i>next</i> joint. That makes the arm a chain: a turn low in the chain moves everything above it.",
      {
        callout: {
          kind: "why",
          text: "People ask where the fingers are. The SO-101 has <b>two jaws, not five fingers</b>. One jaw is part of the printed hand and never moves by itself: the <b>fixed jaw</b>. The other one swings open and closed, moved by motor 6: the <b>moving jaw</b>. Together they pinch."
        }
      },
      "Each motor is a black box with a round spindle that turns. A small round disc called a <b>horn</b> presses onto the spindle, and a printed piece is screwed onto the horn. When the motor turns, the piece turns with it.",
      "The last part is the <b>USB servo board</b> in the base. It joins your computer and the power supply to the chain of motors. Every motor has a number, the <b>motor ID</b>, so the board can talk to one motor at a time.",
      {
        callout: {
          kind: "tip",
          text: "Open the <b>Meet your arm</b> page and click each part of the 3D arm. It lights up and shows its joint name, its motor ID and a short explanation."
        }
      }
    ],
    links: [
      { label: "Glossary: every word explained", href: "#/glossary" },
      { label: "What is a servo?", href: "#/learn/what-is-a-servo" },
      { label: "Official SO-101 build guide", href: OFFICIAL }
    ]
  },
  {
    id: "how-it-works",
    title: "How leader and follower work together",
    level: "start",
    minutes: 4,
    summary: "One picture in words: you move the leader, your computer reads it, and the follower copies it.",
    body: [
      "Picture this chain: <code>you -> leader arm -> computer -> follower arm -> the table</code>.",
      {
        steps: [
          "You hold the leader's handle and move it. The leader's motors are limp, so it moves easily.",
          "The leader's motors measure the angle of every joint. They do not push; they only report.",
          "Your computer reads those six angles many times a second. The app does it more than a hundred times a second.",
          "The computer sends the same six angles to the follower.",
          "The follower's motors turn to those angles and hold them, so the follower copies you."
        ]
      },
      "This is called <b>teleoperation</b>: controlling a robot live, from a distance. There is no wireless link between the arms. Both are plugged into the computer, and the computer sits in the middle.",
      {
        callout: {
          kind: "why",
          text: "This only works if the two arms agree. If the leader says 'my elbow is at 30' and the follower's 30 is a different bend, the copy looks wrong. That is what <b>calibration</b> fixes: after it, the same pose gives the same numbers on both arms."
        }
      },
      "The app adds safety rules around this loop. The follower catches up to the leader at a limited speed at first. It stops if a motor pushes too hard or gets too hot. It will not push into the table, and it will not follow the leader into the bowl in the pick and place demo.",
      {
        callout: {
          kind: "safety",
          text: "Teleoperation never starts on its own. The start button appears only when both arms are connected and calibrated, and you press it."
        }
      },
      "Why two arms at all? Because later you can record yourself doing a task with the leader, and teach an AI to copy it. That is the road in <b>From here to AI</b>."
    ],
    links: [
      { label: "Why calibrate?", href: "#/learn/why-calibrate" },
      { label: "From here to AI", href: "#/learn/from-here-to-ai" },
      { label: "Teleoperation in the glossary", href: "#/glossary" }
    ]
  },
  {
    id: "what-is-a-servo",
    title: "What is a servo?",
    level: "start",
    minutes: 4,
    summary: "Every joint is driven by a servo: a motor that knows its own angle, holds it, and reports how it feels.",
    body: [
      "A plain motor just spins when you give it power. A <b>servo</b> is a motor with a brain: you tell it an angle and it turns there, then holds that angle even if you push on it.",
      "Inside the case of each servo there are four things: a small electric motor, a set of gears, a sensor that measures the angle, and a little circuit board that listens to your commands and compares the angle it wants with the angle it measures.",
      "Your arm uses the <b>STS3215</b>, made by Feetech. It is a <i>bus</i> servo: instead of one wire per motor, all the motors share one 3-pin cable. Each motor answers only to its own number, its <b>motor ID</b>.",
      "The STS3215 reports back four useful things: its position, its <b>load</b> (how hard it pushes), its <b>temperature</b> and its <b>voltage</b>. The app reads them ten times a second, and that is how it knows when a motor is straining.",
      "<b>Gears.</b> The motor spins fast but weakly. Gears slow it down and make it strong. The follower has six motors with a 1/345 gear ratio, which means 345 motor turns for one turn of the joint. The leader uses three kinds so it can hold its own weight and still move easily by hand: 1/191 for shoulder pan and elbow flex, 1/345 for shoulder lift, and 1/147 for wrist flex, wrist roll and gripper.",
      "<b>Torque on or limp.</b> With torque on, a servo holds its angle and fights you. With torque off, the joint is <b>limp</b>: it moves freely and gravity pulls the arm down. Calibration is done with torque off, so that you can move the joints by hand. Never touch an arm whose torque is on: lower it and make it limp first.",
      {
        callout: {
          kind: "safety",
          text: "A servo with torque on holds firmly. Keep your fingers out of the gaps at every joint when an arm is powered. Do not touch or move an arm whose torque is on: make it limp first, lowered, with <b>Release arm</b>."
        }
      }
    ],
    links: [
      { label: "Motor IDs explained", href: "#/learn/motor-ids-explained" },
      { label: "Power and cables", href: "#/learn/power-and-cables" },
      { label: "Glossary: servo, torque, load", href: "#/glossary" }
    ]
  },
  {
    id: "motor-ids-explained",
    title: "Motor IDs explained",
    level: "start",
    minutes: 6,
    summary: "Why every motor needs its own number, and how to give each one its number safely, one at a time.",
    body: [
      "All six motors of an arm share one cable. When your computer sends a command, it has to say who it is for. That is the <b>motor ID</b>: shoulder pan is 1, shoulder lift 2, elbow flex 3, wrist flex 4, wrist roll 5, gripper 6.",
      "<b>The catch.</b> New motors usually all ship as ID 1. If you chain six of them together, they all answer to 1 at once and nothing works. So you give each motor its number <b>one motor at a time</b>, with only that motor plugged into the board.",
      "The number is written into the motor's own memory (its EEPROM), so you only do this once per motor. If you reuse motors from another robot you will probably have to do it again. At the same time, the same speed for talking (the <b>baud rate</b>) is set for every motor, so the board and the motors agree.",
      "The official order is: <b>gripper first</b> (it becomes ID 6), then wrist roll (5), wrist flex (4), elbow flex (3), shoulder lift (2) and last shoulder pan (1). The app follows this order.",
      "Here is how to set ONE motor's ID. Repeat it for each of the six motors, once per arm.",
      {
        steps: [
          "Unplug the power supply from the wall, and pull the USB cable out of the board.",
          "Pull every 3-pin cable out of the board's motor sockets. Leave the board's two jumpers on channel B (USB).",
          "Pick up the motor you are naming, a black box about two and a quarter finger-widths long. Start with the gripper motor.",
          "Push one plug of a 3-pin cable into either socket of that motor until the plug sits flush with the socket opening.",
          "Push the other plug of that cable into a motor socket on the board until it sits flush too.",
          "Check that this is the only motor attached: no other cable leads to the board, and this motor's second socket is empty.",
          "Plug the USB cable into the board and into your computer.",
          "Plug the power supply into the board, then into the wall.",
          "Open the Motor IDs page and look at the list of motors that answered. You want to see exactly 1. If your board has a power light, it is on.",
          "Press the button on that page that sets the ID, the one that names the number you want (for the gripper motor, 6).",
          "Read the message on the page: it confirms the new ID. Write that number on a small sticker and stick it on the motor.",
          "Unplug the power supply, pull the 3-pin cable out of the board (it can stay in the motor), and go on with the next motor in the order above."
        ]
      },
      {
        callout: {
          kind: "warn",
          text: "If the page shows 0 motors: push every plug in until it sits flush, check that the power supply is plugged into the board and the wall, check that both jumpers are on channel B, and try another USB cable (some cables only charge). If it shows 2 or more motors: pull all the motors out of the board and start again with just one."
        }
      },
      {
        callout: {
          kind: "tip",
          text: "Do this before assembly. The official guide sets the IDs first, because each motor has to be plugged in alone, and that is easiest when it is not yet bolted inside the arm. After all six have an ID, you chain them: each motor to the next, and motor 1 to the board."
        }
      }
    ],
    links: [
      { label: "Motor IDs page", href: "#/motors" },
      { label: "Official guide: configure the motors", href: OFFICIAL },
      { label: "Find your port", href: "#/learn/find-your-port" }
    ]
  },
  {
    id: "find-your-port",
    title: "Find your arm's USB port",
    level: "start",
    minutes: 4,
    summary: "Your computer gives each board a name called a port. Learn what it looks like on your system and how the app finds it.",
    body: [
      "A <b>port</b> is the name your computer gives to a USB device. Each arm's board has its own port. The name depends on your system:",
      {
        list: [
          "macOS: <code>/dev/tty.usbmodem</code> followed by numbers and letters.",
          "Linux and Raspberry Pi: <code>/dev/ttyACM0</code>, then <code>/dev/ttyACM1</code> for a second board.",
          "Windows: <code>COM3</code>, or another COM number."
        ]
      },
      "With two boards plugged in you need to know which port is the leader and which is the follower. The app finds out by asking you to unplug one board and plug it back in, because the port that disappears is that board's.",
      {
        steps: [
          "Plug the USB cable of the arm you want to name into your computer, and plug the power supply into that arm's board.",
          "Open the Motor IDs page and start the identify routine. It tells you when to unplug.",
          "When the page asks, pull the USB cable out of that arm's board, straight out, as far as it comes. Count one-thousand-one, one-thousand-two.",
          "When the page asks, push the USB cable back into the board until it stops.",
          "Wait for the page to say which port is this arm's, then choose Leader or Follower for it."
        ]
      },
      {
        callout: {
          kind: "warn",
          text: "Linux says 'permission denied'? Run <code>sudo usermod -aG dialout $USER</code>, then log out and log in again. A quick, temporary fix from the official guide is <code>sudo chmod 666 /dev/ttyACM0</code> (it lasts until you unplug the board)."
        }
      },
      {
        callout: {
          kind: "tip",
          text: "Only one program can use a port at a time. If the app says the port is busy, close any other window that is using the arm, such as another terminal running LeRobot."
        }
      }
    ],
    links: [
      { label: "Troubleshooting: no port found", href: "#/help" },
      { label: "Official guide: find the USB ports", href: OFFICIAL }
    ]
  },
  {
    id: "why-calibrate",
    title: "Why calibrate (and what zero means)",
    level: "start",
    minutes: 7,
    summary: "Calibration teaches each arm where its joints start and stop. Afterwards 0 is the middle of the range you recorded, and both arms agree.",
    body: [
      "A motor only knows a raw number between 0 and 4095 for one full turn. It does not know what 'straight' means on your arm. Two arms built a little differently give two different raw numbers for the same pose.",
      "<b>Calibration</b> fixes that. For every joint, the arm records the lowest and the highest position it can reach. Then:",
      {
        list: [
          "<b>0 is the middle of the range you recorded.</b> It is not 'the arm looks straight'.",
          "In <b>degrees</b>: a joint reads (raw reading minus the halfway point of the range) times 360 divided by 4095. The halfway point reads 0, one end reads a negative number, the other end a positive number.",
          "In the <b>-100 to +100</b> scale LeRobot uses: the lowest point is -100, the middle is 0 and the highest point is +100. The gripper is different: it runs from 0 to 100."
        ]
      },
      {
        callout: {
          kind: "why",
          text: "Both arms must agree. After calibration the leader and the follower report the same numbers in the same physical pose, so the follower can copy the leader. An AI trained on one robot can then work on another."
        }
      },
      "The <b>wrist roll</b> can spin around freely, so it is calibrated as a full turn and you do not sweep it from end to end. All the other joints you move through their full range, from one end stop to the other.",
      "Two things go wrong most often. First, moving a joint only part of the way: the middle then ends up in the wrong place. Second, thinking that 0 means 'looks straight': it means the middle of what you recorded.",
      "The result is saved as a file, the same file LeRobot uses: <code>~/.cache/huggingface/lerobot/calibration/robots/so_follower/YOUR-NAME.json</code> for the follower and <code>.../teleoperators/so_leader/YOUR-NAME.json</code> for the leader.",
      "Here is how to calibrate one arm in the app:",
      {
        steps: [
          "Plug in the arm's USB cable and power supply, then open the Calibrate page and choose that arm.",
          "Read the picture of the middle pose on the page: every joint about halfway through its travel.",
          "Read the first line of the card the page shows: it must say <b>The arm is limp.</b> If the follower arm is stiff (holding itself), do not touch it: press <b>Lower the arm and make it limp</b> and keep your hands clear until it says limp. The arm lowers itself onto the table first, so nothing drops. (The leader arm is always limp.)",
          "Only now, with the arm limp, take it in your hands and move each joint until it looks like the picture, then press the button that says the arm is centred (<b>It's centred</b>) with your free hand.",
          "Move ONE joint from one end stop all the way to the other end stop, and back again. Go as slowly as lowering a cup onto a saucer.",
          "Look at that joint's bar on the page. You will see its minimum and maximum markers move outward from the middle, and a tick appears when the span is big enough.",
          "Do steps 5 and 6 for each joint in turn, except the wrist roll. Leave the wrist roll alone.",
          "Press the button that saves the calibration (<b>Save</b>). The page shows the file path it saved to."
        ]
      },
      {
        callout: {
          kind: "tip",
          text: "If you are unsure what the middle pose looks like, the official calibration video shows it. Move slowly and stop when a joint touches its end stop: do not force it."
        }
      }
    ],
    links: [
      { label: "Calibrate page", href: "#/calibrate" },
      { label: "Official guide: calibration video", href: OFFICIAL },
      { label: "Lessons learned: zero is the middle", href: "#/learn/lessons-learned" }
    ]
  },
  {
    id: "first-moves-safely",
    title: "Your first moves, safely",
    level: "start",
    minutes: 5,
    summary: "A short routine for powering up and moving your arm for the first time, with a hand on the STOP button.",
    body: [
      "The arm is small but strong. It can pinch a finger and knock things over. This routine keeps the first minutes boring, which is what you want.",
      "The rule of the app: <b>the arm moves only when you ask</b>. Before every move, the app says in one sentence what will move, and asks you to confirm inside the page. No pop-ups.",
      "Get ready:",
      {
        steps: [
          "Clear the table around the arm base: remove everything within 40 cm, about a ruler and a hand-width, in all directions.",
          "Push the top edge of the base sideways with one fingertip, with the force you use to press a doorbell. The base must not rock or slide. If it does, tighten the table clamp until it stops.",
          "Read the voltage on the power supply's label. Compare it with the motor version you ordered (7.4V or 12V). They must match (see Power and cables).",
          "Plug the USB cable into the board and into your computer.",
          "Plug the power supply into the board first, then into the wall.",
          "Open the Setup check page and wait until the chip for this arm at the top of the page shows it is connected.",
          "Find the <b>STOP</b> button at the top of the page. Rest the hand you use for the mouse near it."
        ]
      },
      "Make the first move small:",
      {
        steps: [
          "Press the button for the first move the page offers. Read its sentence before you confirm it.",
          "Take both hands off the arm and keep them, and your face, at least 40 cm from the base until the move ends.",
          "Watch the 3D arm on the page and the real arm side by side. You will see them move the same way.",
          "If the real arm moves in any other way than the sentence said, press STOP at once."
        ]
      },
      {
        callout: {
          kind: "safety",
          text: "<b>STOP</b> holds the arm where it is. To make the follower limp, press <b>Release arm</b>: it lowers the arm onto the table first and only then lets go, so nothing drops and nobody has to hold it. Keep your hands clear until the page says the arm is limp. Pulling the power plug out also makes an arm limp, and a raised arm drops: do not do that."
        }
      },
      {
        callout: {
          kind: "warn",
          text: "Closing or restarting the app does not release the motors. An arm that looks idle may still be holding firmly. Check on the page whether the arm is limp before you touch it. If it is stiff, do not touch it."
        }
      },
      "Starting teleoperation for the first time: lay the two arms in about the same pose before you press start. Looking from above, they should point the same way and have their elbows bent by about the same amount. The follower then makes only a small first move, and it catches up gently."
    ],
    links: [
      { label: "Safety checklist", href: "#/learn/safety-checklist" },
      { label: "Control page", href: "#/control" },
      { label: "Troubleshooting", href: "#/help" }
    ]
  },
  {
    id: "cameras-and-the-table",
    title: "Cameras and the table",
    level: "next",
    minutes: 7,
    summary: "How a dot in the camera picture becomes a spot on the table, why you need several spread-out points, and why a perfect fit can lie.",
    body: [
      "A camera sees <b>pixels</b>: dots in a picture. The arm works in real distances. The <b>camera mapping</b> is the recipe that turns 'this pixel' into 'this spot on the table'. It works for things lying <i>on</i> the table, because the table is flat.",
      "You teach it with <b>taught points</b>: the gripper tip touches a known spot on the table, and you tell the app where that spot is in the picture. Each pair, a spot on the table and a pixel, is one taught point.",
      {
        callout: {
          kind: "why",
          text: "Why <b>3 or more, spread out</b>? With fewer points the maths cannot settle. With points all close together, a small click error becomes a big error far away, like judging a long ruler from one inch of it. Put points far apart, near the corners of the area where the arm will work. More is better: the owner's best run used about 14."
        }
      },
      "<b>A perfect fit proves nothing.</b> With exactly 3 points, a simple fit always matches them perfectly, so 'fit error 0.0 mm' is meaningless. The honest test is <b>leave-one-out</b>: hide one point, fit with the others, and see how far off the hidden point lands. Do it for every point. If all of them land close, the mapping predicts spots it has never seen, and you can trust it.",
      "<b>The gripper hides the target.</b> From above, the gripper covers the object it is about to pick up. The visible part of the object then sits up to about 10 cm away from its real centre. So the app never detects the target while the gripper is over it. It remembers where it last saw the object clearly, or uses another camera.",
      "<b>Do not judge the gripper tip by eye</b> in a top-down picture. The body of the gripper hides the tip. What works better is to clamp a red object in the gripper, let the arm visit about 14 known poses by itself, and fit the camera to the joint readings.",
      "<b>Two cameras.</b> Calibrate both in the same pass. The app then averages them, trusting a fully visible detection more than a partly hidden one, and reports how far apart the two cameras are. A good mapping is correct to about 1 to 2 cm, enough for a gripper opening of 6 cm.",
      {
        callout: {
          kind: "warn",
          text: "If a camera moves, even a little, its mapping is wrong. Fix the camera to a stand or clamp and teach the mapping again after anything bumps it."
        }
      },
      {
        callout: {
          kind: "tip",
          text: "A black camera box is a bug, not a feature. The app shows you why: not allowed, in use by another program, or unplugged. See Troubleshooting."
        }
      }
    ],
    links: [
      { label: "Cameras page", href: "#/cameras" },
      { label: "Troubleshooting: camera", href: "#/help" },
      { label: "Pick and place", href: "#/learn/what-is-pick-and-place" }
    ]
  },
  {
    id: "what-is-pick-and-place",
    title: "What is pick and place?",
    level: "next",
    minutes: 6,
    summary: "The demo that finds an object with cameras, picks it up, and puts it in a bowl, and the checks that keep it honest.",
    body: [
      "<b>Pick and place</b> means picking an object up from one spot and putting it down in another. The demo in this app finds a red keychain on the table and puts it in a bowl, using one or two cameras.",
      "It is <i>classic programming</i>, not AI. There is no learning: just cameras, maths and rules. That makes every step easy to check.",
      {
        steps: [
          "<b>See.</b> The cameras find the red keychain and the bowl, every run. Nothing is stored by hand: things on the table get moved.",
          "<b>Work out where.</b> The camera mapping turns pixels into table positions. Inverse kinematics turns that position into joint angles.",
          "<b>Hover.</b> The arm moves above the keychain, with the gripper pointing straight down.",
          "<b>Touch down.</b> It lowers the gripper in tiny steps until the motors feel the table, and saves how far that was from expected.",
          "<b>Pinch.</b> It closes the jaws slowly, starting 4 mm above the table, about the thickness of two coins stacked.",
          "<b>Check the hold.</b> It measures the gap between the jaws: a real hold is a clearly wider gap than a gripper closed on nothing.",
          "<b>Carry.</b> It lifts straight up, travels above the rim of the bowl, and checks the hold all along the way.",
          "<b>Release and look.</b> It lets go over the bowl, and the cameras check that the keychain is there."
        ]
      },
      {
        callout: {
          kind: "why",
          text: "The hard rules come from real mistakes. The gripper must point straight down. A failed grasp stops everything: the arm never carries an empty gripper to the bowl. The bowl is treated as an obstacle, with a model of its real shape. Read the Lessons learned article for the stories."
        }
      },
      "If a grasp fails, the arm opens the jaws, goes straight up, parks high over the bowl so the cameras see the table again, finds the keychain, and tries again with a small shift. After 4 tries it gives up and tells you the real reason.",
      {
        callout: {
          kind: "tip",
          text: "Start with the <b>Hover test</b>: the arm moves above the keychain and stops, so you can check that the camera mapping is right before it ever touches anything."
        }
      }
    ],
    links: [
      { label: "Cameras and the table", href: "#/learn/cameras-and-the-table" },
      { label: "Lessons learned", href: "#/learn/lessons-learned" },
      { label: "Control page", href: "#/control" }
    ]
  },
  {
    id: "kinematics-in-plain-words",
    title: "Kinematics in plain words",
    level: "deep",
    minutes: 6,
    summary: "The maths that links joint angles to where the gripper is, and why a wrong zero makes the gripper point backwards.",
    body: [
      "<b>Kinematics</b> is the maths of how a chain of pieces moves. Two directions matter:",
      {
        list: [
          "<b>Forward kinematics:</b> give it the six joint angles, and it tells you where the gripper is and which way it points.",
          "<b>Inverse kinematics:</b> give it a spot you want the gripper to reach, and it works out the joint angles. There can be no answer: the spot may be out of reach, and then the app says so."
        ]
      },
      "To do this the maths needs the arm's shape. It comes from the official SO-101 <b>URDF</b>, a text file that lists every link (rigid piece), every joint, and their sizes. The 3D arm in this app is drawn from the same file, so the picture and the maths agree.",
      "Pick and place needs inverse kinematics: the camera says where the object is, and the maths finds the angles that put the jaws there, pointing straight down. That is why the gripper has to be <b>perpendicular</b>: the app only accepts a tool within 3 degrees of straight down, or it reports 'out of reach'.",
      {
        callout: {
          kind: "why",
          text: "The maths trusts the joint zeros. If the zero of a joint is wrong by a few degrees, 'straight down' is wrong too, and one jaw ends up about 1 cm above the table. The check: with the arm limp, hold the gripper straight down on the table; the model must say the tool points about straight down and its tip is at table height."
        }
      },
      "<b>Reach.</b> With the tool vertical, at about 22 cm from the base the arm reaches about 10 cm above the table but not 12 cm. So travel heights lower themselves when they must, but never below the rim of the bowl near the bowl.",
      "<b>Tool point.</b> The maths treats one invisible point near the jaw tips as 'the gripper'. On the owner's arm the real jaw ends sit about 14 mm short of it, which the app allows for by touching down in tiny steps."
    ],
    links: [
      { label: "Why calibrate", href: "#/learn/why-calibrate" },
      { label: "Lessons learned: perpendicular", href: "#/learn/lessons-learned" },
      { label: "Glossary: kinematics, URDF", href: "#/glossary" }
    ]
  },
  {
    id: "power-and-cables",
    title: "Power and cables",
    level: "start",
    minutes: 4,
    summary: "Which power supply goes with which arm, how the cables join up, and the small checks that fix half of all problems.",
    body: [
      "Each arm needs three things: a <b>power supply</b>, a <b>USB cable</b> and <b>3-pin cables</b>. The USB cable joins the board to your computer. The power supply plugs into the board and feeds the motors. The 3-pin cables carry power and data from the board to motor 1 and from each motor to the next.",
      "<b>Match the power supply to the motors.</b> The official parts list pairs the 7.4V motors with a 5V supply. A 12V motor version also exists, and then you need a 12V supply rated 5A or more. The leader arm is always the 7.4V kind. So the two arms may need two different supplies.",
      {
        callout: {
          kind: "safety",
          text: "Read the label on the supply and on the motors before you plug in. Do not plug a 12V supply into an arm with 7.4V motors, and do not swap supplies between arms without checking. If you are unsure, check the official guide."
        }
      },
      "<b>The chain.</b> The six motors are joined in a row: board to motor 1, motor 1 to motor 2, and so on up to motor 6. Each motor has two sockets, one for the cable coming in and one for the cable going out. If one cable in the middle is loose, every motor after it stops answering.",
      "<b>Waveshare boards.</b> Both jumpers must sit on channel B (USB). That is the setting the official guide asks for.",
      "<b>One program per port.</b> Only one program at a time can talk to a board. If something is busy, look for another window that is using the arm.",
      {
        callout: {
          kind: "tip",
          text: "When a motor does not answer, check in this order: the power supply, the USB cable, the 3-pin cable, the jumpers. Push each plug in until it sits flush. The power cable can come loose while you handle the board."
        }
      }
    ],
    links: [
      { label: "Motor IDs explained", href: "#/learn/motor-ids-explained" },
      { label: "Troubleshooting: motors not found", href: "#/help" },
      { label: "Parts list and printing (SO-ARM100)", href: SO_ARM }
    ]
  },
  {
    id: "from-here-to-ai",
    title: "From here to AI",
    level: "deep",
    minutes: 5,
    summary: "Where to go after your arm moves: record demonstrations with the leader, train a policy, and let the follower do the task alone.",
    body: [
      "Once your arms are calibrated and teleoperation works, you have everything for <b>imitation learning</b>: teaching a robot by showing it.",
      {
        steps: [
          "<b>Record.</b> You move the leader to do a task many times. LeRobot saves what the cameras saw and what the joints did. Each run is an <b>episode</b>, and all of them together form a <b>dataset</b>.",
          "<b>Train.</b> A computer with a good graphics card (CUDA GPU) trains a <b>policy</b>, the AI 'brain', on the dataset. A popular choice is called ACT.",
          "<b>Run.</b> The policy drives the follower alone, with no leader."
        ]
      },
      {
        callout: {
          kind: "why",
          text: "None of this works well if the arms are not calibrated. The policy learns from joint numbers, so the same pose must give the same numbers every time and on every arm."
        }
      },
      "This app does not record or train for you. That is LeRobot's job, and it is free and well documented. You can install LeRobot next to the app (it is an optional extra). The links below take you to the official tutorials.",
      {
        callout: {
          kind: "tip",
          text: "Plan for training time and space. The Raspberry Pi is good for cameras but too small for training. Use a computer with a graphics card, and keep at least 5 GB of disk free while you record."
        }
      }
    ],
    links: [
      { label: "LeRobot: getting started with real-world robots", href: "https://huggingface.co/docs/lerobot/il_robots" },
      { label: "LeRobot installation guide", href: "https://huggingface.co/docs/lerobot/installation" },
      { label: "LeRobot community on Discord", href: "https://discord.com/invite/s3KuuzsPFb" }
    ]
  },
  {
    id: "lessons-learned",
    title: "What we learned the hard way",
    level: "next",
    minutes: 8,
    summary: "Ten short stories from real hardware: each one cost time, and each is now a rule in the app.",
    body: [
      "These stories come from the first working run of pick and place: a keychain from the table into a bowl. Every one of them cost real time.",
      "<b>1. Zero is the middle of the range, not 'the centred pose'.</b> Someone 'fixed' the zero to the exact middle of the motor's scale, and the gripper then pointed backwards at the base. Zero is the middle of the range you recorded. Check on a live pose: with the arm limp, hold the gripper straight down on the table. The model should say the tool points about straight down, with its tip near table height.",
      "<b>2. Measure the table height by touching.</b> A hand-taught guess was 40 mm wrong. The arm is clamped to the table, so the table never moves relative to the arm. Lowering the tip 3 mm at a time until the motors push back gave the real number. Measure once, and again only if you remount the arm.",
      "<b>3. The gripper must be perpendicular.</b> One jaw 1 cm above the table means no grip at all. A tilt of only 10 degrees lifts one jaw about 1 cm when the jaws are 5 cm apart. The app now accepts only a gripper within 3 degrees of straight down. The closing jaw can also push the gripper up off the table, so the app pinches a few millimetres above it.",
      "<b>4. Never carry on after a failed grasp.</b> A gripper closed on nothing pushes hard against its own jaws, and the app once read that as a hold. It carried an empty gripper to the bowl, twice. Now a hold means the gap between the jaws, measured at every stage. A failure stops the job, and after 4 tries it gives up with the real reason.",
      "<b>5. The app must never get stuck.</b> Jobs that stopped reporting, serial transfers that never ended, motors that cut themselves off, servers that died: each left the buttons dead. Now there is a watchdog, a Reset button that always works, a timeout on the USB link, and a supervisor that restarts the server in about 3 seconds.",
      "<b>6. Hand-held poses beat measuring.</b> People cannot measure exact centimetres from a point they cannot see. Holding the limp arm with both jaw tips flat on the table, and letting the app read the joints, showed that the wrist zero was off by about 12 degrees. The hands did the placing, the motors did the measuring.",
      "<b>7. A perfect fit means nothing.</b> With 3 points a simple fit always matches, so 'error 0.0 mm' was a lie. Leave-one-out showed the truth. The gripper also hides the target: the red you see is up to about 10 cm from the real centre.",
      "<b>8. Buttons must work, and say why they do not.</b> A page that redrew itself on every live number ate clicks: the button a person aimed at no longer existed. Pop-ups can be blocked silently. Now disabled buttons look disabled, with a reason beside them, and every instruction is tested with a real click before it is written down.",
      "<b>9. A full disk breaks everything.</b> When the disk filled, even macOS's own permission storage failed. Keep more than 5 GB free, and only clear caches that can be rebuilt, never your own files.",
      "<b>10. Camera permissions fail silently.</b> macOS can block a camera without any message, and the permission must be requested from the main thread, not from a worker. A black picture with no reason is a bug, so the app now says why: not allowed, in use, or unplugged.",
      {
        callout: {
          kind: "tip",
          text: "The theme in all ten: check against the real thing, let sensors do the measuring, say why every time, and never leave the person with a dead end."
        }
      }
    ],
    links: [
      { label: "Why calibrate", href: "#/learn/why-calibrate" },
      { label: "Cameras and the table", href: "#/learn/cameras-and-the-table" },
      { label: "Troubleshooting", href: "#/help" }
    ]
  },
  {
    id: "safety-checklist",
    title: "Safety checklist",
    level: "start",
    minutes: 3,
    summary: "Run through this list before every session. It takes two minutes and keeps your fingers, your table and your motors safe.",
    body: [
      "Work down the list. Each line is one action with something you can see.",
      {
        steps: [
          "Look at the base: it is clamped to the table. Push its top edge sideways with one fingertip, with the force you use to press a doorbell. It must not rock or slide.",
          "Clear the table within 40 cm of the base, about a ruler and a hand-width. Only the arm, the board and the object you will move stay there.",
          "Tie back long hair and push up loose sleeves, so nothing dangles near the arm.",
          "Read the label on each power supply and check it matches the motor version (7.4V or 12V) of the arm it feeds.",
          "Look along every cable: none may cross the space the arm sweeps, and each plug must be pushed in until it sits flush.",
          "Find the STOP button on screen and rest your mouse hand near it.",
          "Keep your fingers out of the gap between the two jaws, and out of the gap at every joint, whenever an arm is powered.",
          "Never touch an arm that is stiff (holding itself). To make it limp, press <b>Release arm</b>: it lowers the arm onto the table first and then lets go. Wait until the page says the arm is limp.",
          "Do not leave a powered arm alone. Stay in the room, or unplug the power supply before you go."
        ]
      },
      {
        callout: {
          kind: "safety",
          text: "<b>STOP</b> holds the arm where it is. <b>Release arm</b> lowers it onto the table first and only then lets go, so nothing drops. Pulling the power plug also makes it limp, and a raised arm drops: do not do that. Never touch a stiff arm."
        }
      },
      {
        callout: {
          kind: "warn",
          text: "A motor that is hot, buzzing against an end stop, or pushing hard against a cable needs a break. Press STOP, unplug the power supply and let it cool before you try again. The app also stops by itself when a motor pushes too hard or gets too hot."
        }
      }
    ],
    links: [
      { label: "Your first moves, safely", href: "#/learn/first-moves-safely" },
      { label: "Power and cables", href: "#/learn/power-and-cables" },
      { label: "Troubleshooting", href: "#/help" }
    ]
  }
];
