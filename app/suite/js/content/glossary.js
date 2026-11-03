// SO-101 Suite glossary. Plain words first. Every `see` id is another entry here.
// Voice: friendly, second person, short sentences. No jargon without an explanation.
export default [
  {
    id: "servo",
    term: "Servo",
    short: "A motor with a built-in brain: you give it an angle and it turns there and holds.",
    long: "A servo is a motor, a set of gears, an angle sensor and a small circuit board in one case. You send it a target angle and it turns to that angle by itself, then keeps holding it. Every joint of your SO-101 is driven by one servo.",
    see: ["sts3215", "motor-id", "torque", "gear-ratio"]
  },
  {
    id: "sts3215",
    term: "STS3215",
    short: "The model of servo used in every joint of the SO-101 (made by Feetech).",
    long: "The STS3215 is a serial bus servo: several of them share one cable, and each answers only to its own motor ID. It reports its own position, load, temperature and voltage, so the app can see how it is doing. The official kit uses the 7.4V version. A 12V version exists, and the leader arm is always the 7.4V kind.",
    see: ["servo", "bus", "motor-id", "power-supply", "encoder-ticks"]
  },
  {
    id: "motor-id",
    term: "Motor ID",
    short: "A number from 1 to 6 that names each motor on the shared cable.",
    long: "All the motors share one cable, so the computer needs a way to talk to just one of them. Each motor gets its own ID: 1 shoulder pan, 2 shoulder lift, 3 elbow flex, 4 wrist flex, 5 wrist roll, 6 gripper. New motors usually all ship as ID 1, so you set the IDs once, one motor at a time.",
    see: ["bus", "eeprom", "baud-rate", "servo-board"]
  },
  {
    id: "baud-rate",
    term: "Baud rate",
    short: "The speed at which the board and the motors send data. Both sides must use the same one.",
    long: "Think of two people agreeing to talk at the same speed. If the board and a motor use different speeds, they hear only noise and the motor looks missing. When you set up the motor IDs, the app and LeRobot also set every motor to 1,000,000 bits per second, so they all match.",
    see: ["motor-id", "bus", "eeprom"]
  },
  {
    id: "bus",
    term: "Bus",
    short: "One shared line of wires that all the motors hang on, so one USB port reaches all six.",
    long: "On the SO-101 the six motors are joined one after another and share the same wires. The computer sends a message with a motor ID in it, and only that motor answers. That is why every ID on the same arm must be different.",
    see: ["daisy-chain", "motor-id", "servo-board"]
  },
  {
    id: "daisy-chain",
    term: "Daisy chain",
    short: "Plugging motors in a row: board to motor 1, motor 1 to motor 2, and so on.",
    long: "Each motor has two 3-pin sockets, so one cable can come in from the previous motor and another can go out to the next one. If one cable in the middle comes loose, the motors after it stop answering. You build the chain only after every motor has its own ID.",
    see: ["bus", "three-pin-cable", "motor-id"]
  },
  {
    id: "servo-board",
    term: "USB servo board",
    short: "The small circuit board that links your computer's USB port and the power supply to the motors.",
    long: "Also called a bus servo adapter, motor control board or USB serial adapter. There is one board per arm, mounted in the base. On Waveshare boards the two jumpers must sit on channel B (USB), as the official guide says. Each board shows up on your computer as its own port.",
    see: ["port", "bus", "power-supply", "three-pin-cable"]
  },
  {
    id: "port",
    term: "Port (/dev/tty..., COM3)",
    short: "The name your computer gives a USB device, like /dev/ttyACM0 or COM3.",
    long: "On macOS it looks like <code>/dev/tty.usbmodem</code> followed by numbers. On Linux it looks like <code>/dev/ttyACM0</code>. On Windows it looks like <code>COM3</code>. Only one program can use a port at a time, so close any other program that is using it.",
    see: ["servo-board", "dialout", "lerobot"]
  },
  {
    id: "three-pin-cable",
    term: "3-pin cable",
    short: "The thin cable with a small plug on each end that carries power and data between motors.",
    long: "It has 3 wires: power, ground and the data line. The same kind of cable joins the board to motor 1 and each motor to the next one. A plug that is not pushed in all the way is a very common reason for a motor that does not answer.",
    see: ["daisy-chain", "servo-board", "motor-id"]
  },
  {
    id: "eeprom",
    term: "EEPROM (the motor's memory)",
    short: "Memory inside the motor that keeps its ID and settings even when the power is off.",
    long: "When you set a motor's ID it is written into this memory, so you only do it once per motor. The app only writes a new ID when exactly one motor answers on the board, so the wrong motor can never get the number. If you reuse motors from another robot, you probably need to do this step again.",
    see: ["motor-id", "baud-rate"]
  },
  {
    id: "motor-horn",
    term: "Horn",
    short: "The small round disc that presses onto a motor's spindle. Printed arm parts bolt onto it.",
    long: "The spindle is the short round shaft that sticks out of the motor and turns. A horn presses onto it, and a screw in the middle of the horn locks it there. The printed parts of the arm are screwed to the holes in the horn, so when the motor turns, the part turns with it.",
    see: ["servo", "joint"]
  },
  {
    id: "joint",
    term: "Joint",
    short: "A place where the arm bends or turns. Each joint is driven by one motor.",
    long: "The SO-101 has six: shoulder pan, shoulder lift, elbow flex, wrist flex, wrist roll and gripper. Five of them move the arm; the sixth opens and closes the jaws. The 3D model uses these exact names.",
    see: ["degree-of-freedom", "shoulder-pan", "gripper", "urdf"]
  },
  {
    id: "degree-of-freedom",
    term: "Degree of freedom",
    short: "One independent way to move. The SO-101 has five for the arm, plus the gripper.",
    long: "Every joint you can move separately adds one. With five arm joints the gripper can reach a spot and point in a chosen direction. In this app we just say joint.",
    see: ["joint", "forward-kinematics"]
  },
  {
    id: "shoulder-pan",
    term: "Shoulder pan",
    short: "Joint 1 (motor 1): turns the whole arm left and right, like shaking your head no.",
    long: "The pan decides which way the arm is facing. Its motor sits in the base and turns the shoulder piece on top of it. In the 3D model it can swing about 110 degrees each way from the middle.",
    see: ["joint", "shoulder-lift", "motor-id"]
  },
  {
    id: "shoulder-lift",
    term: "Shoulder lift",
    short: "Joint 2 (motor 2): tips the upper arm forward and back, like raising your arm.",
    long: "This joint holds up everything beyond it, so it works the hardest against gravity. Its motor sits in the shoulder piece. On the leader arm it uses the strongest gear, 1/345, the same as on every follower joint.",
    see: ["joint", "elbow-flex", "gear-ratio", "load"]
  },
  {
    id: "elbow-flex",
    term: "Elbow flex",
    short: "Joint 3 (motor 3): bends the forearm at the elbow.",
    long: "Elbow flex folds the arm like your own elbow. Together with the shoulder lift it decides how far from the base the gripper reaches and how high it is. Its motor sits in the upper arm.",
    see: ["shoulder-lift", "wrist-flex", "inverse-kinematics"]
  },
  {
    id: "wrist-flex",
    term: "Wrist flex",
    short: "Joint 4 (motor 4): tips the hand up and down, like nodding your hand.",
    long: "Wrist flex sets how steeply the gripper points. To pick things up from a table the gripper must point straight down, and this joint, with the shoulder lift and elbow flex, makes that happen. Its motor sits in the forearm.",
    see: ["elbow-flex", "wrist-roll", "perpendicular"]
  },
  {
    id: "wrist-roll",
    term: "Wrist roll",
    short: "Joint 5 (motor 5): twists the gripper around its own long axis, like turning a doorknob.",
    long: "Wrist roll decides whether the jaws open side to side or up and down. It can turn much further than the other joints, so calibration treats it as a full turn. Its cable can strain when it turns a lot, which is why pick and place keeps it fixed.",
    see: ["wrist-flex", "gripper", "calibration"]
  },
  {
    id: "gripper",
    term: "Gripper",
    short: "Joint 6 (motor 6) and the hand it belongs to: it opens and closes the two jaws.",
    long: "The gripper is the hand at the end of the arm. Motor 6 swings one jaw open and closed against the other. On the follower it is the part that picks things up. On the leader it is a trigger you squeeze.",
    see: ["jaw", "fixed-jaw", "moving-jaw", "tool-point"]
  },
  {
    id: "jaw",
    term: "Jaw (finger)",
    short: "One of the two pinching parts of the gripper. The SO-101 has two jaws, not five fingers.",
    long: "When people say fingers, they mean these two jaws: one that never moves by itself (the fixed jaw) and one that swings (the moving jaw). Objects get pinched between them. This app says jaw, not claw.",
    see: ["fixed-jaw", "moving-jaw", "gripper"]
  },
  {
    id: "fixed-jaw",
    term: "Fixed jaw",
    short: "The half of the gripper that does not move by itself. It is part of the printed gripper body.",
    long: "The fixed jaw is the side the moving jaw closes toward. It turns and tips only when the wrist and the arm move it. In the URDF model it has no link of its own: it belongs to the gripper link.",
    see: ["jaw", "moving-jaw", "urdf"]
  },
  {
    id: "moving-jaw",
    term: "Moving jaw",
    short: "The jaw that swings open and closed. Motor 6 moves it.",
    long: "This is the only part of the gripper with its own motor. Its joint is called gripper in the model. The official guide calls it the gripper claw. On the owner's arm, 0 on the gripper scale is closed and 100 is open; check yours.",
    see: ["jaw", "fixed-jaw", "gripper", "normalized"]
  },
  {
    id: "tool-point",
    term: "Tool point",
    short: "An invisible dot near the jaw tips that the maths treats as 'where the gripper is'.",
    long: "The model has a marker called gripper_frame_link for it. Kinematics place this point on the thing you want to pick up. On the owner's arm the real jaw ends sit about 14 mm short of it, which the app allows for.",
    see: ["forward-kinematics", "inverse-kinematics", "urdf"]
  },
  {
    id: "leader-arm",
    term: "Leader arm",
    short: "The arm you move by hand. Its motors are only used to read where you moved it.",
    long: "The leader has a handle and a trigger. While you teleoperate, its motors are limp so it is easy to move. The computer reads its joints many times a second and sends them to the follower.",
    see: ["follower-arm", "teleoperation", "limp"]
  },
  {
    id: "follower-arm",
    term: "Follower arm",
    short: "The arm that copies the leader. It has the two-jaw gripper that picks things up.",
    long: "The follower holds its motors on and moves to the angles the leader reports. It is the arm that does the work: picking, placing, and later running an AI policy. Both arms must be calibrated so the same pose gives the same numbers.",
    see: ["leader-arm", "teleoperation", "calibration"]
  },
  {
    id: "teleoperation",
    term: "Teleoperation",
    short: "Controlling a robot live, from a distance. Here: you move the leader and the follower copies.",
    long: "Your hand moves the leader, the computer reads its six joints, and the follower goes to the same six angles, again and again. The app does this more than a hundred times a second. It never starts on its own: you press start when both arms are connected and calibrated.",
    see: ["leader-arm", "follower-arm", "imitation-learning"]
  },
  {
    id: "calibration",
    term: "Calibration",
    short: "Teaching an arm where its joints start and stop, so both arms read the same in the same pose.",
    long: "You put the arm in the middle of every joint's range, then move each joint through its full travel. The arm remembers the lowest and highest positions it saw, and 0 becomes the middle between them. Calibration lets the leader and follower agree, and lets an AI trained on one robot work on another.",
    see: ["middle-of-range", "range-of-motion", "normalized"]
  },
  {
    id: "range-of-motion",
    term: "Range of motion",
    short: "How far a joint can turn, from its lowest position to its highest.",
    long: "Every joint stops at both ends because the printed parts touch or the cables run out of slack. During calibration you move each joint all the way each way, so the arm records its real range. If you only move it one way, the middle ends up in the wrong place.",
    see: ["calibration", "middle-of-range"]
  },
  {
    id: "middle-of-range",
    term: "Middle of range = 0 (homing offset)",
    short: "After calibration, 0 means the middle of the range you recorded for that joint.",
    long: "It does not mean 'the arm looks straight'. In degrees, a joint reads (raw reading minus the halfway point between lowest and highest) times 360 divided by 4095. LeRobot also stores a small correction in each motor, the homing offset, so the pose you hold at the start reads near the middle of the scale.",
    see: ["calibration", "normalized", "encoder-ticks", "range-of-motion"]
  },
  {
    id: "normalized",
    term: "Normalized value (-100 to +100)",
    short: "A joint's position as a simple number: -100 at its lowest point, 0 in the middle, +100 at its highest.",
    long: "LeRobot turns each raw reading into this scale after calibration, so a joint reads the same on any calibrated arm. The gripper is different: it runs from 0 to 100. The Suite can also show plain degrees, with 0 at the middle.",
    see: ["middle-of-range", "calibration", "encoder-ticks"]
  },
  {
    id: "torque",
    term: "Torque",
    short: "How hard a motor can twist. 'Torque on' means the motor is actively holding its position.",
    long: "With torque on, the motor fights any push to keep its angle. With torque off, the joint moves freely. Many safety rules are about torque: it is easy to forget that an arm which looks idle may be holding hard.",
    see: ["limp", "load", "overload-protection"]
  },
  {
    id: "limp",
    term: "Limp (torque off)",
    short: "The arm goes soft and gravity pulls it down, because its motors are not holding it up.",
    long: "You make an arm limp to move it by hand, for example while calibrating. Never touch an arm that is stiff. The app's Release arm lowers the follower onto the table first and only then lets go, so nothing drops and nobody has to hold it. Closing or restarting the app does not make the arm limp by itself, so a stiff arm may still be holding: check that the page says the arm is limp.",
    see: ["torque", "calibration", "leader-arm"]
  },
  {
    id: "load",
    term: "Load",
    short: "How hard a motor is pushing, as a percentage of its maximum.",
    long: "The STS3215 reports its load in tenths of a percent, which the app shows as 0 to 100 percent. A high load means the arm is lifting something heavy or pushing against something solid, like the table. The app stops an automatic move if a joint stays above 70 percent (85 percent for the wrist roll) for three readings in a row.",
    see: ["torque", "overload-protection", "temperature"]
  },
  {
    id: "overload-protection",
    term: "Overload protection",
    short: "A safety feature inside each motor: if it pushes too hard for too long, it shuts itself down.",
    long: "A motor that is stalled against something can overheat. To save itself it cuts its torque, and from outside it may look like it stopped answering. The dashboard tries to turn its torque back on at the position it is at now, at most four times a minute, and tells you what to free.",
    see: ["torque", "load", "temperature"]
  },
  {
    id: "temperature",
    term: "Temperature",
    short: "Each motor reports how hot it is. A single odd jump is usually a bad reading, not a real one.",
    long: "Motors warm up when they push hard for a while. The app polls the temperature of every motor ten times a second. One reading jumped to 72 degrees Celsius when the real value was 34, so the app ignores jumps of more than 10 degrees unless they repeat three times.",
    see: ["load", "overload-protection", "voltage"]
  },
  {
    id: "voltage",
    term: "Voltage",
    short: "How hard the electricity pushes. Each motor reports the voltage it actually receives.",
    long: "If your power supply is too weak or a cable is poor, the voltage a motor sees drops when the arm moves, and motors can twitch or restart. Too high a voltage can damage a motor. Always match the power supply to your motors.",
    see: ["power-supply", "sts3215", "temperature"]
  },
  {
    id: "power-supply",
    term: "Power supply (5V / 12V)",
    short: "The wall adapter that feeds the motors. It must match your motor version.",
    long: "The official parts list pairs the 7.4V motors with a 5V supply. A 12V motor version exists, but then you need a 12V supply rated 5A or more, and the leader arm is always the 7.4V kind. Read the label on the supply and on your motors before you plug in, and never swap supplies between arms without checking.",
    see: ["voltage", "servo-board", "sts3215"]
  },
  {
    id: "gear-ratio",
    term: "Gear ratio (1/345, 1/191, 1/147)",
    short: "How much the motor's gears slow it down. 1/345 means 345 motor turns for one turn of the joint.",
    long: "A bigger number gives more strength and a slower, harder-to-turn joint. Every follower joint uses 1/345. The leader uses three kinds so it can hold its own weight and still be moved easily by hand: 1/191 for shoulder pan and elbow flex, 1/345 for shoulder lift, and 1/147 for wrist flex, wrist roll and gripper.",
    see: ["servo", "backlash", "leader-arm"]
  },
  {
    id: "backlash",
    term: "Backlash",
    short: "A tiny looseness in gears: the joint can wiggle a little before the motor moves.",
    long: "Gears need a little room to turn, so there is a small dead zone when you change direction. It is why the arm may stop a hair away from the exact spot you asked for. Grasps work around it, for example by touching down on the table slowly and measuring.",
    see: ["gear-ratio", "encoder-ticks"]
  },
  {
    id: "encoder-ticks",
    term: "Encoder ticks (0 to 4095)",
    short: "A motor measures its angle as a count from 0 to 4095 for one full turn.",
    long: "The raw reading is called ticks. One tick is about 0.09 degrees. Calibration turns these ticks into the degrees and -100 to +100 numbers you see in the app.",
    see: ["middle-of-range", "normalized", "calibration"]
  },
  {
    id: "forward-kinematics",
    term: "Forward kinematics",
    short: "Maths that takes the six joint angles and tells you where the gripper is.",
    long: "Given the lengths of the arm's parts and the angle of each joint, you can compute the tool point's position and which way it points. A good check: with the arm limp, hold the gripper straight down on the table, and the model should say the tool points straight down with its tip at table height. If it does not, a joint zero is wrong.",
    see: ["inverse-kinematics", "urdf", "tool-point"]
  },
  {
    id: "inverse-kinematics",
    term: "Inverse kinematics",
    short: "Maths in reverse: you say where the gripper should go, it works out the joint angles.",
    long: "Pick and place needs this: the camera says where the object is, and inverse kinematics finds the joint angles that put the jaws there, pointing straight down. Sometimes there is no answer because the spot is out of reach, and the app says so instead of trying.",
    see: ["forward-kinematics", "perpendicular", "pick-and-place"]
  },
  {
    id: "urdf",
    term: "URDF",
    short: "A text file that describes a robot: its links, joints and shapes.",
    long: "The 3D arm on screen is drawn from the official SO-101 URDF. A link is a rigid piece (like the upper arm) and a joint connects two links. The app's kinematics use the same file, so the picture and the maths always agree.",
    see: ["joint", "forward-kinematics", "digital-twin"]
  },
  {
    id: "digital-twin",
    term: "3D twin",
    short: "The live 3D copy of your real arm on screen. It moves when the real arm moves.",
    long: "The twin is drawn from the URDF and fed the real joint readings. If the twin looks wrong, for example the gripper dips under the floor, a joint zero or the calibration is probably wrong, so it works as a health check too.",
    see: ["urdf", "calibration", "middle-of-range"]
  },
  {
    id: "camera-mapping",
    term: "Camera mapping (pixel to table)",
    short: "The recipe that turns 'this dot in the picture' into 'this spot on the table'.",
    long: "A camera sees pixels. The arm works in real distances. To build the mapping you touch known spots on the table with the gripper and click the same spots in the camera picture. If the camera moves afterwards, you have to teach the mapping again.",
    see: ["homography", "intrinsics", "leave-one-out"]
  },
  {
    id: "homography",
    term: "Homography",
    short: "Maths for turning points on one flat surface into points on another, here picture to table.",
    long: "Anything lying on the table can be placed this way, because the table is flat. It does not work for things floating above the table. This is the idea behind the camera mapping.",
    see: ["camera-mapping", "intrinsics"]
  },
  {
    id: "intrinsics",
    term: "Camera intrinsics",
    short: "Numbers about the camera itself: how zoomed in it is and where its picture centre is.",
    long: "They describe the lens and the sensor, not where the camera stands. The fitted zoom number from real data can look unrealistic, because the camera is tilted and the clicks are a bit noisy. That is fine as long as the table mapping is good to about 1 to 2 cm.",
    see: ["camera-mapping", "homography"]
  },
  {
    id: "leave-one-out",
    term: "Leave-one-out check",
    short: "Test a fit by hiding one point, fitting with the rest, and seeing how far off the hidden point lands.",
    long: "A fit with just 3 points always looks perfect, so 'error 0 mm' proves nothing. Hiding each point in turn shows whether the mapping predicts a spot it has never seen. If every hidden point lands close, you can trust the mapping.",
    see: ["camera-mapping", "homography"]
  },
  {
    id: "mjpeg",
    term: "MJPEG",
    short: "A camera stream that is just one JPEG picture after another. Easy for any browser to show.",
    long: "The Raspberry Pi can share its camera as an MJPEG stream over your network, and your computer reads it like a web page. The app also hands out single snapshots of each camera for people and AI helpers.",
    see: ["v4l2", "camera-mapping"]
  },
  {
    id: "v4l2",
    term: "V4L2",
    short: "Video4Linux2: how Linux talks to USB cameras. They appear as /dev/video0 and so on.",
    long: "When two cameras are identical, /dev/video0 and /dev/video1 can swap after a reboot. Use the stable names under <code>/dev/v4l/by-path/</code> instead, because they depend on the USB socket you used.",
    see: ["mjpeg", "port"]
  },
  {
    id: "perpendicular",
    term: "Perpendicular (gripper straight down)",
    short: "The gripper pointing straight down at the table, so both jaw tips touch it at once.",
    long: "To pinch something thin and flat, both jaw tips must be at table level. A tilt of about 10 degrees lifts one jaw about 1 cm when the jaws are 5 cm apart, and then nothing is gripped. The app only accepts a gripper within 3 degrees of the wanted direction.",
    see: ["inverse-kinematics", "wrist-flex", "table-height"]
  },
  {
    id: "table-height",
    term: "Table height",
    short: "How far below the arm's base the table surface is. Measured once by touching it.",
    long: "The arm is clamped to the table, so the table never moves relative to the arm. The app lowers the tip a few millimetres at a time until the motors push back, and saves that height. Measure again only if you remount the arm.",
    see: ["perpendicular", "pick-and-place", "load"]
  },
  {
    id: "pick-and-place",
    term: "Pick and place",
    short: "Picking an object up from one spot and putting it down at another, using cameras to find it.",
    long: "The cameras find the object, the maths plans a path, the arm descends and pinches it, checks it really holds it, carries it over, and lets go. It is classic programming, not AI. Each step is checked, and if a grasp fails the arm stops and tries again instead of carrying on.",
    see: ["camera-mapping", "inverse-kinematics", "perpendicular"]
  },
  {
    id: "lerobot",
    term: "LeRobot",
    short: "Hugging Face's free robotics library for Python, with ready-made tools for the SO-101.",
    long: "LeRobot can find your port, set motor IDs, calibrate, teleoperate, record data and train AI policies. This app uses the same calibration files as LeRobot, so what you calibrate here works there. It is optional for using this app.",
    see: ["dataset", "policy", "calibration"]
  },
  {
    id: "dataset",
    term: "Dataset",
    short: "A saved set of recordings (camera pictures and joint readings) used to teach an AI.",
    long: "You make a dataset by teleoperating the arm to do a task many times while LeRobot records everything. It can be uploaded to Hugging Face to share or to train elsewhere.",
    see: ["episode", "imitation-learning", "lerobot"]
  },
  {
    id: "episode",
    term: "Episode",
    short: "One recording of the task from start to finish.",
    long: "A dataset is made of many episodes. Each one holds what the cameras saw and what the joints did while you did the task once with the leader arm.",
    see: ["dataset", "policy"]
  },
  {
    id: "policy",
    term: "Policy",
    short: "The AI 'brain' that looks at camera pictures and joint readings and decides how to move next.",
    long: "You train a policy on a dataset. Later, the policy runs the follower arm by itself, without the leader. It only works well if the leader and follower were calibrated.",
    see: ["act", "dataset", "imitation-learning"]
  },
  {
    id: "act",
    term: "ACT",
    short: "Action Chunking with Transformers: a kind of policy that LeRobot can train.",
    long: "It predicts a short run of upcoming moves at once instead of one at a time. Training it needs a computer with a good graphics card (a CUDA GPU), not the Raspberry Pi.",
    see: ["policy", "imitation-learning", "lerobot"]
  },
  {
    id: "imitation-learning",
    term: "Imitation learning",
    short: "Teaching a robot by showing it: you do the task, the AI learns to copy you.",
    long: "You teleoperate the leader to do a task many times. The recordings become a dataset, and a policy learns to produce the same moves from what the cameras see.",
    see: ["teleoperation", "dataset", "policy"]
  },
  {
    id: "module",
    term: "Module",
    short: "A folder in modules/ that adds a feature to the app. The app finds it by itself.",
    long: "A module has a small description file and can add its own page and its own small server code. Ask an AI helper to build one: the Modules page has a prompt you can copy. Pick and place is built this way too.",
    see: ["demo-mode"]
  },
  {
    id: "demo-mode",
    term: "Demo mode",
    short: "The whole app running with pretend arms and cameras. Nothing real moves.",
    long: "Use it to learn the app before your arm arrives, or to test a module. A strip at the bottom says it is a demo. Demo mode never opens a real USB port.",
    see: ["module", "servo-board"]
  },
  {
    id: "uv",
    term: "uv",
    short: "A fast tool that installs Python and the app's libraries for you.",
    long: "The setup script uses uv, so you do not have to install Python yourself. It picks a Python version that works with LeRobot, which is currently 3.12. You do not need to learn uv to use the app.",
    see: ["lerobot"]
  },
  {
    id: "dialout",
    term: "dialout group (Linux)",
    short: "On Linux, the group of users allowed to use USB serial ports. Join it to fix 'permission denied'.",
    long: "Run <code>sudo usermod -aG dialout $USER</code>, then log out and back in. The change only applies after you log in again. A few Linux versions use a group called uucp instead.",
    see: ["port", "servo-board"]
  }
];
