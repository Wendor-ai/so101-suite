import json
import logging
import os
import pathlib

import pytest

from so101 import demo, registers, trace


@pytest.fixture(autouse=True)
def fresh_trace():
    trace.reset()
    yield
    trace.reset()


@pytest.fixture()
def bus():
    demo.install()
    import scservo_sdk as sdk
    ph = sdk.PortHandler(demo.FOLLOWER)
    assert ph.openPort()
    pk = trace.wrap_packet_handler(sdk.PacketHandler(0), demo.FOLLOWER)
    yield ph, pk
    demo.uninstall()


def test_off_by_default_and_zero_entries(bus):
    ph, pk = bus
    assert trace.enabled is False and trace.raw is False
    pk.ping(ph, 1)
    pk.read2ByteTxRx(ph, 1, 56)
    trace.log("info", "x", "hello")
    trace.record("bus", op="x")
    snap = trace.snapshot()
    assert snap["items"] == [] and snap["seq"] == 0 and snap["dropped"] == 0 and snap["enabled"] is False


def test_wrapper_delegates_everything_when_off_or_on(bus):
    ph, pk = bus
    assert pk.read2ByteTxRx(ph, 2, 56)[1] == 0 and pk.ping(ph, 2)[0] == 777
    assert pk.getTxRxResult(0)
    trace.set_enabled(True)
    assert pk.read2ByteTxRx(ph, 2, 56)[1] == 0 and pk.write1ByteTxRx(ph, 2, 41, 20) == (0, 0)


def test_enabling_records_decoded_bus_operations(bus):
    ph, pk = bus
    trace.set_enabled(True)
    _, r, _ = pk.read2ByteTxRx(ph, 3, 56)
    pk.write1ByteTxRx(ph, 3, 40, 1)
    pk.ping(ph, 3)
    pk.ping(ph, 99)                                           # nobody there
    items = trace.snapshot()["items"]
    assert [i["op"] for i in items] == ["read2", "write1", "ping", "ping"]
    rd, wr, ok_ping, bad_ping = items
    assert rd["kind"] == "bus" and rd["port"] == demo.FOLLOWER and rd["id"] == 3 and rd["addr"] == 56 and rd["reg"] == "Present_Position" and rd["ok"] is True
    assert 1500 < rd["value"] < 2600 and rd["ms"] >= 0 and isinstance(rd["t"], float) and rd["seq"] == 1
    assert wr["reg"] == "Torque_Enable" and wr["value"] == 1 and wr["ok"] is True
    assert ok_ping["value"] == 777 and ok_ping["ok"] is True
    assert bad_ping["ok"] is False and "no answer" in bad_ping["err"] and bad_ping["id"] == 99
    assert [i["seq"] for i in items] == [1, 2, 3, 4]


def test_exceptions_on_the_bus_are_recorded_and_still_raised(bus):
    ph, pk = bus
    demo.set_port_present(demo.FOLLOWER, False)
    trace.set_enabled(True)
    with pytest.raises(OSError):
        pk.read2ByteTxRx(ph, 1, 56)
    it = trace.snapshot()["items"][0]
    assert it["ok"] is False and "OSError" in it["err"]


def test_since_paging_and_kinds_and_limit():
    trace.set_enabled(True)
    for i in range(10):
        trace.record("bus", op="read1", id=i)
    trace.log("info", "arm", "hi")
    trace.record("http", method="GET", path="/api/x", status=200, size=1)
    first = trace.snapshot(limit=4)
    assert [i["seq"] for i in first["items"]] == [9, 10, 11, 12][-4:] or len(first["items"]) == 4     # no `since`: the newest 4
    assert [i["seq"] for i in first["items"]] == [9, 10, 11, 12]
    nxt = trace.snapshot(since=first["items"][-1]["seq"])
    assert nxt["items"] == [] and nxt["seq"] == 12
    trace.record("bus", op="read1", id=99)
    assert [i["seq"] for i in trace.snapshot(since=12)["items"]] == [13]
    assert [i["seq"] for i in trace.snapshot(since=2, limit=3)["items"]] == [3, 4, 5]                 # paging forward never skips
    assert {i["kind"] for i in trace.snapshot(kinds=["log", "http"])["items"]} == {"log", "http"}
    assert trace.snapshot(kinds=["raw"])["items"] == []


def test_ring_drops_oldest_and_counts_dropped():
    trace.set_max(100)
    trace.set_enabled(True)
    for i in range(130):
        trace.record("bus", op="write1", id=1, value=i)                                           # events (writes, failures, logs) live in the main ring
    s = trace.snapshot(limit=1000)
    assert len(s["items"]) == 100 and s["dropped"] == 30 and s["seq"] == 130
    assert s["items"][0]["seq"] == 31 and s["items"][-1]["seq"] == 130                             # oldest gone, newest last
    trace.clear()
    s = trace.snapshot()
    assert s["items"] == [] and s["dropped"] == 0 and s["seq"] == 130                               # seq keeps increasing after a clear


def test_default_ring_size_is_5000():
    trace.set_enabled(True)
    for i in range(5100):
        trace.record("bus", op="write1")
    s = trace.snapshot(limit=10000)
    assert len(s["items"]) == 5000 and s["dropped"] == 100


def test_healthy_polls_never_push_out_events():
    """A 10 Hz poll writes ~250 entries a second: it must not flush the one error you are trying to catch."""
    trace.set_max(100)
    trace.set_enabled(True)
    trace.record("bus", op="read2", id=4, ok=False, err="no answer (timeout)")                    # the thing worth keeping
    trace.log("warn", "arm", "follower: motor 4 stopped answering")
    for i in range(1000):
        trace.record("bus", op="read2", id=1, addr=56, value=i)                                   # healthy routine polls
    s = trace.snapshot(limit=5000)
    kept = [i for i in s["items"] if i["ok"] is False or i["kind"] == "log"]
    assert len(kept) == 2                                                                         # both events survived the flood
    assert sum(1 for i in s["items"] if i["ok"] and i["kind"] == "bus") == 200                    # routine polls get twice the room, oldest dropped first
    assert [i["seq"] for i in s["items"]] == sorted(i["seq"] for i in s["items"])                 # merged back in order
    assert s["dropped"] == 800


def test_raw_bytes_only_when_raw_is_on(bus):
    ph, pk = bus
    trace.set_enabled(True)
    pk.read2ByteTxRx(ph, 1, 56)
    assert [i["kind"] for i in trace.snapshot()["items"]] == ["bus"]
    trace.set_raw(True)
    pk.read2ByteTxRx(ph, 1, 56)
    raws = [i for i in trace.snapshot()["items"] if i["kind"] == "raw"]
    assert [r["dir"] for r in raws] == ["tx", "rx"] and raws[0]["hex"].startswith("ff ff 01 04 02 38 02") and raws[1]["hex"].startswith("ff ff 01 04 00")
    trace.set_enabled(False)
    n = trace.snapshot()["seq"]
    pk.read2ByteTxRx(ph, 1, 56)
    assert trace.snapshot()["seq"] == n                                                               # off again: nothing recorded


def test_port_handler_wrapper_records_raw_only_when_on():
    class FakePort:
        def __init__(self): self.sent = []
        def writePort(self, packet): self.sent.append(packet); return len(packet)
        def readPort(self, n): return bytes([0xFF, 0xFF, 1, 2, 0, 0xFC])[:n]
    p = trace.wrap_port_handler(FakePort(), "/dev/ttyACM0")
    trace.set_enabled(True)
    p.writePort([0xFF, 0xFF, 1, 2, 1, 0xFB]); p.readPort(6)
    assert trace.snapshot()["items"] == []                                                            # raw is off
    trace.set_raw(True)
    p.writePort([0xFF, 0xFF, 1, 2, 1, 0xFB]); p.readPort(6)
    got = trace.snapshot()["items"]
    assert [(i["dir"], i["hex"]) for i in got] == [("tx", "ff ff 01 02 01 fb"), ("rx", "ff ff 01 02 00 fc")]
    assert trace.wrap_port_handler(object(), "x") is not None                                         # ports without read/write are left alone


def test_export_formats():
    trace.set_enabled(True)
    trace.record("bus", port="p", op="read2", id=1, addr=56, reg="Present_Position", value=2048, ms=1.5)
    trace.record("http", method="GET", path="/api/state", status=200, size=10, ms=2.0)
    trace.log("warn", "arm", "follower arm offline")
    j = json.loads(trace.export("json"))
    assert j["seq"] == 3 and len(j["items"]) == 3 and j["enabled"] is True
    nd = [json.loads(line) for line in trace.export("ndjson").strip().splitlines()]
    assert [i["kind"] for i in nd] == ["bus", "http", "log"]
    txt = trace.export("text")
    assert len(txt.strip().splitlines()) == 3 and "Present_Position" in txt and "GET /api/state -> 200" in txt and "follower arm offline" in txt
    assert trace.export("nonsense").startswith("{")                                                     # unknown format falls back to json
    assert set(trace.CONTENT_TYPES) == {"json", "ndjson", "text"}


def test_no_entry_contains_the_home_directory():
    trace.set_enabled(True)
    home = os.path.expanduser("~")
    trace.log("info", "arm", f"saved calibration to {home}/.cache/x.json")
    trace.record("http", method="GET", path=f"{home}/leak", status=404, size=0)
    for fmt in ("json", "ndjson", "text"):
        assert home not in trace.export(fmt)
    assert "~/.cache/x.json" in trace.export("text")


def test_http_recording_skips_static_files_streams_and_its_own_polling():
    trace.set_enabled(True)
    for p in ("/suite/js/main.js", "/vendor/three.min.js", "/assets/so101/x.stl", "/stream/0.mjpg", "/raw.mjpg", "/api/suite/trace?since=3", "/", "/dashboard"):
        trace.record_http("GET", p, 200, 5, None)
    assert trace.snapshot()["items"] == []
    trace.record_http("GET", "/api/state?x=1", 200, 5, None)
    trace.record_http("POST", "/api/suite/motors", 409, 50, None)
    got = trace.snapshot()["items"]
    assert [(i["path"], i["status"], i["ok"]) for i in got] == [("/api/state", 200, True), ("/api/suite/motors", 409, False)]


def test_python_logging_feeds_the_buffer():
    trace.install_logging()
    trace.install_logging()                                                                              # idempotent
    trace.set_enabled(True)
    logging.getLogger("so101.test").info("a friendly line")
    logging.getLogger("thirdparty").error("broke")
    got = [(i["level"], i["source"], i["msg"]) for i in trace.snapshot()["items"] if i["kind"] == "log"]
    assert ("info", "so101.test", "a friendly line") in got and ("error", "thirdparty", "broke") in got
    root = logging.getLogger()
    assert sum(isinstance(h, trace.BufferHandler) for h in root.handlers) == 1


def test_register_map():
    d = registers.describe(56)
    assert d["name"] == "Present_Position" and d["size"] == 2 and d["desc"]
    for addr, name in {5: "ID", 6: "Baud_Rate", 9: "Min_Position_Limit", 11: "Max_Position_Limit", 31: "Homing_Offset", 33: "Operating_Mode", 40: "Torque_Enable", 41: "Acceleration",
                       42: "Goal_Position", 46: "Goal_Speed", 48: "Torque_Limit", 55: "Lock", 60: "Present_Load", 62: "Present_Voltage", 63: "Present_Temperature", 65: "Status"}.items():
        assert registers.name_of(addr) == name and registers.REGISTERS[addr]["size"] in (1, 2)
    assert registers.name_of(200) == "reg200" and registers.describe(200) is None


# ------------------------------------------------------------------ over HTTP, on the live demo server
def test_api_records_a_demo_poll_and_http_calls(srv):
    r = srv.get("/api/suite/trace").json
    assert r["enabled"] is False and r["raw"] is False and r["items"] == [] and r["max"] == 5000
    assert srv.get("/api/suite/info").json["trace"] == {"enabled": False, "raw": False}
    r = srv.post("/api/suite/trace", {"enabled": True})
    assert r.json["enabled"] is True and srv.get("/api/suite/info").json["trace"]["enabled"] is True
    srv.get("/api/suite/ports")
    srv.post("/api/suite/motors", {"action": "ping", "role": "follower", "id": 2})
    srv.wait(lambda: any(i["kind"] == "bus" for i in srv.get("/api/suite/trace").json["items"]), what="the 10 Hz arm poll to be recorded")
    snap = srv.get("/api/suite/trace?limit=2000").json
    kinds = {i["kind"] for i in snap["items"]}
    assert {"bus", "http"} <= kinds
    http_items = [i for i in snap["items"] if i["kind"] == "http"]
    assert any(i["path"] == "/api/suite/ports" and i["status"] == 200 for i in http_items)
    assert not any(i["path"].startswith("/api/suite/trace") for i in http_items)                  # the inspector does not record itself
    assert any(i["kind"] == "bus" and i["reg"] == "Present_Position" and i["port"] in (demo.FOLLOWER, demo.LEADER) for i in snap["items"])
    last = snap["seq"]
    time.sleep(0.4)
    newer = srv.get(f"/api/suite/trace?since={last}").json
    assert newer["items"] and all(i["seq"] > last for i in newer["items"])
    only = srv.get("/api/suite/trace?kinds=http&limit=50").json
    assert only["items"] and {i["kind"] for i in only["items"]} == {"http"}
    assert not any(i["kind"] == "raw" for i in snap["items"])                                      # raw is off
    srv.post("/api/suite/trace", {"raw": True})
    srv.wait(lambda: any(i["kind"] == "raw" for i in srv.get("/api/suite/trace?kinds=raw").json["items"]), what="raw bytes")
    srv.post("/api/suite/trace", {"raw": False, "clear": True})
    cleared = srv.get("/api/suite/trace?kinds=raw,http").json
    assert cleared["dropped"] == 0
    srv.post("/api/suite/trace", {"max": 100})
    assert srv.get("/api/suite/trace").json["max"] == 100
    assert srv.post("/api/suite/trace", {"max": "lots"}).status == 400
    srv.post("/api/suite/trace", {"max": 5000})
    for fmt, ctype in (("json", "application/json"), ("ndjson", "application/x-ndjson"), ("text", "text/plain")):
        e = srv.get(f"/api/suite/trace/export?format={fmt}")
        assert e.status == 200 and e.ctype == ctype and "so101-trace" in e.headers["Content-Disposition"]
        assert str(pathlib.Path.home()) not in e.text
    assert srv.get("/api/suite/trace/export?format=xml").status == 400
    srv.post("/api/suite/trace", {"enabled": False})
    n = srv.get("/api/suite/trace").json["seq"]
    srv.get("/api/suite/ports")
    time.sleep(0.3)
    assert srv.get("/api/suite/trace").json["seq"] == n                                              # off: costs and records nothing


def test_log_lines_from_the_server(srv):
    srv.post("/api/suite/trace", {"enabled": True, "clear": True})
    demo.set_port_present(demo.LEADER, False)
    srv.wait(lambda: any("offline" in i.get("msg", "") for i in srv.get("/api/suite/trace?kinds=log").json["items"]), what="an 'arm offline' log line")
    demo.set_port_present(demo.LEADER, True)
    srv.wait(lambda: any("connected" in i.get("msg", "") for i in srv.get("/api/suite/trace?kinds=log").json["items"]), what="an 'arm connected' log line")
    srv.post("/api/suite/trace", {"enabled": False})


import time  # noqa: E402


def test_settings_start_recording_at_launch(isolated_home, monkeypatch):
    """adv.trace / adv.traceRaw / adv.traceMax from the store apply when the app starts."""
    from helpers import start_demo_server, stop_demo_server
    s = start_demo_server(config={"adv": {"trace": True, "traceRaw": True, "traceMax": 200}})
    try:
        t = s.get("/api/suite/trace").json
        assert t["enabled"] is True and t["raw"] is True and t["max"] == 200
        s.wait(lambda: s.get("/api/suite/trace?kinds=raw").json["items"], what="raw entries from the first poll")
    finally:
        stop_demo_server(s)
