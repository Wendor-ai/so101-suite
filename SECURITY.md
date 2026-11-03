# Security

SO-101 Suite runs on your own computer and controls a physical robot arm. Please read how it is built, then tell us privately if you find a problem.

## Reporting a vulnerability

Please **do not open a public issue** with the details of a security problem. Use GitHub's private reporting for this repository: the **Security** tab, then **Report a vulnerability**. If that is not available, open a public issue that only says you have a security report (no details) and a maintainer will arrange a private way to receive it.

Include what you found, how to reproduce it (demo mode is fine: `uv run so101 demo`), and what you think the impact is. We will acknowledge your report, keep you informed, and credit you if you wish. This is a volunteer project, so please allow some time. Only the latest release gets fixes.

## What the app does, and does not, protect

Know these before you put the app on a network.

- **The HTTP API has no authentication.** Anyone who can reach the app's port can read its state, see camera pictures and **move the arm**. By default `so101 start` listens on this computer only (`127.0.0.1`), so nobody else on your network can reach it. If you want another device (for example a Raspberry Pi screen) to open it, start it with `uv run so101 start --host 0.0.0.0`, and only on a network you trust. (The older `python app/server.py` dashboard still listens on every interface by default.) Never expose the port to the internet. If you must reach it remotely, put it behind something that authenticates (a VPN or an authenticating reverse proxy).
- **The app fetches the camera addresses it is given.** Adding a network camera makes the app request that `http(s)` address from its own computer, so anyone who can use the API can make it request addresses on your network. Another reason not to expose the port.
- **There is no CORS support and no cookies or accounts.** The app talks to its own page only.
- **Modules are trusted code.** A module's `backend.py` runs inside the app process with the full rights of your user. Read a module before you add it to `modules/`. Modules cannot be installed from the network by the app.
- **Nothing leaves your computer.** There is no telemetry, no analytics and no cloud account. The Inspector records only in memory, and only while it is switched on. "Copy diagnostics" and `so101 doctor` redact serial numbers and hostnames and show your home folder as `~`. If you find personal data in one, that is a bug: please report it.
- **Static files are served from fixed folders only.** Paths with `..` or a leading dot are refused.
- **The app opens serial ports and cameras.** Tests and demo mode never do (`SO101_NO_REAL_PORTS`, a simulated motor bus).

## In scope

Path traversal, command or code injection, a way to move the arm that skips the app's confirmations and guards, leaks of personal data in diagnostics or exports, unsafe handling of the settings or camera addresses, and dependency problems.

Out of scope on their own: the lack of authentication described above (it is documented; reports of how to make it safer are welcome as feature requests), attacks that need a malicious module you installed yourself, and physical safety of the hardware (report those as bugs; see [docs/LEARNINGS.md](docs/LEARNINGS.md) for what the guards do).

## Keeping your install safe

- Keep the project up to date (`git pull`, then `uv sync`). Dependencies are pinned in `uv.lock` and checked weekly by Dependabot.
- Keep secrets in `.env` (git-ignored). Never commit keys, tokens or your calibration files.
- Do not leave a powered arm alone, and keep the STOP button in reach.
