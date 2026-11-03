# Contributing

Thank you for helping. This project is for people who have just bought an SO-101 robot arm, so the best contributions make the first hour easier: clearer words, a fix for a snag you hit, a hardware report, a Learn article, a module.

You do not need to write code. Good ways to help:

- **Report what confused you** or what broke. Use the issue templates: *Bug report*, *Hardware help*, *Feature request*.
- **Add a hardware report:** your operating system, USB board and camera, and whether it worked. Windows reports are especially valuable: Windows is untested.
- **Write or fix text:** Learn articles, glossary terms, troubleshooting entries, docs. Plain words, short sentences.
- **Write a module** in `modules/` (see [docs/MODULES.md](docs/MODULES.md)).
- **Fix a bug or build a feature.**

## Get set up

You need `git` and [uv](https://docs.astral.sh/uv/). No hardware is needed: everything can be developed and tested in demo mode.

```bash
git clone https://github.com/Wendor-ai/so101-suite
cd so101-suite
uv sync --extra dev
uv run so101 start --demo --no-browser --port 8150      # then open http://localhost:8150/suite/
```

Use a free port other than 8000 (a real dashboard may be running there), and stop the server when you are done. For the website you also need Node 22.12 or newer and [pnpm](https://pnpm.io): `cd site && pnpm install`.

## Before you open a pull request

```bash
SO101_NO_REAL_PORTS=1 uv run pytest -q          # Python tests
node --test "tests/js/*.test.mjs"               # tests of the in-browser mock backend (quote the glob)
cd site && pnpm build && pnpm check             # only if you touched site/, app/suite/, docs/ or modules/
```

Then **click through your change in the demo** at 1280 px and 360 px wide, in dark and light, with the browser console open. Tests do not see a button that does nothing.

A good pull request: does one thing, says why, includes a test where there is logic, updates the docs where behaviour changed, and says plainly what you could not test (real hardware, Windows). CI runs the same checks.

## The rules that matter

[AGENTS.md](AGENTS.md) has the full list (it is written for AI assistants, and just as useful for people). The short version:

- **Never open a real serial port in tests.** Tests run with `SO101_NO_REAL_PORTS=1`; use demo mode for anything that needs arms.
- **The arm moves only when the person asked,** after a plain sentence saying what will move. Hardware safety lessons are in [docs/LEARNINGS.md](docs/LEARNINGS.md): read them before changing anything that moves an arm.
- **No browser pop-ups; every disabled button says why; nothing fails silently.**
- **Keep the server demo and the in-browser mock in step** (`tests/checklist_cases.json` is shared).
- **Voice:** friendly and plain. Second person, short sentences. Say Leader arm and Follower arm.
- **No personal data** in the repo: no usernames, paths, IP addresses, serial numbers, keys or photos.
- No build step for the app: plain HTML, CSS and ES modules.

## Working with an AI assistant

Claude Code, Codex and Cursor read `AGENTS.md`. The skills in `.claude/skills/` give each common job a step-by-step procedure (add a module, add a page, add a Learn article, debug hardware, and more). You are responsible for what you submit: read the diff, run the tests, click the change.

## Commits and licence

Small commits, each one thing. Subject: a short imperative sentence about what changed; body: why, and how you checked it. The project is licensed under the [AGPL-3.0-or-later](LICENSE). By contributing you agree that your contribution is licensed the same way, and that you have the right to submit it. Third-party code needs a compatible licence and an entry in [NOTICE.md](NOTICE.md).

Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security problems: [SECURITY.md](SECURITY.md).
