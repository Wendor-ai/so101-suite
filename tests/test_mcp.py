"""The MCP server (so101/mcp.py): the protocol, the tool set, and every tool against a real demo server or a scripted stand-in.

No hardware and no real serial port: the demo server (see tests/helpers.py) is simulated, and the stand-in app is a plain local HTTP server.
Order matters at the end of this file: the last test calibrates the demo's follower arm through the MCP tools."""
import base64
import http.server
import io
import json
import os
import pathlib
import socket
import subprocess
import sys
import threading
import time
import urllib.parse

import pytest

from so101 import cli, demo, mcp

ROOT = pathlib.Path(__file__).resolve().parent.parent
READ_ONLY_TOOLS = {"so101_status", "so101_checklist", "so101_diagnostics", "so101_ports", "so101_cameras", "so101_platform", "so101_trace", "so101_snapshot",
                   "so101_modules", "so101_ping_motor"}
CLICK_TOOLS = {"so101_teach_point", "so101_undo_point", "so101_clear_points"}
ALWAYS_ON = READ_ONLY_TOOLS | CLICK_TOOLS | {"so101_stop"}
MOTION_TOOLS = {"so101_wiggle_motor", "so101_calibration", "so101_rest_arm"}
NOT_RUNNING = "The SO-101 app is not running at "


@pytest.fixture(scope="module", autouse=True)
def fast_hand():
    old = demo.HAND_SLOT
    demo.HAND_SLOT = 0.7                      # the simulated hand takes 0.7 s per joint, so a full calibration sweep is ~4 s
    yield
    demo.HAND_SLOT = old


@pytest.fixture(scope="module")
def base(srv):
    return f"http://127.0.0.1:{srv.port}"


# ------------------------------------------------------------------ helpers
def req(i, method, params=None):
    return {"jsonrpc": "2.0", "id": i, "method": method, **({} if params is None else {"params": params})}


def tool(i, name, **args):
    return req(i, "tools/call", {"name": name, "arguments": args})


INIT = req(0, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "pytest", "version": "1"}})
INITIALIZED = {"jsonrpc": "2.0", "method": "notifications/initialized"}


def session(url, messages, allow_motion=False, drain_s=30.0):
    """Feed these lines to the server in-process and return (parsed response objects, raw stdout text)."""
    stdin = io.StringIO("".join((m if isinstance(m, str) else json.dumps(m)) + "\n" for m in messages))
    stdout = io.StringIO()
    assert mcp.serve(url, allow_motion, stdin=stdin, stdout=stdout, drain_s=drain_s) == 0
    raw = stdout.getvalue()
    return [json.loads(line) for line in raw.split("\n") if line], raw


def rpc(url, method, params=None, **kw):
    resps, _ = session(url, [req(1, method, params)], **kw)
    assert len(resps) == 1 and resps[0]["id"] == 1
    return resps[0]


def call(url, name, _motion=False, **args):
    r = rpc(url, "tools/call", {"name": name, "arguments": args}, allow_motion=_motion)
    assert "result" in r, r
    return r["result"]


def words(result):
    return "\n".join(c["text"] for c in result["content"] if c["type"] == "text")


def closed_port_url():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return f"http://127.0.0.1:{port}"


class Fake:
    """A scripted stand-in for the app: handler(method, path, body) -> (status, payload) and a record of every call."""
    def __init__(self, handler):
        self.calls, outer = [], self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _go(self, method):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}") if n else None
                outer.calls.append((method, self.path, body))
                try:
                    out = handler(method, self.path, body)
                except Exception as e:                                  # a bug in the script must not look like the app
                    out = (500, {"error": f"fake app failed: {e}"})
                status, payload, *rest = out
                headers = rest[0] if rest else {}
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", headers.pop("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(data)))
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self): self._go("GET")
            def do_POST(self): self._go("POST")

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def __enter__(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *a):
        self.httpd.shutdown()
        self.httpd.server_close()

    def posted(self, path):
        return [b for m, p, b in self.calls if m == "POST" and p == path]


def state(pp=None, teleop=None, arms=None, cameras=None):
    return {"pp": pp, "teleop": teleop or {"on": False}, "arms": arms or [], "cameras": cameras or []}


def jpeg(w, h):
    import cv2
    import numpy as np
    return cv2.imencode(".jpg", np.zeros((h, w, 3), np.uint8))[1].tobytes()


# ================================================================== protocol
def test_initialize_handshake_then_initialized_gets_no_reply(base):
    resps, raw = session(base, [INIT, INITIALIZED, req(1, "ping")])
    assert [r["id"] for r in resps] == [0, 1]                                        # the notification produced nothing
    init = resps[0]["result"]
    assert init["protocolVersion"] == "2025-06-18" and "tools" in init["capabilities"]
    assert init["serverInfo"]["name"] == "so101" and init["serverInfo"]["version"]
    for step in ("so101_status", "so101_checklist", "so101_snapshot", "so101_teach_point", "so101_stop"):
        assert step in init["instructions"]
    assert init["instructions"].index("so101_status") < init["instructions"].index("so101_checklist") < init["instructions"].index("so101_snapshot") \
        < init["instructions"].index("so101_teach_point") < init["instructions"].index("so101_stop")
    assert resps[1]["result"] == {} and raw.endswith("\n")


@pytest.mark.parametrize("asked,got", [("2024-11-05", "2024-11-05"), ("2025-03-26", "2025-03-26"), ("2025-06-18", "2025-06-18"), ("1999-01-01", "2025-06-18"), (None, "2025-06-18")])
def test_protocol_version_is_echoed_when_known_else_2025_06_18(base, asked, got):
    params = {"capabilities": {}} if asked is None else {"protocolVersion": asked, "capabilities": {}}
    assert rpc(base, "initialize", params)["result"]["protocolVersion"] == got


def test_malformed_json_is_a_parse_error_and_the_server_keeps_running(base):
    resps, raw = session(base, ["{this is not json", "", "   ", req(1, "ping"), "[1, 2", req(2, "tools/list")])
    assert resps[0] == {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": resps[0]["error"]["message"]}} and resps[0]["error"]["message"]
    assert resps[1]["id"] == 1 and resps[1]["result"] == {}
    assert resps[2]["error"]["code"] == -32700
    assert resps[3]["id"] == 2 and resps[3]["result"]["tools"]


def test_a_line_that_is_json_but_not_a_request_is_invalid_request(base):
    resps, _ = session(base, ["42", '"hello"', json.dumps({"jsonrpc": "2.0", "id": [1], "method": "ping"}), json.dumps({"jsonrpc": "2.0", "id": 5}), req(6, "ping")])
    assert [r["error"]["code"] for r in resps[:4]] == [-32600] * 4 and resps[4]["result"] == {}


def test_unknown_methods_are_32601_and_unknown_notifications_are_silent(base):
    resps, _ = session(base, [req(1, "resources/list"), {"jsonrpc": "2.0", "method": "notifications/whatever"}, {"jsonrpc": "2.0", "method": "nope"}, req(2, "ping")])
    assert [r["id"] for r in resps] == [1, 2] and resps[0]["error"]["code"] == -32601 and "resources/list" in resps[0]["error"]["message"]


def test_params_that_are_not_an_object_are_32602(base):
    r = rpc(base, "tools/list", ["nope"])
    assert r["error"]["code"] == -32602


def test_unknown_tool_is_a_jsonrpc_error(base):
    r = rpc(base, "tools/call", {"name": "so101_make_coffee", "arguments": {}})
    assert r["error"]["code"] == -32602 and "so101_make_coffee" in r["error"]["message"] and "result" not in r


@pytest.mark.parametrize("params", [{}, {"name": ""}, {"name": 5}, {"name": "so101_status", "arguments": ["x"]}])
def test_tools_call_with_bad_params_is_32602(base, params):
    assert rpc(base, "tools/call", params)["error"]["code"] == -32602


def test_batches_are_answered_with_a_batch(base):
    resps, raw = session(base, [json.dumps([req(1, "ping"), {"jsonrpc": "2.0", "method": "notifications/initialized"}, req(2, "ping")])])
    assert len(resps) == 1 and [r["id"] for r in resps[0]] == [1, 2]


def test_output_is_ascii_one_json_object_per_line(base):
    resps, raw = session(base, [req("é-ünï", "ping"), tool(2, "so101_status")])
    assert raw.isascii() and raw.endswith("\n")
    for line in raw.split("\n")[:-1]:
        assert line and isinstance(json.loads(line), dict) and "\r" not in line
    assert {r["id"] for r in resps} == {"é-ünï", 2}


# ================================================================== the tool set
def test_tools_list_has_the_read_only_set_and_no_motion_tools_by_default(base):
    names = {t["name"] for t in rpc(base, "tools/list")["result"]["tools"]}
    assert names == ALWAYS_ON
    assert not names & MOTION_TOOLS


def test_tools_list_with_allow_motion_adds_exactly_the_three_motion_tools(base):
    names = {t["name"] for t in rpc(base, "tools/list", allow_motion=True)["result"]["tools"]}
    assert names == ALWAYS_ON | MOTION_TOOLS
    assert not any(word in n for n in names for word in ("pick", "teleop", "leader_to", "release", "set_id", "motor_id"))      # never offered at all


def test_every_tool_has_a_description_and_a_strict_input_schema(base):
    for t in rpc(base, "tools/list", allow_motion=True)["result"]["tools"]:
        assert len(t["description"]) > 60, t["name"]
        s = t["inputSchema"]
        assert s["type"] == "object" and isinstance(s["properties"], dict) and s["additionalProperties"] is False
        assert set(s["required"]) <= set(s["properties"]), t["name"]
        for k, p in s["properties"].items():
            assert p["type"] in ("integer", "number", "string", "boolean", "array") and p["description"], (t["name"], k)
        assert isinstance(t["annotations"]["readOnlyHint"], bool)
    by = {t["name"]: t for t in rpc(base, "tools/list", allow_motion=True)["result"]["tools"]}
    assert all(by[n]["annotations"]["readOnlyHint"] for n in READ_ONLY_TOOLS)
    assert not any(by[n]["annotations"]["readOnlyHint"] for n in CLICK_TOOLS | MOTION_TOOLS | {"so101_stop"})
    assert by["so101_teach_point"]["inputSchema"]["required"] == ["u", "v"]


def test_a_motion_tool_without_the_flag_is_refused_with_a_jsonrpc_error(base):
    for name, args in (("so101_wiggle_motor", {"role": "follower", "id": 1}), ("so101_calibration", {"arm_index": 0, "action": "start"}), ("so101_rest_arm", {})):
        r = rpc(base, "tools/call", {"name": name, "arguments": args})
        assert r["error"]["code"] == -32602 and "--allow-motion" in r["error"]["message"]


def test_cli_parses_the_mcp_command(monkeypatch):
    monkeypatch.delenv("SO101_URL", raising=False)
    a = cli.build_parser().parse_args(["mcp"])
    assert a.cmd == "mcp" and a.url == "http://127.0.0.1:8000" and a.allow_motion is False
    a = cli.build_parser().parse_args(["mcp", "--url", "http://pi.local:8000", "--allow-motion"])
    assert a.url == "http://pi.local:8000" and a.allow_motion is True
    monkeypatch.setenv("SO101_URL", "http://127.0.0.1:8123")
    assert cli.build_parser().parse_args(["mcp"]).url == "http://127.0.0.1:8123"
    assert cli.build_parser().parse_args(["mcp", "--url", "http://x:1"]).url == "http://x:1"           # the flag beats the environment


def test_a_bad_address_stops_early_and_writes_nothing_to_stdout(capsys):
    assert cli.main(["mcp", "--url", "ftp://example.com"]) == 2
    out = capsys.readouterr()
    assert out.out == "" and "http" in out.err


def test_a_real_process_writes_only_json_rpc_to_stdout(base):
    msgs = [INIT, INITIALIZED, req(1, "tools/list"), tool(2, "so101_status"), tool(3, "so101_snapshot", camera=0), "this is garbage", req(4, "ping")]
    p = subprocess.run([sys.executable, "-m", "so101.cli", "mcp", "--url", base], input="".join((m if isinstance(m, str) else json.dumps(m)) + "\n" for m in msgs),
                       capture_output=True, text=True, timeout=90, cwd=str(ROOT), env={**os.environ, "PYTHONPATH": str(ROOT)})
    assert p.returncode == 0, p.stderr
    lines = p.stdout.split("\n")
    assert lines[-1] == "" and all(lines[:-1])
    objs = [json.loads(line) for line in lines[:-1]]                                    # every single stdout line is JSON ...
    assert all(o["jsonrpc"] == "2.0" for o in objs)                                     # ... and a JSON-RPC message
    by = {o["id"]: o for o in objs if o.get("id") is not None}
    assert {0, 1, 2, 3, 4} <= set(by) and any(o["id"] is None and o["error"]["code"] == -32700 for o in objs)
    assert by[3]["result"]["content"][1]["type"] == "image"
    assert "so101 mcp:" in p.stderr and "motion tools off" in p.stderr                  # the log went to stderr


# ================================================================== argument checking
def test_bad_arguments_are_plain_sentences_and_nothing_reaches_the_app():
    with Fake(lambda m, p, b: (200, state(pp={"taught": 0}))) as f:
        cases = [("so101_teach_point", {"u": 9999, "v": 10}, "'u' must be"), ("so101_teach_point", {"u": "left", "v": 10}, "'u' must be a number"),
                 ("so101_teach_point", {"u": True, "v": 10}, "'u' must be a number"), ("so101_teach_point", {"u": 10}, "Missing argument 'v'"),
                 ("so101_teach_point", {"u": 1, "v": 2, "w": 3}, "Unknown argument: w"), ("so101_snapshot", {"camera": -1}, "'camera' must be"),
                 ("so101_snapshot", {"camera": 1.5}, "whole number"), ("so101_snapshot", {"annotated": "yes"}, "true or false"),
                 ("so101_ping_motor", {"role": "boss", "id": 1}, "one of: follower, leader"), ("so101_ping_motor", {"role": "leader", "id": 9}, "'id' must be"),
                 ("so101_trace", {"kinds": "bus"}, "must be a list"), ("so101_trace", {"kinds": ["wifi"]}, "one of: bus, http, log, raw")]
        for name, args, expect in cases:
            r = call(f.url, name, **args)
            assert r["isError"] is True and expect in words(r), (name, args, words(r))
        assert f.calls == []                                                            # not even a GET: validation happens first


def test_an_internal_bug_is_reported_as_a_sentence_not_a_stack_trace(base, monkeypatch):
    def boom(app, args):
        raise ZeroDivisionError("secret internals")
    monkeypatch.setattr(mcp.TOOLS[0], "handler", boom)
    r = call(base, "so101_status")
    assert r["isError"] is True and "ZeroDivision" not in words(r) and "Traceback" not in words(r) and "went wrong inside" in words(r)
    assert rpc(base, "ping")["result"] == {}                                            # and the server carries on


# ================================================================== the app is not there
@pytest.mark.parametrize("name,args", [("so101_status", {}), ("so101_checklist", {}), ("so101_snapshot", {"camera": 0}), ("so101_teach_point", {"u": 1, "v": 2}),
                                       ("so101_stop", {}), ("so101_trace", {}), ("so101_diagnostics", {})])
def test_app_not_running_is_a_clear_sentence(name, args):
    url = closed_port_url()
    r = call(url, name, **args)
    assert r["isError"] is True
    msg = words(r)
    assert msg.startswith(NOT_RUNNING + url) and "uv run so101 start" in msg and "Traceback" not in msg and "URLError" not in msg


def test_a_trailing_slash_or_missing_scheme_in_the_address_is_fine(base):
    host = base.split("//")[1]
    for url in (base + "/", host):
        assert call(url, "so101_platform")["isError"] is False


def test_app_errors_come_through_in_the_apps_own_words():
    def h(m, p, b):
        if p == "/api/suite/motors":
            return 409, {"error": "A calibration is running: finish or cancel it first."}
        if p == "/api/suite/checklist":
            return 200, b"<html>not json</html>", {"Content-Type": "text/html"}
        return 404, b"nope", {"Content-Type": "text/plain"}
    with Fake(h) as f:
        assert words(call(f.url, "so101_ping_motor", role="follower", id=2)) == "A calibration is running: finish or cancel it first."
        assert "not JSON" in words(call(f.url, "so101_checklist"))
        r = call(f.url, "so101_platform")
        assert r["isError"] and "older version" in words(r)


def test_a_stuck_app_times_out_with_a_sentence(monkeypatch):
    real_init = mcp.App.__init__
    monkeypatch.setattr(mcp.App, "__init__", lambda self, url, allow_motion=False: real_init(self, url, allow_motion, timeout=0.3))
    with Fake(lambda m, p, b: (time.sleep(1.5), (200, {}))[1]) as f:
        r = call(f.url, "so101_platform")
    assert r["isError"] and "did not answer in time" in words(r)


# ================================================================== read-only tools against the demo
def test_status_summary_mentions_both_demo_arms(base):
    r = call(base, "so101_status")
    assert r["isError"] is False
    summary = words(r).split("Raw state")[0]
    assert "DEMO mode" in summary and "arm_index 0:" in summary and "arm_index 1:" in summary
    assert "follower arm: online" in summary and "leader arm: online" in summary and "all 6 motors answer" in summary
    assert "camera 0" in summary and "camera 1" in summary and "picture OK" in summary
    raw = json.loads(r["content"][1]["text"].split("\n", 1)[1])                         # the raw JSON is really JSON
    assert sorted(a["role"] for a in raw["arms"]) == ["follower", "leader"] and "viz" not in raw


def test_checklist_names_the_next_step(base):
    t = words(call(base, "so101_checklist"))
    assert "checks are ok" in t and "NEXT STEP:" in t and "[ok]" in t and "[todo]" in t


def test_the_other_read_only_tools_work_on_the_demo(base):
    assert "SO-101 Suite" in words(call(base, "so101_diagnostics")) and "[arms]" in words(call(base, "so101_diagnostics"))
    assert "demo://follower" in words(call(base, "so101_ports")) and "role follower" in words(call(base, "so101_ports"))
    cams = words(call(base, "so101_cameras"))
    assert "camera 0 'Camera 1'" in cams and "camera 1" in cams
    assert "Computer:" in words(call(base, "so101_platform")) and "Python" in words(call(base, "so101_platform"))
    assert "hello" in words(call(base, "so101_modules"))
    ping = call(base, "so101_ping_motor", role="follower", id=3)
    assert ping["isError"] is False and "Motor 3" in words(ping) and "answered" in words(ping) and "temperature" in words(ping)
    off = call(base, "so101_trace")
    assert off["isError"] is False and "not recording" in words(off) and "never turns it on" in words(off)


def test_ports_leave_serial_numbers_out(base):
    r = call(base, "so101_ports")
    assert "DEMO-FOLLOWER" not in words(r) and "DEMO-LEADER" not in words(r)
    raw = json.loads(r["content"][1]["text"].split("\n", 1)[1])
    assert all("serial" not in p and "key" not in p for p in raw["ports"])


def test_snapshot_returns_a_jpeg_image_block_and_a_status_line(base):
    r = call(base, "so101_snapshot", camera=0)
    assert r["isError"] is False
    kinds = [c["type"] for c in r["content"]]
    assert kinds == ["text", "image"]
    img = r["content"][1]
    assert img["mimeType"] == "image/jpeg"
    data = base64.b64decode(img["data"], validate=True)
    assert data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9" and len(data) > 1000
    assert "Camera 0" in words(r) and "fps" in words(r) and "640x480" in words(r)
    assert base64.b64decode(call(base, "so101_snapshot", camera=1, annotated=True)["content"][1]["data"])[:2] == b"\xff\xd8"
    assert mcp.jpeg_size(data) == (640, 480)


def test_snapshot_of_a_camera_that_does_not_exist_says_so(base):
    r = call(base, "so101_snapshot", camera=9)
    assert r["isError"] is True and "no camera 9" in words(r) and all(c["type"] == "text" for c in r["content"])


def test_snapshot_of_a_dead_camera_says_so_and_returns_no_picture():
    def h(m, p, b):
        if p.startswith("/api/suite/snapshot/"):
            return 200, jpeg(640, 480), {"Content-Type": "image/jpeg", "X-Camera-Ok": "0", "X-Camera-Error": "cannot open /dev/video0"}
        return 200, state(cameras=[{"ok": False, "fps": 0, "err": "cannot open /dev/video0", "src": "0"}])
    with Fake(h) as f:
        r = call(f.url, "so101_snapshot", camera=0)
    assert r["isError"] is True and "no picture" in words(r) and "cannot open /dev/video0" in words(r)
    assert all(c["type"] == "text" for c in r["content"])                               # the placeholder frame is not passed off as a picture


def test_snapshot_tells_the_ai_to_scale_when_the_picture_is_not_640x480():
    with Fake(lambda m, p, b: (200, jpeg(1280, 720), {"Content-Type": "image/jpeg", "X-Camera-Ok": "1"}) if p.startswith("/api/suite/snapshot/") else (200, state(cameras=[{"ok": True, "fps": 30.0}]))) as f:
        r = call(f.url, "so101_snapshot", camera=0)
    assert r["isError"] is False and "1280x720" in words(r) and "scale" in words(r)


def test_status_for_a_broken_setup_is_specific_and_hides_hosts_and_serials():
    st = state(pp=None, arms=[{"role": "follower", "online": False, "err": "could not open /dev/cu.usbmodem5A0000000001", "joints": [], "port": "/dev/cu.usbmodem5A0000000001"},
                              {"role": "leader", "online": True, "calibrated": True, "joints": [{"id": 1, "temp": 31, "load": 20}, {"id": 2, "temp": 40, "load": -300}], "faults": {"elbow_flex": ["overload"]}}],
               cameras=[{"ok": False, "fps": 0, "err": "no frames from http://192.168.1.77:8000/raw.mjpg", "src": "http://192.168.1.77:8000/raw.mjpg"}])
    with Fake(lambda m, p, b: (200, st) if p == "/api/state" else (404, {"error": "no"})) as f:
        r = call(f.url, "so101_status")
    t = words(r)
    assert "OFFLINE" in t and "only motors 1, 2 answer (missing 3, 4, 5, 6)" in t and "hottest motor 40 C" in t and "highest load 30%" in t and "FAULTS: elbow_flex (overload)" in t
    assert "NO PICTURE" in t and "(network)" in t and "Pick & place engine: not running" in t
    assert "192.168.1.77" not in t and "5A0000000001" not in t and "usbmodem*" in t


def test_trace_off_on_and_the_query_it_sends():
    off = {"enabled": False, "raw": False, "seq": 0, "dropped": 0, "items": []}
    on = {"enabled": True, "raw": False, "seq": 42, "dropped": 3, "items": [
        {"seq": 41, "t": 1000.5, "kind": "bus", "ok": True, "ms": 1.2, "op": "read2", "id": 3, "addr": 56, "reg": "present_position", "value": 2048},
        {"seq": 42, "t": 1001.0, "kind": "log", "ok": False, "ms": 0, "level": "warn", "source": "camera", "msg": "camera 1 lost: no frames"}]}
    box = {"d": off}
    with Fake(lambda m, p, b: (200, box["d"])) as f:
        assert "not recording" in words(call(f.url, "so101_trace"))
        box["d"] = on
        r = call(f.url, "so101_trace", since=40, kinds=["bus", "log"], limit=20)
        t = words(r)
        assert "recording is ON" in t and "since=42" in t and "3 older ones were dropped" in t and "read2 id=3" in t and "present_position" in t and "camera 1 lost" in t and "FAIL" in t
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(f.calls[-1][1]).query)
        assert q == {"limit": ["20"], "since": ["40"], "kinds": ["bus,log"]}
        box["d"] = {**off, "seq": 7, "items": on["items"]}
        assert "recording is OFF" in words(call(f.url, "so101_trace")) and "camera 1 lost" in words(call(f.url, "so101_trace"))


# ================================================================== calibration clicks
def test_teach_point_refusal_surfaces_as_an_error_with_the_apps_sentence(base):
    r = call(base, "so101_teach_point", u=320, v=240)                                  # the demo's arms are not calibrated yet
    assert r["isError"] is True
    assert "The app did not record that point" in words(r) and "not online/calibrated" in words(r) and "so101_checklist" in words(r)


def test_teach_point_success_and_the_refusals_with_a_scripted_app():
    st = {"taught": 0, "status": "idle", "refuse": None, "running": False}

    def h(m, p, b):
        if (m, p) == ("GET", "/api/state"):
            return 200, state(pp={"taught": st["taught"], "status": st["status"], "running": st["running"], "limp": True, "fit_mm": 2.5 if st["taught"] > 3 else None})
        if (m, p) == ("POST", "/api/pp/teach"):
            if st["refuse"]:
                st["status"] = "error: " + st["refuse"]                                 # what the real app does: HTTP 200 and the sentence in pp.status
            else:
                st["taught"] += 1
                st["status"] = f"taught point {st['taught']}"
            return 200, {}
        if (m, p) == ("POST", "/api/pp/undo"):
            st["taught"] -= 1
            return 200, {}
        if (m, p) == ("POST", "/api/pp/clear"):
            st["taught"] = 0
            return 200, {}
        return 404, {"error": "no"}
    with Fake(h) as f:
        r1 = call(f.url, "so101_teach_point", u=320, v=240.5)
        assert r1["isError"] is False and "Point 1 recorded" in words(r1) and "(320, 240.5)" in words(r1) and "did not move" in words(r1) and "2 more are needed" in words(r1)
        assert f.posted("/api/pp/teach") == [{"u": 320, "v": 240.5}]
        assert "1 more is needed" in words(call(f.url, "so101_teach_point", u=10, v=20))
        r3 = call(f.url, "so101_teach_point", u=11, v=21)
        assert "enough to map the table" in words(r3)
        r4 = call(f.url, "so101_teach_point", u=12, v=22)
        assert "Fit error 2.5 mm" in words(r4)
        st["refuse"] = "the arm is not limp: press 'Make arm limp' first, then move it by hand"
        r = call(f.url, "so101_teach_point", u=1, v=1)
        assert r["isError"] and "not limp" in words(r) and "never releases torque" in words(r) and "Make arm limp" in words(r)
        st["refuse"] = "the gripper tip hasn't moved since the last point: move it to a NEW spot on the table first"
        r = call(f.url, "so101_teach_point", u=1, v=1)
        assert r["isError"] and "NEW spot" in words(r) and "at least 2 cm" in words(r)
        st["refuse"] = None
        n = st["taught"]
        assert "Removed the newest" in words(call(f.url, "so101_undo_point")) and st["taught"] == n - 1
        assert "Cleared all" in words(call(f.url, "so101_clear_points")) and st["taught"] == 0
        assert "no calibration points to undo" in words(call(f.url, "so101_undo_point"))
        assert "no calibration points to clear" in words(call(f.url, "so101_clear_points"))
        st["running"], st["taught"], before = True, 2, len(f.posted("/api/pp/clear"))
        for name, args in (("so101_teach_point", {"u": 5, "v": 5}), ("so101_undo_point", {}), ("so101_clear_points", {})):
            r = call(f.url, name, **args)
            assert r["isError"] and "Pick & place is running" in words(r)
        assert len(f.posted("/api/pp/clear")) == before and st["taught"] == 2          # nothing was changed while a job runs


def test_teach_point_without_an_arm_engine_says_so():
    with Fake(lambda m, p, b: (200, state(pp=None))) as f:
        r = call(f.url, "so101_teach_point", u=1, v=2)
    assert r["isError"] and "arm engine" in words(r) and f.posted("/api/pp/teach") == []


# ================================================================== stop
def test_stop_calls_both_stops_and_says_the_arm_holds():
    with Fake(lambda m, p, b: (200, state(pp={"running": False}, teleop={"on": False})) if p == "/api/state" else (200, {})) as f:
        r = call(f.url, "so101_stop")
    assert r["isError"] is False and "Stop sent" in words(r) and "holds where it is" in words(r)
    assert [p for m, p, b in f.calls if m == "POST"] == ["/api/teleop/stop", "/api/pp/stop"]


def test_stop_still_succeeds_when_one_of_the_two_calls_fails_and_warns_if_something_runs():
    def h(m, p, b):
        if p == "/api/pp/stop":
            return 500, {"error": "Something went wrong inside the app."}
        if p == "/api/state":
            return 200, state(pp={"running": True}, teleop={"on": False})
        return 200, {}
    with Fake(h) as f:
        r = call(f.url, "so101_stop")
    t = words(r)
    assert r["isError"] is False and "leader-to-follower copying" in t and "pick & place stop did not go through" in t and "still reports something running" in t


def test_stop_is_not_stuck_behind_a_slow_movement():
    def h(m, p, b):
        if p == "/api/suite/motors":
            time.sleep(1.5)                                                             # a test movement takes seconds
            return 200, {"ok": True, "message": "Motor 2 (shoulder lift) moved 10 degrees and came back.", "peak_load_pct": 3}
        return 200, state(pp={"running": False}) if p == "/api/state" else {}
    with Fake(h) as f:
        resps, _ = session(f.url, [tool(1, "so101_wiggle_motor", role="follower", id=2), tool(2, "so101_stop")], allow_motion=True)
    assert [r["id"] for r in resps] == [2, 1] and not resps[0]["result"]["isError"] and not resps[1]["result"]["isError"]


def test_tool_calls_run_in_the_order_they_arrive():
    seen = []

    def h(m, p, b):
        seen.append(p)
        return 200, state(pp={"taught": 1, "status": "x"}) if p == "/api/state" else {}
    with Fake(h) as f:
        session(f.url, [tool(1, "so101_teach_point", u=1, v=1), tool(2, "so101_undo_point")])
    assert [p for p in seen if p.startswith("/api/pp/")] == ["/api/pp/teach", "/api/pp/undo"]


def test_a_cancelled_request_gets_no_answer():
    def h(m, p, b):
        time.sleep(1.0)
        return 200, {"ok": True, "message": "Motor 1 moved.", "peak_load_pct": 1}
    with Fake(h) as f:
        resps, _ = session(f.url, [tool(1, "so101_wiggle_motor", role="leader", id=1), {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}}, req(2, "ping")], allow_motion=True)
    assert [r["id"] for r in resps] == [2]


# ================================================================== motion tools (scripted app)
def test_wiggle_sends_the_right_request_and_reports_the_apps_words():
    def h(m, p, b):
        if p == "/api/suite/motors" and b.get("id") == 4:
            return 409, {"error": "A calibration is running: finish or cancel it first."}
        return 200, {"ok": True, "id": b["id"], "joint": "elbow_flex", "moved_deg": 9.7, "peak_load_pct": 4.2, "message": "Motor 3 (elbow flex) moved 10 degrees and came back. It works."}
    with Fake(h) as f:
        r = call(f.url, "so101_wiggle_motor", _motion=True, role="follower", id=3)
        assert r["isError"] is False and "elbow flex" in words(r) and "Peak load 4.2%" in words(r) and "torque state it started in" in words(r)
        assert f.posted("/api/suite/motors") == [{"action": "wiggle", "role": "follower", "id": 3}]
        r = call(f.url, "so101_wiggle_motor", _motion=True, role="follower", id=4)
        assert r["isError"] is True and words(r) == "A calibration is running: finish or cancel it first."


def calib_app(arm=None, pp=None, teleop=None):
    st = {"calib": {"step": "idle"}, "role": "follower", "online": True, "calibrated": False, "joints": [], **(arm or {})}

    def h(m, p, b):
        if p == "/api/state":
            return 200, state(pp=pp or {"running": False, "limp": True}, teleop=teleop, arms=[st, {"role": "leader", "remote": True, "online": True, "joints": []}])
        if m == "POST" and p.startswith("/api/calib/0/"):
            act = p.rsplit("/", 1)[1]
            if act == "start":
                st["calib"] = {"step": "center"}
            elif act == "center":
                st["calib"] = {"step": "sweep", "ranges": {"shoulder_pan": [2000, 2100]}}
            elif act == "finish":
                st["calib"] = {"step": "sweep", "error": "Move these joints through their full range: shoulder_pan"} if st["calib"].get("ranges") else st["calib"]
            elif act == "cancel":
                st["calib"] = {"step": "idle"}
            return 200, {}
        return 404, {"error": "no"}
    return h, st


def test_calibration_start_is_refused_while_the_follower_is_stiff_and_never_posts(tmp_path=None):
    """The owner's standing rule (docs/LEARNINGS.md 17): nobody touches a stiff arm, and starting switches the torque off at once (a raised arm drops)."""
    for pp in ({"running": False, "limp": False}, {"running": False}):                  # stiff, and "the app did not say" (limp missing is never treated as limp)
        h, st = calib_app(pp=pp)
        with Fake(h) as f:
            r = call(f.url, "so101_calibration", _motion=True, arm_index=0, action="start")
            assert r["isError"] and "STIFF" in words(r) and "so101_rest_arm" in words(r) and "hands off" in words(r) and "LIMP" in words(r) and "drops a raised arm" in words(r)
            assert "human_holding_arm" not in words(r) and "hold" not in words(r).replace("holding itself", "")
            assert [c for c in f.calls if c[0] == "POST"] == [] and st["calib"]["step"] == "idle"


def test_calibration_start_without_the_arm_engine_cannot_tell_so_it_refuses():
    h, st = calib_app()
    base_h = h
    h2 = lambda m, p, b: (200, state(pp=None, arms=[st])) if p == "/api/state" else base_h(m, p, b)
    with Fake(h2) as f:
        r = call(f.url, "so101_calibration", _motion=True, arm_index=0, action="start")
        assert r["isError"] and "does not report whether the follower is limp" in words(r) and "Do not ask anyone to touch it" in words(r)
        assert [c for c in f.calls if c[0] == "POST"] == []


def test_the_old_human_holding_arm_argument_no_longer_exists():
    h, st = calib_app()
    with Fake(h) as f:
        r = call(f.url, "so101_calibration", _motion=True, arm_index=0, action="start", human_holding_arm=True)
        assert r["isError"] and "Unknown argument: human_holding_arm" in words(r) and [c for c in f.calls if c[0] == "POST"] == []
        schema = {t["name"]: t for t in rpc(f.url, "tools/list", allow_motion=True)["result"]["tools"]}["so101_calibration"]["inputSchema"]
        assert set(schema["properties"]) == {"arm_index", "action"}


def test_calibration_walks_start_center_finish_and_reports_a_failed_finish():
    h, st = calib_app()
    with Fake(h) as f:
        r = call(f.url, "so101_calibration", _motion=True, arm_index=0, action="start")
        assert r["isError"] is False and "LIMP" in words(r) and "already limp" in words(r) and "hold" not in words(r) and st["calib"]["step"] == "center"
        assert call(f.url, "so101_calibration", _motion=True, arm_index=0, action="start")["isError"]      # already running
        r = call(f.url, "so101_calibration", _motion=True, arm_index=0, action="center")
        assert r["isError"] is False and "EVERY joint" in words(r) and st["calib"]["step"] == "sweep"
        r = call(f.url, "so101_calibration", _motion=True, arm_index=0, action="finish")
        assert r["isError"] and "not saved" in words(r) and "shoulder_pan" in words(r)
        r = call(f.url, "so101_calibration", _motion=True, arm_index=0, action="cancel")
        assert r["isError"] is False and "cancelled" in words(r) and "Restore default" in words(r) and st["calib"]["step"] == "idle"


def test_calibration_steps_out_of_order_and_bad_arms_are_refused_without_posting():
    h, st = calib_app()
    with Fake(h) as f:
        for action in ("center", "finish"):
            r = call(f.url, "so101_calibration", _motion=True, arm_index=0, action=action)
            assert r["isError"] and "calibration step is 'idle'" in words(r)
        for idx in (1, 5):                                                              # 1 is a mirrored (remote) arm, 5 does not exist
            r = call(f.url, "so101_calibration", _motion=True, arm_index=idx, action="start")
            assert r["isError"] and "no arm with arm_index" in words(r)
        assert [c for c in f.calls if c[0] == "POST"] == []


@pytest.mark.parametrize("arm,pp,teleop,expect", [({"online": False}, None, None, "offline"), ({}, {"running": True}, None, "Pick & place is running"),
                                                  ({}, None, {"on": True}, "driving the follower"), ({"wiggling": True}, None, None, "test movement")])
def test_calibration_will_not_start_while_the_arm_is_busy_or_offline(arm, pp, teleop, expect):
    h, st = calib_app(arm, pp, teleop)
    with Fake(h) as f:
        r = call(f.url, "so101_calibration", _motion=True, arm_index=0, action="start")
        assert r["isError"] and expect in words(r) and [c for c in f.calls if c[0] == "POST"] == []


# ================================================================== the standing rule: lower the arm, THEN let go (so101_rest_arm)
def rest_app(limp=False, refuse=None, running=False, teleop_on=False, pp=True, lowering_polls=2):
    """A scripted app for so101_rest_arm. POST /api/pp/rest starts a 'job' that lowers for `lowering_polls` state reads, then lets go (limp), or refuses with the real sentence."""
    st = {"limp": limp, "status": "idle", "running": running, "left": 0, "polls": 0}

    def h(m, p, b):
        if (m, p) == ("GET", "/api/state"):
            if st["left"] > 0:
                st["left"] -= 1
                if st["left"] == 0:
                    st["limp"], st["running"], st["status"] = True, False, "✓ the arm is limp (it was lowered first). Nothing is holding it now"
            return 200, state(pp={"limp": st["limp"], "running": st["running"], "status": st["status"], "taught": 0} if pp else None, teleop={"on": teleop_on})
        if (m, p) == ("POST", "/api/pp/rest"):
            if refuse:
                st["status"] = f"error: {refuse} (the arm is still STIFF: it was not released)"      # what the real app does: HTTP 200 {} and the sentence in pp.status
            else:
                st["running"], st["status"], st["left"] = True, "lowering the arm before letting it go limp", lowering_polls
            return 200, {}
        return 404, {"error": "no"}
    return h, st


def test_rest_arm_lowers_then_waits_until_the_app_says_limp(monkeypatch):
    monkeypatch.setattr(mcp, "REST_POLL", 0.02)
    h, st = rest_app()
    with Fake(h) as f:
        r = call(f.url, "so101_rest_arm", _motion=True)
        t = words(r)
        assert r["isError"] is False and "LIMP now" in t and "lowered it first" in t and "hands off" in t.lower()
        assert f.posted("/api/pp/rest") == [{}] and st["limp"] is True
        assert [c for c in f.calls if c[0] == "POST" and c[1] != "/api/pp/rest"] == []            # nothing else was posted: no bare release, no calibration
        assert f.calls.index(("POST", "/api/pp/rest", {})) > 0 and f.calls[0][:2] == ("GET", "/api/state")      # it read the real state first


def test_rest_arm_when_already_limp_does_nothing():
    h, st = rest_app(limp=True)
    with Fake(h) as f:
        r = call(f.url, "so101_rest_arm", _motion=True)
        assert r["isError"] is False and "already limp" in words(r) and f.posted("/api/pp/rest") == []


@pytest.mark.parametrize("sentence", ["follower arm not online/calibrated", "that spot is out of the arm's reach"])
def test_rest_arm_refusal_says_the_arm_is_still_stiff_and_never_advises_holding_it(monkeypatch, sentence):
    monkeypatch.setattr(mcp, "REST_POLL", 0.02)
    h, st = rest_app(refuse=sentence)
    with Fake(h) as f:
        t0 = time.time()
        r = call(f.url, "so101_rest_arm", _motion=True)
        t = words(r)
        assert r["isError"] is True and sentence[0].upper() + sentence[1:] in t and "still STIFF" in t and "nobody may touch it" in t and "Help" in t and "cutting its power" in t
        assert "hold it" not in t.replace("never by cutting", "") and time.time() - t0 < 10
        assert st["limp"] is False


@pytest.mark.parametrize("kw,expect", [({"running": True}, "Pick & place is running"), ({"teleop_on": True}, "driving the follower"), ({"pp": False}, "arm engine")])
def test_rest_arm_is_refused_while_busy_or_without_the_engine_and_posts_nothing(kw, expect):
    h, st = rest_app(**kw)
    with Fake(h) as f:
        r = call(f.url, "so101_rest_arm", _motion=True)
        assert r["isError"] and expect in words(r) and f.posted("/api/pp/rest") == []


def test_rest_arm_gives_up_with_the_arm_still_stiff_when_it_never_goes_limp(monkeypatch):
    monkeypatch.setattr(mcp, "REST_POLL", 0.02)
    monkeypatch.setattr(mcp, "REST_TIMEOUT", 0.3)
    h, st = rest_app(lowering_polls=10 ** 6)                                                   # lowers forever
    with Fake(h) as f:
        r = call(f.url, "so101_rest_arm", _motion=True)
        assert r["isError"] and "not made limp" in words(r) and "still STIFF" in words(r)


def test_status_says_stiff_or_limp_in_words_and_points_at_rest_arm():
    with Fake(lambda m, p, b: (200, state(pp={"limp": False, "running": False, "status": "idle", "taught": 0}))) as f:
        t = words(call(f.url, "so101_status"))
        assert "STIFF" in t and "Nobody may touch it" in t and "so101_rest_arm" in t and "Release arm" in t
    with Fake(lambda m, p, b: (200, state(pp={"limp": True, "running": False, "status": "idle", "taught": 0}))) as f:
        assert "the follower is LIMP" in words(call(f.url, "so101_status"))


def test_nothing_in_the_tool_text_tells_anyone_to_hold_a_stiff_arm(base):
    listing = rpc(base, "tools/list", allow_motion=True)["result"]["tools"]
    init = rpc(base, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})["result"]["instructions"]
    blob = " ".join([init] + [t["description"] + " " + json.dumps(t["inputSchema"]) for t in listing]).lower()
    for bad in ("hold the arm", "hold the follower", "holding the arm", "holding it", "human_holding_arm", "one hand"):
        assert bad not in blob, bad
    assert "standing rule" in init.lower() and "so101_rest_arm" in init


# ================================================================== end to end on the demo (keep these last: they calibrate the demo's follower)
def test_calibrate_through_mcp_then_teach_undo_and_wiggle_on_the_demo(base, srv):
    idx = srv.idx("follower")
    assert srv.get("/api/state").json["pp"]["limp"] is True                             # a never-powered demo arm is limp: the app SAYS so, and that is what the tool checks
    r = call(base, "so101_calibration", _motion=True, arm_index=idx, action="start")
    assert r["isError"] is False and srv.arm("follower").calib["step"] == "center" and srv.arm("follower").torque_on is False
    assert "CALIBRATION RUNNING (step 'center'" in words(call(base, "so101_status"))
    assert call(base, "so101_calibration", _motion=True, arm_index=idx, action="center")["isError"] is False
    time.sleep(5.2)                                                                     # the simulated hand moves every joint through its range, one after another
    assert "every joint has moved enough" in words(call(base, "so101_status"))
    r = call(base, "so101_calibration", _motion=True, arm_index=idx, action="finish")
    assert r["isError"] is False and "Calibration saved" in words(r)
    srv.wait(lambda: srv.arm("follower").calib["step"] == "done", what="the follower calibration to finish")
    assert "follower arm: online, calibrated" in words(call(base, "so101_status"))
    assert "[ok] Follower calibrated" in words(call(base, "so101_checklist"))
    first = call(base, "so101_teach_point", u=320, v=240)                               # the first point can never be refused for "has not moved"
    assert first["isError"] is False and "Point 1 recorded" in words(first)
    assert srv.get("/api/state").json["pp"]["taught"] == 1
    assert "0 points left" in words(call(base, "so101_undo_point"))
    assert srv.get("/api/state").json["pp"]["taught"] == 0
    w = call(base, "so101_wiggle_motor", _motion=True, role="follower", id=2)
    assert w["isError"] is False and "shoulder lift" in words(w) and "Peak load" in words(w)
    assert call(base, "so101_stop")["isError"] is False
    # the standing rule on the real demo server: a stiff follower is refused for calibration, lowered with so101_rest_arm, then it is limp and calibration may start
    srv.arm("follower").arm_motion(True)
    srv.wait(lambda: srv.get("/api/state").json["pp"]["limp"] is False, what="the app state to show the stiff follower")        # a state built up to 120 ms ago may still be served
    assert "STIFF" in words(call(base, "so101_status"))
    r = call(base, "so101_calibration", _motion=True, arm_index=idx, action="start")
    assert r["isError"] and "STIFF" in words(r) and srv.arm("follower").calib["step"] == "done" and srv.arm("follower").torque_on is True      # refused, nothing switched off
    r = call(base, "so101_rest_arm", _motion=True)
    assert r["isError"] is False and "LIMP now" in words(r), words(r)
    assert srv.get("/api/state").json["pp"]["limp"] is True and srv.arm("follower").torque_on is False
    assert "the follower is LIMP" in words(call(base, "so101_status"))
