"""A motor can be ignored and the rest still works (docs/LEARNINGS.md, section 22).

An ignored motor leaves ids/missing/problems, is switched off, is never written by goto, and teleop and pick & place no longer wait for it.
Pick & place refuses only when something other than the wrist roll is ignored. Fake arms only; the ignore file lives in a temporary folder."""
import threading
import types

import pytest

import pickplace as P
import server as S


class PK:
    def __init__(self):
        self.writes = []

    def write1ByteTxRx(self, ph, i, reg, v):
        self.writes.append(("w1", i, reg, v))
        return (0, 0, 0)

    def write2ByteTxRx(self, ph, i, reg, v):
        self.writes.append(("w2", i, reg, v))
        return (0, 0, 0)


class PH:
    is_open = True


def arm(role, alive):
    a = S.Arm.__new__(S.Arm)
    a.role = role                             # first: the `online` setter writes a log line that names the role
    a.lock, a.ph, a.pk, a.torque_on, a.online, a.volt = threading.Lock(), PH(), PK(), False, True, 12.2
    a.alive, a.ids, a.missing, a.ignored, a.temp, a.load, a.fault, a._lh, a.pos = set(alive), [], [], [], {}, {}, {}, {}, {}
    a._refresh_ids()
    return a


@pytest.fixture(autouse=True)
def world(monkeypatch, tmp_path):
    """No saved ignore list, no other arms, no teleop: every test starts from the same empty app."""
    monkeypatch.setattr(S, "IGN_FILE", tmp_path / "ignored.json")
    monkeypatch.setattr(S, "IGNORED", set())
    monkeypatch.setattr(S, "arms", {})
    monkeypatch.setattr(S, "TELE", types.SimpleNamespace(fault=None, on=False, roll_gap=lambda: None, ROLL_GAP_DEG=90))


def test_a_silent_ignored_wrist_roll_is_no_longer_a_problem():
    f = arm("follower", [1, 2, 3, 4, 6])                     # wrist roll (5) silent
    assert f.missing == ["wrist_roll"] and [p["kind"] for p in f.problems()] == ["missing"]
    S.arms["f"] = f
    S.ignore_set("wrist_roll", True)
    assert f.missing == [] and f.ids == [1, 2, 3, 4, 6] and f.ignored == ["wrist_roll"] and f.problems() == []


def test_a_live_ignored_motor_is_switched_off_and_never_written():
    S.IGNORED.add("wrist_roll")
    f = arm("follower", [1, 2, 3, 4, 5, 6])
    S.arms["f"] = f
    f.apply_ignore()
    assert 5 not in f.ids and ("w1", 5, 40, 0) in f.pk.writes          # a live motor that is ignored is switched OFF
    f.pk.writes.clear()
    f.goto({1: 2000, 5: 3000})
    assert f.pk.writes == [("w2", 1, 42, 2000)]


def test_an_ignored_motors_heat_and_faults_raise_no_problem():
    S.IGNORED.add("wrist_roll")
    f = arm("follower", [1, 2, 3, 4, 5, 6])
    f.temp, f.fault = {5: 80, 1: 30}, {5: 4}
    assert f.problems() == []


def test_pick_and_place_accepts_only_the_wrist_roll_ignored():
    S.IGNORED.add("wrist_roll")
    f = arm("follower", [1, 2, 3, 4, 5, 6])
    S.arms["f"] = f
    pp = P.PickPlace.__new__(P.PickPlace)
    pp.get_arm = lambda: f
    f.cal = lambda: {"x": 1}
    pp._arm()                                                          # allowed: does not raise
    S.ignore_set("shoulder_lift", True)
    with pytest.raises(RuntimeError):
        pp._arm()                                                      # anything else is refused, with the reason


def test_using_a_motor_again_brings_it_back_and_a_missing_roll_reading_means_the_middle():
    f = arm("follower", [1, 2, 3, 4, 5, 6])
    S.arms["f"] = f
    S.ignore_set("wrist_roll", True)
    S.ignore_set("wrist_roll", False)
    assert f.ids == [1, 2, 3, 4, 5, 6] and f.ignored == []
    pp = P.PickPlace.__new__(P.PickPlace)
    pp.get_viz = lambda: {"flip": {}, "offset": {}}
    cal = {n: {"range_min": 1000, "range_max": 3000} for n in S.JOINTS.values()}
    f.cal = lambda: cal
    q = pp.q_of(f, {1: 2000, 2: 2000, 3: 2000, 4: 2000})              # no reading for the wrist roll
    assert abs(q["wrist_roll"]) < 1e-9                                 # -> the middle (0 rad)
