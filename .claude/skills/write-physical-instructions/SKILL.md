---
name: write-physical-instructions
description: Write step-by-step instructions that tell a person to touch, hold, move, plug in or press something on the robot (assembly, calibration, motor IDs, camera mapping, repairs, tests) so a non-expert can follow them without guessing. Use whenever you are about to tell a human to do something physical, or write app pages, docs or chat replies that contain hands-on steps.
---

# Write physical instructions

Condensed from `docs/design/physical-instructions.md` (read it for the full story). These rules come from a real project where the owner said "you are really horrible with instructions", "sliding, what does it mean", "there is no button called Tune", and "the robot is too stiff, never ask me to do anything when the robot is stiff". Every rule exists because of one of those failures.

## The 13 rules

1. **Name things by how they look and where they are**, with a landmark the person can see now ("the round white disc on the motor's output shaft"), not by role or jargon.
2. **Define every part word once**, with a pointer or picture ("jaw: one of the two long pieces at the bottom of the gripper").
3. **One action per step, one verb.** "Pick it up and put it between the jaws" is two steps.
4. **Say which hand, which direction, how far, how fast**, in human units (finger-widths, a coin, "as slowly as lowering a cup onto a saucer"). Left and right only relative to a landmark.
5. **Give the end state**, not only the motion ("both jaw tips touch the table" beats "lower the gripper").
6. **Every step has a visible check** (what they will see, hear or feel) **and an "if not"** (one concrete fallback).
7. **Never name a control you have not seen.** Use the exact label as displayed and say where it is. A control that cannot be clicked looks disabled and shows why.
8. **Never give a step that cannot be done**: no reach beyond the arm, no scrolling in a pop-up, no free hand that is busy holding the arm, no time they do not have.
9. **Order for safety.** Say what will move, drop, heat or pinch; "hold X BEFORE you press Y"; where hands must not be.
10. **Never leave a person holding a pose while the app thinks.** Acknowledge at once ("Got it, you can let go"), compute after.
11. **Short beats complete.** No "slightly", "gently", "roughly", "nearby" without a referent.
12. **Draw it.** Any step with a position, direction, orientation, hand or count gets a diagram from a stated viewpoint ("top view, you sit at the bottom"): the thing to do in colour, the thing to avoid in red, the wrong way beside the right way when a common mistake exists.
13. **Never ask a person to touch, hold, place or move anything near the arm while it is STIFF** (torque on, holding, moving, or able to move). Make it limp first, **lowered**: `POST /api/pp/rest` (the dashboard and Control button `Release arm`) lowers the arm onto the table and only then lets go, so nothing drops and nobody holds it. Check the real state (`/api/state` -> `pp.limp`) before every physical instruction, say the state in the FIRST line ("The arm is limp now."), and say "hands off" BEFORE the motors switch on again. Never use a bare `POST /api/pp/release`, or start a calibration, to prepare a person's step (both switch the torque off at once and drop a raised arm), and never write "hold the gripper/arm with one hand" before releasing. Keeping clear, pressing a button on screen and moving a LIMP arm by hand are fine. A stiff arm that cannot be lowered (follower not calibrated or not answering): say "do not touch it" and point to Help; never advise holding it or cutting its power. In the app use `app/suite/js/limp.js` (`limpState`, `ensureLimp`, `limpCard`).

**Design for human ability.** People cannot give exact centimetres, exact angles or "perfectly straight". Ask for what they can do reliably (put a thing on a mark, hold still two seconds, tilt until a landmark moves two finger-widths) and let sensors, cameras and maths supply the precision.

## The step card

```
STEP 2 of 5: put the keychain between the jaws
WHERE:    the two black jaws at the bottom of the gripper (picture, circled)
DO:       lay the keychain flat, like a card on a table, between the two open jaws
HOW:      ring end pointing at the monitor; the keychain's middle between the jaw tips
YOU'LL KNOW IT WORKED WHEN: the keychain sits level and does not fall when you let go
IF NOT:   open the jaws wider and try again
THEN:     the page shows "Spot 2 saved" and a short tick sound
```

Also: a **preflight** before step 1 (what you need, hands, what moves, what to clear, how to stop), a **safety block** first when anything can move ("The arm is limp now. It moves freely and falls back down when you let go: keep your fingers out of the gaps between the parts." / "Hands off the arm now: it lowers itself onto the table, then goes limp."), a **progress cue** ("spot 2 of 3") in every loop, and a **completion** line ("Done: your follower is calibrated. You can let go.").

## In the app

Use the components in `app/suite/js/steps.js`: `stepCard({n, total, id, title, where, do: [...], how, know, ifNot, then, safety, diagram, caption, footer})`, `preflight({title, needs, hands, moves, clear, stop})`, `progressCue('spot', 2, 3)`, `rightWrong(right, wrong)`. Diagrams are SVG with a stated viewpoint, in `app/suite/js/diagrams/*.js`. Examples to copy: `app/suite/js/pages/calibrate.js`, `motors.js`, `cameras.js`. Arm moves go through `askYes(...)` with a plain sentence first and "hands off" when the motors will switch on; **STOP** is global; never use a browser pop-up.

## In chat or docs

Numbered list, one action per item, each with its check; the safety line first, in plain text. If the person is moving a LIMP arm, tell them which of their hands stays free for the mouse. Never ask anyone to hold a stiff arm.

## Before you ship

- [ ] A smart stranger could do step 1 right now with no questions.
- [ ] Every object is identified by appearance **and** location; every term defined.
- [ ] Every step: one action, a visible check, an "if not".
- [ ] Every button named in the text exists with exactly that label (click-test it in demo mode: `uv run so101 start --demo --no-browser --port 8150`).
- [ ] No precision a hand and eye cannot deliver.
- [ ] A diagram for every spatial idea, viewpoint stated; picture N matches step N.
- [ ] The order is safe and a hand is free for what you ask.
- [ ] The arm is limp (real state `pp.limp`, lowered with `Release arm`) before any step that touches, holds, places or moves anything near it; the first line says so; "hands off" comes before the motors switch on (rule 13).
- [ ] You said how long to hold still and when they may let go.
- [ ] You tested it (demo click-through) and wrote down what you could not test (real hardware).
