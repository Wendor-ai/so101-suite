// SO-101 Suite: guided assembly. Follows the official LeRobot SO-101 guide (https://huggingface.co/docs/lerobot/so101)
// and the parts list at https://github.com/TheRobotStudio/SO-ARM100, rewritten in plain words.
//
// STEP CARD fields:
//   id, joint (URDF joint name or null), title, motorId (1-6 or null), minutes (first-timer estimate)
//   needs   tools and parts for this step            safety  what can pinch/slip/short, or null
//   do      numbered actions, ONE verb each          know    what you will see, hear or feel when it worked
//   ifNot   one concrete recovery                    check   tick-list of counts
//   warn    mistakes to avoid                        video   official step video or null
//   diagram main picture id; alsoDiagram: extra picture ids used inside the step
//   verify  true = a physical detail could not be confirmed from the official text; show "check the official video"
// Screw counts, order and parts come only from the official guide. Sizes (cm) are measured from the 3D models.
const V = "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/lerobot/";
const TURN_L = "clockwise with the larger Phillips screwdriver until the screw head touches the part and the screwdriver gets hard to turn; then stop";
const TURN_S = "clockwise with the smaller Phillips screwdriver until the screw head touches the part and the screwdriver gets hard to turn; then stop";
const POWER_OFF = "Keep the power supply and the USB cable unplugged from the board while you build.";
const REST = "Rest the part on the table while you screw, and keep your other hand flat on the base so the assembly cannot slide. Never hold a part in your palm with the screwdriver pointing at your hand: a slipped screwdriver goes into your hand.";
const SCREWS = ["Phillips screwdriver, smaller (#0)", "Phillips screwdriver, larger (#1)", "A cup for M2x6 screws and a second cup for M3x6 screws"];

// Generic "fit both horns on motor N" actions (the long version, with definitions, is in Joint 1).
const hornsFor = (n) => [
  "Pick up the motor you labelled " + n + ".",
  "Turn the motor so its spindle points at the ceiling.",
  "Press the first horn onto the spindle with your thumb until it stops.",
  "Drop one M3x6 horn screw into the middle hole of that horn.",
  "Turn the horn screw " + TURN_L + ".",
  "Turn the motor over so the other face points at the ceiling.",
  "Press the second horn onto the matching round spot on that face with your thumb until it stops."
];
const cableFor = (n) =>
  "Push one 3-pin cable plug into a socket of motor " + n + " until the plug sits flush with the socket opening.";

export default {
  tools: [
    "Phillips screwdriver, smaller (#0): for the M2x6 screws. The official parts page recommends sizes #0 and #1.",
    "Phillips screwdriver, larger (#1): for the M3x6 screws and the horn screws. If a tip wobbles in a screw head, try the other size.",
    "A small flat screwdriver or another thin, strong tool: for removing 3D-print support material.",
    "Two cups or small trays: one for M2x6 screws, one for M3x6 screws.",
    "Small stickers and a pen: for writing each motor's ID number on it.",
    "A clear, flat table with good light."
  ],
  parts: [
    { name: "STS3215 servo motor, 7.4V, 1/345 gear (code C001)", qty: 7, note: "6 for the follower (one per joint) plus 1 for the leader's shoulder lift (motor 2)." },
    { name: "STS3215 servo motor, 7.4V, 1/191 gear (code C044)", qty: 2, note: "Leader only: shoulder pan (motor 1) and elbow flex (motor 3)." },
    { name: "STS3215 servo motor, 7.4V, 1/147 gear (code C046)", qty: 3, note: "Leader only: wrist flex (motor 4), wrist roll (motor 5) and gripper (motor 6)." },
    { name: "Motor control board (USB servo board)", qty: 2, note: "One per arm. The official list gives a Waveshare-branded board. Both of its jumpers must sit on channel B (USB)." },
    { name: "USB-C cable", qty: 2, note: "One per arm. Use a cable that carries data, not one that only charges." },
    { name: "Power supply", qty: 2, note: "One per arm. Match each to its motors: the official list pairs 7.4V motors with a 5V supply. A 12V motor version needs a 12V supply rated 5A or more, and the leader is always the 7.4V kind. Read the labels." },
    { name: "Table clamp", qty: 4, note: "The official list gives 2 per arm. Clamp each arm's base to a table." },
    { name: "Screwdriver set", qty: 1, note: "Phillips #0 and #1 are highly recommended." },
    { name: "3D-printed parts shared by both arms", qty: 2, note: "One set per arm: Base_motor_holder, Base, Motor_holder_Base, Motor_holder_Wrist, Under_arm, Upper_arm, Rotation_Pitch, Wrist_Roll_Pitch, WaveShare_Mounting_Plate (all with SO101 in the name)." },
    { name: "3D-printed parts, follower only", qty: 1, note: "Moving_Jaw and Wrist_Roll_Follower (SO101)." },
    { name: "3D-printed parts, leader only", qty: 1, note: "Handle, Trigger and Wrist_Roll (SO101)." },
    { name: "3-pin motor cables", qty: 12, note: "One per motor. They are not in the official parts table, so check that your kit has at least one per motor." },
    { name: "Screws M2x6 and M3x6", qty: null, note: "No total is given in the official guide. Each step says how many you need. M2 are the smallest screws in the kit; M3 are fatter. Both are 6 mm long." }
  ],
  intro:
    "You are going to build two arms: the follower, which does the work, and the leader, which you hold. Joints 1 to 5 are built the same way on both arms. Only the last step is different, so there is one for the follower and one for the leader. Each step is a card with numbered actions, what you should see when it worked, and what to do if it did not. The numbers of screws come from the official guide. For anything you are not sure of, the official step video is linked on the card.",
  beforeYouStart: [
    "Print the parts, or have them printed, using the printing guide on the SO-ARM100 page. Check that you have every piece in the parts list.",
    "Count your motors: 12 for two arms (7 + 2 + 3), or 6 if you build only a follower. If you cannot tell the gear ratio of a motor, look for its code (C001, C044 or C046) on its box or order. The motors look alike from the outside.",
    "Set the motor IDs BEFORE you build. The official guide does it first, because each motor must be plugged into the board alone. Open the Motor IDs page, plug in exactly ONE motor at a time, and write each ID on a small sticker on that motor. The order is: 1 shoulder pan, 2 shoulder lift, 3 elbow flex, 4 wrist flex, 5 wrist roll, 6 gripper.",
    "Put a cup on the table for each screw size. M2x6 and M3x6 look alike, and mixing them up is the commonest mistake.",
    "Unplug the power supply and the USB cable from the board. Keep them unplugged until the last step.",
    "Allow about 2 hours for the first arm. Take a break between joints: nothing is lost if you stop after a card."
  ],
  steps: [
    {
      id: "clean",
      joint: null,
      title: "Clean the 3D-printed parts",
      motorId: null,
      minutes: 25,
      needs: ["The printed parts for the arm you are building", "A small flat screwdriver or another thin, strong tool", "A cup for plastic bits"],
      safety: "Always push the tool away from your hand and your body. Broken-off pieces can be sharp: drop them in the cup, not on the floor.",
      do: [
        "Put one printed part on the table in front of you.",
        "Look for support material: thin, rough plastic that the printer built like scaffolding under overhangs and inside holes. It looks like a lattice or thin walls stuck to the part.",
        "Press the part flat onto the table with one flat hand, with your fingers pointing away from the edge you are about to work on.",
        "Push the tip of the small screwdriver under the edge of a piece of support material, pushing away from your body and your other hand.",
        "Lift the screwdriver handle toward the ceiling until the piece snaps off.",
        "Drop the piece into your cup.",
        "Look into every screw hole and slot of the part, and push out anything that fills it with the screwdriver tip.",
        "Run one fingertip over the part.",
        "Repeat these actions for every printed part of both arms."
      ],
      know: [
        "You hear small snaps as pieces break off.",
        "Every part feels smooth where screws and motors will go, with no scaffolding left on it.",
        "You can see into every screw hole."
      ],
      ifNot: ["If a piece will not snap off, push the screwdriver tip under a different edge of the same piece and lift again. If it still stays, leave it and ask in the official LeRobot Discord."],
      check: ["No support material is left on any part", "Every screw hole and slot is open"],
      warn: ["Use a small screwdriver, as the official guide says. Do not cut toward your hand with a knife."],
      video: null,
      diagram: null,
      alsoDiagram: [],
      verify: false
    },
    {
      id: "joint-1",
      joint: "shoulder_pan",
      title: "Joint 1: shoulder pan (motor 1)",
      motorId: 1,
      minutes: 20,
      needs: [
        "Motor 1 (labelled 1) and its two horns",
        "1 screw M3x6 (the horn screw)",
        "6 screws M2x6: 4 for the motor, 2 for the base motor holder",
        "8 screws M3x6 for the shoulder part",
        "Printed parts: base, base motor holder, shoulder part, shoulder motor holder",
        "1 three-pin cable"
      ].concat(SCREWS),
      safety: POWER_OFF + " " + REST,
      do: [
        "Pick up the motor you labelled 1: a black plastic box about 4.5 cm long, about two and a quarter finger-widths.",
        "Find its spindle: the short round shaft that sticks out of one face of the motor. It is the only part of the motor that turns.",
        "Turn the motor so the spindle points at the ceiling.",
        "Press the first horn onto the spindle with your thumb until it stops. A horn is a small round disc with a ring of tiny holes around its edge and a ridged hole in its middle.",
        "Drop one M3x6 screw into the middle hole of that horn. This is the horn screw. M3x6 screws are 6 mm long, about the width of a pencil, and fatter than the smallest screws in the kit.",
        "Turn the horn screw " + TURN_L + ".",
        "Turn the motor over so the other face points at the ceiling.",
        "Press the second horn onto the matching round spot on that face with your thumb until it stops. Leave this horn without a screw.",
        "Put the base on the table. The base is the biggest printed piece, about 11 cm wide (a hand-width and a thumb), with an opening for motor 1. Position it as the official Joint 1 video shows at its start.",
        "Press the base down onto the table with one flat hand.",
        "Lower motor 1 into the base's motor opening with your other hand until it stops.",
        "Push one 3-pin cable plug into a socket of motor 1 until the plug sits flush with the socket opening. A 3-pin cable is a thin cable with a small plug on each end; the socket is a small rectangular hole in the motor's side.",
        "Screw in the first M2x6 screw through a hole in the base into the motor, with the smaller Phillips screwdriver. M2x6 screws are the smallest screws in the kit, 6 mm long. Turn it " + TURN_S + ".",
        "Screw in three more M2x6 screws the same way, so that two go in from the top and two from the bottom (four in total).",
        "Push the base motor holder over motor 1 until it stops. The base motor holder is a printed piece about 8 cm tall, the length of your index finger.",
        "Screw in one M2x6 screw on one side of the base motor holder, turning it " + TURN_S + ".",
        "Screw in one M2x6 screw on the other side of the base motor holder, the same way.",
        "Place the shoulder part onto the horns of motor 1, with its screw holes over the holes in the horns. The shoulder part is a printed piece about 6 cm by 8 cm.",
        "Screw in four M3x6 screws on the top of the shoulder part, one at a time, turning each " + TURN_L + ".",
        "Turn the whole assembly over so the underside of the shoulder part faces the ceiling.",
        "Screw in four M3x6 screws on the underside of the shoulder part, one at a time, the same way.",
        "Place the shoulder motor holder on the shoulder part, where the official Joint 1 video shows it. The shoulder motor holder is a printed piece about 3 cm by 4 cm by 5.5 cm; it will carry motor 2 in the next step."
      ],
      know: [
        "Motor 1 sits flat in the base and does not rock when you wiggle it with two fingers.",
        "The shoulder part sits on the horns and does not wobble when you push its edge with one fingertip, with the force of pressing a doorbell.",
        "Every screw head sits flat against its part."
      ],
      ifNot: ["If motor 1 rocks, unscrew the four M2x6 screws, lift the motor out, and lower it again until it stops before you screw it back. If you are not sure which way it faces, compare it with the first frame of the official Joint 1 video."],
      check: ["6 screws M2x6 used (4 for the motor, 2 for the holder)", "9 screws M3x6 used (the horn screw, 4 on top, 4 underneath)", "One 3-pin cable is plugged into motor 1"],
      warn: [
        "Only the top horn gets the M3x6 horn screw. The bottom horn gets no screw, as the official guide says.",
        "Keep M2 and M3 screws in separate cups. They look alike."
      ],
      video: V + "Joint1_v2.mp4",
      diagram: "joint1",
      alsoDiagram: ["horns", "motor-in-base", "cables"],
      verify: true
    },
    {
      id: "joint-2",
      joint: "shoulder_lift",
      title: "Joint 2: shoulder lift (motor 2)",
      motorId: 2,
      minutes: 12,
      needs: [
        "Motor 2 (labelled 2) and its two horns",
        "1 screw M3x6 (the horn screw)",
        "4 screws M2x6",
        "8 screws M3x6",
        "The upper arm (a printed piece)",
        "1 three-pin cable"
      ].concat(SCREWS),
      safety: POWER_OFF + " " + REST,
      do: hornsFor(2).concat([
        "Press the base and shoulder you built in Joint 1 flat onto the table with one hand.",
        "Push motor 2 down from above into the shoulder motor holder with your other hand until it stops.",
        cableFor(2),
        "Screw in the first M2x6 screw through the shoulder motor holder into motor 2, turning it " + TURN_S + ".",
        "Screw in three more M2x6 screws the same way (four in total).",
        "Place the upper arm onto the horns of motor 2, with its screw holes over the holes in the horns. The upper arm is a long printed piece, about 14 cm long, a hand-width and a half.",
        "Screw in four M3x6 screws on one side of the upper arm, one at a time, turning each " + TURN_L + ".",
        "Turn the assembly around to show its other side.",
        "Screw in four M3x6 screws on the other side of the upper arm, one at a time, the same way."
      ]),
      know: [
        "Motor 2 sits all the way down in the shoulder motor holder and does not rock when you wiggle it with two fingers.",
        "The upper arm does not wobble where it meets the horns when you push its far end with one fingertip, with the force of pressing a doorbell."
      ],
      ifNot: ["If the upper arm wobbles, turn each of its eight M3x6 screws until it stops. If a hole does not line up, unscrew the arm, place it on the horns again and compare with the official Joint 2 video."],
      check: ["4 screws M2x6 used for the motor", "9 screws M3x6 used (the horn screw, plus 4 on each side of the upper arm)", "One 3-pin cable is plugged into motor 2"],
      warn: [
        "Only the top horn gets the horn screw. The bottom horn gets no screw.",
        "The official guide says '4 M3x6 screws on each side'. If a hole is left over, check the video."
      ],
      video: V + "Joint2_v2.mp4",
      diagram: "joint2",
      alsoDiagram: ["horns", "cables"],
      verify: true
    },
    {
      id: "joint-3",
      joint: "elbow_flex",
      title: "Joint 3: elbow flex (motor 3)",
      motorId: 3,
      minutes: 12,
      needs: [
        "Motor 3 (labelled 3) and its two horns",
        "1 screw M3x6 (the horn screw)",
        "4 screws M2x6",
        "8 screws M3x6",
        "The forearm (a printed piece)",
        "1 three-pin cable"
      ].concat(SCREWS),
      safety: POWER_OFF + " " + REST,
      do: hornsFor(3).concat([
        "Press the base flat onto the table with one hand.",
        "Push motor 3 into the opening at the far end of the upper arm, the end away from the shoulder, with your other hand until it stops.",
        cableFor(3),
        "Screw in the first M2x6 screw through the upper arm into motor 3, turning it " + TURN_S + ".",
        "Screw in three more M2x6 screws the same way (four in total).",
        "Place the forearm onto the horns of motor 3, with its screw holes over the holes in the horns. The forearm is the second long printed piece, about 13 cm long.",
        "Screw in four M3x6 screws on one side of the forearm, one at a time, turning each " + TURN_L + ".",
        "Turn the assembly around to show its other side.",
        "Screw in four M3x6 screws on the other side of the forearm, one at a time, the same way."
      ]),
      know: [
        "Motor 3 sits all the way in the upper arm and does not rock when you wiggle it with two fingers.",
        "The forearm does not wobble where it meets the horns when you push its far end with one fingertip, with the force of pressing a doorbell."
      ],
      ifNot: ["If the forearm wobbles, turn each of its eight M3x6 screws until it stops. If it sits at an odd angle, unscrew it, place it on the horns again and compare with the official Joint 3 video."],
      check: ["4 screws M2x6 used for the motor", "9 screws M3x6 used (the horn screw, plus 4 on each side of the forearm)", "One 3-pin cable is plugged into motor 3"],
      warn: [
        "Only the top horn gets the horn screw. The bottom horn gets no screw.",
        "The official guide says '4 M3x6 screws on each side'. If a hole is left over, check the video."
      ],
      video: V + "Joint3_v2.mp4",
      diagram: "joint3",
      alsoDiagram: ["horns", "cables"],
      verify: true
    },
    {
      id: "joint-4",
      joint: "wrist_flex",
      title: "Joint 4: wrist flex (motor 4)",
      motorId: 4,
      minutes: 12,
      needs: [
        "Motor 4 (labelled 4) and its two horns",
        "1 screw M3x6 (the horn screw)",
        "4 screws M2x6",
        "Motor holder 4 (a printed piece)",
        "1 three-pin cable"
      ].concat(SCREWS),
      safety: POWER_OFF + " " + REST,
      do: hornsFor(4).concat([
        "Press the base flat onto the table with one hand.",
        "Fit motor holder 4 onto the end of the forearm that is farthest from the elbow, in the position the official Joint 4 video shows. Motor holder 4 is a printed piece about 3 cm by 4 cm by 5.5 cm, the same size as the shoulder motor holder.",
        "Push motor 4 into motor holder 4 with your other hand until it stops.",
        cableFor(4),
        "Screw in the first M2x6 screw through motor holder 4 into motor 4, turning it " + TURN_S + ".",
        "Screw in three more M2x6 screws the same way (four in total)."
      ]),
      know: [
        "Motor holder 4 does not slide on the forearm when you push it with one fingertip.",
        "Motor 4 sits all the way in its holder and does not rock when you wiggle it with two fingers."
      ],
      ifNot: ["If motor 4 rocks, unscrew its four M2x6 screws, push it in until it stops and screw it back. If you are unsure how the holder sits, compare with the official Joint 4 video."],
      check: ["4 screws M2x6 used", "1 screw M3x6 used (the horn screw)", "One 3-pin cable is plugged into motor 4"],
      warn: ["Only the top horn gets the horn screw. The bottom horn gets no screw."],
      video: V + "Joint4_v2.mp4",
      diagram: "joint4",
      alsoDiagram: ["horns", "cables"],
      verify: true
    },
    {
      id: "joint-5",
      joint: "wrist_roll",
      title: "Joint 5: wrist roll (motor 5)",
      motorId: 5,
      minutes: 15,
      needs: [
        "Motor 5 (labelled 5) and ONE horn",
        "1 screw M3x6 (the horn screw)",
        "2 screws M2x6",
        "M3x6 screws for the wrist: 4 on each side (the guide says '4 on both sides': check the video)",
        "The wrist holder (a printed piece)",
        "1 three-pin cable"
      ].concat(SCREWS),
      safety: POWER_OFF + " " + REST,
      do: [
        "Pick up the motor you labelled 5.",
        "Push motor 5 into the wrist holder with your other hand until it stops. The wrist holder is the printed piece that will carry motor 5, about 6 cm wide and 8 cm tall.",
        cableFor(5),
        "Screw in the first M2x6 screw on the front of the wrist holder, turning it " + TURN_S + ". The front is the face the official Joint 5 video shows.",
        "Screw in the second M2x6 screw on the front of the wrist holder, the same way.",
        "Press ONE horn onto the spindle of motor 5 with your thumb until it stops. This motor gets only one horn.",
        "Drop one M3x6 horn screw into the middle hole of that horn.",
        "Turn the horn screw " + TURN_L + ".",
        "Place the wrist holder, with motor 5 in it, onto the horns of motor 4, with its screw holes over the holes in those horns.",
        "Screw in four M3x6 screws on one side of the wrist, one at a time, turning each " + TURN_L + ".",
        "Turn the assembly around to show its other side.",
        "Screw in four M3x6 screws on the other side of the wrist, one at a time, the same way."
      ],
      know: [
        "Motor 5 sits all the way in the wrist holder and does not rock when you wiggle it with two fingers.",
        "The wrist does not wobble where it meets motor 4 when you push it with one fingertip, with the force of pressing a doorbell."
      ],
      ifNot: ["If the wrist wobbles, turn each of its M3x6 screws until it stops. If a hole is left over or does not line up, compare with the official Joint 5 video."],
      check: ["2 screws M2x6 used", "1 horn screw M3x6 used, and only ONE horn on motor 5", "One 3-pin cable is plugged into motor 5"],
      warn: [
        "Motor 5 gets only ONE horn. This is different from joints 1 to 4.",
        "The official guide says '4 M3x6 screws on both sides' for the wrist. The video shows exactly where they go; check it if a hole is left over."
      ],
      video: V + "Joint5_v2.mp4",
      diagram: "joint5",
      alsoDiagram: ["horns", "cables"],
      verify: true
    },
    {
      id: "gripper-follower",
      joint: "gripper",
      title: "Follower: the gripper (motor 6)",
      motorId: 6,
      minutes: 20,
      needs: [
        "Motor 6 (labelled 6) and its two horns",
        "1 screw M3x6 (the horn screw)",
        "4 screws M2x6",
        "M3x6 screws: 4 for the gripper body, and 4 on each side of the moving jaw (the guide says '4 on both sides': check the video)",
        "Printed parts: the follower gripper body and the moving jaw",
        "1 three-pin cable"
      ].concat(SCREWS),
      safety: POWER_OFF + " " + REST + " Keep your fingers out from between the two jaws once they are on.",
      do: [
        "Pick up the gripper body: the printed hand with a flat jaw built into it, about 10 cm long (on your print list: Wrist_Roll_Follower).",
        "Place the gripper body onto the single horn on motor 5, with its screw holes over the holes in the horn.",
        "Screw in four M3x6 screws through the gripper body into that horn, one at a time, turning each " + TURN_L + ".",
        "Pick up the motor you labelled 6.",
        "Push motor 6 into the opening of the gripper body until it stops.",
        "Screw in two M2x6 screws on one side of the gripper body, one at a time, turning each " + TURN_S + ".",
        "Screw in two M2x6 screws on the other side of the gripper body, the same way.",
        cableFor(6),
        "Press the first horn onto the spindle of motor 6 with your thumb until it stops.",
        "Drop one M3x6 horn screw into the middle hole of that horn.",
        "Turn the horn screw " + TURN_L + ".",
        "Press the second horn onto the matching round spot on the opposite face of motor 6 with your thumb until it stops. Leave this horn without a screw.",
        "Place the moving jaw onto the horns of motor 6, with its screw holes over the holes in the horns. The moving jaw is the printed lever that swings, about 9 cm long (on your print list: Moving_Jaw). The official guide calls it the gripper claw.",
        "Screw in four M3x6 screws on one side of the moving jaw, one at a time, turning each " + TURN_L + ".",
        "Turn the assembly around to show its other side.",
        "Screw in four M3x6 screws on the other side of the moving jaw, one at a time, the same way."
      ],
      know: [
        "The gripper body does not wobble where it meets the wrist when you push it with one fingertip, with the force of pressing a doorbell.",
        "The moving jaw does not wobble sideways when you push its tip with one fingertip."
      ],
      ifNot: ["If the moving jaw wobbles, turn each of its M3x6 screws until it stops. If you cannot see how it sits, or a hole is left over, compare with the official Gripper video."],
      check: ["4 screws M3x6 used for the gripper body", "4 screws M2x6 used for motor 6", "1 horn screw M3x6, and 4 screws M3x6 on each side of the moving jaw", "One 3-pin cable is plugged into motor 6"],
      warn: [
        "Motor 6 goes into the gripper body BEFORE its horns, as the official guide orders it.",
        "The official guide says '4 M3x6 screws on both sides' for the moving jaw. Check the video if a hole is left over.",
        "Only the top horn gets the horn screw. The bottom horn gets no screw."
      ],
      video: V + "Gripper_v2.mp4",
      diagram: "gripper-follower",
      alsoDiagram: ["horns", "cables"],
      verify: true
    },
    {
      id: "gripper-leader",
      joint: "gripper",
      title: "Leader: the handle and trigger (motor 6)",
      motorId: 6,
      minutes: 20,
      needs: [
        "Motor 6 (labelled 6) and ONE horn",
        "1 screw M3x6 (the horn screw)",
        "5 screws M2x6: 1 for the handle, 4 for the motor",
        "8 screws M3x6: 4 for the leader holder, 4 for the trigger",
        "Printed parts: the leader holder, the handle and the trigger",
        "1 three-pin cable"
      ].concat(SCREWS),
      safety: POWER_OFF + " " + REST,
      do: [
        "Place the leader holder onto the wrist, where the official Leader video shows it. The leader holder is the leader-only printed piece that takes the place of the follower's gripper body.",
        "Screw in four M3x6 screws through the leader holder into the wrist, one at a time, turning each " + TURN_L + ".",
        "Place the handle against the leader holder, where the official Leader video shows it. The handle is the printed grip you hold in your hand (on your print list: Handle).",
        "Screw in one M2x6 screw through the handle into the leader holder, turning it " + TURN_S + ".",
        "Pick up the motor you labelled 6.",
        "Push motor 6 into its opening in the leader holder until it stops.",
        "Screw in two M2x6 screws on one side of the leader holder, one at a time, turning each " + TURN_S + ".",
        "Screw in two M2x6 screws on the other side of the leader holder, the same way.",
        cableFor(6),
        "Press one horn onto the spindle of motor 6 with your thumb until it stops. This motor gets only one horn.",
        "Drop one M3x6 horn screw into the middle hole of that horn.",
        "Turn the horn screw " + TURN_L + ".",
        "Place the trigger onto the horn, where the official Leader video shows it. The trigger is the small printed lever that your finger squeezes (on your print list: Trigger).",
        "Screw in four M3x6 screws through the trigger into the horn, one at a time, turning each " + TURN_L + "."
      ],
      know: [
        "The handle does not wobble when you wiggle it with two fingers.",
        "The trigger does not wobble sideways when you push its tip with one fingertip."
      ],
      ifNot: ["If a piece wobbles, turn its screws until each stops. If you cannot tell where the leader holder, the handle or the trigger go, compare with the official Leader video; the names on your print list are listed in the parts list."],
      check: ["4 screws M3x6 used for the leader holder", "1 screw M2x6 used for the handle", "4 screws M2x6 used for motor 6", "1 horn screw M3x6, and 4 screws M3x6 on the trigger"],
      warn: [
        "The leader's gripper motor gets only ONE horn, as the official guide says.",
        "The names of the leader pieces on your print list may differ from the words here. The official video is the reference."
      ],
      video: V + "Leader_v2.mp4",
      diagram: "gripper-leader",
      alsoDiagram: ["horns", "cables"],
      verify: true
    },
    {
      id: "chain",
      joint: null,
      title: "Join the motors in a chain and fix the board",
      motorId: null,
      minutes: 10,
      needs: ["The finished arm, with one 3-pin cable plugged into every motor", "The USB servo board of this arm"],
      safety: "The power supply and the USB cable stay unplugged for this whole card. Do not plug the power in until you are done with this arm.",
      do: [
        "Check that the power supply and the USB cable are not plugged into the board.",
        "Push the loose end of motor 6's cable into the free socket of motor 5 until the plug sits flush with the socket opening.",
        "Push the loose end of motor 5's cable into the free socket of motor 4 until it sits flush.",
        "Push the loose end of motor 4's cable into the free socket of motor 3 until it sits flush.",
        "Push the loose end of motor 3's cable into the free socket of motor 2 until it sits flush.",
        "Push the loose end of motor 2's cable into the free socket of motor 1 until it sits flush.",
        "Push the loose end of motor 1's cable into a motor socket on the board until it sits flush.",
        "Fix the board to the mounting plate in the base, the way the official SO-ARM100 pictures show.",
        "Look along the cables from the board to motor 6.",
        "Repeat all of this for the other arm."
      ],
      know: [
        "Following the cables with a fingertip from the board, you pass 6 motors in a row: 1, 2, 3, 4, 5, 6.",
        "Every plug sits flush with its socket, and no cable is pinched between two printed parts."
      ],
      ifNot: ["If a cable is too short to reach, swap it for a longer one from your kit; the order of the chain stays the same. If you lose track, pull the cables out of the board and motor 1 and start again at motor 6."],
      check: ["Board, then motor 1, 2, 3, 4, 5, 6 in one line", "No cable is pinched between two printed parts"],
      warn: ["The chain is board, 1, 2, 3, 4, 5, 6. One loose cable in the middle makes every motor after it stop answering."],
      video: null,
      diagram: "chain",
      alsoDiagram: ["cables"],
      verify: true
    }
  ],
  afterAssembly: [
    "Clamp each arm's base to the table with a table clamp. Then push the top edge of the base sideways with one fingertip, with the force you use to press a doorbell: it must not rock or slide.",
    "Plug the USB cable into the board and into your computer.",
    "Plug the power supply into the board, then into the wall. First read the label: it must match the motors of that arm.",
    "Open the Setup check page. It shows how many motors answered on each arm. You want to see 6.",
    "Open the Calibrate page and calibrate the follower, then the leader.",
    "Read the Safety checklist before you move anything."
  ]
};
