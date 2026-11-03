---
name: run-demo-and-tests
description: Run the SO-101 Suite with simulated hardware (demo mode), click-test it, and run every test suite safely. Use when asked to "run the app", "start the demo", "run the tests", "check my change", "verify it works", "click through the UI", or before saying a change is done.
---

# Run the demo and the tests

Everything here is safe: demo mode uses a fake motor bus and synthetic cameras, tests run with `SO101_NO_REAL_PORTS=1`. **Never run `so101 start`/`setup` against a real arm unless the owner asked, never start a server on port 8000** (the owner's live dashboard may be on it), and stop every server you start.

## 1. Environment

```bash
uv sync --extra dev          # once; installs the package and pytest into ./.venv
# offline or in a shared environment: UV_PROJECT_ENVIRONMENT=<path to a venv> uv run --offline ...
```

## 2. Python tests (about 240)

```bash
SO101_NO_REAL_PORTS=1 uv run pytest -q                    # everything
SO101_NO_REAL_PORTS=1 uv run pytest -q tests/test_checklist.py -k camera    # one file / keyword
```

`tests/conftest.py` gives every test its own `HOME`, `SO101_HOME` and `HF_LEROBOT_CALIBRATION`, so nothing touches real files; the `srv` fixture starts a real demo server on an ephemeral port (`tests/helpers.py`: `start_demo_server`, `Srv.get/post`, `wait_arms`). Config-aware tests use `defaults.load(Store(tmp_path / "c.json"))`.

## 3. JavaScript tests (the in-browser mock backend)

```bash
node --test "tests/js/*.test.mjs"        # quote the glob; a bare directory fails on Node 22
```

It also runs the Python `checklist.build()` on `tests/checklist_cases.json` and compares with the JS port, and checks `app/suite/js/mock/defaults.js` equals `defaults/so101.defaults.json`.

## 4. Website (only if you touched `site/`, `app/suite/`, `app/vendor/`, `app/assets/`, `docs/` or `modules/`)

```bash
cd site && pnpm install && pnpm build && pnpm check      # Node 22.12+; check exits non-zero on broken links or missing alt text
```

## 5. Run the demo and look at it

```bash
uv run so101 start --demo --no-browser --port 8150      # same as: uv run so101 demo --no-browser --port 8150
# open http://localhost:8150/suite/   (the classic dashboard is /dashboard)
curl -s http://localhost:8150/api/suite/checklist | python3 -m json.tool | head -40
uv run so101 doctor --port 8150                          # the checklist as text, from the running demo
# stop it when you are done:
lsof -ti :8150 | xargs kill
```

Demo gives two simulated arms (`demo://follower`, `demo://leader`, motors 1 to 6), and three synthetic cameras (two started, a third "plugged in" to try Add camera). Simulated hands move a limp arm, so calibration works end to end. **Restarting a demo server currently resets its state** (calibration, added cameras).

No Python at all: the page falls back to the in-browser mock when no backend answers: `python3 -m http.server 8130 --directory app/suite` does **not** work alone (it needs `./vendor` and `./assets` next to it); use `site` (`pnpm dev`) or the live server. Mock flags: `?demo=1`, `?scenario=fresh|ready|nothing`, `?seed=7`, `?os=linux|windows`, `?theme=dark|light`.

## 6. Click-test checklist (use the browser tools, do not just read code)

1. Open the page you changed at **1280 px** and **360 px** wide, **dark** and **light** (`?theme=`), console open: no errors.
2. Walk the empty state, the error state and the happy path. Use `scenario=nothing` (nothing connected) and `scenario=ready`.
3. Click **every** button you named in text; each must exist with that exact label, and every disabled one shows why.
4. Keyboard only: Tab reaches everything, focus is visible, Escape closes pop-ups.
5. Nothing re-draws while you hold a button; nothing scrolls the wrong thing; no browser pop-ups.
6. Check the same flow against the live demo server and the mock (`?demo=1`): both backends must agree.

## Done means

Tests green (steps 2 and 3, plus 4 when relevant), demo click-tested, docs updated, no personal data, servers stopped, and a plain statement of what you could not test (real hardware, Windows).
