"""SO-101 forward/inverse kinematics from the official URDF (metres, radians, base_link frame)."""
import math, os
import xml.etree.ElementTree as ET
import numpy as np

URDF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "so101", "so101_new_calib.urdf")
ARM = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll"]


def _T(xyz, rpy):
    r, p, y = rpy
    Rx = np.array([[1, 0, 0], [0, np.cos(r), -np.sin(r)], [0, np.sin(r), np.cos(r)]])
    Ry = np.array([[np.cos(p), 0, np.sin(p)], [0, 1, 0], [-np.sin(p), 0, np.cos(p)]])
    Rz = np.array([[np.cos(y), -np.sin(y), 0], [np.sin(y), np.cos(y), 0], [0, 0, 1]])
    T = np.eye(4); T[:3, :3] = Rz @ Ry @ Rx; T[:3, 3] = xyz
    return T


def _rot(axis, a):
    x, y, z = axis; c, s = np.cos(a), np.sin(a); C = 1 - c
    T = np.eye(4)
    T[:3, :3] = [[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                 [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                 [z * x * C - y * s, z * y * C + x * s, c + z * z * C]]
    return T


class Kin:
    def __init__(self, path=URDF):
        self.j = {}
        for e in ET.parse(path).getroot().findall("joint"):
            o, ax, lim = e.find("origin"), e.find("axis"), e.find("limit")
            self.j[e.get("name")] = dict(
                type=e.get("type"), parent=e.find("parent").get("link"), child=e.find("child").get("link"),
                T=_T([float(v) for v in o.get("xyz").split()], [float(v) for v in o.get("rpy").split()]),
                axis=np.array([float(v) for v in ax.get("xyz").split()]) if ax is not None else None,
                lo=float(lim.get("lower")) if lim is not None else None, hi=float(lim.get("upper")) if lim is not None else None)
        by_child = {v["child"]: k for k, v in self.j.items()}
        chain, link = [], "gripper_frame_link"
        while link in by_child:
            k = by_child[link]; chain.append(k); link = self.j[k]["parent"]
        self.chain = chain[::-1]
        self.lo = np.array([self.j[n]["lo"] for n in ARM[:4]]); self.hi = np.array([self.j[n]["hi"] for n in ARM[:4]])
        # fast forward kinematics: the fixed transforms between two revolute joints are multiplied together ONCE, and a joint turns only the 3x3 rotation part (the original rebuilt
        # np.eye(4) matrices on every call; on a slow computer an IK solve took 6.5 s of the 11 s the table scan's first move needed, and the watchdog called that 'no progress')
        self._I3 = np.eye(3); self._steps = []; Rs, ps = np.eye(3), np.zeros(3)
        for n in self.chain:
            j = self.j[n]; Rs, ps = Rs @ j["T"][:3, :3], ps + Rs @ j["T"][:3, 3]
            if j["type"] == "revolute":
                ax = j["axis"]; K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]]); O = np.outer(ax, ax)
                self._steps.append((Rs, ps, n, ax, K, O, n == "wrist_roll")); Rs, ps = np.eye(3), np.zeros(3)
        self._tail = (Rs, ps)

    def _chain_Rp(self, q, want_roll=False):
        R = self._I3; p = np.zeros(3); roll_o = roll_a = None
        for Rs, ps, n, ax, K, O, is_roll in self._steps:
            p = p + R @ ps; R = R @ Rs
            if is_roll: roll_o, roll_a = p.copy(), R @ ax
            a = q.get(n, 0.0); c, sn = math.cos(a), math.sin(a)
            R = R @ (c * self._I3 + sn * K + (1.0 - c) * O)
        Rs, ps = self._tail; p = p + R @ ps; R = R @ Rs
        return R, p, roll_o, roll_a

    def fk(self, q):
        """q: dict joint->rad. Returns (tip xyz, approach unit vector pointing from wrist toward the gripper tip)."""
        R, tip, roll_o, roll_a = self._chain_Rp(q)
        if np.dot(tip - roll_o, roll_a) < 0: roll_a = -roll_a
        return tip, roll_a / np.linalg.norm(roll_a)

    def fk_slow(self, q):
        """The original 4x4 implementation, kept as the reference the fast one is tested against."""
        T = np.eye(4); roll_o = roll_a = None
        for n in self.chain:
            j = self.j[n]; T = T @ j["T"]
            if n == "wrist_roll": roll_o, roll_a = T[:3, 3].copy(), T[:3, :3] @ j["axis"]
            if j["type"] == "revolute": T = T @ _rot(j["axis"], q.get(n, 0.0))
        tip = T[:3, 3].copy()
        if np.dot(tip - roll_o, roll_a) < 0: roll_a = -roll_a
        return tip, roll_a / np.linalg.norm(roll_a)

    def fkT(self, q):
        """Full 4x4 pose of the gripper tip frame (rotation + position), so a point fixed in the gripper (a finger tip) can be placed in the world."""
        R, p, _, _ = self._chain_Rp(q); T = np.eye(4); T[:3, :3] = R; T[:3, 3] = p
        return T

    def ik(self, target, roll=0.0, tool_down=True, tilt=0.0):
        """Solve pan/lift/elbow/wrist_flex so the tip reaches `target` with the tool pointing straight down in the REAL world.
        `tilt` (rad, + = fingers lean away from the base) is what the model reads when the real gripper is truly vertical (measured once by hand)."""
        target = np.asarray(target, float)
        pan0 = np.arctan2(target[1], target[0])
        az = np.arctan2(target[1], target[0] - 0.0388)                      # direction of the arm's vertical plane (the pan axis is 38.8 mm in front of the base origin)
        want = np.array([np.sin(tilt) * np.cos(az), np.sin(tilt) * np.sin(az), -np.cos(tilt)])
        def res(v):
            q = dict(zip(ARM[:4], v)); q["wrist_roll"] = roll
            tip, app = self.fk(q)
            return np.r_[tip - target, 1.0 - app @ want] if tool_down else tip - target
        best = (1e9, None)
        for lift in (0.3, -0.4, 1.0):
            for elbow in (0.6, 1.2, -0.3):
                for wrist in (0.6, -0.6, 1.2):
                    v = np.clip([pan0, lift, elbow, wrist], self.lo, self.hi)
                    for _ in range(60):
                        r = res(v)
                        if np.linalg.norm(r) < 1e-5: break
                        J = np.stack([(res(v + np.eye(4)[i] * 1e-5) - r) / 1e-5 for i in range(4)], 1)
                        v = np.clip(v - np.linalg.solve(J.T @ J + 1e-5 * np.eye(4), J.T @ r), self.lo, self.hi)
                    e = np.linalg.norm(res(v))
                    if e < best[0]: best = (e, v.copy())
                    if e < 1e-4: break
                else: continue
                break
            else: continue
            break
        if best[1] is None: return None
        r = res(best[1])
        if np.linalg.norm(r[:3]) > 3e-3 or (tool_down and r[3] > 1.4e-3): return None      # at most 3 mm off target and 3° off the wanted direction: never silently accept a tilted tool
        q = dict(zip(ARM[:4], map(float, best[1]))); q["wrist_roll"] = float(roll)
        return q
