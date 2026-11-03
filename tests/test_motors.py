"""Roles, identify-by-unplugging, motor IDs, ping and wiggle, on the demo bus."""
import time
import types

import pytest

from so101 import demo, suite_api, trace

F, L = demo.FOLLOWER, demo.LEADER


def read(arm, mid, addr, n=1):
    with arm.lock:
        return (arm.pk.read1ByteTxRx if n == 1 else arm.pk.read2ByteTxRx)(arm.ph, mid, addr)[0]


def restore_bus(srv):
    """Put both demo adapters back to six motors and wait until the arms are back."""
    for port in (F, L):
        demo.set_port_present(port, True)
        demo.connect(port, range(1, 7))
        for m in demo._bus.ports[port].motors.values():
            m._w(demo.R_BAUD, 1, 0)
    for a in srv.arms.values():
        a.online = False
    srv.wait_arms()


@pytest.fixture(autouse=True)
def clean(srv):
    yield
    srv.server.TELE.on = False
    srv.server.PP.running = False
    for a in srv.arms.values():
        if a.calib["step"] != "idle":
            a.calib_cancel()
    suite_api.ctx.identify = {"state": "idle", "message": "", "port": None}
    suite_api.ctx.identify_timeout = suite_api.IDENTIFY_TIMEOUT
    restore_bus(srv)
    srv.post("/api/suite/role", {"port": F, "role": "follower"})


# ------------------------------------------------------------------ identify and roles
def test_identify_flow_assigns_role(srv):
    assert srv.post("/api/suite/identify", {"action": "start"}).status == 400                  # needs a role
    r = srv.post("/api/suite/identify", {"action": "start", "role": "leader"}).json
    assert r["state"] == "unplug" and "Unplug" in r["message"]
    assert srv.get("/api/suite/identify").json["state"] == "unplug"                           # nothing happened yet
    srv.post("/api/demo/usb", {"port": L, "plugged": False})
    r = srv.get("/api/suite/identify").json
    assert r["state"] == "replug" and "plug the same USB cable back" in r["message"]
    srv.post("/api/demo/usb", {"port": L, "plugged": True})
    r = srv.get("/api/suite/identify").json
    assert r["state"] == "done" and r["port"] == L and "leader" in r["message"]
    assert srv.arm("leader").path == L and srv.arm("follower").path == F


def test_identify_can_swap_the_roles(srv):
    srv.post("/api/suite/identify", {"action": "start", "role": "follower"})
    srv.post("/api/demo/usb", {"port": L, "plugged": False})
    srv.wait(lambda: srv.get("/api/suite/identify").json["state"] == "replug", what="the identify to notice the unplug")
    srv.post("/api/demo/usb", {"port": L, "plugged": True})
    assert srv.get("/api/suite/identify").json["state"] == "done"
    assert srv.arms[L].role == "follower" and srv.arms[F].role == "leader"                      # the other adapter took the other role: never two of a kind
    ports = {p["path"]: p["role"] for p in srv.get("/api/suite/ports").json["ports"]}
    assert ports == {F: "leader", L: "follower"}
    assert srv.server.role_for(L) == "follower"                                                # and it is saved by the adapter's identity


def test_identify_cancel_timeout_and_errors(srv):
    srv.post("/api/suite/identify", {"action": "start", "role": "follower"})
    assert srv.post("/api/suite/identify", {"action": "cancel"}).json["state"] == "idle"
    suite_api.ctx.identify_timeout = 0.2
    srv.post("/api/suite/identify", {"action": "start", "role": "follower"})
    time.sleep(0.4)
    r = srv.get("/api/suite/identify").json
    assert r["state"] == "error" and "too long" in r["message"]
    for port in (F, L):
        demo.set_port_present(port, False)
    r = srv.post("/api/suite/identify", {"action": "start", "role": "follower"}).json
    assert r["state"] == "error" and "No USB adapter" in r["message"]
    assert srv.post("/api/suite/identify", {"action": "dance"}).status == 400


def test_two_adapters_vanishing_asks_to_unplug_just_one(srv):
    srv.post("/api/suite/identify", {"action": "start", "role": "leader"})
    demo.set_port_present(F, False)
    demo.set_port_present(L, False)
    r = srv.get("/api/suite/identify").json
    assert r["state"] == "unplug" and "Two adapters" in r["message"]


def test_role_endpoint(srv):
    assert srv.post("/api/suite/role", {"port": L, "role": "boss"}).status == 400
    assert srv.post("/api/suite/role", {"port": "demo://nope", "role": "leader"}).status == 404
    r = srv.post("/api/suite/role", {"port": L, "role": "follower"})
    assert r.status == 200 and {p["path"]: p["role"] for p in r.json["ports"]} == {F: "leader", L: "follower"}
    assert srv.arms[L].role == "follower"
    srv.server.TELE.on = True
    assert srv.post("/api/suite/role", {"port": L, "role": "leader"}).status == 409


# ------------------------------------------------------------------ ping
def test_ping_ok_and_missing_id(srv):
    r = srv.post("/api/suite/motors", {"action": "ping", "role": "follower", "id": 3}).json
    assert r["ok"] is True and r["id"] == 3 and r["joint"] == "elbow_flex" and 1500 < r["position"] < 2600 and r["volt"] == 7.4 and r["ms"] >= 0 and 25 < r["temp_c"] < 50
    demo.connect(F, [1, 2, 3, 4, 6])
    r = srv.post("/api/suite/motors", {"port": F, "action": "ping", "id": 5})
    assert r.status == 200 and r.json["ok"] is False and "did not answer" in r.json["message"] and r.json["position"] is None
    assert srv.post("/api/suite/motors", {"role": "follower", "action": "ping", "id": 9}).status == 409
    assert srv.post("/api/suite/motors", {"role": "follower", "action": "ping"}).status == 400
    assert srv.post("/api/suite/motors", {"role": "follower", "action": "ping", "id": "x"}).status == 400
    assert srv.post("/api/suite/motors", {"role": "nobody", "action": "ping", "id": 1}).status == 404
    assert srv.post("/api/suite/motors", {"role": "follower", "action": "explode", "id": 1}).status == 400


def test_ping_never_writes(srv):
    trace.set_enabled(True)
    trace.clear()
    srv.post("/api/suite/motors", {"action": "ping", "role": "follower", "id": 2})
    ops = [i["op"] for i in trace.snapshot(limit=1000)["items"] if i["kind"] == "bus"]
    assert ops and not any(o.startswith("write") for o in ops)
    trace.reset()


# ------------------------------------------------------------------ wiggle
def test_wiggle_moves_a_joint_and_a_limp_motor_ends_limp(srv):
    arm = srv.arm("follower")
    assert read(arm, 3, 40) == 0 and arm.torque_on is False
    before = read(arm, 3, 56, 2)
    r = srv.post("/api/suite/motors", {"action": "wiggle", "role": "follower", "id": 3})
    assert r.status == 200, r.text
    d = r.json
    assert d["ok"] is True and d["id"] == 3 and d["joint"] == "elbow_flex" and 4 <= d["moved_deg"] <= 14 and "It works" in d["message"] and d["peak_load_pct"] >= 0
    assert read(arm, 3, 40) == 0                                                               # it started limp, it ends limp
    assert arm.torque_on is False and arm.wiggling is False                                    # bookkeeping untouched
    assert abs(read(arm, 3, 56, 2) - before) < 12                                              # and it came back
    assert read(arm, 1, 40) == 0 and read(arm, 2, 40) == 0                                     # no other motor was touched


def test_wiggle_while_holding_stays_holding(srv):
    arm = srv.arm("follower")
    arm.arm_motion(True)
    try:
        before = read(arm, 2, 56, 2)
        goal_before = read(arm, 2, 42, 2)
        r = srv.post("/api/suite/motors", {"action": "wiggle", "role": "follower", "id": 2}).json
        assert r["ok"] is True and 4 <= r["moved_deg"] <= 14
        assert read(arm, 2, 40) == 1 and arm.torque_on is True                                 # it started holding, it ends holding
        assert abs(read(arm, 2, 42, 2) - goal_before) < 6 and abs(read(arm, 2, 56, 2) - before) < 12
        assert read(arm, 2, 41) == 25 and read(arm, 2, 46, 2) == 900                           # acceleration and speed are back to what arm_motion set
    finally:
        arm.arm_motion(False)


def test_wiggle_gripper_is_smaller_and_gentle(srv):
    arm = srv.arm("follower")
    cap_before = read(arm, 6, 48, 2)
    r = srv.post("/api/suite/motors", {"action": "wiggle", "role": "follower", "id": 6}).json
    assert r["ok"] is True and 4 <= r["moved_deg"] <= 8.5                                        # 80 ticks, not 110
    assert read(arm, 6, 48, 2) == cap_before and read(arm, 6, 40) == 0


def test_wiggle_stays_inside_the_limit_registers(srv):
    arm = srv.arm("follower")
    pos = read(arm, 4, 56, 2)
    with arm.lock:
        arm.pk.write1ByteTxRx(arm.ph, 4, 55, 0)
        arm.pk.write2ByteTxRx(arm.ph, 4, 9, pos - 80)
        arm.pk.write2ByteTxRx(arm.ph, 4, 11, pos + 80)
        arm.pk.write1ByteTxRx(arm.ph, 4, 55, 1)
    seen = []
    import threading
    stop = threading.Event()
    def watch():
        while not stop.is_set():
            seen.append(read(arm, 4, 56, 2)); time.sleep(0.03)
    t = threading.Thread(target=watch); t.start()
    try:
        r = srv.post("/api/suite/motors", {"action": "wiggle", "role": "follower", "id": 4}).json
    finally:
        stop.set(); t.join()
    assert max(seen) <= pos + 80 and min(seen) >= pos - 80
    assert r["ok"] is True and 4 <= r["moved_deg"] <= 6.7                                       # 75 ticks, not the usual 110: clamped to the motor's own limits


def test_wiggle_of_a_missing_motor_is_refused_with_a_sentence(srv):
    demo.connect(F, [1, 2, 3, 4, 6])
    arm = srv.arm("follower")
    arm.online = False
    srv.wait(lambda: arm.online and 5 not in arm.ids, what="the arm to notice motor 5 is gone")
    r = srv.post("/api/suite/motors", {"action": "wiggle", "role": "follower", "id": 5})
    assert r.status == 409 and "not answering" in r.json["error"] and "cable" in r.json["error"]


def test_wiggle_refused_when_the_arm_is_offline(srv):
    demo.set_port_present(L, False)
    srv.wait(lambda: not srv.arm("leader").online, what="the leader to go offline")
    r = srv.post("/api/suite/motors", {"action": "wiggle", "role": "leader", "id": 1})
    assert r.status == 409 and "offline" in r.json["error"]
    assert srv.post("/api/suite/motors", {"action": "ping", "role": "leader", "id": 1}).status == 409


def test_wiggle_refused_during_calibration_teleop_job_and_another_wiggle(srv):
    body = {"action": "wiggle", "role": "follower", "id": 1}
    srv.post(f"/api/calib/{srv.idx('follower')}/start")
    assert srv.arm("follower").calib["step"] == "center"
    r = srv.post("/api/suite/motors", body)
    assert r.status == 409 and "calibration" in r.json["error"]
    assert srv.post("/api/suite/motors", {"action": "ping", "role": "follower", "id": 1}).status == 200   # reading is harmless
    srv.arm("follower").calib_cancel()
    srv.server.TELE.on = True
    r = srv.post("/api/suite/motors", body)
    assert r.status == 409 and "leader" in r.json["error"]
    srv.server.TELE.on = False
    srv.server.PP.running = True
    r = srv.post("/api/suite/motors", body)
    assert r.status == 409 and "Pick & place" in r.json["error"]
    srv.server.PP.running = False
    srv.arm("follower").wiggling = True
    r = srv.post("/api/suite/motors", body)
    assert r.status == 409 and "test movement" in r.json["error"]
    srv.arm("follower").wiggling = False
    assert read(srv.arm("follower"), 1, 40) == 0                                                # nothing moved in any of those


def test_wiggle_stops_when_a_motor_pushes_hard(srv, monkeypatch):
    arm = srv.arm("follower")
    real = type(arm.pk).read2ByteTxRx

    def hot(self, port, mid, addr):
        v, r, e = real(self, port, mid, addr)
        return (900, r, e) if (addr == 60 and mid == 3) else (v, r, e)                        # the motor reports 90% load
    monkeypatch.setattr(type(arm.pk), "read2ByteTxRx", hot)
    r = srv.post("/api/suite/motors", {"action": "wiggle", "role": "follower", "id": 3}).json
    assert r["ok"] is False and "pushing" in r["message"] and r["peak_load_pct"] >= 70
    monkeypatch.undo()
    assert read(arm, 3, 40) == 0                                                                # and it was left limp, as it started


# ------------------------------------------------------------------ scan and set id
def test_scan_lists_the_motors_and_never_writes(srv):
    trace.set_enabled(True)
    trace.clear()
    r = srv.post("/api/suite/motors", {"action": "scan", "role": "follower"}).json
    assert r["ok"] and r["ids"] == [1, 2, 3, 4, 5, 6] and r["baud"] == 1000000 and "6 motors" in r["message"]
    items = [i for i in trace.snapshot(limit=5000)["items"] if i["kind"] == "bus"]
    assert items and not any(i["op"].startswith("write") for i in items)                      # a scan only asks
    trace.reset()
    assert srv.arm("follower").ph.baudrate == 1000000                                          # and the bus speed is restored
    demo.connect(F, [])
    r = srv.post("/api/suite/motors", {"action": "scan", "role": "follower"}).json
    assert r["ids"] == [] and r["baud"] is None and "No motor answered" in r["message"]


def test_scan_finds_a_motor_at_another_baud_rate(srv):
    demo.connect(F, [1])
    demo._bus.ports[F].motors[1]._w(demo.R_BAUD, 1, 3)                                         # 128000
    r = srv.post("/api/suite/motors", {"action": "scan", "port": F}).json
    assert r["ids"] == [1] and r["baud"] == 128000


def test_set_id_refused_with_six_motors(srv):
    r = srv.post("/api/suite/motors", {"action": "set_id", "role": "follower", "id": 6})
    assert r.status == 409 and "6 motors answer" in r.json["error"] and "only the one" in r.json["error"]
    assert demo.motor_ids(F) == [1, 2, 3, 4, 5, 6]


def test_set_id_refused_with_no_motor(srv):
    demo.connect(F, [])
    r = srv.post("/api/suite/motors", {"action": "set_id", "role": "follower", "id": 6})
    assert r.status == 409 and "No motor answered" in r.json["error"]


def test_set_id_one_motor_changes_id_to_6(srv):
    arm = srv.arm("follower")
    demo.connect(F, [1])
    arm.online = False
    srv.wait(lambda: arm.online and arm.ids == [1], what="the arm to see just motor 1")
    assert srv.post("/api/suite/motors", {"action": "scan", "role": "follower"}).json["ids"] == [1]
    r = srv.post("/api/suite/motors", {"action": "set_id", "role": "follower", "id": 6})
    assert r.status == 200, r.text
    d = r.json
    assert d["ok"] and d["changed"] and d["old_id"] == 1 and d["new_id"] == 6 and d["baud"] == 1000000 and "ID is now 6" in d["message"]
    assert demo.motor_ids(F) == [6]
    assert demo._bus.ports[F].motors[6].regs[55] == 1 and demo._bus.ports[F].motors[6].regs[40] == 0     # locked again, torque off
    srv.wait(lambda: arm.online and arm.ids == [6], what="the arm to reconnect and see motor 6")        # forced reconnect picked up the new ID
    again = srv.post("/api/suite/motors", {"action": "set_id", "role": "follower", "id": 6}).json
    assert again["changed"] is False


def test_set_id_also_fixes_the_baud_rate(srv):
    demo.connect(F, [1])
    demo._bus.ports[F].motors[1]._w(demo.R_BAUD, 1, 1)                                         # 500000: the arm itself cannot see it at 1 Mbit/s
    d = srv.post("/api/suite/motors", {"action": "set_id", "port": F, "id": 3}).json
    assert d["ok"] and d["old_id"] == 1 and d["new_id"] == 3
    m = demo._bus.ports[F].motors[3]
    assert m.regs[demo.R_BAUD] == 0 and m.baud == 1000000
    srv.wait(lambda: srv.arm("follower").online and srv.arm("follower").ids == [3], what="the arm to find motor 3 at 1 Mbit/s")


def test_set_id_validation(srv):
    demo.connect(F, [1])
    for bad in (0, 253, "x", None, -1):
        r = srv.post("/api/suite/motors", {"action": "set_id", "role": "follower", "id": bad})
        assert r.status == 409 and "ID" in r.json["error"], bad
    assert demo.motor_ids(F) == [1]


def test_set_id_refused_during_calibration(srv):
    demo.connect(F, [1])
    srv.post(f"/api/calib/{srv.idx('follower')}/start")
    r = srv.post("/api/suite/motors", {"action": "set_id", "role": "follower", "id": 6})
    assert r.status == 409 and "calibration" in r.json["error"]
    assert demo.motor_ids(F) == [1]                                                            # nothing was written
    assert srv.post("/api/suite/motors", {"action": "scan", "role": "follower"}).status == 409


def test_set_id_refused_during_a_job_or_teleop(srv):
    demo.connect(F, [1])
    srv.server.PP.running = True
    assert srv.post("/api/suite/motors", {"action": "set_id", "role": "follower", "id": 6}).status == 409
    srv.server.PP.running = False
    srv.server.TELE.on = True
    assert srv.post("/api/suite/motors", {"action": "set_id", "role": "follower", "id": 6}).status == 409
    assert demo.motor_ids(F) == [1]


def test_demo_connect_endpoint(srv):
    r = srv.post("/api/demo/connect", {"port": F, "ids": [1, 2, 3, 4]})
    assert r.json["ids"] == [1, 2, 3, 4]
    srv.wait(lambda: srv.arm("follower").online and srv.arm("follower").ids == [1, 2, 3, 4], what="the follower to see 4 motors")
    items = {i["id"]: i for i in srv.get("/api/suite/checklist").json["items"]}
    assert items["follower_motors"]["status"] == "fail" and "5, 6" in items["follower_motors"]["detail"] and "4 of 6" in items["follower_motors"]["detail"]
    assert srv.get("/api/suite/checklist").json["summary"]["next"] in ("follower_motors", "follower_calibrated")
    assert srv.post("/api/demo/connect", {"port": "demo://nope", "ids": [1]}).status == 400
    assert srv.post("/api/demo/connect", {"port": F, "ids": "all"}).status == 400
