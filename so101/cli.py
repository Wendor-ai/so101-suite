"""The `so101` command: start the app, set it up, check it, detect hardware, run the demo.

    so101 start [--port 8000] [--demo] [--no-browser] [--camera-url ...]
    so101 setup        detect everything, then open the app on the right page
    so101 doctor [--json]   the checklist as text or JSON (paste it into a bug report)
    so101 detect       what this computer can see (OS, Raspberry Pi, ports, cameras)
    so101 demo         start with simulated hardware
    so101 mcp [--url http://127.0.0.1:8000] [--allow-motion]   MCP server for AI agents (talks to the running app)
    so101 version
"""
import argparse
import json
import os
import shutil
import sys
import threading
import time
import urllib.request
from typing import List, Optional

from . import LICENSE_ID, __version__, checklist, defaults, paths, platform_info
from . import ports as ports_mod

CALIBRATE_PAGE = "calibrate?first=1"
WELCOME_PAGE = "welcome"


# ================================================================= helpers
def can_open_browser(env=None, which=None, system=None) -> bool:
    """Is there a screen to open a browser on? (no on a Pi or server reached over SSH)"""
    env = os.environ if env is None else env
    which = which or shutil.which
    system = (system or sys.platform).lower()
    if system.startswith("win") or system == "nt":
        return True
    if system == "darwin":
        return bool(which("open")) and not env.get("SSH_CONNECTION")
    return bool(env.get("DISPLAY") or env.get("WAYLAND_DISPLAY")) and bool(which("xdg-open") or which("gio") or which("sensible-browser"))


def load_server():
    """Import app/server.py (the legacy dashboard server). The demo bus must already be installed when asked for."""
    for p in (str(paths.REPO_ROOT), str(paths.APP_DIR)):
        if p not in sys.path:
            sys.path.insert(0, p)
    import server
    return server


def _server_argv(a) -> List[str]:
    out = ["--port", str(a.port), "--host", a.host]
    if a.demo:
        out.append("--demo")
    if getattr(a, "camera_url", None):
        out += ["--camera-url", a.camera_url]
    if getattr(a, "camera", None) is not None:
        out += ["--camera", a.camera]
    for flag in ("camera2", "remote"):
        if getattr(a, flag, None):
            out += [f"--{flag}", getattr(a, flag)]
    if getattr(a, "camera_only", False):
        out.append("--camera-only")
    return out


def _wait_for_arms(server, timeout=6.0):
    """Give the adapters a moment to answer so the first page can be chosen from facts: every arm online and no new arm for a moment."""
    from . import suite_api
    t0 = last_change = time.time()
    n = -1
    while time.time() - t0 < timeout:
        arms = list(suite_api.ctx.arms.values())
        if len(arms) != n:
            n, last_change = len(arms), time.time()
        if not arms and not ports_mod.list_ports():
            return                                              # nothing is plugged in: no point waiting
        if arms and all(a.online for a in arms) and time.time() - last_change > 0.8:
            return
        time.sleep(0.1)


def _first_calibration_sentence(info: dict) -> str:
    unc = info.get("uncalibrated") or []
    if unc and info.get("first_calibration_needed"):
        who = " and ".join(unc)
        return f"Your {who} arm{'s are' if len(unc) > 1 else ' is'} connected but not calibrated yet, so I'm opening the calibration guide."
    return "No connected arm needs its first calibration right now, so I'm opening the welcome page."


def run_server(a, page=None, serve=True, out=print) -> int:
    """Start the app. `page` is a page name, a callable(info) -> (page, sentence), or None. serve=False starts and stops again (tests)."""
    if a.demo:
        from . import demo
        demo.install(fresh=not os.environ.get("SO101_RESTARTING"))
    server = load_server()
    try:
        httpd, args = server.setup(_server_argv(a))
    except OSError as e:
        out(f"I could not start on port {a.port}: {e.strerror or e}. Is the SO-101 app (or the old dashboard) already running? "
            f"Open http://localhost:{a.port}, or choose another port with --port {a.port + 1}.")
        return 1
    from . import suite_api
    port = httpd.server_address[1]
    base = f"http://localhost:{port}"
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()
    sentence = ""
    if callable(page):
        _wait_for_arms(server)
        page, sentence = page(suite_api.info())
    url = f"{base}/suite/#/{page}" if page else f"{base}/"
    out(f"SO-101 Suite {__version__} is running" + (" in DEMO mode (simulated arms and cameras, nothing real is touched)" if a.demo else "") + f": {base}")
    if sentence:
        out(sentence)
    opened = False
    if not a.no_browser and serve and can_open_browser():
        try:
            import webbrowser
            opened = bool(webbrowser.open(url))
        except Exception:
            opened = False
    if not opened:
        out(f"Open this address in your browser: {url}")
    if not serve:
        httpd.shutdown()
        httpd.server_close()
        server.stop_background()
        return 0
    out("Press Ctrl+C to stop.")
    try:
        while th.is_alive():
            th.join(0.5)
    except KeyboardInterrupt:
        out("\nStopping. (The motors keep their torque; the arm will not drop.)")
    return 0


# ================================================================= commands
def cmd_start(a, serve=True, out=print) -> int:
    return run_server(a, page=a.open_page, serve=serve, out=out)


def _detect_report(demo: bool, cameras: bool, out=print) -> dict:
    if demo:
        from . import demo as demo_mod
        demo_mod.install(fresh=False)
    plat = platform_info.detect()
    out(f"os: {plat.os} {plat.os_version} ({plat.arch})")
    out(f"raspberry pi: {plat.pi_model or 'no'}")
    out(f"python: {plat.python}   uv: {'yes' if plat.uv else 'no (setup.sh installs it)'}")
    if plat.in_dialout is False:
        out("serial permission: NOT yet. Run this once, then log out and in again: sudo usermod -aG dialout $USER")
    elif plat.in_dialout:
        out("serial permission: ok")
    pl = ports_mod.list_ports()
    out(f"usb serial adapters: {len(pl)}" + ("" if pl else "  (plug in the arm's controller board, and its power supply)"))
    for p in pl:
        out(f"  {ports_mod.redact_port_path(p.path)}  {'looks like a servo adapter' if p.likely_servo_board else 'unknown adapter'}  (id {p.vid and format(p.vid, '04x')}:{p.pid and format(p.pid, '04x')})")
    cams = []
    if cameras:
        from . import cameras as cam_mod
        cams = cam_mod.list_cameras()
        out(f"cameras: {len(cams)}")
        for c in cams:
            out(f"  {c.name} ({c.width}x{c.height})" if not c.err else f"  {c.name} - {c.err}")
    else:
        out("cameras: not checked (opening cameras is skipped with --no-cameras)")
    return {"platform": plat, "ports": pl, "cameras": cams}


def cmd_detect(a, out=print) -> int:
    try:
        _detect_report(a.demo, not a.no_cameras, out)
    finally:
        if a.demo:
            from . import demo
            demo.uninstall()
    return 0


def cmd_setup(a, serve=True, out=print) -> int:
    out("Looking at your computer ...")
    info = _detect_report(a.demo, not a.no_cameras, out)
    if a.demo:
        from . import demo
        demo.uninstall()                                       # run_server installs it again for the app itself
    from .store import Store
    if not a.demo:
        st = Store()
        st.set("setup.last_run", time.strftime("%Y-%m-%d %H:%M:%S"))
        st.set("setup.os", info["platform"].os)
    out("")
    out("Starting the app ...")
    return run_server(a, page=lambda inf: (CALIBRATE_PAGE, _first_calibration_sentence(inf)) if inf.get("first_calibration_needed") else (WELCOME_PAGE, _first_calibration_sentence(inf)),
                      serve=serve, out=out)


# ---------------------------------------------------------------- doctor
def _snapshot_from_legacy_state(state: dict, plat: dict, ports: list) -> dict:
    """Build a checklist snapshot from the classic dashboard's /api/state (so doctor can describe a dashboard that is already running)."""
    def arm(a):
        return {"port": a.get("port"), "online": bool(a.get("online")), "motor_ids": [j["id"] for j in a.get("joints", [])] if a.get("online") else [],
                "calibrated": bool(a.get("calibrated")), "err": a.get("err", "")}
    by = {}
    for a in state.get("arms", []):
        if a.get("remote"):
            continue
        if a.get("role") not in by or (a.get("online") and not by[a["role"]].get("online")):
            by[a.get("role")] = a
    cams = [{"ok": bool(c.get("ok")), "calibrated": bool((state.get("pp") or {}).get("cam_cal")) if i == 0 else False, "err": c.get("err", "")} for i, c in enumerate(state.get("cameras", []))]
    return {"platform": {k: plat.get(k) for k in ("os", "python", "uv", "in_dialout")}, "ports": ports,
            "arms": {"follower": arm(by["follower"]) if "follower" in by else None, "leader": arm(by["leader"]) if "leader" in by else None},
            "cameras": {"detected": 0, "configured": cams}, "progress": {}}


def _http_json(url: str, timeout=2.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None


def _first_calibration(snap: dict) -> dict:
    arms = snap.get("arms") or {}
    connected = {r: a for r, a in arms.items() if a and a.get("online")}
    unc = sorted(r for r, a in connected.items() if not a.get("calibrated"))
    return {"done": (not unc) if connected else None, "uncalibrated": unc}


def build_doctor(a) -> dict:
    """Everything `so101 doctor` reports. Never opens a serial port or (without --probe) a camera: it asks a running app, or only lists what is plugged in."""
    notes: List[str] = []
    plat = platform_info.detect().to_dict()
    source, snap, live_info = "offline", None, None
    ports_list = []
    if a.demo:
        from . import demo, suite_api
        demo.install(fresh=False)
        server = load_server()
        httpd, _ = server.setup(["--demo", "--port", "0", "--host", "127.0.0.1"])
        try:
            _wait_for_arms(server)
            snap = suite_api.build_snapshot()
            live_info = suite_api.info()
            ports_list = [{"path": p["path"], "vid": p["vid"], "pid": p["pid"], "likely_servo_board": p["likely_servo_board"], "role": p["role"]} for p in suite_api.ports_view()]
        finally:
            httpd.server_close()
            server.stop_background()
            demo.uninstall()
        source = "demo"
    else:
        for port in [a.port]:
            base = f"http://localhost:{port}"
            ck = _http_json(base + "/api/suite/checklist")
            if ck and "items" in ck:
                snap = None
                live_info = _http_json(base + "/api/suite/info") or {}
                st = _http_json(base + "/api/state")
                source = f"app on port {port}"
                result = {"items": ck["items"], "summary": ck["summary"]}
                fc = ({"done": (not live_info.get("uncalibrated")) if any(x.get("online") for x in (st or {}).get("arms", [])) else None, "uncalibrated": live_info.get("uncalibrated", [])})
                return {"version": __version__, "source": source, "live": True, "first_calibration": fc, "platform": plat, "ports": _ports_for_report(), "notes": notes, **result}
            st = _http_json(base + "/api/state")
            if st and "arms" in st:
                source = f"classic dashboard on port {port}"
                snap = _snapshot_from_legacy_state(st, plat, [{"path": p["path"], "likely_servo_board": p["likely_servo_board"], "role": None} for p in _ports_for_report()])
                break
        if snap is None:
            pl = ports_mod.list_ports()
            ports_list = _ports_for_report(pl)
            cam_detected = 0
            if a.probe:
                from . import cameras as cam_mod
                cam_detected = len(cam_mod.list_cameras())
            else:
                notes.append("Motors and cameras were not checked: the app is not running. Start it with `so101 start` and run doctor again, or use `so101 doctor --probe` (with the app stopped) to look at the cameras.")
            snap = {"platform": {k: plat.get(k) for k in ("os", "python", "uv", "in_dialout")}, "ports": [{"path": p.path, "likely_servo_board": p.likely_servo_board, "role": None} for p in pl],
                    "arms": {"follower": None, "leader": None}, "cameras": {"detected": cam_detected, "configured": []}, "progress": {}}
    res = checklist.build(snap)
    live = source != "offline"
    fc = _first_calibration(snap) if live else {"done": None, "uncalibrated": []}
    if source == "demo" and live_info:
        fc = {"done": fc["done"], "uncalibrated": live_info.get("uncalibrated", [])}
    return {"version": __version__, "source": source, "live": live, "first_calibration": fc, "platform": plat,
            "ports": ports_list or _ports_for_report(), "notes": notes, **res}


def _ports_for_report(pl=None) -> list:
    """Ports without serial numbers (the report gets pasted into public issues)."""
    return [{"path": ports_mod.redact_port_path(p.path), "vid": p.vid, "pid": p.pid, "likely_servo_board": p.likely_servo_board} for p in (pl if pl is not None else ports_mod.list_ports())]


def format_doctor(d: dict) -> str:
    sym = {"ok": "ok  ", "todo": "todo", "warn": "warn", "fail": "FAIL", "skip": "skip"}
    lines = [f"SO-101 Suite {d['version']} ({LICENSE_ID})   checked: {d['source']}", f"os: {d['platform']['os']} {d['platform']['os_version']} ({d['platform']['arch']})   python {d['platform']['python']}", ""]
    for it in d["items"]:
        lines.append(f"[{sym[it['status']]}] {it['title']}: {it['detail']}")
        if it["status"] in ("todo", "warn", "fail") and it.get("fix"):
            lines.append(f"       fix: {it['fix']['label']} (page: {it['fix']['page']})")
    fc = d["first_calibration"]
    lines.append("")
    if fc["done"] is True:
        lines.append("first calibration: done")
    elif fc["done"] is False:
        lines.append(f"first calibration: not done ({' and '.join(fc['uncalibrated'])} still need it)")
    else:
        lines.append("first calibration: unknown (no arm is connected to check)")
    s = d["summary"]
    lines.append(f"{s['ok']} of {s['total']} checks ok. Next: {s['next'] or 'nothing, you are all set'}")
    for n in d["notes"]:
        lines.append(f"note: {n}")
    return "\n".join(lines)


def cmd_doctor(a, out=print) -> int:
    d = build_doctor(a)
    out(json.dumps(d, indent=2) if a.json else format_doctor(d))
    return 0


def cmd_env(a, out=print) -> int:
    from . import envfile
    return envfile.report(shell=a.shell, out=out)


def cmd_version(a, out=print) -> int:
    out(f"so101 {__version__} ({LICENSE_ID})")
    return 0


# ================================================================= argument parsing
def _add_start_options(p, with_page=True):
    p.add_argument("--port", type=int, default=defaults.get("server.port"), help="port to serve on (default %(default)s)")
    p.add_argument("--host", default=defaults.get("server.host"), help="address to listen on (default %(default)s = this computer only, because the app has no password; use 0.0.0.0 to let other devices on your network open it)")
    p.add_argument("--demo", action="store_true", help="simulated arms and cameras: no hardware needed, no real device is ever opened")
    p.add_argument("--no-browser", action="store_true", help="do not open a browser, just print the address")
    p.add_argument("--camera-url", default="", help="comma-separated MJPEG URLs of network cameras (overrides the saved camera list)")
    p.add_argument("--camera", default=None, help="a local camera: index or device path (overrides the saved camera list)")
    p.add_argument("--camera2", default="", help=argparse.SUPPRESS)
    p.add_argument("--remote", default="", help=argparse.SUPPRESS)
    p.add_argument("--camera-only", action="store_true", help=argparse.SUPPRESS)
    if with_page:
        p.add_argument("--open-page", default=None, metavar="PAGE", help="open the app on this page (for example setup, calibrate, cameras)")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="so101", description="SO-101 Suite: a beginner-friendly web app for the SO-101 robot arm.")
    sub = ap.add_subparsers(dest="cmd")
    _add_start_options(sub.add_parser("start", help="start the app"))
    s = sub.add_parser("setup", help="detect your hardware, then open the app on the right page")
    _add_start_options(s, with_page=False)
    s.add_argument("--no-cameras", action="store_true", help="do not open cameras while detecting")
    d = sub.add_parser("doctor", help="check what is connected and what is left (paste the output into a bug report)")
    d.add_argument("--json", action="store_true", help="machine-readable output")
    d.add_argument("--demo", action="store_true", help="check the simulated demo instead")
    d.add_argument("--port", type=int, default=defaults.get("server.port"), help="where to look for a running app")
    d.add_argument("--probe", action="store_true", help="also open cameras to find them (do this with the app stopped)")
    t = sub.add_parser("detect", help="show what this computer can see")
    t.add_argument("--demo", action="store_true")
    t.add_argument("--no-cameras", action="store_true", help="do not open cameras")
    m = sub.add_parser("demo", help="start with simulated hardware (same as: start --demo)")
    _add_start_options(m)
    from . import mcp as mcp_mod
    mcp_mod.add_arguments(sub.add_parser("mcp", help="run the MCP server so an AI agent (Claude Code, Claude Desktop, Cursor) can use the running app"))
    e = sub.add_parser("env", help="show which .env files were found and which settings they set (never the values)")
    e.add_argument("--shell", action="store_true", help="print export lines for shell scripts")
    sub.add_parser("version", help="print the version")
    return ap


def main(argv=None, *, serve=True, out=print) -> int:
    ap = build_parser()
    a = ap.parse_args(argv)
    if a.cmd is None:
        ap.print_help()
        return 0
    if a.cmd == "demo":
        a.demo = True
        a.cmd = "start"
    if a.cmd == "start":
        return cmd_start(a, serve=serve, out=out)
    if a.cmd == "setup":
        return cmd_setup(a, serve=serve, out=out)
    if a.cmd == "doctor":
        return cmd_doctor(a, out=out)
    if a.cmd == "detect":
        return cmd_detect(a, out=out)
    if a.cmd == "env":
        return cmd_env(a, out=out)
    if a.cmd == "mcp":                                         # stdout belongs to the protocol here: nothing may print through `out`
        from . import mcp as mcp_mod
        return mcp_mod.run(a.url, a.allow_motion)
    return cmd_version(a, out=out)


if __name__ == "__main__":
    sys.exit(main())
