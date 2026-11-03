import json
import socket
import sys

import pytest

from so101 import cli, defaults, demo


class Out:
    def __init__(self): self.lines = []
    def __call__(self, *a): self.lines.append(" ".join(str(x) for x in a))
    @property
    def text(self): return "\n".join(self.lines)


@pytest.fixture(autouse=True)
def fresh_server_module():
    """Each command starts its own server module instance (it holds global state) and leaves no simulated bus behind."""
    for m in ("server", "pickplace"):
        sys.modules.pop(m, None)
    yield
    for m in ("server", "pickplace"):
        sys.modules.pop(m, None)
    demo.uninstall()


def run(argv, **kw):
    out = Out()
    code = cli.main(argv, out=out, **kw)
    return code, out


LOCAL = ["--port", "0", "--host", "127.0.0.1", "--no-browser"]


def test_default_port_is_8000_like_the_legacy_server():
    assert defaults.get("server.port") == 8000
    assert cli.build_parser().parse_args(["start"]).port == 8000
    assert cli.build_parser().parse_args(["demo"]).port == 8000


def test_doctor_json_demo():
    code, out = run(["doctor", "--json", "--demo"])
    d = json.loads(out.text)
    assert code == 0 and d["source"] == "demo" and d["live"] is True
    assert [i["id"] for i in d["items"]][:2] == ["python", "uv"] and d["summary"]["total"] >= 10
    assert d["first_calibration"] == {"done": False, "uncalibrated": ["follower", "leader"]}
    got = {i["id"]: i["status"] for i in d["items"]}
    assert got["follower_connected"] == "ok" and got["follower_motors"] == "ok" and got["follower_calibrated"] == "todo"
    assert "DEMO-FOLLOWER" not in out.text                                                  # no serial numbers in anything pasted around
    assert all("serial" not in p for p in d["ports"])


def test_doctor_text_demo_lists_first_calibration():
    code, out = run(["doctor", "--demo"])
    assert code == 0 and "first calibration: not done (follower and leader still need it)" in out.text
    assert "Follower arm connected" in out.text and "checks ok. Next: " in out.text


def test_doctor_offline_never_opens_anything(monkeypatch):
    monkeypatch.setattr(cli, "_http_json", lambda *a, **k: None)                          # no app running
    import so101.cameras as cams
    monkeypatch.setattr(cams, "list_cameras", lambda *a, **k: pytest.fail("cameras must not be opened without --probe"))
    code, out = run(["doctor", "--json", "--port", "1"])
    d = json.loads(out.text)
    assert d["source"] == "offline" and d["live"] is False and d["first_calibration"]["done"] is None
    assert any("not running" in n for n in d["notes"])
    assert "so101_" not in out.text


def test_doctor_uses_a_running_apps_checklist(monkeypatch):
    items = [{"id": "python", "group": "computer", "title": "Python 3.10 or newer", "status": "ok", "detail": "Python is fine.", "fix": None}]
    calls = []
    def fake(url, timeout=2.0):
        calls.append(url)
        return {"/api/suite/checklist": {"items": items, "summary": {"ok": 1, "total": 1, "next": None}}, "/api/suite/info": {"uncalibrated": ["follower"]},
                "/api/state": {"arms": [{"online": True, "role": "follower"}]}}.get("/" + url.split("/", 3)[3])
    monkeypatch.setattr(cli, "_http_json", fake)
    code, out = run(["doctor", "--json", "--port", "8123"])
    d = json.loads(out.text)
    assert d["source"] == "app on port 8123" and d["first_calibration"] == {"done": False, "uncalibrated": ["follower"]} and d["items"] == items
    assert all("8000" not in u for u in calls)                                              # only the port it was told about


def test_doctor_reads_the_classic_dashboards_state(monkeypatch):
    state = {"arms": [{"role": "follower", "online": True, "calibrated": True, "joints": [{"id": i} for i in range(1, 7)], "port": "/dev/x"}],
             "cameras": [{"ok": True, "err": ""}], "pp": {"cam_cal": True}}
    monkeypatch.setattr(cli, "_http_json", lambda url, timeout=2.0: state if url.endswith("/api/state") else None)
    code, out = run(["doctor", "--json", "--port", "8123"])
    d = json.loads(out.text)
    got = {i["id"]: i["status"] for i in d["items"]}
    assert d["source"].startswith("classic dashboard") and got["follower_calibrated"] == "ok" and got["camera_mapped"] == "ok" and d["first_calibration"]["done"] is True


def test_detect_prints_os():
    code, out = run(["detect", "--no-cameras"])
    assert code == 0 and any(f"os: {name}" in out.text for name in ("macos", "linux", "windows"))
    assert "usb serial adapters:" in out.text and "not checked" in out.text


def test_detect_demo_lists_the_simulated_hardware():
    code, out = run(["detect", "--demo"])
    assert "usb serial adapters: 2" in out.text and "cameras: 3" in out.text and "demo://follower" in out.text


def test_start_headless_prints_url(monkeypatch):
    monkeypatch.setattr(cli, "can_open_browser", lambda *a, **k: False)
    code, out = run(["start", "--demo", *LOCAL], serve=False)
    assert code == 0
    assert "DEMO mode" in out.text and "Open this address in your browser: http://localhost:" in out.text
    assert out.lines[0].startswith("SO-101 Suite ")


def test_demo_command_is_start_demo():
    code, out = run(["demo", *LOCAL], serve=False)
    assert code == 0 and "DEMO mode" in out.text


def test_start_open_page_goes_into_the_url():
    code, out = run(["start", "--demo", "--open-page", "cameras", *LOCAL], serve=False)
    assert "/suite/#/cameras" in out.text


def test_start_when_the_port_is_taken_says_so_and_starts_nothing():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(1)
    port = s.getsockname()[1]
    try:
        code, out = run(["start", "--demo", "--port", str(port), "--host", "127.0.0.1", "--no-browser"], serve=False)
    finally:
        s.close()
    assert code == 1 and "already running" in out.text and f"--port {port + 1}" in out.text
    assert sys.modules["server"].arms == {}                                                    # no arm thread was started: no serial port can be opened twice


def test_setup_opens_the_first_calibration_when_an_arm_needs_it():
    code, out = run(["setup", "--demo", "--no-cameras", *LOCAL], serve=False)
    assert code == 0
    assert "Looking at your computer" in out.text and "usb serial adapters: 2" in out.text
    assert "Your follower and leader arms are connected but not calibrated yet, so I'm opening the calibration guide." in out.text
    assert "/suite/#/calibrate?first=1" in out.text


def test_setup_opens_welcome_when_the_prompt_was_already_shown(isolated_home, monkeypatch):
    home = isolated_home / ".so101" / "demo" / "home" / ".so101"
    home.mkdir(parents=True)
    (home / "config.json").write_text(json.dumps({"ui": {"calibrationPrompted": True}}))
    monkeypatch.setenv("SO101_RESTARTING", "1")                                              # keep the demo folder as it is
    code, out = run(["setup", "--demo", "--no-cameras", *LOCAL], serve=False)
    assert "opening the welcome page" in out.text and "/suite/#/welcome" in out.text


def test_setup_with_nothing_plugged_in_opens_welcome(monkeypatch):
    # not demo, and no adapter listed: no real device is opened, nothing to wait for
    monkeypatch.setattr(cli.ports_mod, "list_ports", lambda *a, **k: [])
    import so101.ports as p
    monkeypatch.setattr(p, "list_ports", lambda *a, **k: [])
    code, out = run(["setup", "--no-cameras", "--camera-url", "http://127.0.0.1:9/raw.mjpg", *LOCAL], serve=False)
    assert code == 0 and "opening the welcome page" in out.text and "usb serial adapters: 0" in out.text


def test_version_and_help():
    code, out = run(["version"])
    assert out.text.startswith("so101 0.1.0") and "AGPL" in out.text
    code, out = run([])
    assert code == 0


def test_can_open_browser_rules():
    which = lambda name: "/usr/bin/" + name
    nothing = lambda name: None
    assert cli.can_open_browser({}, which, "linux") is False                                 # a Pi or server with no screen
    assert cli.can_open_browser({"DISPLAY": ":0"}, which, "linux") is True
    assert cli.can_open_browser({"DISPLAY": ":0"}, nothing, "linux") is False
    assert cli.can_open_browser({"WAYLAND_DISPLAY": "wayland-0"}, which, "linux") is True
    assert cli.can_open_browser({}, which, "darwin") is True
    assert cli.can_open_browser({"SSH_CONNECTION": "1 2 3 4"}, which, "darwin") is False
    assert cli.can_open_browser({}, which, "win32") is True


def test_first_calibration_sentences():
    assert "follower arm is connected but not calibrated" in cli._first_calibration_sentence({"uncalibrated": ["follower"], "first_calibration_needed": True})
    assert "welcome" in cli._first_calibration_sentence({"uncalibrated": [], "first_calibration_needed": False})


def test_setup_sh_dry_run_changes_nothing_and_never_asks_for_sudo():
    import pathlib
    import subprocess
    root = pathlib.Path(__file__).resolve().parent.parent
    script = root / "setup.sh"
    assert subprocess.run(["bash", "-n", str(script)]).returncode == 0
    r = subprocess.run(["bash", str(script), "--dry-run"], capture_output=True, text=True, cwd=str(root), timeout=60)
    assert r.returncode == 0, r.stderr
    assert "uv sync" in r.stdout and "so101 setup" in r.stdout and "dry run" in r.stdout
    text = script.read_text()
    assert "sudo usermod -aG dialout" in text            # the hint is printed for the person to run themselves
    for line in text.splitlines():                        # ...but sudo is never executed: it only appears in comments or in printed notes
        s = line.strip()
        if "sudo" in s and not s.startswith("#"):
            assert s.startswith(("note ", "warn ", "echo ", "printf ")), f"sudo must only be printed, never run: {line!r}"
    again = subprocess.run(["bash", str(script), "--dry-run", "--no-start"], capture_output=True, text=True, cwd=str(root), timeout=60)
    assert again.returncode == 0 and "All set" in again.stdout                                    # running it again is fine


def test_setup_ps1_says_windows_is_untested():
    import pathlib
    text = (pathlib.Path(__file__).resolve().parent.parent / "setup.ps1").read_text()
    assert "UNTESTED" in text and "uv sync" in text and "so101 setup" in text and "-DryRun" in text


def test_start_listens_on_this_computer_only_by_default():
    """The app has no password, so `so101 start` must not open itself to the whole network unless asked."""
    assert cli.build_parser().parse_args(["start"]).host == "127.0.0.1"
    assert cli.build_parser().parse_args(["start", "--host", "0.0.0.0"]).host == "0.0.0.0"
