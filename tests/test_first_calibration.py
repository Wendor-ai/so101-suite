"""The first-time calibration prompt: info flag, and the first calibration becoming the restore point. Order matters in this file."""
import time

import pytest

from so101 import demo


@pytest.fixture(scope="module", autouse=True)
def fast_hand():
    old = demo.HAND_SLOT
    demo.HAND_SLOT = 0.7                      # the simulated hand takes 0.7 s per joint, so a full sweep is ~4 s
    yield
    demo.HAND_SLOT = old


def info(srv):
    return srv.get("/api/suite/info").json


def calibrate(srv, roles):
    for r in roles:
        i = srv.idx(r)
        srv.post(f"/api/calib/{i}/start")
        assert srv.arm(r).calib["step"] == "center"
        assert srv.arm(r).torque_on is False
    for r in roles:
        srv.post(f"/api/calib/{srv.idx(r)}/center")
        assert srv.arm(r).calib["step"] == "sweep"
    time.sleep(5.2)                           # the hand moves every joint through its range, one after another
    for r in roles:
        srv.post(f"/api/calib/{srv.idx(r)}/finish")
        srv.wait(lambda r=r: srv.arm(r).calib["step"] == "done", what=f"{r} calibration to finish")


def test_flag_is_on_while_connected_arms_are_uncalibrated(srv):
    d = info(srv)
    assert d["uncalibrated"] == ["follower", "leader"] and d["first_calibration_needed"] is True
    assert srv.get("/api/state").json["arms"][0]["calibrated"] is False


def test_prompted_flag_silences_the_offer_but_not_the_list(srv):
    srv.post("/api/suite/settings", {"ui": {"calibrationPrompted": True}})
    d = info(srv)
    assert d["first_calibration_needed"] is False and d["uncalibrated"] == ["follower", "leader"]
    srv.post("/api/suite/settings", {"ui": {"calibrationPrompted": False}})
    assert info(srv)["first_calibration_needed"] is True


def test_a_disconnected_arm_is_not_asked_to_calibrate(srv):
    demo.set_port_present(demo.LEADER, False)
    srv.wait(lambda: not srv.arm("leader").online, what="the leader to go offline")
    assert info(srv)["uncalibrated"] == ["follower"]
    demo.set_port_present(demo.LEADER, True)
    srv.wait(lambda: srv.arm("leader").online, what="the leader to come back")


def test_flag_flips_after_a_demo_calibration_finishes(srv):
    calibrate(srv, ["follower"])
    d = info(srv)
    assert d["uncalibrated"] == ["leader"] and d["first_calibration_needed"] is True          # the leader still needs it
    calibrate(srv, ["leader"])
    d = info(srv)
    assert d["uncalibrated"] == [] and d["first_calibration_needed"] is False
    items = {i["id"]: i for i in srv.get("/api/suite/checklist").json["items"]}
    assert items["follower_calibrated"]["status"] == "ok" and items["leader_calibrated"]["status"] == "ok"


def test_the_first_calibration_becomes_the_default_straight_away(srv):
    server = srv.server
    for role in ("follower", "leader"):
        assert server.cal_path(role).exists()
        assert server.cal_path(role, ".default").exists()                                        # no reconnect was needed to create it
        assert server.cal_path(role, ".default").read_bytes() == server.cal_path(role).read_bytes()
    assert all(a["has_default"] for a in srv.get("/api/state").json["arms"])
    # later calibrations never overwrite that default
    first = server.cal_path("follower", ".default").read_bytes()
    srv.arm("follower").calib_cancel()
    calibrate(srv, ["follower"])
    assert server.cal_path("follower", ".default").read_bytes() == first


def test_calibration_zero_is_the_middle_of_the_recorded_range(srv):
    import json
    cal = json.loads(srv.server.cal_path("follower").read_text())
    arm = srv.arm("follower")
    for jid, name in srv.server.JOINTS.items():
        lo, hi = cal[name]["range_min"], cal[name]["range_max"]
        assert hi - lo >= 150 and cal[name]["id"] == jid
    assert cal["wrist_roll"]["range_min"] == 0 and cal["wrist_roll"]["range_max"] == 4095
