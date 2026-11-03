# Information architecture (IA)

Made **before** any UI work, on purpose: this is the map every screen is built from.
Covers (1) the Suite web app, (2) its Settings, (3) the public marketing site with the no-backend demo.

## 1. Who it is for

| Person | Wants | Needs from the app |
|---|---|---|
| **Unboxer**: just bought the kit, may never have coded | "Make it move" | One command, one next step at a time, no jargon, no way to break things |
| **Builder**: arm is assembled | Calibrate, add cameras, run pick & place | A truthful "what's connected / what's left" list, fast fixes |
| **Curious**: no arm yet (or evaluating the kit) | Understand what it does | The Learn section and the live demo that needs no hardware |
| **AI-assisted developer** | Extend it with Claude/Codex/Cursor | `AGENTS.md`, skills, a documented API, a demo mode to test against |
| **Contributor** | Add a module or fix a bug | Clear layout, tests, module template |

## 2. Principles

1. **One next step, always.** Every screen says what to do next; the header always shows it.
2. **Explain on demand.** Every unfamiliar word is a *Term*: tap it for a plain-language card with a picture. Beginner mode (default) shows explanations inline; Expert mode folds them away.
3. **Truth over reassurance.** Status chips and the checklist come from the real machine. A black camera box is a bug: show the reason.
4. **Never trapped.** Every page has Back, Help and a way out of a stuck state. STOP is always visible whenever an arm is powered.
5. **The arm moves only when asked,** after a plain sentence saying what will move ("The arm will lift and turn. Keep your hands clear."), confirmed inline (no browser pop-ups).
6. **Same app everywhere.** The web app and the website demo are the same UI; only the backend differs (real vs simulated).
7. **Fast to scan.** Short sentences, verbs first, numbers for physical steps, one primary action per screen.

## 3. Suite sitemap

Routes are hash routes (`#/...`) so the app is a static bundle that also runs on the website.

```
Welcome            #/welcome            first run: "I just unboxed it" | "My arm is built" | "Just looking around"
Home               #/                   Next-step card, progress, what's connected, quick links

GET STARTED (the journey, numbered in the nav)
  1 Setup check    #/setup              Every check, grouped; each non-OK item has a fix button
  2 Motor IDs      #/motors             Find the board -> label Leader/Follower -> set IDs one LOOSE motor at a time (before building, like the official guide)
  3 Assemble       #/assemble           Parts, tools, 1 card per joint, tick off, official videos
  4 Calibrate      #/calibrate          Centre -> sweep -> save; every joint reads 0 at the middle
  5 Cameras        #/cameras            Detect/add cameras, live view, click-to-calibrate

USE
  Control          #/control            The 3D twin, leader -> follower, pick & place (existing dashboard, embedded)
  Modules          #/modules            Installed modules, status, "add one with AI"; each module may add #/m/<id>

LEARN
  Learn hub        #/learn              Paths: Meet your arm - How it works - Why calibrate - Cameras and the table - Safety - Lessons learned
  Learn article    #/learn/<id>
  Glossary         #/glossary           Every term, searchable

HELP
  Help             #/help               Symptom -> tests -> fix; "Copy diagnostics"; "Ask an AI" prompt; community links

SETTINGS           #/settings
```

**Global frame (every screen):**
- Left nav (collapses to a bottom bar under 720 px): Home, the five journey steps with done-ticks, Control, Modules, Learn, Help, Settings.
- Top bar: logo, page title, status chips (Follower, Leader, Camera 1..n, each with a live dot and a reason on hover), **Next step** pill, **STOP** (shown whenever an arm has torque on), command palette hint (`Ctrl/Cmd+K`).
- Footer strip in demo mode: "Demo: simulated hardware. Nothing here is real."

## 4. Page inventory

For each page: purpose, primary action, content blocks, empty state, error state.

| Page | Purpose | Primary action | Empty / error |
|---|---|---|---|
| **Welcome** | Route a person by situation | Three big choices | n/a |
| **Home** | Orient and push forward | "Next step: <title>" button | No hardware: "Nothing connected yet" + Setup + Demo hint |
| **Setup check** | Truthful status | The fix button on the first non-OK item | Everything OK: celebratory state + "Open Control" |
| **Assemble** | Build the arms | "Mark step done" | Skippable: "My arms are already built" |
| **Motor IDs** | Make the bus addressable | "Set ID <n>" (only when exactly one motor is connected) | Refusal always explains why ("2 motors answer: plug in only the gripper motor") |
| **Calibrate** | Teach the arm its range | "It's centred" -> "Save" | Arm not connected: show what to plug in; mid-run disconnect: pause and say so |
| **Cameras** | Cameras visible and mapped | "Add camera" / click on picture | None found: per-OS reasons (permission, in use, unplugged) |
| **Control** | Run the arm | Start leader -> follower | Embedded dashboard; if server down: reconnect banner |
| **Modules** | Extend | "How to add a module" | None installed: explain + hello module |
| **Learn** | Understand | Open an article | n/a |
| **Help** | Unstick | "Copy diagnostics" | Search finds nothing: "Ask an AI" prompt prefilled |
| **Settings** | Preferences | n/a | n/a |

### Calibrate (detail, because it is the heart)
1. *Before you start* (what calibration is, 30 s read, safety).
2. **Centre**: arm goes limp; picture of the middle pose; "It's centred".
3. **Sweep**: each joint has a bar with a **0 tick in the middle**, the live value (degrees and -100..+100), min/max markers that grow, and a tick when its span is big enough. Wrist roll spins freely: explained.
4. **Save**: written to the LeRobot-compatible file; shows the path and a "Restore default / Set as default" row.
Zero rule shown everywhere: *0 = middle of the range you just recorded.*

### Cameras (detail)
List (name, source, fps, resolution, status) - Add (detected USB list, network URL) - Live view - **Click-to-calibrate**: instruction sequence, click the gripper tip in the picture; each click is a taught point with fit error shown; "Auto" option for the hands-free flow. AI/CLI alternative documented next to it (snapshot URL + teach endpoint).

## 5. Settings IA (`#/settings`)

| Group | Items | Stored |
|---|---|---|
| **Appearance** | Theme (Auto / Dark / Light), accent colour (Orange default, 5 more), text size, reduce motion | `ui.theme, ui.accent, ui.textSize, ui.reduceMotion` |
| **Explanations** | Beginner mode (inline help) vs Expert mode | `ui.guide` |
| **Units** | Joint display: degrees (0 at middle) or LeRobot -100..+100 | `ui.units` |
| **3D view** | Existing look options (theme, arm colour, floor, camera angle, labels, ghost, trail) | localStorage `so101-ui` |
| **Devices** | Rename arms; swap Leader/Follower; forget a port; camera order | `arms.*, cameras.*` |
| **Safety** | Confirm before every arm move (on), max speed preset (gentle/normal), STOP shortcut (Space) | `safety.*` |
| **Data** | Data folder path, export config (.json), import, reset onboarding | server store |
| **Advanced** | Restart app, show raw API links, enable modules, diagnostics log level | `adv.*` |
| **About** | Version, licence (AGPL-3.0), third-party notices, links, "Copy diagnostics" | read-only |

In the website demo, Settings persist to `localStorage` instead of the server store.

## 6. Key flows

1. **Unboxer:** Welcome -> Motor IDs (motors still loose, one at a time) -> Assemble -> Calibrate -> Cameras (optional, skippable) -> Control. *(Order follows the official LeRobot guide: IDs first, because each motor must be plugged in alone.)* The nav shows "3 of 5 done".
2. **Built arm:** Welcome -> Setup check -> fix the first red item -> repeat -> Control.
3. **Returning:** `/` lands on Control once onboarding is done; the Suite button in the dashboard goes back to Home.
4. **Stuck:** any screen -> Help -> symptom -> test -> fix; or Copy diagnostics -> paste to an AI/issue.
5. **Extend with AI:** Modules -> "Add a module with AI" -> copies a prompt that points at `AGENTS.md` and the `add-module` skill.
6. **Visitor on the website:** Home -> "Try the live demo" -> Welcome (demo banner) -> any flow, simulated.

## 7. Terminology (use exactly these words)

| Say | Not |
|---|---|
| **Leader arm / Follower arm** | master/slave, arm 1/2 |
| **Motor ID** | servo address |
| **Joint** (shoulder pan, shoulder lift, elbow flex, wrist flex, wrist roll, gripper) | axis, DOF in beginner copy |
| **Jaw** (fixed jaw + moving jaw = the "fingers") | claw |
| **Calibrate** / **middle of range = 0** | home/zero offset (only in Expert detail) |
| **Camera mapping** (pixel <-> table position) | extrinsics |
| **Module** | plugin, addon |
| **Demo mode** | simulation |

## 8. Voice and UX rules

- Second person, present tense, short. "Plug in the USB cable of the arm you want to set up."
- Physical instructions are numbered, one action each, and only name buttons that exist with their exact label.
- Every disabled control shows a reason beside it. Every error says what happened, why, and the next action.
- Motion is purposeful (150-200 ms), respects `prefers-reduced-motion`.
- Accessible: WCAG AA contrast, visible focus, full keyboard use, labels on icon buttons, live regions for status changes.
- Responsive from 360 px; touch targets >= 44 px.

## 9. Design language

Dark "instrument panel" default with the SO-101 orange accent (`#ff8a1f`), light theme as equal citizen. System font stack (works offline). Rounded 14 px cards, hairline borders, generous spacing (4/8/12/16/24/32), one accent per screen, status colours reserved for status (green ok, amber todo/warn, red fail, blue info). The 3D arm is the hero visual (Home, Learn, Calibrate).

## 10. Marketing site (Astro, served by Cloudflare)

```
/                Home: hero, install command (OS tabs + copy), feature grid with screenshots, 3-step how it works, FAQ, GitHub/stars
/demo            The Suite running in demo mode (no backend), full screen
/features        Feature tour with screenshots: checklist, calibration, cameras, learn, modules, AI-friendly
/get-started     Quickstart per OS, what to buy, links to official build guides
/learn, /learn/<id>   Learn articles rendered statically from the same content as the app
/docs, /docs/<id>     Rendered docs (architecture, API, modules, troubleshooting)
/modules         Module gallery from modules/*/module.json
/ai              Built for AI agents: AGENTS.md, skills, API, demo mode
/about           Licence (AGPL-3.0), roadmap, community, credits
/404
```

The demo is the same `app/suite` bundle with a **mock backend** (`js/mock/*`) that implements the Suite API in the browser, so what visitors try is what ships.

## 11. Debug tools (amends §3-§6): Test motors and Inspector

People are intimidated by debugging hardware because it is invisible. Two tools make it visible.

**Nav:** a new group **DEBUG** (after Help, before Settings): **Test motors** `#/test`, **Inspector** `#/inspector`. Linked from Setup check (a motor that does not answer),
Help, Motor IDs, and any Calibrate error.

### Test motors (`#/test`): "Is my arm healthy?"
- Primary action: **Check all motors** (ping each ID, then wiggle each in turn) -> a report card: six rows, each OK or a specific problem with a picture and a fix.
- One card per motor (1-6): which joint it is and **where it is on the arm** (3D model highlights the part), live position (0 at the middle), load %, temperature, then two buttons: **Ping** (read-only, never moves) and **Wiggle** (a small, slow move of about 10 degrees there and back).
- Each card says **what you should see** ("the gripper jaw opens and closes a little") and **if not** (cable, power, ID, with a diagram).
- Safety: Wiggle asks first ("Hold the arm or rest it on the table. This joint will move a little"), never runs during calibration, teleop or a pick and place job, STOP stays visible, and the joint ends **in the state it started** (limp stays limp, holding stays holding).
- Result line after a wiggle: "Motor 6 moved 11 degrees. It works." or "Motor 6 did not move. Check its cable and power." with a link to the fix.
- A **mini communication view** under the cards shows the last few messages to that motor ("The app asked motor 6 where it is. It answered 2048 = 0 degrees"), so people learn what is happening.

### Inspector (`#/inspector`): like a browser's Network tab for the arm
- **Off by default.** An explicit **Record** switch with one honest sentence: "Records what the app and the motors say to each other. Stays on this computer, in memory (last 5,000 entries). Nothing is sent anywhere."
- Filters: **All - Bus** (messages to the motors) **- Network** (the app's own web API) **- Logs** (app messages) **- Errors only**; search box; Pause; Clear; Export (JSON, NDJSON, text); **Copy as issue report**.
- Table (like DevTools): Time (relative), Type, Summary in words ("Read position, motor 3 -> 2048"), Status (OK/ERR), Duration (ms bar), Size. Click a row: a detail drawer with **Request - Response - Timing - Explain**; **Raw bytes** (hex) only when the Advanced raw switch is on.
- **Group polling** (on by default) folds the repeating 10 Hz reads into one expandable line so beginners see events, not noise.
- **Explain** translates a row into plain words using the register map (ID, torque enable, goal position, present position, load, temperature...).
- Settings (Advanced): start recording on launch (off), capture raw bytes (off), max entries (5,000).
- Privacy: entries hold only motor IDs, register numbers, values, API paths and status codes; export is always an explicit click.

### Flow 7: Debug
Setup check shows a red motor -> **Test motors** -> Ping/Wiggle -> the report says "motor 4 does not answer; check its cable" with a picture -> fix -> Check all again. Still stuck: **Inspector** -> Record -> reproduce -> **Copy as issue report**.

### Terminology additions
**Wiggle** (a small safe move to prove a motor works), **Ping** (ask a motor "are you there?"; never moves it), **Bus** (the daisy-chained cable that carries messages to all motors), **Inspector** (not "console" or "packet sniffer" in beginner copy).
