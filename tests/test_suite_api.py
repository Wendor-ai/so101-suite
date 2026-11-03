import argparse
import http.client
import json
import os
import pathlib
import time
import types

import pytest

from so101 import paths, suite_api
from so101.store import Store


# ------------------------------------------------------------------ read-only API
def test_info_reports_demo(srv):
    d = srv.get("/api/suite/info").json
    assert d["demo"] is True and d["version"] and d["license"] == "AGPL-3.0-or-later" and d["repo"].startswith("https://")
    assert d["modules"] >= 1 and d["onboarded"] is False
    assert d["trace"] == {"enabled": False, "raw": False}
    assert "first_calibration_needed" in d and "uncalibrated" in d


def test_platform(srv):
    d = srv.get("/api/suite/platform").json
    assert d["os"] in ("macos", "linux", "windows") and d["python"]


def test_state_has_the_legacy_shape_with_two_demo_arms(srv):
    d = srv.get("/api/state").json
    assert sorted(a["role"] for a in d["arms"]) == ["follower", "leader"]
    assert all(a["online"] and len(a["joints"]) == 6 for a in d["arms"])
    assert len(d["cameras"]) == 2 and d["camera"] is True
    for k in ("pp", "teleop", "viz", "camera_src", "camera_fps"):
        assert k in d
    assert srv.get("/api/health").json["ok"] is True


def test_ports_lists_demo_arms_with_roles(srv):
    ports = srv.get("/api/suite/ports").json["ports"]
    assert sorted(p["path"] for p in ports) == ["demo://follower", "demo://leader"]
    by = {p["path"]: p for p in ports}
    assert by["demo://follower"]["role"] == "follower" and by["demo://leader"]["role"] == "leader"
    assert all(p["owned_by_app"] and p["likely_servo_board"] and p["key"] for p in ports)


def test_snapshot_is_jpeg(srv):
    r = srv.get("/api/suite/snapshot/0.jpg")
    assert r.status == 200 and r.ctype == "image/jpeg" and r.body[:2] == b"\xff\xd8" and r.headers["X-Camera-Ok"] == "1"
    assert srv.get("/api/suite/snapshot/1.jpg?annotated=1").ctype == "image/jpeg"
    bad = srv.get("/api/suite/snapshot/9.jpg")
    assert bad.status == 404 and "no camera 9" in bad.json["error"]


def test_snapshot_of_a_dead_camera_is_a_picture_with_the_reason(srv, monkeypatch):
    cam = srv.server.cams[1]
    monkeypatch.setattr(type(cam), "ok", property(lambda self: False if self is cam else True))
    monkeypatch.setattr(cam, "err", "test: cable pulled")
    r = srv.get("/api/suite/snapshot/1.jpg")
    assert r.status == 200 and r.body[:2] == b"\xff\xd8" and r.headers["X-Camera-Ok"] == "0" and "cable pulled" in r.headers["X-Camera-Error"]


def test_streams_new_and_legacy(srv):
    for path in ("/stream/0.mjpg", "/raw/1.mjpg", "/stream.mjpg", "/raw2.mjpg"):
        c = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=10)
        c.request("GET", path)
        r = c.getresponse()
        assert r.status == 200 and "multipart/x-mixed-replace" in r.getheader("Content-Type"), path
        chunk = r.read(400)
        assert b"--f" in chunk and b"image/jpeg" in chunk, path
        c.close()
    assert srv.get("/stream/7.mjpg").status == 404


def test_checklist_endpoint(srv):
    d = srv.get("/api/suite/checklist").json
    assert [i["id"] for i in d["items"]][:3] == ["python", "uv", "serial_permission"] and d["summary"]["total"] >= 10
    got = {i["id"]: i for i in d["items"]}
    assert got["follower_connected"]["status"] == "ok" and got["leader_motors"]["status"] == "ok"
    assert got["serial_permission"]["status"] == "skip"                  # the demo opens no serial port


def test_progress_roundtrip(srv):
    assert srv.get("/api/suite/progress").json == {}
    r = srv.post("/api/suite/progress", {"assembly.step.base": True})
    assert r.json == {"assembly.step.base": True}
    srv.post("/api/suite/progress", {"key": "cameras.skipped", "value": True})
    assert srv.get("/api/suite/progress").json == {"assembly.step.base": True, "cameras.skipped": True}
    assert srv.post("/api/suite/progress", {"Bad Key": True}).status == 400
    assert srv.post("/api/suite/progress", {"assembly.done": "yes"}).status == 400
    srv.post("/api/suite/progress", {"assembly.done": True})
    items = {i["id"]: i for i in srv.get("/api/suite/checklist").json["items"]}
    assert items["assembly_done"]["status"] == "ok" and "marked" in items["assembly_done"]["detail"]
    srv.post("/api/suite/progress", {"assembly.done": False, "cameras.skipped": False, "assembly.step.base": False})
    assert srv.post("/api/suite/progress", raw_body=b"{nope").status == 400


def test_diagnostics_has_no_personal_data(srv):
    r = srv.get("/api/suite/diagnostics")
    assert r.status == 200 and r.ctype == "text/plain"
    t = r.text
    for part in ("[platform]", "[ports]", "[arms]", "[cameras]", "[checklist]", "[modules]", "SO-101 Suite"):
        assert part in t
    assert "DEMO-FOLLOWER-0001" not in t and "DEMO-LEADER-0002" not in t                       # no adapter serial numbers
    for home in {os.path.expanduser("~"), str(pathlib.Path.home())}:
        assert home not in t
    assert "/Users/" not in t and "192.168." not in t


def test_modules_list_and_backend(srv):
    mods = srv.get("/api/suite/modules").json["modules"]
    hello = next(m for m in mods if m["id"] == "hello")
    assert hello["enabled"] is True and hello["error"] is None and hello["path"] == "modules/hello"
    r = srv.post("/api/m/hello/greet", {"name": "Ada"})
    assert r.status == 200 and r.json["message"] == "Hello, Ada!" and r.json["demo"] is True and r.json["arms_connected"] == 2
    assert srv.get("/api/m/hello/ping").json == {"ok": True}
    assert srv.get("/api/m/nope/x").status == 404


def test_broken_modules_are_listed_not_fatal(srv, tmp_path, monkeypatch):
    mdir = tmp_path / "mods"
    (mdir / "boom").mkdir(parents=True)
    (mdir / "boom" / "module.json").write_text(json.dumps({"id": "boom", "backend": "backend.py"}))
    (mdir / "boom" / "backend.py").write_text("def handle(m, p, b, c):\n    raise RuntimeError('kaboom')\n")
    (mdir / "junk").mkdir()
    (mdir / "junk" / "module.json").write_text("{ not json")
    monkeypatch.setattr(suite_api.ctx, "modules_dir", mdir)
    mods = {m["id"]: m for m in srv.get("/api/suite/modules").json["modules"]}
    assert mods["junk"]["error"] and mods["boom"]["error"] is None
    r = srv.get("/api/m/boom/x")
    assert r.status == 500 and "kaboom" in r.json["error"]
    assert srv.get("/api/health").json["ok"]                                                    # and the app is fine


def test_module_ui_files(srv):
    js = srv.get("/suite/modules/hello/ui.js")
    assert js.status == 200 and js.ctype == "text/javascript" and b"render(root, ctx)" in js.body
    assert srv.get("/suite/modules/hello/module.json").ctype == "application/json"
    assert srv.get("/suite/modules/hello/backend.py").status == 404
    assert srv.get("/suite/modules/hello/README.md").status == 404
    assert srv.get("/suite/modules/Hello/ui.js").status == 404
    for bad in ("/suite/modules/hello/../../app/server.py", "/suite/modules/hello/%2e%2e/%2e%2e/pyproject.toml", "/suite/modules/../app/server.py", "/suite/modules/hello/..%2fbackend.py"):
        assert srv.get(bad).status == 404, bad


def test_defaults_endpoint(srv):
    d = srv.get("/api/suite/defaults").json
    assert d["defaults"]["serial"]["baud"] == 1000000 and d["effective"]["safety"]["load_limit_pct"] == 70 and d["defaults"]["server"]["port"] == 8000


# ------------------------------------------------------------------ routing and static files
def test_root_redirects_by_onboarding(srv):
    r = srv.get("/")
    assert r.status == 302 and r.headers["Location"] == "/suite/"
    assert srv.post("/api/suite/onboarded", {"value": True}).json == {"onboarded": True}
    assert srv.get("/").headers["Location"] == "/dashboard"
    assert srv.get("/api/suite/info").json["onboarded"] is True
    assert srv.post("/api/suite/onboarded", {"value": "x"}).status == 400
    srv.post("/api/suite/onboarded", {"value": False})
    assert srv.get("/").headers["Location"] == "/suite/"


def test_dashboard_still_served(srv):
    r = srv.get("/dashboard")
    assert r.status == 200 and r.ctype == "text/html"
    assert r.body == (paths.APP_DIR / "index.html").read_bytes()
    assert srv.get("/dashboard/").status == 200
    assert srv.get("/vendor/three.min.js").status == 200                                         # legacy routes for the old dashboard
    assert srv.get("/assets/so101/so101_new_calib.urdf").status == 200


def test_suite_route_exists_even_without_a_ui(srv, monkeypatch, tmp_path):
    monkeypatch.setattr(suite_api.ctx, "suite_dir", tmp_path / "nothing-here")
    r = srv.get("/suite/")
    assert r.status == 404 and "dashboard" in r.text
    assert srv.get("/suite").status == 302


def test_static_mime_types_and_vendor_assets(srv, monkeypatch, tmp_path):
    ui = tmp_path / "ui"
    (ui / "css").mkdir(parents=True)
    (ui / "js").mkdir()
    files = {"index.html": "<!doctype html><title>t</title>", "css/suite.css": "a{}", "js/main.js": "export default 1", "data.json": "{}", "i.svg": "<svg/>", "p.png": "x", "q.jpg": "x"}
    for name, body in files.items():
        (ui / name).write_text(body)
    monkeypatch.setattr(suite_api.ctx, "suite_dir", ui)
    want = {"/suite/": "text/html", "/suite/index.html": "text/html", "/suite/css/suite.css": "text/css", "/suite/js/main.js": "text/javascript", "/suite/data.json": "application/json",
            "/suite/i.svg": "image/svg+xml", "/suite/p.png": "image/png", "/suite/q.jpg": "image/jpeg",
            "/suite/vendor/three.min.js": "text/javascript", "/suite/assets/so101/base_so101_v2.stl": "model/stl", "/suite/assets/so101/so101_new_calib.urdf": "application/xml"}
    for path, ctype in want.items():
        r = srv.get(path)
        assert r.status == 200 and r.ctype == ctype, (path, r.status, r.ctype)
    assert srv.get("/suite/vendor/three.min.js").body == (paths.APP_DIR / "vendor" / "three.min.js").read_bytes()
    assert srv.get("/suite/js/").status == 404 and srv.get("/suite/missing.js").status == 404
    assert srv.request("HEAD", "/suite/css/suite.css").status == 200


def test_static_traversal_rejected(srv):
    bad = ["/suite/../server.py", "/suite/%2e%2e/server.py", "/suite/..%2fserver.py", "/suite/vendor/../../server.py", "/suite/assets/../../so101/__init__.py",
           "/suite/vendor/%2e%2e/%2e%2e/pyproject.toml", "/suite/./../server.py", "/suite/..\\server.py", "/suite/vendor/..%5c..%5cserver.py", "/suite/%00", "/suite/.git/config"]
    for path in bad:
        r = srv.get(path)
        assert r.status == 404 and b"import" not in r.body and b"scservo" not in r.body, (path, r.status)


# ------------------------------------------------------------------ cameras
def test_cameras_list_detect_add_rename_remove(srv):
    d = srv.get("/api/suite/cameras").json
    assert [c["source"] for c in d["cameras"]] == ["demo://camera/0", "demo://camera/1"] and d["origin"] == "auto" and d["restart_needed"] is False
    assert all(c["ok"] and c["name"] and c["id"] for c in d["cameras"])
    d = srv.get("/api/suite/cameras?refresh=1").json
    assert [c["source"] for c in d["detected"]] == ["demo://camera/2"]                         # the third demo camera is "plugged in" but not added
    r = srv.post("/api/suite/cameras", {"action": "add", "source": "demo://camera/2", "name": "Spare"})
    assert r.status == 200 and r.json["restart_needed"] is True
    d = srv.get("/api/suite/cameras").json
    assert [c["name"] for c in d["cameras"]] == ["Camera 1", "Camera 2", "Spare"] and d["cameras"][2]["pending"] is True and d["restart_needed"] is True
    assert srv.get("/api/suite/cameras").json["detected"] == []                                  # now it is added
    assert srv.post("/api/suite/cameras", {"action": "add", "source": "demo://camera/2"}).status == 409
    spare = d["cameras"][2]["id"]
    r = srv.post("/api/suite/cameras", {"action": "rename", "id": spare, "name": "Desk"})
    assert r.status == 200 and r.json["restart_needed"] is False
    assert Store(suite_api.ctx.store.path).get("cameras.list")[-1]["name"] == "Desk"            # persisted
    assert srv.post("/api/suite/cameras", {"action": "remove", "id": spare}).json["restart_needed"] is True
    assert srv.post("/api/suite/cameras", {"action": "remove", "id": "nope"}).status == 404
    assert srv.get("/api/suite/cameras").json["restart_needed"] is False
    suite_api.ctx.store.delete("cameras.list")


def test_adding_a_unreachable_network_camera_says_why(srv):
    r = srv.post("/api/suite/cameras", {"action": "add", "source": "http://127.0.0.1:9/raw.mjpg"})
    assert r.status == 400 and "reach" in r.json["error"].lower()
    assert srv.post("/api/suite/cameras", {"action": "add"}).status == 400
    assert srv.post("/api/suite/cameras", {"action": "fly"}).status == 400


def test_camera_source_precedence(srv, tmp_path):
    pick = srv.server.pick_cameras
    ns = lambda **kw: argparse.Namespace(**{"camera": None, "camera2": "", "camera_url": "", **kw})
    store = Store(tmp_path / "s.json")
    assert pick(ns(), store) == (["demo://camera/0", "demo://camera/1"], "auto")             # demo auto-detect
    store.set("cameras.list", [{"id": "cam0", "name": "A", "source": "2"}, {"id": "cam1", "name": "B", "source": "http://pi/raw.mjpg"}])
    assert pick(ns(), store) == ([2, "http://pi/raw.mjpg"], "store")                          # saved list beats auto-detect
    assert pick(ns(camera="1"), store) == ([1], "cli")                                        # command line / env beat the saved list
    assert pick(ns(camera_url="http://a/raw.mjpg, http://b/raw.mjpg"), store) == (["http://a/raw.mjpg", "http://b/raw.mjpg"], "cli")
    assert pick(ns(camera="/dev/video0", camera2="3"), store) == (["/dev/video0", 3], "cli")


# ------------------------------------------------------------------ settings
def test_settings_roundtrip_and_whitelist(srv):
    d = srv.get("/api/suite/settings").json
    assert set(d) == {"ui", "safety", "adv"} and d["ui"]["theme"] == "auto" and d["safety"]["speed_preset"] == "gentle" and "_doc" not in d["ui"]
    r = srv.post("/api/suite/settings", {"ui": {"theme": "dark", "reduceMotion": True}, "adv.rawLinks": True})
    assert r.status == 200 and r.json["ui"]["theme"] == "dark" and r.json["ui"]["reduceMotion"] is True and r.json["adv"]["rawLinks"] is True
    assert suite_api.ctx.store.get("ui.theme") == "dark"                                       # persisted in the store
    assert srv.post("/api/suite/settings", {"ui": {"customThing": "x"}}).status == 200         # free-form UI preferences are fine
    for bad, why in (({"ui": {"theme": "neon"}}, "one of"), ({"ui": {"reduceMotion": "yes"}}, "true/false"), ({"cameras": {"width": 1}}, "Unknown setting"),
                     ({"nonsense": 1}, "Unknown setting"), ({"safety": {"load_limit_pct": 100}}, "built-in safety limit"), ({"ui": {"bad key": 1}}, "valid setting name"),
                     ({"ui": {"theme": ["a"]}}, "text"), ({"ui.accent": "x" * 300}, "too")):
        r = srv.post("/api/suite/settings", bad)
        assert r.status == 400 and why in r.json["error"], (bad, r.json)
    assert srv.get("/api/suite/settings").json["safety"]["load_limit_pct"] == 70                 # a refused request changes nothing
    assert srv.post("/api/suite/settings", {"safety": {"confirm_before_move": False, "speed_preset": "normal"}}).json["safety"]["speed_preset"] == "normal"
    srv.post("/api/suite/settings", {"ui": {"theme": "auto", "reduceMotion": False}, "adv": {"rawLinks": False}, "safety": {"confirm_before_move": True, "speed_preset": "gentle"}})


# ------------------------------------------------------------------ restart
def test_restart_refused_while_teleop_on(srv, monkeypatch):
    monkeypatch.setattr(srv.server, "TELE", types.SimpleNamespace(on=True, state=lambda: {}))
    r = srv.post("/api/suite/restart")
    assert r.status == 409 and "Stop" in r.json["error"]


def test_restart_refused_while_a_job_runs(srv, monkeypatch):
    monkeypatch.setattr(type(srv.server.PP), "running", property(lambda self: True))
    assert srv.post("/api/suite/restart").status == 409


def test_restart_goes_ahead_when_idle(srv, monkeypatch):
    calls = []
    monkeypatch.setattr(suite_api.ctx, "restart_fn", lambda: calls.append(1))
    r = srv.post("/api/suite/restart")
    assert r.status == 200 and r.json["restarting"] is True
    srv.wait(lambda: calls, what="the restart hook")


def test_unknown_api_paths_are_json_404(srv):
    r = srv.get("/api/suite/nope")
    assert r.status == 404 and "error" in r.json
    assert srv.get("/api/demo/connect").status == 405
    assert srv.get("/nothing-here").status == 404


# ---- regressions found while writing the docs and testing on a real Raspberry Pi ----------------------------------------
def test_settings_accept_what_the_settings_page_sends(srv):
    """The page sends ui.units 'norm' and safety.stop_shortcut; the server used to answer HTTP 400 to both."""
    r = srv.post("/api/suite/settings", {"ui": {"units": "norm"}, "safety": {"stop_shortcut": False}})
    assert r.status == 200, r.json
    got = srv.get("/api/suite/settings").json
    assert got["ui"]["units"] == "norm" and got["safety"]["stop_shortcut"] is False
    assert srv.post("/api/suite/settings", {"ui": {"units": "furlongs"}}).status == 400              # still validated
    srv.post("/api/suite/settings", {"ui": {"units": "deg"}, "safety": {"stop_shortcut": True}})


def test_allow_modules_switch_really_turns_modules_off(srv):
    assert any(m["enabled"] for m in srv.get("/api/suite/modules").json["modules"])
    srv.post("/api/suite/settings", {"adv": {"modulesEnabled": False}})
    try:
        mods = srv.get("/api/suite/modules").json["modules"]
        assert mods and not any(m["enabled"] for m in mods)
        assert srv.post("/api/m/hello/greet", {"name": "x"}).status >= 400                          # a disabled module's backend is refused too
    finally:
        srv.post("/api/suite/settings", {"adv": {"modulesEnabled": True}})
    assert any(m["enabled"] for m in srv.get("/api/suite/modules").json["modules"])
