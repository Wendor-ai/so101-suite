# MCP: let an AI agent use the app

`so101 mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. It lets an AI agent (Claude Code, Claude Desktop, Cursor, or any MCP client) **do things** with the SO-101 app instead of only reading about it: look at a camera, run the health checks, read the Inspector, and click-calibrate the camera mapping.

It talks to the running app's local web API (the same one the web page uses, see [API.md](API.md)), so it works against your real arm and against `so101 demo`. It is pure Python standard library: nothing extra to install.

```
AI client  --stdio-->  so101 mcp  --HTTP-->  the SO-101 app (so101 start / so101 demo)  --> arms and cameras
```

## What to ask it

Start the app first (`uv run so101 start`, or `uv run so101 demo` to try without hardware), then ask your agent things like:

- *"Is everything connected? What is the next thing I should do?"* (status, then the checklist)
- *"Look at camera 1 and tell me if the whole table is visible."* (the app's "Camera 1" is camera `0` to the tools: they count from 0)
- *"The follower arm shows offline. Why?"* (status, ports, diagnostics)
- *"Read the Inspector and tell me which motor keeps failing."* (trace; recording is off by default, so you switch it on in the app's Inspector page first)
- *"Wiggle motor 3 on the follower so I can see which joint it is."* (needs `--allow-motion`, see below)
- *"The follower is stiff: lower it and make it limp so I can calibrate it."* (needs `--allow-motion`: `so101_rest_arm` lowers the arm onto the table before it lets go; you keep your hands off it until the agent says it is limp)

### Calibrating the camera by clicking

The camera has to learn where the table is: you touch a spot with the gripper tip and mark that spot in the picture, three or four times. The agent can do the marking, you do the touching. **You only touch the arm once it is limp** (see the standing rule below). The arm never moves by itself while you touch it: the one move it makes is lowering itself onto the table, when you ask for the arm to be made limp.

1. In the app, open **Cameras** and press **Start mapping the table**. If the follower is stiff, take your hands off it and press **Lower the arm and make it limp** (or, with `--allow-motion`, ask the agent to call `so101_rest_arm`). The arm lowers itself onto the table and only then lets go: nothing drops and nobody holds it. Wait until the page says **The arm is limp**.
2. Now that the arm is limp, touch the gripper tip to a spot on the table that camera 1 can see, and hold it still.
3. Tell the agent: *"The tip is on the table now. Take a snapshot of camera 0, find the gripper tip, and teach that point."* It calls `so101_snapshot`, finds the pixel, and calls `so101_teach_point` with `u` and `v`.
4. Move the tip to a different spot (at least 15 mm away, and spread the spots out) and repeat. You need **3** points. Do a **4th**: with exactly three points the fit is always a perfect 0 mm and tells you nothing, and the 4th shows the real **fit error** (under about 5 mm is good, 10 mm or more is rough).
5. If a click looks wrong, say so: *"That one was off, undo it."* (`so101_undo_point`). `so101_snapshot` with `annotated: true` draws the app's overlay so you can both check where the points landed.

A prompt that does it all:

> Check with so101_status that the follower arm is limp. If it is stiff, tell me to take my hands off it and lower it first. Then I will move the limp arm and put its gripper tip on the table, one spot at a time. Each time I say "next", snapshot camera 0, find the gripper tip in the picture, and teach that pixel. Do four spots, then tell me the fit error. If the app refuses a point, tell me what it says and do not try to work around it.

Coordinates are pixels in the camera's **640 x 480** picture: `(0, 0)` is the top-left corner, `u` goes right to 640 and `v` goes down to 480. `so101_snapshot` says what size the picture really is and tells the agent to scale if it is not 640 x 480.

## Install

Every client launches the server itself as a command. The command is always the same:

```
uv run --project /ABSOLUTE/PATH/TO/so101-suite so101 mcp
```

Run `uv sync` once in the repo first, so the first launch does not spend a minute building the environment (some clients give up waiting). The app (`so101 start` or `so101 demo`) runs separately; the server does not start it. If it is not running, every tool says so in plain words.

Replace `/ABSOLUTE/PATH/TO/so101-suite` with where you cloned the repo (`pwd` inside the folder prints it).

### Claude Code

```bash
claude mcp add so101 -- uv run --project /ABSOLUTE/PATH/TO/so101-suite so101 mcp
```

Add `--scope project` before the name to share it through a `.mcp.json` file in a project instead. Check with `claude mcp list` or `/mcp` inside Claude Code. A ready-made file is [examples/mcp/claude-code.json](../examples/mcp/claude-code.json).

### Claude Desktop

Open the config file (Claude Desktop: Settings, Developer, Edit Config; on macOS it is `~/Library/Application Support/Claude/claude_desktop_config.json`, on Windows `%APPDATA%\Claude\claude_desktop_config.json`) and add the server from [examples/mcp/claude-desktop.json](../examples/mcp/claude-desktop.json):

```json
{
  "mcpServers": {
    "so101": {
      "command": "/ABSOLUTE/PATH/TO/uv",
      "args": ["run", "--project", "/ABSOLUTE/PATH/TO/so101-suite", "so101", "mcp"]
    }
  }
}
```

Use the full path of `uv` (`which uv` prints it; on Windows `where uv`): desktop apps do not see the `PATH` your terminal has, so a bare `uv` is often "not found". Then quit and reopen Claude Desktop.

### Cursor

Create `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project) with the same `mcpServers` block as above (`"command": "uv"` is fine when Cursor was started from a terminal that has `uv`), then switch the server on in Cursor Settings, MCP.

### Other clients and options

Any client that can run a command and speak MCP over stdio works. Options:

| Option | What it does |
|---|---|
| `--url http://127.0.0.1:8000` | Where the app runs. The default is this computer, port 8000. The environment variable `SO101_URL` does the same (the option wins). Use it for an app on another port, or on another computer, for example `--url http://raspberrypi.local:8000`. |
| `--allow-motion` | Also offers the three tools that can move an arm (`so101_rest_arm`, `so101_calibration`, `so101_wiggle_motor`). Off by default. See the next section. |

## The tools

Camera numbers start at `0`. Arm numbers (`arm_index`) are the order `so101_status` lists them.

**Read-only (always on).** They never move or change anything.

| Tool | What it does |
|---|---|
| `so101_status` | **Call first.** Which arms are online and calibrated, which motors answer, which cameras have a picture, whether a job or leader-to-follower is running, whether the table mapping is taught. A plain-text summary plus the raw JSON. |
| `so101_checklist` | The setup checklist with the one NEXT step spelled out. |
| `so101_diagnostics` | The app's plain-text diagnostics report (the one behind "Copy diagnostics"): computer, ports, motors, cameras, versions. |
| `so101_ports` | USB serial adapters, which look like a servo controller board, which arm role each has. |
| `so101_cameras` | The cameras the app uses and their numbers, whether each has a picture, whether its table mapping is done, cameras found but not added. |
| `so101_platform` | Operating system, Raspberry Pi, Python, `uv`, serial-port permission. |
| `so101_trace` | The Inspector log (bus reads and writes, HTTP calls, log lines), with `since`, `kinds` and `limit`. Says plainly when recording is off (the default); it never turns it on. |
| `so101_snapshot` | **Look at a camera.** Returns a JPEG picture plus a line with the camera's status and fps. `camera` (default 0), `annotated` (draw the app's overlay). If the camera is dead it says so and returns no picture. |
| `so101_modules` | The modules (`modules/` folders) the app found. |
| `so101_ping_motor` | Asks one motor (`role` follower or leader, `id` 1 to 6) whether it answers and reports position, load, temperature and voltage. |

**Calibration clicks (always on).** They only record a point in the camera mapping. They never move the arm.

| Tool | What it does |
|---|---|
| `so101_teach_point` | Records one point: the pixel `u`, `v` where the gripper tip is. The app refuses (and the tool returns its sentence) unless the follower is calibrated, **limp** (a stiff arm must be lowered first: `so101_rest_arm`) and the tip moved at least 15 mm since the last point. |
| `so101_undo_point` | Removes the newest point. |
| `so101_clear_points` | Removes all points (the mapping must be taught again). |

All three refuse while pick & place or leader-to-follower is running.

**Safety (always on).**

| Tool | What it does |
|---|---|
| `so101_stop` | Tells the app to stop pick & place and leader-to-follower, and to hold the arm where it is. It does not release torque or move the arm to a pose. It is answered immediately even while another tool call is still running. |

**Motion (only with `--allow-motion`; otherwise not even listed).**

| Tool | What it does |
|---|---|
| `so101_wiggle_motor` | Moves one motor about 10 degrees, slowly, there and back, so you can see which joint an ID is. Refused during a calibration or a job, or when the arm is offline. Ends in the torque state it started in. |
| `so101_rest_arm` | **Lowers the follower onto the table and only then lets go** (the same as the app's **Release arm** button, `POST /api/pp/rest`), then waits until `/api/state` says `pp.limp` is true (up to about 45 seconds). It is the only way this server releases torque, and it is safe: nothing drops and nobody has to hold the arm. Take your hands off the arm first, because it moves by itself. If the arm is already limp nothing happens. Refused, with the app's sentence, when the follower is not online and calibrated or a job or the leader link is running; the arm then stays stiff and the answer says nobody may touch it. |
| `so101_calibration` | Drives the app's guided calibration for one arm: `start`, `center`, `finish`, `cancel`. **`start` resets the arm's calibration in its motors and switches its torque off at once, which would drop a raised arm, so the tool refuses unless `/api/state` says the follower is already limp** (`pp.limp` is true; the old `human_holding_arm` argument no longer exists). If it is stiff the answer says so, tells the person to keep their hands off the arm, and points at `so101_rest_arm`. |

## Safety model

**The server can never:** start pick & place, start leader-to-follower, write motor IDs, or release torque any way except `so101_rest_arm` (which lowers the arm first). Those tools do not exist. There is also nothing that moves the arm to a position of your choice.

**The standing rule (from a real failure, [LEARNINGS.md](LEARNINGS.md) section 17): nobody is asked to touch, hold, place or move anything near the arm while it is stiff.** The agent reads the real state from the app (`so101_status` says LIMP or STIFF, from `pp.limp`), says that state in the first line, refuses to start a calibration unless the follower is limp, and tells you to take your hands off the arm BEFORE it calls `so101_rest_arm`. A stiff arm is made limp by lowering it, never by asking you to hold it and never by cutting its power. Asking you to keep clear, or to press a button on screen, is fine, and so is moving a limp arm by hand.

**What is always on** is reading, recording a calibration click (a number written to the camera mapping: no motion), and stopping.

**Motion is opt-in.** Without `--allow-motion` the three motion tools are not listed, and calling them by name is refused with an error that says so. You switch it on by starting the server yourself with the flag, for example `claude mcp add so101 -- uv run --project /ABSOLUTE/PATH/TO/so101-suite so101 mcp --allow-motion`. An agent cannot turn it on for itself.

**A person is always there.** Calibration clicks need a limp arm that you move by hand; `so101_rest_arm` needs your hands off the arm while it lowers itself; `so101_calibration start` needs the follower already limp; a wiggle needs the space around the arm clear. Do not use `--allow-motion` on a machine nobody is standing next to.

**The app has the last word.** Every refusal the app already has (not limp, tip has not moved, a job is running, arm offline) is passed to the agent in the app's own sentence, and the agent is told not to work around it. The server also checks the obvious ones itself before sending anything.

**Stop is first-class.** `so101_stop` is always listed, is never queued behind another call, and tries both stops even if one fails. It is the same stop the app's Stop button gives ("the arm holds", see [LEARNINGS.md](LEARNINGS.md) sections 8 and 11). If you are at the computer, the app's Stop and Reset buttons are still the real safety net. Keep your hands off a stiff arm.

**Privacy.** Everything stays on your machine except what the tools return to your AI client: that includes **camera pictures**, which go wherever your client sends its conversation. Serial numbers (the one macOS puts in an adapter's device name) and the host of network camera addresses are left out of what the tools return. Text from the app and from devices (camera names, USB descriptions, log lines) reaches the agent as data; it is not instructions.

## Troubleshooting

**"The SO-101 app is not running at http://127.0.0.1:8000: start it with `uv run so101 start`."** The server cannot reach the app. Start the app (or `so101 demo`). If it runs on a different port or computer, add `--url` (or set `SO101_URL`) in the client's config and restart the client. Test from a terminal: `curl http://127.0.0.1:8000/api/health`.

**The client says the server failed to start, or "uv not found".** Use the full path to `uv` in the config (see Claude Desktop above), run `uv sync` once in the repo, and check the server's log: Claude Desktop writes `mcp-server-so101.log` (macOS: `~/Library/Logs/Claude/`), for Claude Code try `claude --debug` or `/mcp`. The server logs to standard error only; standard output is reserved for the protocol.

**A tool says it is switched off, or is missing from the list.** Motion tools exist only with `--allow-motion`. Add it to the server's arguments and restart the client.

**`so101_teach_point` is refused.** Read the sentence: the arm is stiff (take your hands off it and press **Lower the arm and make it limp** in the app, or call `so101_rest_arm` with `--allow-motion`; never hold a stiff arm), the tip has not moved from the last point (the app needs 15 mm; move it 2 cm to be safe), or the follower is not connected or calibrated (see `so101_checklist`).

**`so101_snapshot` says the camera has no picture.** See `so101_cameras` for the reason (cable, another program using the camera, a network address that does not answer). The app keeps trying to reconnect; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

**The picture is not 640 x 480.** The tool says so. The camera mapping works in 640 x 480 coordinates, so the agent has to scale positions before teaching a point.

**Try the server without any client.** It reads one JSON object per line:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
               '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
               '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"so101_status","arguments":{}}}' | uv run so101 mcp
```

With Node installed, `npx @modelcontextprotocol/inspector uv run so101 mcp` opens a web page to click through the tools.

## How it works (for contributors)

- The code is `so101/mcp.py` (one file, standard library only); tests are `tests/test_mcp.py` (no hardware: a demo server and a scripted stand-in app).
- Transport: MCP over stdio, newline-delimited JSON-RPC 2.0. One JSON object per line in and out; nothing else is ever written to standard output (logs and stray prints go to standard error). Output is plain ASCII so no character can break a line.
- Implemented: `initialize` (echoes the client's protocol version if it is 2024-11-05, 2025-03-26, 2025-06-18 or 2025-11-25, else answers 2025-06-18), `notifications/initialized`, `notifications/cancelled`, `ping`, `tools/list`, `tools/call`. Errors: `-32700` parse, `-32600` invalid request, `-32601` unknown method, `-32602` unknown tool or bad params. A tool that fails returns `isError: true` with one plain sentence, never a stack trace; wrong arguments are such a sentence too, so the agent can correct itself.
- Tool calls run one at a time in the order they arrive (a teach followed by an undo must not swap), except `so101_stop`, which runs at once.
- Tools use only what the app's HTTP API already offers. The old `/api/pp/*` and `/api/calib/*` routes answer `200 {}` even when refusing, so the teach and calibration tools read `/api/state` before and after to find out what really happened.
- To add a tool: write a `t_<name>(app, args)` function, add a `Tool(...)` entry to `TOOLS` with a description that says when to use it and what it never does, give it a JSON Schema, and add tests. Anything that can move an arm must be marked `motion=True`.
