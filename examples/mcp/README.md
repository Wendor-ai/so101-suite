# MCP config snippets

Ready-to-paste configuration so an AI agent can use the SO-101 app. What it is and what it can (and never can) do: [docs/MCP.md](../../docs/MCP.md).

| File | For | Where it goes |
|---|---|---|
| [claude-code.json](claude-code.json) | Claude Code | save as `.mcp.json` in your project, or use the one-liner below |
| [claude-desktop.json](claude-desktop.json) | Claude Desktop | merge into `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) |
| Cursor | Cursor | the same `mcpServers` block as `claude-code.json`, in `~/.cursor/mcp.json` or `.cursor/mcp.json` |

## Replace the placeholders first

- `REPLACE_WITH_ABSOLUTE_PATH_TO_YOUR_so101-suite_FOLDER`: where you cloned this repo. Run `pwd` inside the folder to see it.
- `REPLACE_WITH_FULL_PATH_TO_uv` (Claude Desktop only): the output of `which uv` (macOS, Linux) or `where uv` (Windows). Desktop apps do not see your terminal's `PATH`.
- `SO101_URL`: where the app runs. Keep `http://127.0.0.1:8000` when it runs on the same computer with the default port; delete the `env` block entirely if you do not need it.

The app itself is started separately: `uv run so101 start` (or `uv run so101 demo` to try it with simulated hardware). Run `uv sync` once in the repo so the first launch is quick.

## One-liner for Claude Code

```bash
claude mcp add so101 -- uv run --project /ABSOLUTE/PATH/TO/so101-suite so101 mcp
```

## Letting it move an arm (off by default)

Add `"--allow-motion"` at the end of `args` (or at the end of the one-liner). That adds `so101_wiggle_motor` and `so101_calibration`. Only do this with a person standing at the arm: see the safety model in [docs/MCP.md](../../docs/MCP.md).
