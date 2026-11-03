"""`Limp now` and the problem list work even when the arm does not answer (docs/LEARNINGS.md, section 22).

Seen on a real arm: the follower went silent (no motor answered) and was STIFF, while the app said "already limp (torque is off)" and greyed out
Release. 1) limp_now writes torque-off to ALL six ids, also the ones that never answered; 2) the app no longer claims limp for an arm it cannot
reach; 3) six silent motors are ONE problem (no_bus), not six overlapping ones. Fake arms only: nothing here can open a serial port."""
import threading
import types

import pytest

import pickplace as P
import server as S

NAMES = list(S.JOINTS.values())


class PK:
    def __init__(self, answer):
        self.answer, self.writes = answer, []

    def write1ByteTxRx(self, ph, i, reg, v):
        self.writes.append((i, reg, v))
        return (0, 0 if i in self.answer else -6, 0)


class PH:
    is_open = True

    def openPort(self):
        self.is_open = True
        return True

    def setBaudRate(self, b):
        return True


def arm(answer, missing, online):
    a = S.Arm.__new__(S.Arm)
    a.role = "follower"                       # first: the `online` setter writes a log line that names the role
    a.lock, a.ph, a.pk, a.torque_on, a.volt = threading.Lock(), PH(), PK(answer), True, 12.2
    a.missing, a.online, a.ids, a.temp, a.load, a.fault, a._lh = missing, online, [], {}, {}, {}, {}
    return a


@pytest.fixture(autouse=True)
def no_teleop(monkeypatch):
    monkeypatch.setattr(S, "TELE", types.SimpleNamespace(fault=None, on=False, roll_gap=lambda: None, ROLL_GAP_DEG=90))


def test_limp_now_reaches_every_id_even_if_none_answers():
    a = arm(set(), NAMES, False)
    confirmed = a.limp_now()
    assert sorted({i for i, reg, v in a.pk.writes if reg == 40 and v == 0}) == [1, 2, 3, 4, 5, 6]
    assert confirmed == 0 and a.torque_on is False


@pytest.mark.parametrize("answer, missing, expected", [({1, 2, 3, 4, 5, 6}, [], 6), ({1, 2, 3, 4, 5}, ["gripper"], 5)])
def test_limp_now_counts_the_motors_that_confirmed(answer, missing, expected):
    assert arm(answer, missing, True).limp_now() == expected


def test_six_silent_motors_are_one_problem():
    problems = arm(set(), NAMES, False).problems()
    assert [p["kind"] for p in problems] == ["no_bus"] and problems[0]["count"] == 6


def test_one_silent_motor_is_one_missing_problem():
    a = arm(set(), ["gripper"], True)
    a.ids = [1, 2, 3, 4, 5]
    assert [(p["kind"], p["joint"]) for p in a.problems()] == [("missing", "gripper")]


def test_pick_and_place_says_so_when_no_motor_confirms():
    pp = P.PickPlace.__new__(P.PickPlace)
    pp.history, pp.abort = [], False
    pp.limp_now(arm(set(), NAMES, False))
    assert "STIFF" in pp.status and "power supply" in pp.status


def test_pick_and_place_confirms_a_healthy_arm_is_limp():
    pp = P.PickPlace.__new__(P.PickPlace)
    pp.history, pp.abort = [], False
    pp.limp_now(arm({1, 2, 3, 4, 5, 6}, [], True))
    assert pp.status.startswith("✓")
