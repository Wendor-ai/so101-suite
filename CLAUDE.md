@AGENTS.md

## Claude Code specifics

- The skills in `.claude/skills/` match common jobs by their trigger phrases (add a module, calibrate, debug the arm, write beginner copy, tell a person to touch hardware). Use them instead of improvising; each one lists the exact files and the verification commands.
- To look at the app, start the demo on a free high port (`uv run so101 demo --no-browser --port 8150`, never 8000), open it with the browser tools, click through the change at 1280 px and 360 px, dark and light, and stop the server when you are done.
- Only commit or push when asked. Never `git add` files under `~/.so101`, `calibration/*.json` or anything with personal data.
