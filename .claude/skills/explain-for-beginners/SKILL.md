---
name: explain-for-beginners
description: Write or review user-facing text for SO-101 Suite in the project's plain, friendly voice - app copy, error messages, help, README and docs sections, glossary entries. Use when asked to "explain this simply", "write copy", "make this beginner friendly", "reword this error", "write the help text", or whenever you add any text a first-time builder will read.
---

# Explain for beginners

The reader just bought a robot arm, may never have coded, and is a little afraid of breaking it. The text must make them feel capable. Voice and terms: `docs/design/information-architecture.md` sections 7 and 8; UI rules: `app/suite/js/README.md`.

## The voice

- **Second person, present tense, short sentences, verbs first.** "Plug in the USB cable of the arm you want to set up." Not "The user should connect...".
- **Say what happened, why, and the next action**, in that order, for every error. "The app can't open the camera. Another app is using it. Close the other app, then press Look again."
- **No jargon without a way to learn it.** A term a beginner may not know is `term('motor-id', 'motor ID')` in the UI (opens a plain card with a picture), or a glossary entry. Define it once, in one sentence, the first time.
- **Honest, never hype or alarm.** No "simply", "just", "easily", "powerful", "seamless". No fake reassurance: if a step can hurt or drop the arm, say so first. No "oops".
- **Numbers and names over adjectives.** "Move it about a hand-width" not "move it a bit". For physical actions use `write-physical-instructions`.
- **One idea per paragraph, one primary action per screen.** Put the thing to do before the explanation of why.
- Accessible: no meaning carried only by colour; link text says where it goes ("Open the Setup check", not "click here").

## Use the project's words

| Say | Not |
|---|---|
| Leader arm, Follower arm | master/slave, arm 1/2 |
| Motor ID | servo address |
| Joint (shoulder pan, shoulder lift, elbow flex, wrist flex, wrist roll, gripper) | axis, DOF |
| Jaw (fixed jaw, moving jaw) | claw, finger (the SO-101 has two jaws, not five fingers) |
| Calibrate, "0 = the middle of the range" | home, zero offset (Expert detail only) |
| Camera mapping | extrinsics |
| Module | plugin, addon |
| Demo mode | simulation |
| Wiggle (a small safe move), Ping (never moves), Bus, Inspector | packet sniffer, console |

## Where text lives

- Page text is short, in the page file; **long copy goes in `app/suite/js/content/*.js`**: `learn.js` (articles), `glossary.js`, `assemble.js` (step cards), `troubleshooting.js` (symptom -> test -> fix), `anatomy.js`.
- Inline tags in content strings: `<b> <i> <code>` (the header of `learn.js` allows only those; `rich()` in `app/suite/js/ui.js` and the website also accept `<em> <strong> <kbd> <br> <a href>`). Hash links like `#/learn/why-calibrate` are routes inside the app.
- Extra explanations that Expert mode may hide go in an element with class `beginner-only`.
- Every disabled button has a reason next to it (`button('Save', {why: '...'})`).

## Before and after

- Before: "ERR_PORT_BUSY on /dev/ttyACM0." After: "The app can't use the USB port: another program is using it. Close any other copy of the app or a LeRobot window, then press Try again."
- Before: "Calibrate the homing offsets." After: "Teach the arm where the middle of each joint is. It takes about two minutes."
- Before: "Gently rotate the wrist slightly." After: "Turn the wrist a quarter turn, as slowly as lowering a cup onto a saucer."

## Check before you finish

1. Could a smart 12-year-old do the first thing you say, right now, with no questions?
2. Every unfamiliar word is a `term()` or defined in place. No word from the "Not" column above.
3. Every error says what happened, why, and what to do next.
4. Every button you name exists, with that exact label (click it in demo mode: `uv run so101 start --demo --no-browser --port 8150`).
5. No claim you did not verify: no counts, benchmarks, prices, availability, or "works on X" without a test.
6. Read it aloud. If you run out of breath, split the sentence.
