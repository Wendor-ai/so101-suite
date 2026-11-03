// "Meet your arm": the parts of the SO-101, tied to the real URDF names.
// Source of truth: app/assets/so101/so101_new_calib.urdf
//   links  (parent -> child via joint):
//     base_link --shoulder_pan--> shoulder_link --shoulder_lift--> upper_arm_link
//     --elbow_flex--> lower_arm_link --wrist_flex--> wrist_link --wrist_roll--> gripper_link
//     gripper_link --gripper--> moving_jaw_so101_v1_link ; gripper_link --(fixed)--> gripper_frame_link
// Each link CARRIES the motor of the NEXT joint: base_link holds motor 1, shoulder_link motor 2,
// upper_arm_link motor 3, lower_arm_link motor 4, wrist_link motor 5, gripper_link motor 6.
// The FIXED JAW has no link of its own: it is part of the printed body inside gripper_link.
// tryIt lines follow the physical-instruction standard: one action, a referent a beginner can see, a visible result.
export default [
  {
    id: "base",
    title: "Base",
    urdfLinks: ["base_link"],
    joint: null,
    motorId: null,
    what: "The base is the heavy foot of the arm: it holds motor 1 and the USB servo board, and it clamps to your table.",
    why: "Everything else turns around the base, so it must never move. Because the arm is clamped to the table, the table's height never changes relative to the arm, and that is why pick and place can measure the table height once and trust it. If the base rocks, every position the arm works out is wrong.",
    tryIt: "Put one fingertip on the top edge of the base and push it sideways with the force you would use to press a doorbell. You will see and feel the base stay still. If it rocks or slides, turn the table clamp tighter until it stops moving, then push again.",
    terms: ["servo-board", "table-height", "urdf"]
  },
  {
    id: "shoulder-pan",
    title: "Shoulder (shoulder pan)",
    urdfLinks: ["shoulder_link"],
    joint: "shoulder_pan",
    motorId: 1,
    what: "The shoulder is the piece on top of the base that turns the whole arm left and right, like shaking your head to say no.",
    why: "This joint decides which way the arm faces. Motor 1 sits in the base and turns this piece; the shoulder in turn carries motor 2 for the next joint. In the 3D model it swings about 110 degrees each way from the middle.",
    tryIt: "Click the shoulder in the 3D picture. You will see it light up, with the label shoulder_pan and motor 1. Then find the same piece on your real arm: it is the printed piece that stands on top of the base.",
    terms: ["shoulder-pan", "joint", "motor-id", "limp"]
  },
  {
    id: "shoulder-lift",
    title: "Upper arm (shoulder lift)",
    urdfLinks: ["upper_arm_link"],
    joint: "shoulder_lift",
    motorId: 2,
    what: "The upper arm is the long piece, about 14 cm long, that tips forward and back from the shoulder like you raising your arm.",
    why: "Motor 2 sits in the shoulder piece and tips this part. Everything beyond it hangs out in front, so this joint works hardest against gravity. On the leader arm it gets the strongest gear (1/345), as the official gear table says.",
    tryIt: "Click the upper arm in the 3D picture. You will see it light up. Then find the same piece on your real arm: it is the long printed piece that runs from the shoulder up to the elbow.",
    terms: ["shoulder-lift", "gear-ratio", "load", "motor-horn"]
  },
  {
    id: "elbow-flex",
    title: "Forearm (elbow flex)",
    urdfLinks: ["lower_arm_link"],
    joint: "elbow_flex",
    motorId: 3,
    what: "The forearm is the second long piece, about 13 cm long, that bends at the elbow; the model calls it lower_arm_link.",
    why: "Motor 3 sits in the upper arm and bends the forearm. With the shoulder lift, elbow flex decides how far from the base the gripper reaches and how high it is. In the 3D model it bends about 97 degrees each way from the middle.",
    tryIt: "Click the forearm in the 3D picture. You will see it light up, with the label elbow_flex and motor 3. Then find the same piece on your real arm: it is the long printed piece beyond the elbow, the one that ends at the wrist.",
    terms: ["elbow-flex", "shoulder-lift", "inverse-kinematics"]
  },
  {
    id: "wrist-flex",
    title: "Wrist (wrist flex)",
    urdfLinks: ["wrist_link"],
    joint: "wrist_flex",
    motorId: 4,
    what: "The wrist piece tips the hand up and down, like nodding your hand; the model calls it wrist_link.",
    why: "Motor 4 sits in the forearm and tips the wrist piece, which carries motor 5 (wrist roll) and everything beyond it. To pick something up from a table the gripper must point straight down, and wrist flex is the joint that finishes that job, together with the shoulder lift and the elbow. In the 3D model it tips about 95 degrees each way.",
    tryIt: "Click the wrist in the 3D picture. You will see it light up, with the label wrist_flex and motor 4. Then find the same piece on your real arm: it is the small printed block between the end of the forearm and the gripper.",
    terms: ["wrist-flex", "perpendicular", "elbow-flex"]
  },
  {
    id: "wrist-roll",
    title: "Wrist roll",
    urdfLinks: ["gripper_link"],
    joint: "wrist_roll",
    motorId: 5,
    what: "The wrist roll twists the whole gripper around its own long axis, like turning a doorknob.",
    why: "Motor 5 sits in the wrist piece and spins the gripper body (that is the part called gripper_link), including motor 6 and both jaws. It can turn much further than the other joints, from about minus 157 to plus 163 degrees in the model, so calibration records it as a full turn. Its motor can strain against its own cable, so pick and place keeps it fixed.",
    tryIt: "Click the gripper in the 3D picture. You will see the whole hand light up, with the label wrist_roll and motor 5. Then look at your real arm: the wrist roll is the joint between the small wrist block and the printed hand, and it turns the hand like a doorknob.",
    terms: ["wrist-roll", "calibration", "load", "limp"]
  },
  {
    id: "gripper-body",
    title: "Gripper body",
    urdfLinks: ["gripper_link"],
    joint: null,
    motorId: null,
    what: "The gripper body is the printed hand at the end of the arm; it holds motor 6 and the fixed jaw.",
    why: "This is the last piece in the chain, and everything the arm touches happens here. The model calls it gripper_link. It is turned by the wrist roll, and it carries motor 6, which opens and closes the moving jaw. Its tool point (gripper_frame_link) is a marker about 98 mm out along it, near the jaw tips.",
    tryIt: "Look at your real gripper from the side. You will see one jaw that is part of the printed hand and one jaw that swings. Point to the printed hand with your finger: that is the gripper body.",
    terms: ["gripper", "tool-point", "urdf", "jaw"]
  },
  {
    id: "fixed-jaw",
    title: "Fixed jaw (one of the two 'fingers')",
    urdfLinks: ["gripper_link"],
    joint: null,
    motorId: null,
    what: "The fixed jaw is the half of the gripper that does not move by itself: it is part of the printed gripper body.",
    why: "The SO-101 has two jaws, not five fingers. The fixed jaw is the side the moving jaw closes toward. In the model it has no link of its own: it lives inside gripper_link, so it moves only when the wrist and arm move it. When you pick up something thin and flat, the tips of both jaws must sit at table level, so the fixed jaw tells you how straight the gripper really is.",
    tryIt: "Open the gripper on your arm, then look at it from above. You will see one jaw stay still while the other swings away. The one that stays is the fixed jaw.",
    terms: ["jaw", "fixed-jaw", "moving-jaw", "perpendicular"]
  },
  {
    id: "moving-jaw",
    title: "Moving jaw (the other 'finger')",
    urdfLinks: ["moving_jaw_so101_v1_link"],
    joint: "gripper",
    motorId: 6,
    what: "The moving jaw is the second finger: motor 6 swings it open and closed against the fixed jaw.",
    why: "It is the only part of the gripper with its own motor, and its joint is called gripper. In the model it swings from about minus 10 to plus 100 degrees. On the owner's arm 0 on the gripper scale is closed and 100 is open, so check yours. A jaw closed on nothing still pushes hard against its own stop, so the app tells a real hold from an empty grip by measuring the gap between the jaws, not by the load.",
    tryIt: "If both arms are set up and the follower is copying the leader, do this. Keep your fingers out from between the follower's two jaws. Then squeeze the leader's trigger slowly, as if pressing a doorbell. You will see the follower's moving jaw close, and open again when you let go.",
    terms: ["jaw", "gripper", "normalized", "load"]
  },
  {
    id: "motor-horn",
    title: "Motor and horn",
    urdfLinks: ["base_link", "shoulder_link", "upper_arm_link", "lower_arm_link", "wrist_link", "gripper_link"],
    joint: null,
    motorId: null,
    what: "A servo is a black box with a spindle that turns, and a horn is the small round disc on that spindle that a printed part bolts onto.",
    why: "Every arm has six motors, and each printed piece of the arm is bolted to the horn of the motor at its joint. When the motor turns its spindle, the horn and the printed piece turn with it. Each piece also carries the motor for the next joint, which is why the arm is a chain: a turn at the base moves everything above it.",
    tryIt: "Pick one joint on your assembled arm and put a finger on the black motor box on one piece. Then put a finger on the round horn on the next piece. You will see the screw in the middle of the horn, and the printed piece fixed around it.",
    terms: ["servo", "motor-horn", "sts3215", "joint"]
  },
  {
    id: "servo-board",
    title: "USB servo board",
    urdfLinks: ["base_link"],
    joint: null,
    motorId: null,
    what: "The USB servo board is the small circuit board in the base that connects your computer (by USB) and the power supply to the chain of motors.",
    why: "Without it your computer cannot talk to the motors. Each arm has its own board, so each arm shows up as its own port. The 3D model draws only the plate it sits on (waveshare_mounting_plate_so101_v2). On Waveshare boards the two jumpers must be on channel B (USB), as the official guide says.",
    tryIt: "With the power supply unplugged, look at the board in the base. Find the USB-C socket, the power socket, and the two small plastic jumper caps. You will see both caps sitting on the pins marked B. If either cap is on A, pull it off with your fingernails and press it onto B.",
    terms: ["servo-board", "port", "power-supply", "three-pin-cable"]
  },
  {
    id: "tool-point",
    title: "Tool point (invisible)",
    urdfLinks: ["gripper_frame_link"],
    joint: null,
    motorId: null,
    what: "The tool point is an invisible dot near the jaw tips that the maths treats as 'where the gripper is'.",
    why: "The model marks it with gripper_frame_link, joined to the gripper by a fixed joint (gripper_frame_joint), so no motor moves it. Kinematics put this point on the thing you want to pick up. On the owner's arm the real jaw ends sit about 14 mm short of it, which the app allows for.",
    tryIt: "With the arm unpowered, open the gripper by hand and hold a pen so its tip points between the two jaw tips, one finger-width in front of them. You will see that this is the spot the maths treats as the gripper position; it has no motor of its own.",
    terms: ["tool-point", "forward-kinematics", "inverse-kinematics"]
  }
];
