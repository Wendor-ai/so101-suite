---
name: Hardware help
about: Your arm, motors, USB adapter or camera does not work, and you want help
title: ""
labels: hardware
assignees: ""
---

<!-- Hardware problems are normal, and we are happy to help. Please work through these first, they fix most cases:
     1. Open the app, then Test motors (Check all motors).
     2. Look at the Help page for your symptom, or docs/TROUBLESHOOTING.md.
     3. Run `uv run so101 doctor`.
     Please never paste photos or text that show serial numbers, network addresses or your name. -->

## What is not working

<!-- For example: "motors 4, 5 and 6 do not answer", "the camera is black", "the arm twitches". -->

## What you see in the app

- Setup check: which items are not green, and what do they say?
- Test motors: which motors answer (ping), which ones move (wiggle)? 

## What you have

- Operating system and version:
- Computer (for example a laptop, a Raspberry Pi 5):
- USB servo board (the model, if you know it) and how it is connected:
- Power supply voltage and what the label on the motors says (7.4 V or 12 V):
- One arm or two (leader and follower)? Built, or motors still loose?
- Cameras (USB model or network):

## What you already tried

- [ ] Both ends of every 3-pin cable pushed in until they sit flush
- [ ] The board's power supply plugged in, and a different USB cable tried
- [ ] On a Waveshare board, both jumper caps on **B**
- [ ] On Linux: user in the `dialout` group (and `video` for cameras), logged out and in again
- [ ] Only one program uses the arm (no other copy of the app, no LeRobot window)

## `so101 doctor` output

```
paste here
```

## Inspector report (optional)

<!-- Inspector page, switch Record on, repeat the problem, then press "Copy as issue report" and paste it here. -->

```
paste here
```
