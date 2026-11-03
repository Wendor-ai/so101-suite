# Suite UI: contract for pages

Plain ES modules, no build step, no CDN. The same code runs in the live app (`/suite/`) and on the website (`/app/`, demo mode).
Read `docs/design/information-architecture.md` (what each page is for) and `docs/design/physical-instructions.md` (how to tell a person to touch hardware) before writing a page.

## Files

| File | Job |
|---|---|
| `index.html`, `css/suite.css`, `css/components.css` | Frame, design tokens, components. Use the existing classes before adding CSS. |
| `js/main.js` | Boot: live backend or built-in demo, settings, shell, router |
| `js/api.js` | `api.get(path)`, `api.post(path, body)`; throws `ApiError` with a human sentence. `api.demo` is true in demo mode |
| `js/state.js` | `createCtx()`, `poseFromArm(arm)`, `normalized(arm, joint)`, `JOINTS`, `JOINT_LABEL` |
| `js/ui.js` | `h, icon, rich, toast, askYes, badge, dot, chip, button, actions, ring, callout, copyBox, empty, skeleton, term, cameraView, pageHead, safe, debounce` |
| `js/steps.js` | `stepCard`, `preflight`, `progressCue`, `rightWrong` (physical instructions) |
| `js/limp.js` | The standing safety rule as code: `limpState(ctx)`, `ensureLimp(ctx, {onStatus})` (POST `/api/pp/rest`: lowers the follower, then lets go; waits for `pp.limp`), `limpCard(ctx, {title, then})`. Use it before ANY step that asks a person to touch the arm |
| `js/twin.js` | `mountTwin(el, {pose, highlight, view, interactive, zoom, onPick, autoRotate})` real 3D SO-101 |
| `js/shell.js`, `js/router.js` | Frame and hash routing (do not edit from a page) |
| `js/pages/<id>.js` | One file per page |
| `js/content/*.js` | Pure data (learn, glossary, assemble, anatomy, troubleshooting) |
| `js/mock/*` | In-browser fake backend (demo mode) |

## A page

```js
import { h, button, callout, pageHead } from '../ui.js';
export default {
  id: 'calibrate', title: 'Calibrate',
  render(root, ctx, route) {            // route = {page, args, query}
    root.append(pageHead('Get started', 'Calibrate your arm', 'Takes about 2 minutes.'));
    const off = ctx.onChange(c => c.arm('follower')?.calib?.step, step => { /* update only what changed */ });
    return () => off();                  // cleanup: unsubscribe, destroy camera views and twins
  },
};
```

`ctx`: `api`, `state` (live `/api/state`, refreshed every 500 ms), `checklist`, `info`, `settings`, `offline`,
`subscribe(fn)`, `onChange(select, cb)`, `arm('follower'|'leader')`, `go('calibrate?first=1')`, `setSetting('ui.units','norm')`, `refresh()`, `guide` (`'beginner'|'expert'`), `units` (`'deg'|'norm'`), `moving`.

## Rules (each one exists because of a real failure, see `docs/LEARNINGS.md` §4, §14)

1. **Never rebuild DOM on every tick.** `ctx.subscribe` fires twice a second. Use `ctx.onChange(select, cb)` and rebuild only when what you draw changed; update live numbers by setting `textContent` on existing nodes. Never rebuild while a button is pressed (a re-drawn button eats clicks).
2. **No browser pop-ups** (`alert`, `confirm`, `prompt`). Use `askYes(message, 'Yes, start', fn)` (inline bar) and `toast`.
3. **Every disabled button says why.** `button('Save', {why: 'Move every joint first'})` greys it out; wrap groups in `actions([...])` so one line lists the reasons.
4. **Never fail silently.** Wrap click handlers in `safe(fn)`. Camera views show a reason (`cam.setStatus(false, 'in use by another app')`), never a black box. Every empty state explains what to do.
5. **Every term a beginner may not know is `term('motor-id', 'motor ID')`** (opens the glossary card). Long copy lives in `js/content/*`, not in the page.
6. **Physical steps use `stepCard`/`preflight`** and include a diagram (SVG) with a stated viewpoint; name only buttons that exist with their exact label; one action per step; say what will move and where hands must not be.
7. **Arm moves only after the person asks.** Put a plain sentence first ("The arm will lift and turn. Keep your hands clear.") and confirm with `askYes`. The STOP button is global (`shell.js`).
8. **Clean up.** Return a function that unsubscribes, calls `cameraView.destroy()` and `twin.destroy()`.
9. **Relative asset URLs only** (`new URL('../assets/...', import.meta.url)`); no CDN; works offline.
10. **Accessible:** real `button`/`a` elements, labels on icon-only buttons, visible focus, AA contrast, works at 360 px wide and with the keyboard.
11. **Beginner vs expert:** wrap extra explanations in an element with class `beginner-only` (hidden in Expert mode).
12. **Zero is the middle.** Joint values are shown as degrees where 0 = middle of the recorded range (`poseFromArm`) or `normalized()` for LeRobot's -100..+100; respect `ctx.units`.
13. **Never ask a person to touch, hold, place or move anything near the arm while it is stiff** (`docs/LEARNINGS.md` 17, physical-instructions rule 13). Check `ctx.state.pp.limp` (`limpState`), make it limp first with `ensureLimp`/`limpCard` (lowers the arm, then lets go), say "The arm is limp now." in the first line, and say "hands off" before the motors switch on. Never use a bare `POST /api/pp/release` or a calibration start to prepare a person's step: they switch the torque off at once and drop a raised arm.

## Run and look at it

```bash
# real backend with simulated hardware (needs the Python env; ports 8110-8119 are for agents)
uv run so101 start --demo --no-browser --port 8112      # then open http://localhost:8112/suite/
# or no Python at all: the page falls back to the in-browser mock when no backend answers
python3 -m http.server 8130 --directory app/suite        # needs ./vendor and ./assets next to it (the website build copies them)
```
Query flags: `?demo=1` force the mock, `?scenario=fresh|ready|nothing|stiff` (`stiff`: calibrated arms and the follower holding itself, to demo the "make it limp first" flow), `?seed=7`, `?os=linux|windows`.
Check every page at 1280 px and 360 px wide, in dark and light theme, with the console open (no errors).
