"""The automatic grey-cylinder loop, with every motion replaced by a stub that writes to a log (logic only).

The order: 1 go to the TOP position and look for a grey cylinder; 2 found: OPEN the gripper, move close, pick it up; 3 find the pink bowl, move close,
drop it; 4 back to the top position and look again, repeating until Stop."""
import collections

import pickplace as P


def test_the_loop_looks_picks_drops_and_looks_again():
    log = []
    pp = P.PickPlace.__new__(P.PickPlace)
    pp.history = collections.deque(maxlen=80); pp._status = ""; pp._running = False; pp._beat = 0; pp._job_t0 = 0; pp.abort = False; pp.cycles = 0; pp._holding = False; pp.cfg = dict(P.DEFAULTS)
    pp.get_arm = lambda: object()
    pp._arm = lambda: type("A", (), {"arm_motion": lambda s, on: None})()
    pp.measure_empty = lambda a: None
    pp.camera_alive = lambda cid=0: True
    pp._wait_stop = lambda t: None
    pp._hold_quiet = lambda: None
    pp.search_pose = lambda a: log.append("top position")
    seq = [[dict(x=0.2, y=0.0, u=1, v=1, area=1500), dict(x=0.25, y=-0.05, u=2, v=2, area=1400)], [dict(x=0.25, y=-0.05, u=2, v=2, area=1400)], [], [], []]
    def find():
        r = seq.pop(0) if seq else []
        if not r and not seq: pp.abort = True                      # the person presses Stop after the loop has watched an empty table
        return r
    pp.find_cylinders_world = find
    pp.grip = lambda a, pct, t=0.8: log.append(f"gripper {pct}%")
    pp.pick_cyl = lambda a, x, y: log.append(f"pick ({x:.2f},{y:.2f})")
    pp.zone_center = lambda n: (0.1, 0.1, 0.07)
    pp.place = lambda a, zone: log.append(f"drop in {zone}")
    pp._recover = lambda a: log.append("recover")
    pp.running = True
    pp._cyl_job(False)
    want = ["top position", "gripper 100%", "pick (0.20,0.00)", "drop in bowl", "top position", "gripper 100%", "pick (0.25,-0.05)", "drop in bowl", "top position"]
    assert log[:len(want)] == want, log
    assert pp.cycles == 2 and "stopped" in pp.status
