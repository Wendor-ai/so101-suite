# Roadmap

Where the project is and where it could go. These are ideas, not promises: this is a community project, and the best way to move something up is to try it and open a pull request. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## What exists today (version 0.1.0)

- One-command setup (`setup.sh`, `setup.ps1`) and the `so101` command: `start`, `setup`, `doctor`, `detect`, `demo`, `version`.
- The web app: Setup check, Motor IDs, Assemble, Calibrate, Cameras, Control, Modules, Learn, Glossary, Help, Test motors, Inspector, Settings, a command palette, light and dark themes.
- Auto-detection of the operating system, Raspberry Pi, serial adapters, motors and cameras, and a live checklist.
- Demo mode (simulated hardware) and an in-browser mock backend, which powers the website demo.
- A documented HTTP API, drop-in modules, and the classic pick and place dashboard with its safety guards.
- Agent files: `AGENTS.md`, `CLAUDE.md`, skills, Cursor rules, `llms.txt`.

## Known limits

- **Windows is untested.** The setup script exists; nobody has run it on real hardware yet.
- **No authentication.** The app trusts its network. Use `--host 127.0.0.1` on shared networks.
- **Camera changes need a restart,** and the table mapping assumes one fixed camera position and 640 x 480 pictures.
- **The legacy API answers `{}` even when it refuses.** Reasons are in `GET /api/state`. The new Suite API uses proper status codes.
- **Two roles only:** one follower and one leader. Each role has one calibration name (`my_follower`, `my_leader`, changeable with environment variables), so several followers on one computer are not supported.
- **Pick and place is tuned for a red keychain and a bowl** on a table, as described in [LEARNINGS.md](LEARNINGS.md).

## Ideas that would help most

Roughly in the order they would help beginners.

1. **Test on Windows,** and fix what breaks. Reports from real machines are as valuable as code.
2. **More hardware reports:** other USB adapters, other operating system versions, Raspberry Pi models. The `Hardware help` issue template is for this.
3. **More Learn articles and glossary terms,** especially from first-time builders: what confused you? Use the `add-learn-article` skill.
4. **More modules:** joint-angle viewers, pose recorders and players, a camera test pattern, a gamepad driver. Start from `modules/hello`.
5. **Pick and place as a module,** so it can be turned off and replaced like any other feature.
6. **Better first-run help for bad cases:** a board with unusual jumpers, motors with a wrong speed, a charge-only cable. The Help page grows from real reports.
7. **Translations** of the Learn content and the app text.
8. **Automated screenshots** of every page for the docs and the website, kept in step with the UI.
9. **Support for more than two arms** on one computer, with a name and a calibration each.
10. **Optional access control** for people who run the app on a shared network.

## Not planned

- **Recording and training robot-learning policies.** That is [LeRobot](https://github.com/huggingface/lerobot)'s job; the repo only links to it and keeps optional helper scripts.
- **A mobile app, cloud accounts, or telemetry.** Nothing leaves the machine.
- **Selling or recommending hardware.** See [HARDWARE.md](HARDWARE.md) for the official sources.
- **A frontend build step.** The app stays plain HTML, CSS and ES modules so anyone, and any AI agent, can read and change it.
