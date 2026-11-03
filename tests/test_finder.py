"""The object finder on a SIMULATED world: a downward-looking hand camera over a table (pinhole, 3750 px/m, rotated 35 degrees, mirrored) and one grey cylinder.

Checks: the sweep finds the cylinder, the probe measures the right picture-vs-hand matrix, tracking centres the hand over it, and it FOLLOWS when the cylinder is moved."""
import collections
import math
import threading
import time

import cv2
import numpy as np

import pickplace as P


def test_the_hand_finds_centres_over_and_follows_a_cylinder():
    S, TH = 3750.0, math.radians(35)
    R = np.array([[math.cos(TH), -math.sin(TH)], [math.sin(TH), math.cos(TH)]]) @ np.diag([1, -1])        # table metres -> picture pixels (rotated and mirrored)
    world = dict(cyl=np.array([0.215, -0.085]), hand=np.array([0.20, 0.0]))
    def frame():
        img = np.full((480, 640, 3), 215, np.uint8); img[::40, :] = 190                                   # a white table with faint lines
        px = np.array([320.0, 240.0]) + S * (R @ (world["cyl"] - world["hand"]))
        if -60 < px[0] < 700 and -60 < px[1] < 540:
            cv2.rectangle(img, (int(px[0] - 22), int(px[1] - 34)), (int(px[0] + 22), int(px[1] + 34)), (150, 135, 110), -1)    # bluish grey body (BGR)
        return img

    pp = P.PickPlace.__new__(P.PickPlace)
    pp.history = collections.deque(maxlen=80); pp._status = ""; pp._running = False; pp._beat = 0; pp._job_t0 = 0; pp.abort = False; pp._holding = False; pp.cfg = dict(P.DEFAULTS); pp.z_table = -0.02
    pp.get_frame = lambda i=0: frame()
    pp._arm = lambda: type("A", (), {"arm_motion": lambda s, on: None, "ids": [1, 2, 3, 4, 6], "pos": {}, "goto": lambda s, g: None})()
    pp.grip = lambda a, pct, t=0.8: None
    pp.tip_now = lambda a: np.array([world["hand"][0], world["hand"][1], 0.13])
    def goto(a, x, y, z, yaw=0.0, **k): world["hand"] = np.array([x, y])
    pp.goto_xyz = goto
    pp._wait_stop = lambda t: time.sleep(0.002)
    def servo(a, x, y, hits): world["hand"] = world["hand"] + np.clip(np.array([x, y]) - world["hand"], -0.03, 0.03); return True
    pp._servo_xy = servo
    pp._hold_quiet = lambda: None; pp.bowl_geom = lambda: None
    pp.running = True
    t = threading.Thread(target=pp._finder_job, daemon=True); t.start()
    def wait(cond, secs):
        t0 = time.time()
        while time.time() - t0 < secs:
            if cond(): return True
            time.sleep(0.02)
        return False
    assert wait(lambda: "locked" in pp.status or "following" in pp.status or "over the cylinder" in pp.status, 20), pp.status
    assert wait(lambda: np.linalg.norm(world["hand"] - world["cyl"]) < 0.004, 10), (world, pp.status)
    world["cyl"] = np.array([0.255, -0.03])                                                               # somebody moves the product
    assert wait(lambda: np.linalg.norm(world["hand"] - world["cyl"]) < 0.004, 15), (world, pp.status)
    pp.abort = True; t.join(5); assert not t.is_alive()
