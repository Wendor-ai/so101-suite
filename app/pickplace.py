"""Vision-guided pick & place: overhead camera pixel -> table plane (homography taught by touching the table) -> IK -> motion.
Safety: slow smooth moves, joint targets clamped to the calibrated range, Stop holds position, nothing starts without teach + bowl."""
import collections, json, math, os, pathlib, random, threading, time
import cv2
import numpy as np
import vision
from kin import Kin, ARM

FILE = pathlib.Path("~/.so101_pickplace.json").expanduser()
DEFAULTS = dict(stall_abort_s=40, stall_cut_s=70, points=[], zones={"tray": dict(p=None, drop=0.07, r=60.0), "bowl": dict(p=None, drop=0.11, r=110.0)},
                roll_offset=0.0, grasp_dz=0.004, travel=0.06, off_x=0.0, off_y=0.0, auto_bowl=True, bowl_h=0.076,
                bowl_clear=0.005, finger_rad=0.03, finger_tan=0.02, finger_len=0.04, bowl_base=0.6)   # bowl model: safety margin, gripper half-size along/across the arm, finger length, base radius / rim radius
LOAD_LIMIT, LOAD_COUNT, TEMP_LIMIT = 700, 3, 68      # stop if a motor pushes at >= 70% torque for 3 readings, or overheats
BASE_Z = -0.0024                                         # lowest point of the arm's base in the model frame (from the URDF mesh): the base is clamped flat on the table, so the table is here
CAM_AGREE = 0.03                                         # two cameras may put the keychain at most 30 mm apart; more means a camera is out of date (usually it was moved): do not move to a guess
GRIP_MIN_GAP = 150                                       # fingers this many ticks wider than 'closed on nothing' = something is between them (empty ~1840-1900, clamped keychain ~2370)
NAMES = {1: "shoulder_pan", 2: "shoulder_lift", 3: "elbow_flex", 4: "wrist_flex", 5: "wrist_roll", 6: "gripper"}


class Overload(Exception): pass


CAM_MOVED_MM = 12                                        # a camera whose picture has shifted by more than this on the TABLE (not in pixels: camera 1 is 0.5 mm per pixel, camera 2 about 1.2) is treated as moved
CAM_MOVED_PX = 10                                        # a camera whose picture has shifted by more than this many pixels (about 10 mm on the table) since it was calibrated is treated as moved


def drift_between(ref, cur):
    """How far the camera's picture has shifted since the reference picture, from the still background (ORB features + RANSAC similarity: the arm, keychain and bowl move, so they come out as outliers)."""
    g1, g2 = (cv2.cvtColor(x, cv2.COLOR_BGR2GRAY) if x.ndim == 3 else x for x in (ref, cur))
    if g1.shape != g2.shape: return dict(state="unsure", why="different picture size")
    orb = cv2.ORB_create(2000); k1, d1 = orb.detectAndCompute(g1, None); k2, d2 = orb.detectAndCompute(g2, None)
    if d1 is None or d2 is None or len(k1) < 30 or len(k2) < 30: return dict(state="unsure", n=0)
    m = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(d1, d2)
    if len(m) < 30: return dict(state="unsure", n=len(m))
    p1 = np.float32([k1[x.queryIdx].pt for x in m]); p2 = np.float32([k2[x.trainIdx].pt for x in m])
    M, inl = cv2.estimateAffinePartial2D(p1, p2, method=cv2.RANSAC, ransacReprojThreshold=3.0)
    n = int(inl.sum()) if inl is not None else 0
    if M is None or n < 30: return dict(state="unsure", n=n)
    h, w = g1.shape; c = np.float32([[0, 0], [w, 0], [w, h], [0, h], [w / 2, h / 2]])
    shift = float(np.max(np.linalg.norm(cv2.transform(c[None], M)[0] - c, axis=1)))
    return dict(state="moved" if shift > CAM_MOVED_PX else "ok", shift_px=round(shift, 1), n=n)


# Screensaver / attract mode poses: (x mm, y mm, height of the fingertips above the table mm/1000, lean in degrees). All verified reachable with the inverse kinematics
# (a vertical tool only reaches ~11 cm high; leaning the fingers away from the base reaches higher) and all at least 12 cm above the table, well clear of the bowl rim (76 mm).
ATTRACT = ((150, -60, 0.18, 45), (130, -120, 0.12, 15), (170, -130, 0.14, 15), (210, -120, 0.16, 30), (250, -80, 0.14, 15), (260, -20, 0.16, 30),
           (190, -20, 0.20, 45), (250, 40, 0.14, 15), (210, 60, 0.16, 30), (170, 70, 0.14, 15))


class GraspFailed(RuntimeError): pass    # the keychain was not gripped, or slipped out on the way: the arm stops and recovers instead of carrying on


class Collision(RuntimeError): pass       # a planned move would pass through an obstacle (the bowl): refused before anything moves


ORDER = ["tray", "bowl"]               # the goal: keychain into the tray first, then into the bowl


class PickPlace:
    def __init__(self, get_arm, get_frame, get_viz, ncam=1):
        self.get_arm, self.get_frame, self.get_viz, self.ncam = get_arm, get_frame, get_viz, ncam
        self.founds = [[] for _ in range(ncam)]; self._ft = [0.0] * ncam; self._bowl_est = [None] * ncam; self.bowl_xy = None; self.fusion = None
        self.rim = None; self._rim_est = [None] * ncam; self._rim_t = [0.0] * ncam; self._ne = (0.0, None)        # the bowl's real rim circle (table coordinates) and the cached no-go outline
        self.kin = Kin(); self.cfg = {**DEFAULTS, **self._load()}
        self.H = None; self.z_table = None; self.err_mm = None
        saved = self.cfg.get("cams") or ([self.cfg["cam"]] if self.cfg.get("cam") else [])      # one calibrated camera model per camera
        self.models = [(saved[i] if i < len(saved) else None) for i in range(ncam)]; self.cam = self.models[0]
        self.cam_chk = [dict(state="noref") for _ in range(ncam)]       # per-camera 'has it moved since calibration'
        self.auto = dict(on=False, msg="", holding=0.0, kc="none"); self._still_since = None
        self._beat = time.time(); self._job_t0 = time.time(); self._running = False; self.align_spots = []; self.history = collections.deque(maxlen=80); self._status = "idle"; self.grip_empty = None; self._holding = False
        threading.Thread(target=self._watchdog, daemon=True).start(); threading.Thread(target=self._camwatch, daemon=True).start()
        self.found = []; self.status = "idle"; self.running = False; self.abort = False; self.cycles = 0; self.mode = None; self.check = None
        self._fit()

    @property
    def running(self): return self._running

    @running.setter
    def running(self, v):
        self._running = v; self._beat = time.time()
        if v: self._job_t0 = time.time()

    @property
    def status(self): return self._status

    @status.setter
    def status(self, v):
        self._status = v; self._beat = time.time()
        if not self.history or self.history[-1][1] != v: self.history.append((time.time(), v))

    def _busy(self):
        """True while a job runs, or while the leader arm is driving the follower (never two controllers at once)."""
        if self.running: return True
        if self.external_busy(): self.status = "the leader arm is driving the follower: press Stop leader → follower first"; return True
        return False

    external_busy = staticmethod(lambda: False)
    viz_set = staticmethod(lambda d: {})            # the server plugs in the function that stores per-joint offsets

    # ---------- persistence / calibration ----------
    def _load(self):
        try: return json.loads(FILE.read_text())
        except Exception: return {}

    def _save(self): FILE.write_text(json.dumps(self.cfg))

    def _fit(self):
        P = self.cfg["points"]
        if len(P) < 3: self.H = self.err_mm = None; self.z_table = self.cfg.get("z_table", self.z_table); return
        src = np.float32([[p["u"], p["v"]] for p in P]); dst = np.float32([[p["x"], p["y"]] for p in P])
        if len(P) == 3: H = np.vstack([cv2.getAffineTransform(src, dst), [0, 0, 1]])   # overhead camera: affine is accurate enough
        elif len(P) >= 6: H, _ = cv2.findHomography(src, dst, cv2.RANSAC, 0.02)       # tolerate a bad sample
        else: H, _ = cv2.findHomography(src, dst, 0)
        if H is None: self.H = self.err_mm = None; self.z_table = self.cfg.get("z_table", self.z_table); return
        self.H, self.z_table = H, float(self.cfg.get("z_table", np.mean([p["z"] for p in P])))
        pred = cv2.perspectiveTransform(src[None], H)[0]
        self.err_mm = float(np.mean(np.linalg.norm(pred - dst, axis=1)) * 1000)

    def _in_scan(self, u, v):
        """Is this camera-1 pixel inside (or within 30 px of) the area covered by the fingertip scan? Outside it the fitted map is an extrapolation and diverges (measured: the bowl landed 10 cm off)."""
        P = self.cfg.get("points") or []
        if len(P) < 6: return True
        hull = cv2.convexHull(np.float32([[p["u"], p["v"]] for p in P]).reshape(-1, 1, 2))
        return cv2.pointPolygonTest(hull, (float(u), float(v)), True) > -30.0

    def px2xy(self, u, v, cid=0, h=0.0):
        """Camera pixel -> table-plane position (metres) at height h above the table, through that camera's calibrated model."""
        m = self.models[cid] if cid < len(self.models) else None
        def via_model(hh):
            K = np.array(m["K"]); R, _ = cv2.Rodrigues(np.array(m["rvec"])); t = np.array(m["tvec"])
            d = R.T @ np.linalg.solve(K, np.array([u, v, 1.0])); C = -R.T @ t; p = C + (self.z_table + hh - C[2]) / d[2] * d
            return np.array([float(p[0]), float(p[1])])
        if cid == 0 and self.H is not None and self.err_mm is not None and self.err_mm < 12 and self.cfg.get("prefer_H", True) and h <= 0.03 and self._in_scan(u, v):
            # The table map taught from the arm's own fingertips (ground truth) beats the camera model (its bias was measured at 3 cm). An object above the table still shifts with height:
            # take that shift from the model, as a DIFFERENCE, so the model's own translation error cancels.
            x, y = cv2.perspectiveTransform(np.float32([[[u, v]]]), self.H)[0, 0]; base = np.array([float(x), float(y)])
            if m and h > 0.002: base = base + (via_model(h) - via_model(0.0))
            return float(base[0]), float(base[1])
        if m:
            p = via_model(h); return float(p[0]), float(p[1])
        if cid == 0 and self.H is not None:
            x, y = cv2.perspectiveTransform(np.float32([[[u, v]]]), self.H)[0, 0]; return float(x), float(y)
        raise RuntimeError(f"camera {cid + 1} is not calibrated")

    def usable(self):
        """Cameras that are calibrated, allowed by the camera mode, and delivering fresh frames."""
        mode = str(self.cfg.get("cam_mode", "auto")); ids = range(self.ncam) if mode == "auto" else [int(mode)]
        return [i for i in ids if i < self.ncam and (self.models[i] or (i == 0 and self.H is not None)) and time.time() - self._ft[i] < 2.0]

    def locate(self, h=0.004):
        """Where the keychain lies on the table. Every usable camera votes; a fully visible detection counts more than a partly hidden one."""
        if self.z_table is None: return None
        ests = []
        for cid in self.usable():
            f = self.founds[cid]
            if not f: continue
            d = f[0]
            try: x, y = self.px2xy(d["u"], d["v"], cid, h)
            except Exception: continue
            ests.append((cid, x, y, 0.4 if d.get("partial") else 1.0, d))
        if not ests: return None
        W = sum(e[3] for e in ests); x = sum(e[1] * e[3] for e in ests) / W; y = sum(e[2] * e[3] for e in ests) / W
        spread = max((math.dist((p[1], p[2]), (q[1], q[2])) for p in ests for q in ests), default=0.0)
        d0 = max(ests, key=lambda e: e[3])[4]; z_above = None; gap = None
        tri_ok = [e for e in ests if self.models[e[0]]]
        if len(tri_ok) >= 2:                                   # two cameras: triangulate the real 3D position (no parallax error, gives the height)
            try:
                pt, gap = self.triangulate([(e[0], e[4]["u"], e[4]["v"]) for e in tri_ok]); z_above = float(pt[2] - self.z_table)
                if gap < 0.03 and -0.03 < z_above < 0.2: x, y = float(pt[0]), float(pt[1])
            except Exception: pass
        return dict(z=z_above, gap=gap, x=x, y=y, spread=spread, cams=[e[0] for e in ests], partial=all(e[4].get("partial") for e in ests), u=d0["u"], v=d0["v"], angle=d0["angle"])

    def _ray(self, u, v, cid):
        m = self.models[cid]; K = np.array(m["K"]); R, _ = cv2.Rodrigues(np.array(m["rvec"])); t = np.array(m["tvec"])
        d = R.T @ np.linalg.solve(K, np.array([u, v, 1.0])); return -R.T @ t, d / np.linalg.norm(d)

    def triangulate(self, obs):
        """3D point closest to the viewing rays of several calibrated cameras (obs = [(cid, u, v)]). Returns (point, worst ray distance)."""
        A, b, rays = np.zeros((3, 3)), np.zeros(3), []
        for cid, u, v in obs:
            C, d = self._ray(u, v, cid); M = np.eye(3) - np.outer(d, d); A += M; b += M @ C; rays.append((C, d))
        p = np.linalg.solve(A, b)
        return p, max(float(np.linalg.norm(np.cross(d, p - C))) for C, d in rays)

    def _mm_per_px(self, cid, u, v, h):
        x0, y0 = self.px2xy(u, v, cid, h); x1, y1 = self.px2xy(u + 10, v, cid, h); return math.dist((x0, y0), (x1, y1)) / 10

    def _fuse_bowl(self):
        now = time.time(); ests = [e for e in self._bowl_est if e and now - e[3] < 2.0]
        if ests: self.bowl_xy = (sum(e[0] for e in ests) / len(ests), sum(e[1] for e in ests) / len(ests), sum(e[2] for e in ests) / len(ests))

    def zone_center(self, name):
        """(x, y, radius) in metres. The bowl follows the real pink bowl as seen by every camera; the tray uses the clicked spot."""
        if name == "bowl" and self.cfg.get("auto_bowl", True) and self.bowl_xy:
            x, y, r = self.bowl_xy
            if self.rim and time.time() - self.rim["t"] < 30: x, y, r = self.rim["x"], self.rim["y"], max(r, 0.8 * self.rim["r"])      # centre of the real rim, not of the visible pink blob
            return x, y, max(r, 0.07)
        z = self.cfg["zones"].get(name)
        if not z or not z["p"] or self.z_table is None or not (self.models[0] or self.H is not None): return None
        h = 0.045 if name == "bowl" else 0.03
        try: x, y = self.px2xy(z["p"][0], z["p"][1], 0, h); return x, y, z["r"] * self._mm_per_px(0, z["p"][0], z["p"][1], h)
        except Exception: return None

    def zone_of_world(self, x, y):
        for n in self.cfg["zones"]:
            c = self.zone_center(n)
            if c and math.dist((x, y), c[:2]) < c[2]: return n
        return None

    def set_param(self, k, v):
        if k == "cam_mode": self.cfg["cam_mode"] = str(v); self._save()
        elif k == "auto_bowl": self.cfg["auto_bowl"] = bool(float(v)); self._save()
        elif k == "ignore_heat": self.cfg[k] = bool(float(v)); self._save()
        elif k == "z_table": self.cfg["z_table"] = float(v); self.z_table = float(v); self._save()        # table height in the model frame, metres (kept even when there is no camera map: the arm needs it)          # the ignore_heat switch: motor temperatures are shown but never block, warn or stop anything here (the motors' own thermal protection stays on)
        elif k == "pitch_trim_deg": self.cfg[k] = max(-25.0, min(25.0, float(v))); self._save(); self.status = f"gripper trim set to {self.cfg[k]:+.1f}° (the model's lean when the finger tips are truly flat)"
        elif k in ("roll_offset", "grasp_dz", "travel", "off_x", "off_y", "bowl_h", "bowl_clear"): self.cfg[k] = max(0.0, float(v)) if k == "bowl_clear" else float(v); self._save()
        elif k.split(".")[0] in self.cfg["zones"]: z, f = k.split("."); self.cfg["zones"][z][f] = float(v); self._save()

    def set_point(self, which, u, v):
        if which in self.cfg["zones"]:
            self.cfg["zones"][which]["p"] = [float(u), float(v)]
            if which == "bowl": self.cfg["auto_bowl"] = False          # clicking the bowl by hand switches off auto-find
            self._save()

    def clear_points(self): self.cfg["points"] = []; self._fit(); self._save()

    def undo_point(self):
        if self.cfg["points"]: self.cfg["points"].pop(); self._fit(); self._save()

    # ---------- arm <-> kinematics ----------
    def _arm(self):
        a = self.get_arm()
        if not a or not a.online or a.cal() is None: raise RuntimeError("follower arm not online/calibrated")
        if a.missing: raise RuntimeError(f"follower {', '.join(a.missing)} does not answer: check its cable and power")
        no = [n for n in getattr(a, "ignored", []) if n != "wrist_roll"]
        if no: raise RuntimeError(f"pick & place cannot work without {', '.join(no)}: only the wrist roll can be ignored (the gripper then keeps its current twist). Use {no[0]} again or fix it")
        return a

    def _conv(self, a):
        cal, viz = a.cal(), self.get_viz()
        return cal, viz.get("flip", {}), viz.get("offset", {})

    def q_now(self, a): return self.q_of(a, a.pos)

    def q_of(self, a, raw):
        """Joint angles (radians) for a set of raw motor positions {motor id: ticks}."""
        cal, flip, off = self._conv(a); q = {}
        for n in ARM:
            i = {"shoulder_pan": 1, "shoulder_lift": 2, "elbow_flex": 3, "wrist_flex": 4, "wrist_roll": 5}[n]
            mid = (cal[n]["range_min"] + cal[n]["range_max"]) / 2          # zero = middle of the calibrated range (LeRobot degrees; verified on the live arm)
            deg = (raw.get(i, mid) - mid) * 360 / 4095          # an ignored motor has no reading: assume its middle
            q[n] = math.radians((-deg if flip.get(n) else deg) + off.get(n, 0.0))
        return q

    def ticks(self, a, q):
        cal, flip, off = self._conv(a); out = {}
        for n in ARM:
            i = {"shoulder_pan": 1, "shoulder_lift": 2, "elbow_flex": 3, "wrist_flex": 4, "wrist_roll": 5}[n]
            deg = math.degrees(q[n]) - off.get(n, 0.0)
            if flip.get(n): deg = -deg
            lo, hi = cal[n]["range_min"], cal[n]["range_max"]
            out[i] = int(max(lo + 3, min(hi - 3, (lo + hi) / 2 + deg * 4095 / 360)))
        return out

    def grip_tick(self, a, pct):
        cal, flip, _ = self._conv(a); lo, hi = cal["gripper"]["range_min"], cal["gripper"]["range_max"]
        f = pct / 100.0
        return int(hi - f * (hi - lo) if flip.get("gripper") else lo + f * (hi - lo))

    def _closed_raw(self, a):
        cal, flip, _ = self._conv(a); g = cal["gripper"]
        return g["range_max"] if flip.get("gripper") else g["range_min"]

    def _tip_or_none(self, a):
        try: return self.tip_now(a) if a else None
        except Exception: return None

    def _gap_or_none(self, a):
        try: return round(self.grip_gap(a)) if a else None
        except Exception: return None                       # the gripper position is not read yet (right after a reconnect): state() must never crash on that

    def grip_gap(self, a):
        """How far the fingers are apart beyond 'closed on nothing' (ticks): ~0 when empty, ~500 when clamped on the keychain. Position, not load: an empty closed gripper also pushes hard against itself."""
        ref, sg = self._grip_params(a); return (a.pos[6] - ref) * sg

    def _grip_params(self, a):
        cal, flip, _ = self._conv(a); g = cal["gripper"]; fl = bool(flip.get("gripper"))
        return (self.grip_empty if self.grip_empty is not None else (g["range_max"] if fl else g["range_min"])), (-1 if fl else 1)

    def measure_empty(self, a):
        """Close the gripper on nothing once per job to learn where 'empty' is, so a missed grasp can never look like a hold."""
        self.status = "checking the gripper: closing it on nothing"; self.grip(a, 100, 0.7); self.grip(a, 0, 1.0)
        pos, ld = float(a.pos[6]), abs(a.read_loads().get(6, 0)); self.grip(a, 100, 0.7)
        if abs(pos - self._closed_raw(a)) <= 120: self.grip_empty = pos
        else: self.grip_empty = None; self.status = f"gripper stopped at {pos:.0f} when closing empty (expected ~{self._closed_raw(a)}): something is between the fingers? using the calibrated closed position"
        self.status = f"gripper closes empty at {pos:.0f} (load {ld / 10:.0f}%): a gap above {GRIP_MIN_GAP} ticks will count as holding the keychain"

    def tip_now(self, a): return self.kin.fk(self.q_now(a))[0]

    def trim(self): return math.radians(self.cfg.get("pitch_trim_deg", 0.0))

    def tool_tilt(self, a):
        """(in the arm's plane, sideways) lean of the fingers in degrees, from the real joint positions: + = the fingertips lean away from the base."""
        q = self.q_now(a); app = self.kin.fk(q)[1]; pan = -q["shoulder_pan"]          # the arm's plane points at azimuth -pan (URDF pan axis is flipped)
        return (math.degrees(math.atan2(app[0] * math.cos(pan) + app[1] * math.sin(pan), -app[2])), math.degrees(math.atan2(-app[0] * math.sin(pan) + app[1] * math.cos(pan), -app[2])))

    def vertical_set(self):
        """The user holds the limp gripper truly straight down (both finger tips flat on the table). Whatever tilt the model reads there is its error: from now on every move aims for that reading."""
        a = self._arm()
        if a.torque_on: raise RuntimeError("the arm is not limp: press 'Release arm', hold the gripper straight down with both finger tips flat on the table, then press Set vertical")
        s, lat = self.tool_tilt(a)
        if abs(s) > 25: raise RuntimeError(f"the model reads {s:+.0f}° there: that is too far from straight down. Hold the gripper with the fingers pointing at the table")
        self.cfg["pitch_trim_deg"] = round(s, 2); self._save()
        self.status = f"✓ vertical set: straight down reads {s:+.1f}° in the model (sideways {lat:+.1f}°). Every move aims for that now; clamp-calibration is NOT needed"

    # ---------- align the model to the real arm: gripper flat on the table at 3+ spots ----------
    def align_record(self, r_cm):
        """The user holds the limp gripper straight down, both finger tips flat on the table, exactly r_cm from the centre of the shaft the arm turns on (ruler). Remember the joint readings."""
        a = self._arm(); r_cm = float(r_cm)
        if not 8 <= r_cm <= 27: raise RuntimeError("distance must be between 8 and 27 cm (the arm cannot reach further with the gripper straight down)")
        if a.torque_on: raise RuntimeError("the arm is not limp: press 'Release arm', then hold the gripper straight down with both finger tips flat on the table")
        raw = {i: int(a.pos[i]) for i in (1, 2, 3, 4, 5)}; q = self.q_of(a, raw); tip, app = self.kin.fk(q); s, _ = self.tool_tilt(a)
        if abs(s) > 35 or not -0.14 < tip[2] < 0.10: raise RuntimeError(f"that does not look like the gripper flat on the table (the model reads {s:+.0f}° lean and the tip {1000 * tip[2]:.0f} mm from the base level): hold it straight down on the table")
        self.align_spots = [sp for sp in self.align_spots if abs(sp["r"] - r_cm / 100) > 0.02]            # recording the same distance again replaces the old spot
        self.align_spots.append(dict(raw=raw, r=r_cm / 100)); self.status = f"spot at {r_cm:.0f} cm recorded ({len(self.align_spots)} so far)" + (" · now press Fit & apply" if len(self.align_spots) >= 3 else " · need 3: 12, 17 and 22 cm")

    def _xy(self, a, raw): return self.kin.fk(self.q_of(a, raw))[0][:2]

    def _rad(self, a, raw): return math.hypot(*(self._xy(a, raw) - np.array([0.0388, 0.0])))

    def _align_res(self, a, p):
        z0 = self.cfg.get("base_z", BASE_Z); out = []; d = {"shoulder_lift": p[0], "elbow_flex": p[1], "wrist_flex": p[2]}
        for sp in self.align_spots:
            q = self.q_of(a, sp["raw"])
            for n, v in d.items(): q[n] += v
            tip, app = self.kin.fk(q); pan = -q["shoulder_pan"]
            lean = math.atan2(app[0] * math.cos(pan) + app[1] * math.sin(pan), -app[2])
            out += [tip[2] + app[2] * p[3] - z0, 0.06 * lean, math.hypot(tip[0] - 0.0388, tip[1]) - sp["r"]]      # the finger end is on the table; the tool is vertical (1° ~ 1 mm); the tip is where the ruler says
        return np.array(out + [0.003 * p[0], 0.003 * p[1], 0.003 * p[2]])

    def align_fit(self, apply=True):
        a = self._arm(); S = self.align_spots
        if len(S) < 3: raise RuntimeError(f"record at least 3 spots ({len(S)} so far)")
        rs = [sp["r"] for sp in S]
        if max(rs) - min(rs) < 0.08: raise RuntimeError("use spots at different distances: 12, 17 and 22 cm")
        p, lam = np.array([0.0, 0.0, 0.0, 0.01]), 1e-3
        for _ in range(60):
            r0 = self._align_res(a, p); c0 = float(r0 @ r0)
            J = np.stack([(self._align_res(a, p + np.eye(4)[i] * 1e-6) - r0) / 1e-6 for i in range(4)], 1)
            p2 = p - np.linalg.solve(J.T @ J + lam * np.eye(4), J.T @ r0); p2[3] = min(0.04, max(-0.01, p2[3])); r2 = self._align_res(a, p2)
            if float(r2 @ r2) < c0: p, lam = p2, lam * 0.3
            else: lam *= 10
            if lam > 1e8: break
        res = self._align_res(a, p)[:3 * len(S)]; zr, lr, rr = res[0::3] * 1000, np.degrees(res[1::3] / 0.06), res[2::3] * 1000
        info = dict(rad_res_mm=rr.tolist(), lift=math.degrees(p[0]), elbow=math.degrees(p[1]), flex=math.degrees(p[2]), tool_mm=p[3] * 1000, z_res_mm=zr.tolist(), lean_res_deg=lr.tolist(), r_mm=[round(r * 1000) for r in rs])
        if max(abs(zr)) > 7 or max(abs(lr)) > 3.5 or max(abs(rr)) > 12 or max(abs(info[k]) for k in ("lift", "elbow", "flex")) > 30:
            raise RuntimeError(f"the spots do not agree with each other (worst height error {max(abs(zr)):.0f} mm, worst lean {max(abs(lr)):.1f}°, worst distance error {max(abs(rr)):.0f} mm): were both finger tips flat on the table, exactly on the ruler marks? Clear the spots and redo them")
        if apply: self._align_apply(a, p, info)
        return info

    def _align_apply(self, a, p, info):
        viz = self.get_viz(); old_off = {n: viz.get("offset", {}).get(n, 0.0) for n in ("shoulder_lift", "elbow_flex", "wrist_flex")}
        d = {"shoulder_lift": p[0], "elbow_flex": p[1], "wrist_flex": p[2]}; S = self.align_spots
        zs = []
        for sp in S:
            q = self.q_of(a, sp["raw"])
            for n, v in d.items(): q[n] += v
            zs.append(float(self.kin.fk(q)[0][2]))
        new_zt = float(np.mean(zs))
        self.cfg["align_backup"] = dict(cams=[m for m in self.models], z_table=self.z_table, offsets=old_off, trim=self.cfg.get("pitch_trim_deg", 0.0))
        notes = self._remap_cameras(d)
        for n, v in d.items(): self.viz_set({"joint": n, "offset": old_off[n] + math.degrees(v)})
        self.cfg["z_table"] = new_zt; self.z_table = new_zt; self.cfg["pitch_trim_deg"] = 0.0
        self.cam = self.models[0]; self.cfg["cams"] = self.models; self.cfg["cam"] = self.models[0]; self._save(); self.align_spots = []
        self.status = (f"✓ model aligned: lift {info['lift']:+.1f}°, elbow {info['elbow']:+.1f}°, wrist {info['flex']:+.1f}°, table now {1000 * new_zt:.0f} mm (was {1000 * self.cfg['align_backup']['z_table']:.0f}); "
                       f"spots agree within {max(abs(v) for v in info['z_res_mm']):.1f} mm / {max(abs(v) for v in info['lean_res_deg']):.1f}°; " + "; ".join(notes))

    def apply_offsets(self, d_rad, new_zt, why=""):
        """Apply joint zero corrections found from hand-held poses: the twin and the kinematics use them, the camera models are re-mapped through them, the table height is reset, Undo restores everything."""
        viz = self.get_viz(); names = ("shoulder_lift", "elbow_flex", "wrist_flex"); d = {n: float(d_rad.get(n, 0.0)) for n in names}
        old_off = {n: viz.get("offset", {}).get(n, 0.0) for n in names}
        self.cfg["align_backup"] = dict(cams=[m for m in self.models], z_table=self.z_table, offsets=old_off, trim=self.cfg.get("pitch_trim_deg", 0.0))
        notes = self._remap_cameras(d)
        for n, v in d.items(): self.viz_set({"joint": n, "offset": old_off[n] + math.degrees(v)})
        old_zt = self.z_table; self.cfg["z_table"] = float(new_zt); self.z_table = float(new_zt); self.cfg["pitch_trim_deg"] = 0.0
        self.cam = self.models[0]; self.cfg["cams"] = self.models; self.cfg["cam"] = self.models[0]; self._save()
        self.status = f"✓ joint zeros corrected ({', '.join(f'{n.split(chr(95))[0]} {math.degrees(v):+.1f}°' for n, v in d.items() if v)}); table height {1000 * new_zt:.0f} mm (was {1000 * (old_zt or 0):.0f}); " + "; ".join(notes) + (f" · {why}" if why else "")

    def _remap_cameras(self, d):
        """The corrected joint zeros move every arm position by a few cm. Replay poses through each camera's OLD mapping (what it saw) with the NEW arm positions (where the arm really was) and refit each camera: no new calibration run needed."""
        zt = self.z_table; old, new = [], []
        for x in (0.10, 0.14, 0.18, 0.22, 0.26, 0.30):
            for y in (-0.20, -0.14, -0.08, -0.02, 0.04, 0.10, 0.16):
                for h in (0.0, 0.03, 0.07, 0.11):
                    q = self.kin.ik([x, y, zt + h], roll=0.0, tilt=0.0)
                    if not q: continue
                    o = self.kin.fk(q)[0]; q2 = dict(q)
                    for n, v in d.items(): q2[n] += v
                    old.append(o); new.append(self.kin.fk(q2)[0])
        old, new = np.float32(old), np.float32(new); notes = []
        for i, m in enumerate(self.models):
            if not m: continue
            K = np.array(m["K"]); rv, tv = np.array(m["rvec"]), np.array(m["tvec"])
            uv = cv2.projectPoints(old.reshape(-1, 1, 3), rv, tv, K, np.zeros(5))[0].reshape(-1, 2)
            ok = (uv[:, 0] > 0) & (uv[:, 0] < 640) & (uv[:, 1] > 0) & (uv[:, 1] < 480)
            if ok.sum() < 20: notes.append(f"camera {i + 1}: kept (too few points in view)"); continue
            O, U = new[ok], uv[ok].astype(np.float32)
            good, rv2, tv2 = cv2.solvePnP(O, U, K, None, rvec=rv.copy(), tvec=tv.copy(), useExtrinsicGuess=True, flags=cv2.SOLVEPNP_ITERATIVE)
            rms = float(np.sqrt(np.mean(np.sum((cv2.projectPoints(O.reshape(-1, 1, 3), rv2, tv2, K, np.zeros(5))[0].reshape(-1, 2) - U) ** 2, axis=1)))) if good else 1e9
            self.models[i] = dict(K=K.tolist(), rvec=rv2.ravel().tolist(), tvec=tv2.ravel().tolist(), rms=max(float(m.get("rms", 0.0)), rms), n=int(ok.sum()))
            notes.append(f"camera {i + 1} re-mapped ({rms:.1f} px)")
        return notes

    def align_clear(self): self.align_spots = []; self.status = "alignment spots cleared"

    def align_undo(self):
        b = self.cfg.get("align_backup")
        if not b: raise RuntimeError("nothing to undo")
        for n, v in b["offsets"].items(): self.viz_set({"joint": n, "offset": v})
        self.models = b["cams"]; self.cam = self.models[0]; self.cfg["cams"] = self.models; self.cfg["cam"] = self.models[0]
        self.cfg["z_table"] = b["z_table"]; self.z_table = b["z_table"]; self.cfg["pitch_trim_deg"] = b.get("trim", 0.0); self.cfg.pop("align_backup", None); self._save(); self.status = "alignment undone: the previous joint zeros, cameras and table height are back"

    def vertical_reset(self): self.cfg["pitch_trim_deg"] = 0.0; self._save(); self.status = "vertical reset to the model's own straight down"

    def tip_dir_now(self, a): return self.kin.fk(self.q_now(a))        # (tip xyz, approach direction)

    # ---------- teach ----------
    def teach(self, u, v):
        a = self._arm(); tip = self.tip_now(a)
        if a.torque_on: raise RuntimeError("the arm is not limp: press 'Make arm limp' first, then move it by hand")
        for p in self.cfg["points"]:
            if math.dist((p["x"], p["y"], p["z"]), tip) < 0.015:
                raise RuntimeError("the gripper tip hasn't moved since the last point: move it to a NEW spot on the table first")
        self.cfg["points"].append(dict(u=float(u), v=float(v), x=float(tip[0]), y=float(tip[1]), z=float(tip[2])))
        self._fit(); self._save()
        self.status = f"taught point {len(self.cfg['points'])}" + (f" · fit error {self.err_mm:.1f} mm" if self.err_mm is not None else " (need 3+)")

    # ---------- automatic table mapping: keychain pixel (camera) <-> gripper tip (joint angles) ----------
    def auto_start(self):
        if self.auto["on"]: return
        self.auto = dict(on=True, msg="Put the keychain flat on the table, then touch the gripper tip to its middle and hold still.", holding=0.0, kc="none")
        self._still_since = None
        threading.Thread(target=self._auto_loop, daemon=True).start()

    def auto_stop(self): self.auto["on"] = False

    def _auto_loop(self):
        """Records (keychain pixel, gripper-tip position) pairs when the arm is held still on the keychain. Exposes WHY it is waiting."""
        hist = collections.deque(maxlen=60); kc_hist = collections.deque(maxlen=12); kc = None; ref_area = 0.0; A = self.auto
        while A["on"]:
            time.sleep(0.1)
            try:
                a = self._arm()
                if a.torque_on: A.update(why="limp", holding=0.0); continue
                tip, appr = self.tip_dir_now(a); now = time.time(); hist.append((now, tip))
                tilt = math.degrees(math.acos(max(-1.0, min(1.0, -appr[2])))); A["tilt"] = round(tilt)
                f = self.found[0] if self.found else None
                if f:                                   # remember where the keychain lies while it is visible and not moving
                    kc_hist.append((now, f["u"], f["v"], f["area"], bool(f.get("partial"))))
                    if not f.get("partial"): ref_area = max(ref_area * 0.998, f["area"])
                    pts = [q for q in kc_hist if now - q[0] < 0.8]
                    if len(pts) >= 5 and max(math.dist((q[1], q[2]), (f["u"], f["v"])) for q in pts) < 4:
                        full = not f.get("partial") and f["area"] >= 0.8 * ref_area
                        if full or kc is None or math.dist((f["u"], f["v"]), kc[:2]) > 30: kc = (f["u"], f["v"], now)     # a moved keychain replaces the old memory
                A["kc"] = "seen" if f and not f.get("partial") else "hidden" if kc is not None and now - kc[2] < 90 else "none"
                recent = [t for tt, t in hist if now - tt < 1.2]
                still = len(recent) >= 8 and max(np.linalg.norm(r - tip) for r in recent) < 0.005
                P = self.cfg["points"]
                if tilt > 50: self._still_since = None; A.update(why="tilt", holding=0.0); continue
                if not still: self._still_since = None; A.update(why="move", holding=0.0); continue
                if kc is None or now - kc[2] > 90: A.update(why="kc", holding=0.0); continue
                if P:
                    dz = (tip[2] - float(np.median([q["z"] for q in P]))) * 1000; A["dz"] = round(dz)
                    if abs(dz) > 25: A.update(why="height", holding=0.0); continue
                if any(math.dist((q["x"], q["y"]), tip[:2]) < 0.04 or math.dist((q["u"], q["v"]), kc[:2]) < 25 for q in P): A.update(why="dup", holding=0.0); continue
                if self._still_since is None: self._still_since = now
                A.update(why="hold", holding=min(1.0, (now - self._still_since) / 1.4))
                if A["holding"] < 1.0: continue
                P.append(dict(u=float(kc[0]), v=float(kc[1]), x=float(tip[0]), y=float(tip[1]), z=float(tip[2])))
                self._fit(); self._save(); self._still_since = None
                A.update(why="saved", holding=0.0, saved_at=now, n=len(P))
                self.status = f"mapped spot {len(P)}" + (f" · fit error {self.err_mm:.1f} mm" if self.err_mm is not None else "")
            except Exception as e: A.update(why="error", err=str(e), holding=0.0)
        self._still_since = None

    # ---------- vision ----------
    def detect_now(self): return self.found

    def annotate(self, frame, cid=0):
        found = vision.detect(frame) or vision.detect(frame, min_area=250, min_fill=0.45)   # fall back to a partly hidden keychain
        self.founds[cid] = found; self._ft[cid] = time.time()
        if cid == 0: self.found = found
        if self.cfg.get("auto_bowl", True):                       # the bowl target follows the real bowl, wherever it is put
            b = vision.find_bowl(frame)
            if b:
                if cid == 0: z = self.cfg["zones"]["bowl"]; z["p"] = [b["u"], b["v"]]; z["r"] = b["r"] * 0.9       # pixel zone for the overlay
                try:
                    if self.z_table is not None and (self.models[cid] or (cid == 0 and self.H is not None)):
                        x, y = self.px2xy(b["u"], b["v"], cid, 0.045)
                        self._bowl_est[cid] = (x, y, b["r"] * 0.9 * self._mm_per_px(cid, b["u"], b["v"], 0.045), time.time())
                except Exception: pass
                self._fuse_bowl()
            if time.time() - self._rim_t[cid] > 0.5 and self.z_table is not None and self.models[cid]:
                self._rim_t[cid] = time.time(); pts = vision.bowl_rim_points(frame)
                if pts is not None: self._fit_rim(cid, pts)
        out = vision.draw(frame, found, self.cfg["zones"] if cid == 0 else None, self.cfg["points"] if cid == 0 else ())
        self._draw_tip(out, cid); self._draw_bowl(out, cid)
        cv2.putText(out, f"camera {cid + 1}", (8, 18), cv2.FONT_HERSHEY_SIMPLEX, .55, (255, 255, 255), 1, cv2.LINE_AA)
        return out

    def _draw_tip(self, out, cid):
        """Overlay where the calibration says the gripper tip is: a live visual check that the camera model matches reality."""
        m = self.models[cid] if cid < len(self.models) else None
        a = self.get_arm()
        if not m or not a or not a.online or a.cal() is None: return
        try:
            pt, _ = cv2.projectPoints(np.float32([self.tip_now(a)]).reshape(1, 1, 3), np.array(m["rvec"]), np.array(m["tvec"]), np.array(m["K"]), np.zeros(5))
            u, v = pt[0, 0]; cv2.drawMarker(out, (int(u), int(v)), (60, 220, 255), cv2.MARKER_CROSS, 18, 2)
            cv2.putText(out, "tip", (int(u) + 8, int(v) - 6), cv2.FONT_HERSHEY_SIMPLEX, .45, (60, 220, 255), 1, cv2.LINE_AA)
        except Exception: pass

    # ---------- motion ----------
    def _wait_stop(self, t):
        end = time.time() + t
        while time.time() < end:
            if self.abort: raise InterruptedError()
            self._beat = time.time(); time.sleep(0.03)

    def _guard(self, a, hits):
        """Load sensing on every motor: stop the move the moment something pushes back (collision, jam) or a motor runs hot."""
        for i, l in a.read_loads().items():
            if i == 6: continue                                   # the gripper is allowed to squeeze
            hits[i] = hits.get(i, 0) + 1 if abs(l) >= (850 if i == 5 else LOAD_LIMIT) else 0
            if hits[i] >= LOAD_COUNT: raise Overload(f"{NAMES[i]} pushing at {abs(l) / 10:.0f}% torque")
        for i, t in a.temp.items():
            if i in a.ids and t >= TEMP_LIMIT and not self.cfg.get("ignore_heat"): raise Overload(f"{NAMES[i]} is hot ({t} °C)")

    def _overload(self, e):
        try: self._arm().hold_here()                                   # stop pushing, keep holding
        except Exception: pass
        self.status = f"⚠ stopped by load sensing: {e}. The arm holds still."

    # ---------- the bowl as an obstacle ----------
    def _fit_rim(self, cid, pts):
        """The bowl's real rim circle on the table plane, from its outline in one camera. RANSAC, so a gripper or keychain hiding part of the outline doesn't spoil it."""
        hb = self.cfg.get("bowl_h", 0.076)
        try: w = np.array([self.px2xy(float(u), float(v), cid, hb) for u, v in pts])
        except Exception: return
        if len(w) < 30: return

        def circ(p):
            A = np.c_[2 * p[:, 0], 2 * p[:, 1], np.ones(len(p))]; s = np.linalg.lstsq(A, (p ** 2).sum(1), rcond=None)[0]
            return s[0], s[1], math.sqrt(max(s[2] + s[0] ** 2 + s[1] ** 2, 0.0))
        rng, best = np.random.default_rng(0), None
        for _ in range(300):
            try: x, y, r = circ(w[rng.choice(len(w), 3, replace=False)])
            except Exception: continue
            if not 0.065 < r < 0.125: continue
            n = int((np.abs(np.linalg.norm(w - [x, y], axis=1) - r) < 0.012).sum())
            if best is None or n > best[0]: best = (n, x, y, r)
        if best is None or best[0] < 0.45 * len(w): return
        inl = np.abs(np.linalg.norm(w - [best[1], best[2]], axis=1) - best[3]) < 0.012
        try: x, y, r = circ(w[inl])
        except Exception: return
        if not 0.065 < r < 0.125: return
        now = time.time(); self._rim_est[cid] = (x, y, r, float(inl.mean()), now)
        fresh = [e for e in self._rim_est if e and now - e[4] < 3.0]
        if len(fresh) > 1 and max(math.dist(p[:2], q[:2]) for p in fresh for q in fresh) > 0.03: fresh = [max(fresh, key=lambda e: e[3])]     # cameras disagree: trust the better fit
        W = sum(e[3] for e in fresh)
        self.rim = dict(x=sum(e[0] * e[3] for e in fresh) / W, y=sum(e[1] * e[3] for e in fresh) / W, r=sum(e[2] * e[3] for e in fresh) / W, t=now, cams=len(fresh))

    def bowl_geom(self):
        """(centre x, centre y, rim radius, rim height) of the bowl as the gripper must treat it, or None."""
        if not self.cfg.get("keepout", True): return None
        hb = self.cfg.get("bowl_h", 0.076)
        if self.rim and self.cfg.get("auto_bowl", True): return self.rim["x"], self.rim["y"], self.rim["r"], hb
        bz = self.zone_center("bowl")
        return (bz[0], bz[1], max(bz[2], 0.10) + 0.02, hb) if bz else None        # no rim fit: assume a generous circle

    def bowl_gap(self, x, y, z):
        """(distance from the bowl centre, distance the open gripper needs there) in metres, or None when the gripper is clear above the rim.
        The bowl is a cone (narrow at the table, widest at the rim). Fingers reach finger_len above the tip, so the wall that matters is the one at the top of the fingers;
        the gripper sticks out finger_rad along the arm (the jaws open radially) and finger_tan across it, measured towards the bowl."""
        g = self.bowl_geom()
        if g is None or self.z_table is None: return None
        cx, cy, R, hb = g; c = self.cfg; dz = max(0.0, z - self.z_table)
        if dz > hb + 0.02: return None
        dx, dy = cx - x, cy - y; dist = math.hypot(dx, dy)
        zp = min(dz + c["finger_len"], hb); base = c["bowl_base"] * R; Rz = base + (R - base) * zp / hb
        if dist < 1e-6: return 0.0, Rz
        pan = math.atan2(y, x); ux, uy = dx / dist, dy / dist
        ext = abs(ux * math.cos(pan) + uy * math.sin(pan)) * c["finger_rad"] + abs(-ux * math.sin(pan) + uy * math.cos(pan)) * c["finger_tan"]
        return dist, Rz + ext + c["bowl_clear"]

    def bowl_blocked(self, x, y, z, extra=0.0):
        g = self.bowl_gap(x, y, z - extra)        # extra widens the zone: treat the point as if it were lower
        return g is not None and g[0] < g[1] + extra

    def keepout(self):
        """For the UI: [(x, y, rim radius, height above the table)] of the bowl obstacle."""
        g = self.bowl_geom(); return [(g[0], g[1], g[2], g[3] + 0.02)] if g else []

    def near_bowl(self, x, y, z, extra=0.0): return self.bowl_blocked(x, y, z, extra)

    def _noentry(self):
        """Outline on the table (cached) of where the open gripper tip may not go: found by searching outwards from the bowl centre in 48 directions."""
        t = time.time()
        if t - self._ne[0] < 1.0: return self._ne[1]
        g = self.bowl_geom(); poly = None
        if g and self.z_table is not None:
            poly = []
            for k in range(48):
                a = 2 * math.pi * k / 48; lo, hi = 0.0, 0.35
                for _ in range(12):
                    mid = (lo + hi) / 2
                    if self.bowl_blocked(g[0] + mid * math.cos(a), g[1] + mid * math.sin(a), self.z_table + 0.004): lo = mid
                    else: hi = mid
                poly.append((g[0] + hi * math.cos(a), g[1] + hi * math.sin(a)))
        self._ne = (t, poly); return poly

    def _draw_bowl(self, out, cid):
        """Show what the arm believes about the bowl: white = rim circle, red = where the open gripper may not go (at table level)."""
        m = self.models[cid] if cid < len(self.models) else None
        g = self.bowl_geom()
        if not m or not g or self.z_table is None: return
        try:
            def proj(pts):
                p, _ = cv2.projectPoints(np.float32(pts).reshape(-1, 1, 3), np.array(m["rvec"]), np.array(m["tvec"]), np.array(m["K"]), np.zeros(5)); return p.reshape(-1, 2).astype(np.int32)
            rim = [(g[0] + g[2] * math.cos(a), g[1] + g[2] * math.sin(a), self.z_table + g[3]) for a in np.linspace(0, 2 * math.pi, 60, endpoint=False)]
            cv2.polylines(out, [proj(rim)], True, (255, 255, 255), 1, cv2.LINE_AA)
            ne = self._noentry()
            if ne: cv2.polylines(out, [proj([(x, y, self.z_table + 0.004) for x, y in ne])], True, (60, 60, 255), 2, cv2.LINE_AA)
        except Exception: pass

    def _check_path(self, q_from, q_to, n=24):
        if self.bowl_geom() is None: return
        tip0 = self.kin.fk(q_from)[0]; z0 = float(tip0[2]); start_in = self.bowl_blocked(*[float(v) for v in tip0])
        g0 = self.bowl_gap(*[float(v) for v in tip0]); start_near = g0 is not None and g0[0] < g0[1] + 0.015          # inside the zone, or within 15 mm outside it (the arm can be parked right on the line)
        for k in range(n + 1):
            f = k / n; f = f * f * (3 - 2 * f); q = {j: q_from[j] + (q_to[j] - q_from[j]) * f for j in ARM}; tip = [float(v) for v in self.kin.fk(q)[0]]
            if self.bowl_blocked(*tip):
                if start_in and tip[2] >= z0 - 0.002: continue          # already inside: leaving upward / level is allowed
                if start_near and tip[2] >= z0 - 0.002 and self.bowl_gap(*tip)[0] >= g0[0] - 0.006: continue          # parked just outside the line: going up is allowed, getting closer to the bowl is not
                g = self.bowl_gap(*tip)
                raise Collision(f"refused: that move would bring the gripper into the bowl (tip {1000 * (tip[2] - self.z_table):.0f} mm above the table, {1000 * g[0]:.0f} mm from the bowl centre, needs {1000 * g[1]:.0f} mm). Move the object or the bowl apart")

    def _move_q(self, a, q, dur):
        self._check_path(self.q_now(a), q)
        goal = {i: v for i, v in self.ticks(a, q).items() if i in a.ids}; start = {i: a.pos[i] for i in goal}; hits = {}; lost = 0; gref, gsg = self._grip_params(a) if self._holding else (0, 1)
        n = max(2, int(dur * 25))
        for k in range(1, n + 1):
            if self.abort: raise InterruptedError()
            self._beat = time.time(); self._guard(a, hits)
            if self._holding:                                            # carrying: if the fingers close up the keychain is gone: stop right here
                gap = (a.pos[6] - gref) * gsg; lost = lost + 1 if gap < 0.6 * GRIP_MIN_GAP else 0
                if lost >= 4:
                    try: a.hold_here()
                    except Exception: pass
                    raise GraspFailed(f"the keychain slipped out of the gripper on the way (fingers closed to a {gap:.0f}-tick gap)")
            s = k / n; s = s * s * (3 - 2 * s)
            a.goto({i: start[i] + (goal[i] - start[i]) * s for i in goal}); time.sleep(0.04)
        for _ in range(40):                                  # settle within ~1.6 s
            if all(abs(a.pos[i] - goal[i]) < 25 for i in goal): break
            self._wait_stop(0.04)

    def _roll_for(self, a, x, y, yaw_deg, pan):
        r = yaw_deg - math.degrees(pan) + self.cfg["roll_offset"]
        return math.radians(((r + 90) % 180) - 90)           # parallel jaws: 180° symmetric

    def goto_xyz(self, a, x, y, z, yaw_deg=0.0, dur=None, keep_roll=False, min_h=None, raw=False, tilt=None):
        tl = self.trim() if tilt is None else tilt                  # + = fingers lean away from the base: a leaning tool reaches farther (used only to drop into a far bowl)
        if not raw: x, y = x + self.cfg.get("off_x", 0.0), y + self.cfg.get("off_y", 0.0)
        q, floor_z = None, (self.z_table + max(0.03, min_h or 0.0) if self.z_table is not None else z)
        for k in range(0, 12):                      # travel/hover moves may be lowered until the arm can reach (never below table + 30 mm)
            zz = z - 0.01 * k; self._beat = time.time()               # an IK attempt that fails can take seconds on a slow machine: that is working, not stuck
            if k and zz < floor_z: break
            q = self.kin.ik([x, y, zz], roll=0.0, tilt=tl)
            if q: z = zz; break
        if q is None: raise RuntimeError(f"target out of reach ({x:.3f}, {y:.3f}, {z:.3f}) m")
        q["wrist_roll"] = self.q_now(a)["wrist_roll"] if (keep_roll or self.cfg.get("keep_roll", True)) else self._roll_for(a, x, y, yaw_deg, q["shoulder_pan"])   # the roll motor strains against its cable: keep it still
        q2 = self.kin.ik([x, y, z], roll=q["wrist_roll"], tilt=tl) or q
        cur = self.q_now(a); dist = max(abs(math.degrees(q2[n] - cur[n])) for n in ARM)
        self._move_q(a, q2, dur or max(1.4, dist / 22))

    def grip(self, a, pct, t=0.8):
        a.goto({6: self.grip_tick(a, pct)}); self._wait_stop(t)

    def touch_down(self, a, x, y, z_hi, z_lo):
        """Lower the tip in 1.5 mm steps while watching the motors' load and position error; stop the moment they feel the table.
        Returns the height where contact was felt, or None if nothing was felt down to z_lo."""
        roll = self.q_now(a)["wrist_roll"]; z, base = z_hi, None
        while z >= z_lo:
            if self.abort: raise InterruptedError()
            self._beat = time.time()
            q = self.kin.ik([x, y, z], roll=roll, tilt=self.trim())
            if q is None: return None
            goal = self.ticks(a, q); a.goto(goal); time.sleep(0.24)
            ld = max(abs(v) for i, v in a.read_loads().items() if i in (2, 3, 4)); err = max(abs(a.pos[i] - goal[i]) for i in (2, 3, 4))
            if base is None: base = (err, ld)
            self.status = f"touching down: {1000 * (z - self.z_table):+.0f} mm from the expected table, load {ld / 10:.0f}%"
            if err > base[0] + 14 or ld > base[1] + 110: return float(self.tip_now(a)[2])
            z -= 0.0015
        return None

    def see_check(self, a):
        """Right before closing: wait for fresh frames from every camera and look again. Is the keychain still where the fingers are?
        'ok' = seen within 22 mm of the tip, 'moved' = clearly somewhere else, 'unsure' = partly hidden by the gripper, 'unseen' = hidden from every camera."""
        t0 = time.time()
        while time.time() - t0 < 1.0 and any(self._ft[i] < t0 for i in self.usable()): self._wait_stop(0.05)
        loc = self.locate(); tip = self.tip_now(a)
        if loc is None: return dict(state="unseen")
        e = math.hypot(loc["x"] + self.cfg.get("off_x", 0.0) - tip[0], loc["y"] + self.cfg.get("off_y", 0.0) - tip[1])
        if loc.get("partial") or len(loc["cams"]) < 2:                                  # the gripper hides part of it: its visible centre is biased, so be lenient
            return dict(state="ok" if e <= 0.035 else ("moved" if e > 0.07 else "unsure"), err=e, cams=loc["cams"])
        return dict(state="ok" if e <= 0.022 else "moved", err=e, cams=loc["cams"])

    def squeeze(self, a):
        """Close the gripper slowly and watch the ARM while it closes. If the moving jaw lands on the table it pushes the arm (and the fixed jaw) up:
        the tip rises or the tool tilts, or the lift motors load up, before the jaws meet the keychain. Returns dict(event 'held'|'empty'|'pushed', gap, load, why)."""
        p0 = a.read_pos(); q0 = self.q_of(a, {**a.pos, **p0}); tip0, app0 = self.kin.fk(q0); z0 = float(tip0[2])
        ld0 = {i: abs(v) for i, v in a.read_loads().items() if i in (2, 3, 4)}
        a.set_grip_torque(250)                                                          # gentle until the jaws have something: a jaw on the table then pushes less
        closed = self.grip_tick(a, 0); start = int(a.pos[6]); n, hist, ev, why = 45, [], "empty", ""
        for k in range(1, n + 1):
            if self.abort: raise InterruptedError()
            self._beat = time.time(); tgt = int(start + (closed - start) * k / n); a.goto({6: tgt}); time.sleep(0.045)
            p = a.read_pos(); pos = {**a.pos, **p}; q = self.q_of(a, pos); tip, app = self.kin.fk(q)
            lift = float(tip[2]) - z0; dtilt = math.degrees(math.acos(max(-1.0, min(1.0, float(app @ app0)))))
            ld = {i: abs(v) for i, v in a.read_loads().items() if i in (2, 3, 4)}; rise = max((ld[i] - ld0.get(i, 0) for i in ld), default=0)
            if abs(lift) > 0.0012 or dtilt > 1.5 or rise > 120:
                ev = "pushed"; why = f"the tip moved {1000 * lift:+.1f} mm, the tool tilted {dtilt:.1f}°, a lift motor's load rose {rise / 10:.0f}% while the gripper was still {self.grip_gap(a):.0f} ticks open"; break
            hist.append(p.get(6, a.pos[6]))
            if k > 8 and len(hist) > 6 and abs(hist[-1] - hist[-6]) < 3 and abs(hist[-1] - tgt) > 25: ev = "held"; break      # the jaws stopped on something
        time.sleep(0.15); gap = self.grip_gap(a) if ev != "pushed" else (a.pos[6] - self._grip_params(a)[0]) * self._grip_params(a)[1]
        if ev == "held" and gap < GRIP_MIN_GAP: ev = "empty"
        return dict(event=ev, gap=gap, load=abs(a.read_loads().get(6, 0)), why=why)

    def scene_check(self, kc):
        """At the start of every attempt, look at everything again: both cameras fresh and in agreement, the bowl rim fitted just now."""
        t0 = time.time()
        while time.time() - t0 < 2.5 and (any(self._ft[i] < t0 for i in self.usable()) or (self.models[0] and (self.rim is None or time.time() - self.rim["t"] > 5.0))): self._wait_stop(0.1)
        note = f"re-seen: keychain by camera {' + '.join(str(i + 1) for i in kc['cams'])}" + (f", cameras agree within {kc['spread'] * 1000:.0f} mm" if len(kc["cams"]) > 1 else "")
        if self.rim and time.time() - self.rim["t"] < 6: note += f", bowl rim {self.rim['r'] * 2000:.0f} mm wide fitted just now"
        if len(kc["cams"]) > 1 and kc["spread"] > 0.03: note += f" · WARNING: the cameras disagree by {kc['spread'] * 1000:.0f} mm: the camera mapping is off"
        self.status = note

    def _axis_world(self, kc):
        """Unit vector (x, y on the table) along the keychain's long axis, from its detected angle in the first camera that sees it; None if it cannot be told."""
        try:
            cid = kc["cams"][0]; ang = math.radians(kc["angle"]); p0 = np.array(self.px2xy(kc["u"], kc["v"], cid, 0.004)); p1 = np.array(self.px2xy(kc["u"] + 20 * math.cos(ang), kc["v"] + 20 * math.sin(ang), cid, 0.004))
            d = p1 - p0; n = float(np.linalg.norm(d)); return d / n if n > 1e-6 else None
        except Exception: return None

    def pick(self, a, kc, hover_only=False, attempt=1):
        x, y = kc["x"], kc["y"]; yaw = 0.0
        zt, c = self.z_table, self.cfg
        if attempt > 1 and not hover_only:                          # same spot failed before: shift a little sideways (across the pan direction) instead of repeating the same miss
            ax = self._axis_world(kc)
            if ax is not None:                                      # a miss is most likely ALONG the keychain (measured 2026-10-30: fingertips 3 cm towards the ring end): try that first, then across it
                cands = [(x + d * ax[0], y + d * ax[1]) for d in (0.015, -0.015, 0.03, -0.03)] + [(x + d * -ax[1], y + d * ax[0]) for d in (0.012, -0.012)]
            else:
                pan = math.atan2(y, x); tx, ty = -math.sin(pan), math.cos(pan)
                cands = [(x + d * tx, y + d * ty) for d in (0.012, -0.012, 0.024, -0.024)]
            cands = [p for p in cands if not self.near_bowl(p[0], p[1], zt + 0.004) and not self.near_bowl(p[0], p[1], zt + c["travel"])] or [(x, y)]     # only shift to spots the bowl rule still allows
            x, y = cands[(attempt - 2) % len(cands)]
        tip0 = self.tip_now(a); near = self.near_bowl(tip0[0], tip0[1], tip0[2], 0.03) or self.near_bowl(x, y, zt + c["travel"], 0.05)
        if self.near_bowl(x, y, zt + 0.004):
            g = self.bowl_gap(x, y, zt + 0.004); raise Collision(f"the keychain is too close to the bowl: the open gripper needs {1000 * g[1]:.0f} mm from the bowl centre there, it is {1000 * g[0]:.0f} mm. Move it about {max(1, math.ceil((g[1] - g[0]) * 100 + 1)):.0f} cm further away")
        self.status = "opening gripper"; self.grip(a, 100, 0.6)
        if near and self.bowl_geom():
            hh, mh = c.get("bowl_h", 0.076) + 0.05, c.get("bowl_h", 0.076) + 0.03; self.status = "lifting clear of the bowl"      # high route: rim + 5 cm (may sink to rim + 3 cm if out of reach)
            self.goto_xyz(a, float(tip0[0]), float(tip0[1]), zt + hh, yaw, raw=True, min_h=mh)
            self.status = "moving above keychain (high, clear of the bowl)"; self.goto_xyz(a, x, y, zt + hh, yaw, min_h=mh)
            self.goto_xyz(a, x, y, zt + c["travel"], yaw, dur=1.2)
        else: self.status = "moving above keychain"; self.goto_xyz(a, x, y, zt + c["travel"], yaw)
        if hover_only: return
        self.status = "descending"; self.goto_xyz(a, x, y, zt + 0.02, yaw, dur=2.0)
        contact = self.touch_down(a, x, y, zt + 0.02, zt - 0.006)              # always feel for the table instead of trusting a fixed height
        if contact is None: self.status = "no table felt down to 6 mm below the expected height: gripping there"; zg = zt - 0.006
        else:
            self.table_err = contact - zt
            if self.table_err > 0.004:                                          # the fingertips did not reach the table: a finger is resting ON TOP of the keychain (it is ~10 mm thick), so closing would grab nothing
                self.goto_xyz(a, x, y, zt + c["travel"], yaw, dur=1.2)
                raise GraspFailed(f"the fingertips stopped {1000 * self.table_err:.0f} mm above the table, so a finger is resting on top of the keychain: not closing (the spot is off by about a finger width)")
            zg = contact + c.get("grasp_dz", 0.004)                              # pinch the keychain mid-height, not at the table: the moving jaw must stay clear of the table
            self.status = f"touched the table at {contact * 1000:.0f} mm (expected {zt * 1000:.0f})" + ("" if abs(self.table_err) < 0.01 else ": that is off by more than 1 cm, re-measure the table height")
            self.goto_xyz(a, x, y, zg, yaw, dur=0.6)                            # back off so the fixed jaw hovers just above the table
        self._wait_stop(0.3); seen = self.see_check(a)                          # look again with every camera BEFORE the fingers close
        if seen["state"] == "moved":
            self.goto_xyz(a, x, y, zt + c["travel"], yaw, dur=1.2)
            raise GraspFailed(f"the keychain is not between the fingers any more (the cameras see it {1000 * seen['err']:.0f} mm away: it was pushed): not closing")
        self.status = {"ok": f"cameras confirm the keychain is between the fingers (within {1000 * seen.get('err', 0):.0f} mm): closing slowly", "unseen": "keychain hidden by the gripper from every camera: closing slowly (unconfirmed)", "unsure": f"keychain partly hidden (cameras say {1000 * seen.get('err', 0):.0f} mm off): closing slowly"}[seen["state"]]
        r = self.squeeze(a); gap, ld = r["gap"], r["load"]
        if r["event"] == "pushed":
            self.grip(a, 100, 0.6); a.set_grip_torque(450); old = c.get("grasp_dz", 0.004); new = min(0.009, old + 0.003)
            self.goto_xyz(a, x, y, zt + c["travel"], yaw, dur=1.2)
            if new > old: c["grasp_dz"] = new; self._save()
            raise GraspFailed(f"the moving jaw touched the table and pushed the arm: {r['why']}. " + (f"Next try grips {1000 * new:.0f} mm above the table (was {1000 * old:.0f})." if new > old else "Already at the highest safe grip height: check the alignment and that the gripper is straight down."))
        a.set_grip_torque(450)
        if gap < GRIP_MIN_GAP:
            self.goto_xyz(a, x, y, zt + c["travel"], yaw, dur=1.2)
            raise GraspFailed(f"nothing between the fingers after closing (gap {gap:.0f} ticks, needs {GRIP_MIN_GAP}+; load {ld / 10:.0f}%)")
        s_t, lat_t = self.tool_tilt(a)
        self.status = f"holding something: finger gap {gap:.0f} ticks, load {ld / 10:.0f}%, lean {s_t - c.get('pitch_trim_deg', 0.0):+.1f}° in the arm's plane / {lat_t:+.1f}° sideways (0 = straight down)"; self._holding = True
        self.status = "lifting"; self.goto_xyz(a, x, y, zt + c["travel"], yaw, dur=2.0)
        gap = self.grip_gap(a)
        if gap < GRIP_MIN_GAP: raise GraspFailed(f"the keychain did not come up with the gripper (gap {gap:.0f} ticks)")
        self.status = f"lifted with the keychain (finger gap {gap:.0f} ticks)"

    def place(self, a, zone, yaw_deg=0.0):
        """Carry the keychain over to a zone: straight up first, over at a height that clears the bowl rim, then down, release, and back up."""
        zc = self.zone_center(zone)
        if zc is None: raise RuntimeError(f"I can't find the {zone}: put it where a camera can see it")
        x, y = zc[0], zc[1]; zt, c = self.z_table, self.cfg
        drop = self.cfg["zones"][zone]["drop"]
        clear = max(c["travel"], drop) if zone == "bowl" else c["travel"]
        min_h = (c.get("bowl_h", 0.076) + 0.03) if zone == "bowl" else None            # never lower than rim + 3 cm while near the bowl
        tilt = None
        if zone == "bowl":                                                             # a far bowl cannot be reached 12 cm up with the gripper straight down (2026-10-30: bowl 22 cm out, limit 9 cm, and the bowl rule needs rim + 3 cm): lean the tool a few degrees instead (the release does not need it vertical)
            rim = c.get("bowl_h", 0.076); ox, oy = c.get("off_x", 0.0), c.get("off_y", 0.0); hmin = rim + 0.03
            hf = hmin + 0.006                                                          # the lowest flight height the bowl rule allows (plus a little): if it can be reached, flying there is enough. (A failed reach test costs ~2 s, so only this one height is tried per lean.)
            for deg in (0, 10, 20, 25):
                if self.kin.ik([x + ox, y + oy, zt + hf], roll=0.0, tilt=math.radians(deg) + (self.trim() if deg == 0 else 0.0)):
                    tilt = None if deg == 0 else math.radians(deg); clear = drop = max(hf, min(clear, hf + 0.004)); break
            else: raise RuntimeError(f"the bowl is too far from the arm to drop into, even with the gripper leaning 25 degrees (the rim is {1000 * rim:.0f} mm high): move the bowl closer to the arm")
        cx, cy = [float(v) for v in self.tip_now(a)[:2]]
        self.status = "lifting clear"; self.goto_xyz(a, cx, cy, zt + clear, yaw_deg, min_h=min_h, raw=True, tilt=tilt)
        self.status = f"carrying over the {zone}"; self.goto_xyz(a, x, y, zt + clear, yaw_deg, min_h=min_h, tilt=tilt)
        self.status = "lowering"; self.goto_xyz(a, x, y, zt + drop, yaw_deg, dur=2.0, min_h=min_h, tilt=tilt)
        if self.grip_gap(a) < GRIP_MIN_GAP: raise GraspFailed("the keychain is no longer in the gripper above the " + zone)
        self._holding = False; self.status = "releasing"; self.grip(a, 100, 0.9)
        self.status = "retreating up"; self.goto_xyz(a, x, y, zt + clear, yaw_deg, dur=1.6, min_h=min_h, tilt=tilt)

    def _recover(self, a):
        """After a failed grasp or a drop: open the fingers, go straight up, then park high over the bowl so the cameras see the table again."""
        self._holding = False; c = self.cfg; zt = self.z_table
        try:
            self.grip(a, 100, 0.6); cx, cy = [float(v) for v in self.tip_now(a)[:2]]
            clear = max(c["travel"], c["zones"]["bowl"]["drop"]); mh = c.get("bowl_h", 0.076) + 0.03
            self.goto_xyz(a, cx, cy, zt + clear, 0.0, dur=1.6, raw=True, min_h=mh)
            bz = self.zone_center("bowl")
            if bz: self.goto_xyz(a, bz[0], bz[1], zt + clear, 0.0, min_h=mh, raw=True)
        except (InterruptedError, Overload): raise
        except Exception as e: self.status = f"{self.status} (could not park: {e})"

    # ---------- run / stop ----------
    # ---------- has a camera been moved since it was calibrated? ----------
    def cam_ref_path(self, i): return os.path.expanduser(f"~/.so101_camref/cam{i + 1}.png")

    def save_cam_refs(self, ids=None):
        """Remember what each camera sees right now: the calibration just done belongs to this picture. Later pictures are compared to it."""
        try:
            os.makedirs(os.path.expanduser("~/.so101_camref"), exist_ok=True)
            for i in (range(self.ncam) if ids is None else ids):
                fr = self.get_frame(i)
                if fr is not None: cv2.imwrite(self.cam_ref_path(i), fr)
        except Exception: pass
        self.check_cams()

    def _mm_per_px(self, i):
        """Millimetres on the table per picture pixel near the middle of camera i's picture (0.5 for camera 1, about 1.2 for camera 2)."""
        try:
            m = self.models[i]
            if not m: return 1.0
            a = np.array(self._model_point(m, 320, 240)); b = np.array(self._model_point(m, 330, 240)); return float(np.linalg.norm(a - b) * 100)
        except Exception: return 1.0

    def _model_point(self, m, u, v):
        K = np.array(m["K"]); R, _ = cv2.Rodrigues(np.array(m["rvec"])); t = np.array(m["tvec"]); d = R.T @ np.linalg.solve(K, np.array([u, v, 1.0])); C = -R.T @ t
        return (C + ((self.z_table if self.z_table is not None else 0.0) - C[2]) / d[2] * d)[:2]

    def check_cams(self):
        """Compare each camera's picture now with the one saved when it was calibrated: ok / moved (+ pixels) / noref / unsure / nopic / uncal."""
        for i in range(self.ncam):
            try:
                if not (self.models[i] or (i == 0 and self.H is not None)): self.cam_chk[i] = dict(state="uncal"); continue
                ref = cv2.imread(self.cam_ref_path(i)) if os.path.exists(self.cam_ref_path(i)) else None      # (a missing file makes OpenCV print a warning every check)
                if ref is None: self.cam_chk[i] = dict(state="noref"); continue
                fr = self.get_frame(i)
                if fr is None or time.time() - self._ft[i] > 5: self.cam_chk[i] = dict(state="nopic"); continue
                r = drift_between(ref, fr)
                if r.get("state") in ("ok", "moved"):                  # judge by millimetres on the table, not pixels
                    mm = r["shift_px"] * self._mm_per_px(i); r["shift_mm"] = round(mm, 1); r["state"] = "moved" if mm > CAM_MOVED_MM else "ok"
                self.cam_chk[i] = r
            except Exception as e: self.cam_chk[i] = dict(state="unsure", why=str(e)[:60])

    def _camwatch(self):
        time.sleep(6)                                           # let the first pictures arrive: checked once at start-up, then every 15 s
        while True:
            try: self.check_cams()
            except Exception: pass
            time.sleep(15)

    def cam_problem(self):
        """One plain sentence when a camera cannot be trusted right now, else None."""
        mode = str(self.cfg.get("cam_mode", "auto")); used = range(self.ncam) if mode == "auto" else [int(mode)]
        for i, c in enumerate(self.cam_chk):
            if i in used and c.get("state") == "moved": return f"camera {i + 1} has moved about {round(c.get('shift_mm', c['shift_px']) / 5) * 5:.0f} mm on the table ({c['shift_px']:.0f} px) since it was calibrated"
        loc = self.locate() if self.usable() else None
        if loc and len(loc["cams"]) > 1 and loc["spread"] > CAM_AGREE: return f"camera 1 and camera 2 put the keychain about {round(loc['spread'] * 100) * 10:.0f} mm apart (the limit is {CAM_AGREE * 1000:.0f} mm), so one of them is out of date"
        return None

    def ready(self, mode=None):
        if not any(self.models) and self.H is None: return "Calibrate the camera first: press “Tune…” then “Auto-calibrate” (or press “Re-map the table”)"
        if self.z_table is None: return "Find the table height first: press “Tune…” then “Find by touching”"
        prob = self.cam_problem()
        if prob: return f"Not picking: {prob}. Press “Tune…” then “Auto-calibrate”"
        for n in (["bowl"] if mode == "bowl" else ORDER):
            if self.zone_center(n) is None: return ("I can't see the pink bowl: put it where a camera can see it" if n == "bowl" else f"Set the {n} position first (Set {n}, then click it in the camera picture)")
        try: self._arm()
        except Exception as e: return str(e)
        return None

    def run(self, mode, cycles):
        if self._busy(): return
        self.check_cams()                                       # look again right now, not only at the last 15 s check
        err = self.ready(mode)
        if err: self.status = err; return
        self.abort = False; self.running = True; self.mode = mode; self.cycles = 0
        threading.Thread(target=self._job, args=(mode, int(cycles)), daemon=True).start()

    def _job(self, mode, cycles):
        try:
            a = self._arm(); a.arm_motion(True); attempts = 0; fails = 0; placed = False; problem = ""; self.history.clear()
            if mode != "hover": self.measure_empty(a)
            while True:
                kc = self.locate()
                if kc is None:
                    self.status = ("✔ released over the bowl and the keychain is no longer visible: it is probably inside the bowl (the cameras cannot see into it): please look" if placed
                                   else "no red keychain visible to a calibrated camera: stopping")
                    break
                here = self.zone_of_world(kc["x"], kc["y"]); self.fusion = dict(cams=[i + 1 for i in kc["cams"]], spread_mm=round(kc["spread"] * 1000))
                if len(kc["cams"]) > 1 and kc["spread"] > CAM_AGREE:        # averaging two disagreeing cameras lands in neither place: refuse BEFORE moving
                    self.status = (f"✗ not moving: camera 1 and camera 2 put the keychain {kc['spread'] * 1000:.0f} mm apart (the limit is {CAM_AGREE * 1000:.0f} mm), so at least one camera is out of date, "
                                   f"usually because it was moved. Re-do the camera calibration, then start again"); break
                if mode == "hover":
                    self.pick(a, kc, hover_only=True)
                    self.status = f"hover test done: keychain located by camera {' + '.join(str(i + 1) for i in kc['cams'])}, cameras agree within {kc['spread'] * 1000:.0f} mm"; break
                if mode == "bowl":
                    if here == "bowl": self.status = "✅ done: the keychain is in the bowl"; break
                    dest = "bowl"
                else:
                    if mode == "goal" and here == ORDER[-1]: self.status = f"✅ goal reached: keychain is in the {ORDER[-1]}"; break
                    if mode == "goal": dest = ORDER[ORDER.index(here) + 1] if here in ORDER else ORDER[0]
                    else: dest = ORDER[(ORDER.index(here) + 1) % len(ORDER)] if here in ORDER else ORDER[0]
                    if mode == "goal" and here is not None and here == dest: continue
                attempts += 1
                if attempts > (4 if mode != "loop" else 10 ** 6): self.status = f"gave up after 4 tries ({fails} failed grasps). Last problem: {problem}"; break
                try:
                    self.scene_check(kc); self.pick(a, kc, attempt=fails + 1); self.place(a, dest)
                except GraspFailed as e:
                    fails += 1; problem = str(e); self.status = f"✗ {e}: going back up and trying again"; self._recover(a); continue
                finally: self._holding = False
                self._wait_stop(1.2); after = self.locate(); placed = True
                ok = bool(after) and self.zone_of_world(after["x"], after["y"]) == dest
                self.status = f"keychain {'is in' if ok else 'NOT confirmed in'} the {dest}" + ("" if ok or not after else f" (seen at {after['x'] * 1000:.0f}, {after['y'] * 1000:.0f} mm)")
                if ok: self.cycles += 1; attempts = 0; fails = 0; placed = False
                if mode == "loop" and cycles and self.cycles >= cycles: break
        except InterruptedError: self.status = "stopped (arm holding position)"; self._hold_quiet()
        except Overload as e: self._overload(e)
        except Exception as e: self.status = f"error: {e}"; self._hold_quiet()
        finally:
            self.running = False; self._holding = False
            try: pathlib.Path("~/.so101_lastrun.log").expanduser().write_text("\n".join(f"{time.strftime('%H:%M:%S', time.localtime(t))}  {m}" for t, m in self.history))
            except Exception: pass

    # ---------- table map from the arm's own fingertips (no keychain) ----------
    def calib_tip(self):
        """Hover the fingertips just above the table over a grid, find them in camera 1's picture (lowest point of the black gripper) and fit pixel -> table.
        The truth is the arm's forward kinematics; nothing held in the gripper can hide or bias it (a held keychain did: docs/LEARNINGS.md section 18)."""
        if self._busy(): return
        self.abort = False; self.running = True; self.mode = "scan"
        def job():
            try:
                a = self._arm(); a.arm_motion(True); zt = self.z_table if self.z_table is not None else -0.008
                ref = self.get_frame(0); ref = None if ref is None else ref.copy()            # the view with the arm still folded at rest: the fingertip is found as what CHANGED
                self.status = "table scan: lifting the arm straight up first (clear of the bowl)"
                cx, cy = [float(v) for v in self.tip_now(a)[:2]]; bh = self.cfg.get("bowl_h", 0.076)
                try: self.goto_xyz(a, cx, cy, zt + bh + 0.05, 0.0, dur=2.5, raw=True, min_h=bh + 0.03, keep_roll=True)
                except RuntimeError: pass
                grid = [(x, y) for j, y in enumerate((-140, -90, -40, 10, 60)) for x in ((140, 180, 220, 260) if j % 2 == 0 else (260, 220, 180, 140))]
                self.grip(a, 0, 0.8)                                  # jaws together: one pair of fingertips, the point the arm's kinematics describe
                loc = self.locate()                                   # never hover the fingertips over the keychain lying on the table (the camera's idea of where it is can be 3 cm off: keep 75 mm clear)
                if loc: grid = [(x, y) for (x, y) in grid if math.hypot(x / 1000 - loc["x"], y / 1000 - loc["y"]) > 0.075]
                pts = []
                for k, (x, y) in enumerate(grid):
                    if self.abort: raise InterruptedError()
                    self.status = f"table scan: position {k + 1}/{len(grid)} (fingertips found so far: {len(pts)})"
                    try: self.goto_xyz(a, x / 1000, y / 1000, zt + 0.010, 0.0, keep_roll=True, raw=True)
                    except RuntimeError: continue
                    self._wait_stop(1.0); tip = self.tip_now(a); seen = []
                    for _ in range(4):
                        fr = self.get_frame(0)
                        d = (vision.find_fingertip_diff(ref, fr) if ref is not None else vision.find_fingertip(fr)) if fr is not None else None
                        if d: seen.append((d["u"], d["v"]))
                        self._wait_stop(0.15)
                    if len(seen) >= 3: u, v = np.median(np.array(seen), axis=0); pts.append(dict(u=float(u), v=float(v), x=float(tip[0]), y=float(tip[1]), z=float(tip[2])))
                if len(pts) < 8: raise RuntimeError(f"found the fingertips in only {len(pts)} positions (need 8): is camera 1 showing the table?")
                uv = np.array([[q["u"], q["v"]] for q in pts]); spread = float(max(uv[:, 0].max() - uv[:, 0].min(), uv[:, 1].max() - uv[:, 1].min()))
                if spread < 60 or int((uv[:, 1] >= 470).sum()) > len(pts) // 2: raise RuntimeError("the fingertip detections are not credible (almost all at the bottom edge or in one spot of the picture): camera 1 is probably black, covered or looking at something else. The old table map was kept")
                old_pts = self.cfg.get("points", []); self.cfg["points_before_scan"] = old_pts; self.cfg["points"] = pts; self._fit()
                if self.H is None or self.err_mm is None:
                    self.cfg["points"] = old_pts; self._fit(); raise RuntimeError("the scanned fingertip positions do not give a valid table map: the old map was kept")
                self.cfg["cam_mode"] = "0"; self._save(); self.save_cam_refs([0])
                self.status = f"✓ table map from {len(pts)} fingertip positions: error {self.err_mm:.1f} mm. Camera 1 only is used for picking now (camera 2 is not calibrated this way yet)"
            except InterruptedError: self.status = "stopped (arm holding position)"; self._hold_quiet()
            except Overload as e: self._overload(e)
            except Exception as e: self.status = f"error: {e}"; self._hold_quiet()
            finally: self.running = False
        threading.Thread(target=job, daemon=True).start()

    def goto_robot(self, x, y, zrel, yaw=0.0):
        """Move the tip to a robot-frame spot (metres) at zrel above the table. Used to calibrate/inspect the camera mapping."""
        if self._busy(): return
        self.abort = False; self.running = True; self.mode = "goto"
        def job():
            try:
                a = self._arm(); a.arm_motion(True); self.status = f"moving to ({x*1000:.0f}, {y*1000:.0f}) mm"
                zt = self.z_table if self.z_table is not None else -0.008
                self.goto_xyz(a, x, y, zt + zrel, yaw); self.status = f"at ({x*1000:.0f}, {y*1000:.0f}), {zrel*1000:.0f} mm above table"
            except InterruptedError: self.status = "stopped (arm holding position)"; self._hold_quiet()
            except Overload as e: self._overload(e)
            except Exception as e: self.status = f"error: {e}"; self._hold_quiet()
            finally: self.running = False
        threading.Thread(target=job, daemon=True).start()

    # ---------- table height: lower the tip until the motors start to push back ----------
    def probe_table(self, x=0.20, y=-0.09):
        if self._busy(): return
        self.abort = False; self.running = True; self.mode = "probe"
        def job():
            try:
                a = self._arm(); a.arm_motion(True); zt = self.z_table if self.z_table is not None else -0.008
                self.status = "probe: moving above the table"; self.goto_xyz(a, x, y, zt + 0.05, 0.0); self._wait_stop(0.8)
                z, hit, base = zt + 0.05, None, None; roll = self.q_now(a)["wrist_roll"]
                while z > zt - 0.07:
                    if self.abort: raise InterruptedError()
                    q = self.kin.ik([x, y, z], roll=roll, tilt=self.trim())
                    if q is None: raise RuntimeError("probe position is out of reach")
                    goal = self.ticks(a, q); a.goto(goal); time.sleep(0.32)
                    err = max(abs(a.pos[i] - goal[i]) for i in (2, 3, 4)); ld = max(abs(v) for i, v in a.read_loads().items() if i in (2, 3, 4))
                    if base is None: base, lbase = err, ld
                    self.status = f"probe: {1000 * (z - zt):.0f} mm above the old estimate, load {ld / 10:.0f}% (push-back {err - base:+d})"
                    if err > base + 18 or ld > lbase + 150: hit = float(self.tip_now(a)[2]); break
                    z -= 0.003
                if hit is None: raise RuntimeError("no contact found: is the spot clear?")
                self.cfg["z_table"] = hit; self.z_table = hit; self._save()
                self.status = f"✓ table touched: height {hit * 1000:.0f} mm"
                self.goto_xyz(a, x, y, hit + 0.04, 0.0)
            except InterruptedError: self.status = "stopped (arm holding position)"; self._hold_quiet()
            except Overload as e: self._overload(e)
            except Exception as e: self.status = f"error: {e}"; self._hold_quiet()
            finally: self.running = False
        threading.Thread(target=job, daemon=True).start()

    # ---------- camera calibration: the arm carries the red keychain through known poses ----------
    def _fit_cams(self, obs):
        """Fit every camera from the carried-keychain observations (see app/camfit.py): the clamp offset is fitted too, half-hidden detections count less,
        hand-taught table points help camera 1 when they agree. Saves every observation to calibration/samples/ so the fit can be redone offline."""
        import camfit
        fr = self.get_frame(0); size = (fr.shape[1], fr.shape[0]) if fr is not None else (640, 480); notes = []
        cnt = {i: sum(1 for o in obs if o["cam"] == i) for i in range(self.ncam)}
        usable = [i for i in range(self.ncam) if cnt[i] >= 8]
        for i in range(self.ncam):
            if i not in usable: notes.append(f"camera {i + 1}: saw the keychain in only {cnt[i]} poses")
        if not usable: return 0, notes
        held = [o for o in obs if o["cam"] in usable]; init = camfit.rough_init(held, size); extra = []; pts = self.cfg.get("points", [])
        if 0 in init and len(pts) >= 4:                                   # hand-taught points (tip on the keychain on the table): only if they agree with the carried keychain
            m0 = camfit.fit(held, init, size)["models"][0]; K0 = np.array(m0["K"])
            err = [float(np.linalg.norm(cv2.projectPoints(np.float32([[p["x"], p["y"], p["z"]]]).reshape(-1, 1, 3), np.array(m0["rvec"], float).reshape(3, 1), np.array(m0["tvec"], float).reshape(3, 1), K0, None)[0].reshape(2) - [p["u"], p["v"]])) for p in pts]
            if float(np.median(err)) < 15: extra = [dict(cam=0, T=[p["x"], p["y"], p["z"]], R=np.eye(3).ravel().tolist(), uv=[p["u"], p["v"]], partial=False, kind="touch") for p in pts]
            else: notes.append(f"the {len(pts)} hand-taught table points disagree with the carried keychain ({np.median(err):.0f} px): not used")
        res = camfit.fit(held + extra, init, size); stab = camfit.stability(held + extra, init, res, size, z_world=(self.z_table if self.z_table is not None else 0.0)); done = 0
        for i, m in res["models"].items():
            if m["rms"] > 18: notes.append(f"camera {i + 1}: too loose ({m['rms']:.0f} px)"); continue
            m["src"] = "carried keychain + clamp offset"; m["weak"] = bool(stab.get(i, 0) > 15); self.models[i] = m; done += 1
            sx, sy, sz = [1000 * v for v in res["s"]]
            notes.append(f"camera {i + 1}: {m['rms']:.1f} px from {m['n']} observations" + (f", table map stable to {stab.get(i, 0):.0f} mm" if i in stab else "") + (" (WEAK: few observations, do it again if it misses)" if m["weak"] else ""))
        if done: notes.append(f"clamp offset fitted: {sx:.0f}, {sy:.0f}, {sz:.0f} mm in the tool frame"); self.cfg["clamp_offset_mm"] = [round(sx, 1), round(sy, 1), round(sz, 1)]
        try:
            d = pathlib.Path(__file__).resolve().parent.parent / "calibration" / "samples"; d.mkdir(parents=True, exist_ok=True)
            with open(d / ("autocal_" + time.strftime("%Y%m%d_%H%M%S") + ".json"), "w") as fh: json.dump(dict(obs=obs, touch_points_used=len(extra), s_mm=[round(1000 * v, 1) for v in res["s"]], models=res["models"], stability_mm=stab, size=size), fh)
        except Exception: pass
        return done, notes

    def calib_auto(self):
        if self._busy(): return
        self.abort = False; self.running = True; self.mode = "calib"
        def job():
            try:
                a = self._arm(); a.arm_motion(True); zt = self.z_table if self.z_table is not None else -0.008
                self.status = "auto-calibrating: lifting the arm straight up first (clear of the bowl)"
                cx, cy = [float(v) for v in self.tip_now(a)[:2]]; bh = self.cfg.get("bowl_h", 0.076)
                try: self.goto_xyz(a, cx, cy, zt + bh + 0.05, 0.0, dur=2.5, raw=True, min_h=bh + 0.03, keep_roll=True)
                except RuntimeError: pass
                poses = [(x, y, h) for h in (0.11, 0.07, 0.04) for (x, y) in ((150, -60), (150, -120), (200, -60), (200, -120), (200, -170), (250, -60), (250, -120))]      # high first (clear of the bowl), then lower: the table level is what the pick uses
                poses += [(x, y, h) for h in (0.11, 0.06) for (x, y) in ((150, 0), (200, 0), (250, 0), (150, 50), (200, 50), (250, 50))]                                         # and the bowl side of the table: a fit from one corner extrapolates badly (poses the bowl rule forbids are skipped)
                obs = []
                for k, (x, y, h) in enumerate(poses):
                    if self.abort: raise InterruptedError()
                    self.status = f"auto-calibrating: pose {k + 1}/{len(poses)} (seen so far: " + ", ".join(f"camera {i + 1}: {sum(1 for o in obs if o['cam'] == i)}" for i in range(self.ncam)) + ")"
                    try: self.goto_xyz(a, x / 1000, y / 1000, zt + h, 0.0, keep_roll=True)
                    except RuntimeError: continue
                    self._wait_stop(1.3); T = self.kin.fkT(self.q_now(a))
                    for i in range(self.ncam):                       # every camera records the keychain at the same moment, with the full tool pose and whether the gripper hides part of it
                        f = self.founds[i]
                        if f and time.time() - self._ft[i] < 1.0: obs.append(dict(cam=i, T=T[:3, 3].tolist(), R=T[:3, :3].ravel().tolist(), uv=[float(f[0]["u"]), float(f[0]["v"])], partial=bool(f[0].get("partial")), kind="held", pose=k))
                done, notes = self._fit_cams(obs)
                if not done: raise RuntimeError("no camera could be calibrated (" + "; ".join(notes) + "): the red keychain must be clamped in the gripper and visible")
                self.cam = self.models[0]; self.cfg["cams"] = self.models; self.cfg["cam"] = self.models[0]; self._save()
                self.save_cam_refs()                                    # remember what each camera sees now: later pictures are compared to it
                self.status = "✓ calibrated: " + "; ".join(notes)
            except InterruptedError: self.status = "stopped (arm holding position)"; self._hold_quiet()
            except Overload as e: self._overload(e)
            except Exception as e: self.status = f"error: {e}"; self._hold_quiet()
            finally: self.running = False
        threading.Thread(target=job, daemon=True).start()

    def set_grip(self, pct):
        """Open/close the gripper to pct (0 closed .. 100 open)."""
        try: a = self._arm(); a.arm_motion(True); a.goto({6: self.grip_tick(a, pct)}); self.status = f"gripper set to {pct:.0f}%"
        except Exception as e: self.status = f"error: {e}"; self._hold_quiet()

    def _hold_quiet(self):
        """Stop pushing: every motor is told to stay exactly where it is. Never raises, never waits long (the bus may be what is stuck)."""
        def go():
            try:
                a = self.get_arm()
                if a: a.hold_here()
            except Exception: pass
        t = threading.Thread(target=go, daemon=True); t.start(); t.join(2.0)

    def stop(self): self.abort = True; self._hold_quiet()

    def reset(self):
        """The always-available way out: cancel whatever runs, make the arm hold still, clear every flag that could keep the controls disabled."""
        self.abort = True; self._hold_quiet(); time.sleep(0.4)
        self.running = False; self.abort = False; self._holding = False; self.align_spots = []
        a = self.get_arm()
        try:
            if a: a.fault = {}; a._rec = []
        except Exception: pass
        self.status = "reset: nothing is running, the arm holds where it is. Start again when ready"

    def _watchdog(self):
        """A job that stops reporting progress is cancelled; one that ignores the cancel is cut loose so the dashboard never stays locked."""
        while True:
            time.sleep(0.5)
            try:
                if not self.running: continue
                now = time.time(); idle = now - self._beat
                if idle > self.cfg.get("stall_cut_s", 28):
                    self.running = False; self.abort = False; self._holding = False
                    self.status = "a job was stuck and has been cancelled: the arm holds still. You can start again"; self._hold_quiet()
                elif idle > self.cfg.get("stall_abort_s", 15) and not self.abort:
                    self.abort = True; self.status = f"no progress for {idle:.0f} s: stopping and holding the arm"; self._hold_quiet()
                elif now - self._job_t0 > (43200 if self.mode in ("screensaver", "cylinders", "finder") else self.cfg.get("job_max_s", 1200)) and not self.abort:
                    self.abort = True; self.status = "time limit for one job reached: stopped"; self._hold_quiet()
            except Exception: pass
    def ready_screensaver(self):
        """None when the screensaver can start, else the plain reason it cannot (shown on the greyed-out button). It needs only the arm: no camera, no keychain."""
        try: a = self._arm()
        except Exception as e: return str(e)
        if self.z_table is None: return "Find the table height first: press “Tune…” then “Find by touching”"
        g = self._gap_or_none(a)
        if g is not None and GRIP_MIN_GAP <= g <= 900: return "the gripper is holding something: press “Tune…” then “Let go (open)” first"
        return None

    def screensaver(self):
        """Attract-attention mode: the arm glides from pose to pose high above the table, never near the bowl, and now and then waves its gripper. Stop ends it (the arm holds still)."""
        if self._busy(): return
        err = self.ready_screensaver()
        if err: self.status = err; return
        self.abort = False; self.running = True; self.mode = "screensaver"
        def job():
            try:
                a = self._arm(); a.arm_motion(True); zt = self.z_table; rng = random.Random(); n = 0
                self.status = "screensaver: lifting clear"
                cx, cy = [float(v) for v in self.tip_now(a)[:2]]; bh = self.cfg.get("bowl_h", 0.076)
                try: self.goto_xyz(a, cx, cy, zt + bh + 0.06, 0.0, dur=2.5, raw=True, min_h=bh + 0.03, keep_roll=True)
                except RuntimeError: pass
                self.grip(a, 100, 0.6)
                while True:
                    order = list(ATTRACT); rng.shuffle(order)
                    for (x, y, h, lean) in order:
                        if self.abort: raise InterruptedError()
                        if self.bowl_geom() and self.bowl_blocked(x / 1000, y / 1000, zt + h, 0.04): continue          # never anywhere near the bowl
                        self.status = f"screensaver: moving ({n + 1})  ·  press Stop to end it"
                        try: self.goto_xyz(a, x / 1000, y / 1000, zt + h, 0.0, dur=rng.uniform(2.4, 3.6), keep_roll=True, raw=True, tilt=math.radians(lean) if lean else None)
                        except RuntimeError: continue                                                              # refused by the bowl rule or out of reach: skip this pose
                        n += 1
                        if n % 3 == 0:
                            self.status = "screensaver: wave"
                            for pct in (30, 100, 30, 100): self.grip(a, pct, 0.45)
                        self._wait_stop(rng.uniform(0.5, 1.3))
            except InterruptedError: self.status = "screensaver stopped (the arm holds still)"; self._hold_quiet()
            except Overload as e: self._overload(e)
            except Exception as e: self.status = f"error: {e}"; self._hold_quiet()
            finally: self.running = False
        threading.Thread(target=job, daemon=True).start()

    def rest(self):
        """Lower the arm onto a clear spot at the table, THEN let it go limp: a person never has to hold a stiff arm and it never drops from height.
        (User rule: never ask a person to do anything near a stiff robot. Make it limp first.)"""
        if self._busy(): return
        self.abort = False; self.running = True; self.mode = "rest"
        def job():
            try:
                a = self._arm()
                was = a.torque_on
                if was:
                    a.arm_motion(True); zt = self.z_table if self.z_table is not None else -0.008
                    self.status = "lowering the arm before letting it go limp"; self.goto_xyz(a, 0.18, 0.0, zt + 0.05, 0.0); self._wait_stop(0.6)
                a.arm_motion(False); self.status = "✓ the arm is limp" + (" (it was lowered first)" if was else " (it already was)") + ". Nothing is holding it now"
            except InterruptedError: self.status = "stopped (the arm is still stiff and holding position)"; self._hold_quiet()
            except Overload as e: self._overload(e)
            except Exception as e: self.status = f"error: {e} (the arm is still STIFF: it was not released)"; self._hold_quiet()
            finally: self.running = False
        threading.Thread(target=job, daemon=True).start()

    # ---------- joint check: every joint one at a time, from the MIDDLE of its calibrated range, never near an end ----------
    CHECK_ORDER = (2, 3, 4, 1, 5, 6)                  # the joints that carry the arm first (lift, elbow, wrist bend), then pan, roll, gripper
    CHECK_FRACS = (0.25, 0.5)                         # swing = this fraction of the HALF-span (middle to the nearer end): never further than half way to an end
    CHECK_CAP = {5: 250, 6: 260}                      # ticks, at the larger swing: the wrist roll twists its own cable, the gripper only opens and closes on nothing
    CHECK_WARN_LOAD, CHECK_HOT, CHECK_MID_OFF, CHECK_REACH = 550, 55, 40, 25

    def check_plan(self, cal, jid):
        """Pure plan for one joint: (middle tick, [swing sizes in ticks]). From calibration only, so it can be tested without an arm."""
        lo, hi = cal[NAMES[jid]]["range_min"], cal[NAMES[jid]]["range_max"]; mid = (lo + hi) / 2; half = min(mid - lo, hi - mid)
        cap = self.CHECK_CAP.get(jid)
        return int(mid), [int(min(half * f, cap * f / self.CHECK_FRACS[-1]) if cap else half * f) for f in self.CHECK_FRACS]

    def check_verdict(self, rec):
        """Turn what was measured into issues (kind + numbers) and one status: ok / warn / fail. The dashboard words them."""
        iss = []
        if rec.get("stuck"): iss.append(dict(kind="no_reach", value=rec["err"]))
        for sign, moved, cmd in rec["moved"]:
            if abs(moved) < 0.8 * abs(cmd): iss.append(dict(kind="no_follow", sign=sign, moved=moved, cmd=cmd)); break
        if rec["peak"] >= self.CHECK_WARN_LOAD: iss.append(dict(kind="high_load", value=round(rec["peak"] / 10)))
        if rec["t_rise"] >= 10: iss.append(dict(kind="heat", value=rec["t_rise"]))
        if rec["mid_err"] is not None and rec["mid_err"] > self.CHECK_MID_OFF: iss.append(dict(kind="mid_off", value=round(rec["mid_err"] * 360 / 4095, 1)))
        if rec["skipped"]: iss.append(dict(kind="limited", sides=rec["skipped"]))
        rec["issues"] = [i for i in rec.get("issues", [])] + iss
        bad = {"no_reach", "no_follow", "blocked"}
        rec["status"] = "fail" if any(i["kind"] in bad for i in rec["issues"]) else "warn" if rec["issues"] else "ok"

    def _tip_z(self, a, raw): return float(self.kin.fk(self.q_of(a, {**a.pos, **raw}))[0][2])

    def _path_clear(self, a, start, goal, n=20):
        """Would the fingertip stay 20 mm above the table (or at least not go lower than it already is) on the straight joint path start -> goal?"""
        fz = (self.z_table if self.z_table is not None else -0.047) + 0.02; z0 = self._tip_z(a, start)
        for k in range(1, n + 1):
            s = k / n; z = self._tip_z(a, {i: start[i] + (goal[i] - start[i]) * s for i in goal})
            if z < fz and z < z0 - 1e-4: return False
        return True

    def _swing(self, a, goal, dur, jid, rec):
        """Smooth move to raw ticks with load + temperature sensing; records the tested joint's peak load. True when every joint ended within CHECK_REACH ticks."""
        start = {i: a.pos[i] for i in goal}; hits = {}; n = max(2, int(dur * 25))
        for k in range(1, n + 1):
            if self.abort: raise InterruptedError()
            self._beat = time.time(); self._guard(a, hits)
            ld = a.load.get(jid)
            if ld is not None: rec["peak"] = max(rec["peak"], abs(ld))
            s = k / n; s = s * s * (3 - 2 * s)
            a.goto({i: start[i] + (goal[i] - start[i]) * s for i in goal}); time.sleep(0.04)
        for _ in range(40):
            if all(abs(a.pos[i] - goal[i]) < self.CHECK_REACH for i in goal): break
            self._wait_stop(0.04)
        return all(abs(a.pos[i] - goal[i]) < self.CHECK_REACH for i in goal)

    def check_joints(self, names):
        """Check the named follower joints one by one. First the arm goes slowly to the middle pose (every joint at the middle of its calibrated range); each joint is then
        swung a little each way from there (a quarter, then half of the way to its nearer end), back to the middle each time. Load, heat, reach and the calibration's middle
        are judged per joint. Ends by lowering the arm and letting it go limp, like rest()."""
        if self._busy(): return
        order = [i for i in self.CHECK_ORDER if NAMES[i] in names]
        if not order: self.status = "no joint named to check"; return
        self.abort = False; self.running = True; self.mode = "check"
        ck = self.check = dict(running=True, done=False, order=[NAMES[i] for i in order], joints={}, current=None, msg="getting ready", t0=time.time(), aborted="")
        def job():
            try:
                a = self._arm(); cal = a.cal()
                if a.wiggling or a.calib["step"] != "idle": raise RuntimeError("the arm is busy with a calibration or test")
                hot = [] if self.cfg.get("ignore_heat") else [f"{NAMES[i]} {t} °C" for i, t in a.temp.items() if t >= self.CHECK_HOT]
                if hot: raise RuntimeError(f"too warm to test: {', '.join(hot)}. Let it cool below {self.CHECK_HOT} °C first")
                mid = {i: self.check_plan(cal, i)[0] for i in NAMES if i in a.ids}              # an ignored motor is neither moved nor tested
                order[:] = [i for i in order if i in a.ids]
                if not order: raise RuntimeError("nothing to test: the motor is ignored (press Use again first)")
                ck["order"] = [NAMES[i] for i in order]
                full = lambda d: {i: (d[i] if i in d else a.pos.get(i, 0)) for i in range(1, 6)}      # the five arm joints: tested ones at their goal, others where they are
                a.arm_motion(True)
                ck["msg"] = "moving slowly to the middle pose (every joint at the middle of its range)"; self.status = ck["msg"]
                seq = [mid] if self._path_clear(a, full({}), full(mid)) else [{i: mid[i]} for i in (2, 3, 4, 1, 5) if i in mid] + ([{6: mid[6]}] if 6 in mid else [])
                if len(seq) > 1:
                    cur = full({})
                    for step in seq[:-1]:
                        nxt = {**cur, **step}
                        if not self._path_clear(a, cur, nxt): raise RuntimeError("the hand would touch the table on the way to the middle pose. Press Release arm, lift the hand about 20 cm above the table, and try again")
                        cur = nxt
                rec0 = dict(peak=0)
                for step in seq:
                    far = max(abs(a.pos[i] - v) for i, v in step.items())
                    self._swing(a, step, max(2.0, far / 100 * 0.7), 2, rec0)
                for jid in order:
                    n = NAMES[jid]; ck["current"] = n; ck["msg"] = f"checking {n} ({order.index(jid) + 1} of {len(order)})"; self.status = ck["msg"]
                    rec = ck["joints"][n] = dict(status="running", peak=0, err=0.0, mid_err=None, moved=[], skipped=[], t_rise=0, stuck=False, issues=[], targets=[])
                    t0 = a.temp.get(jid, 0); m, amps = self.check_plan(cal, jid); lo, hi = cal[n]["range_min"], cal[n]["range_max"]
                    try:
                        self._wait_stop(0.4); rec["mid_err"] = abs(a.pos[jid] - m)
                        for amp in amps:
                            for sign in (1, -1):
                                for sc in (1.0, 0.8, 0.6, 0.4, 0.25):
                                    tgt = int(max(lo + 8, min(hi - 8, m + sign * amp * sc)))
                                    if jid == 6 or self._path_clear(a, {i: a.pos[i] for i in range(1, 6)}, {i: (tgt if i == jid else a.pos[i]) for i in range(1, 6)}): break
                                else: rec["skipped"].append(sign); continue
                                rec["targets"].append(dict(sign=sign, ticks=tgt - m))
                                dur = max(1.2, abs(tgt - a.pos[jid]) / 100 * 0.7)
                                reached = self._swing(a, {jid: tgt}, dur, jid, rec)
                                rec["moved"].append((sign, a.pos[jid] - m, tgt - m)); rec["err"] = max(rec["err"], abs(a.pos[jid] - tgt)); rec["stuck"] = rec["stuck"] or not reached
                                self._wait_stop(0.3); self._swing(a, {jid: m}, dur, jid, rec)
                        rec["t_rise"] = a.temp.get(jid, t0) - t0
                        self.check_verdict(rec)
                    except Overload as e:
                        rec["issues"].append(dict(kind="blocked", text=str(e))); rec["t_rise"] = a.temp.get(jid, t0) - t0; self.check_verdict(rec); raise
                ck["current"] = None; ck["msg"] = "all checked: lowering the arm and letting it go limp"; self.status = ck["msg"]
                zt = self.z_table if self.z_table is not None else -0.008
                self.goto_xyz(a, 0.18, 0.0, zt + 0.05, 0.0); self._wait_stop(0.6); a.arm_motion(False)
                self.status = "✓ joint check finished, the arm is limp"; ck["msg"] = self.status
            except InterruptedError:
                ck["aborted"] = "stopped by you"; ck["msg"] = "stopped: the arm is still STIFF and holding position (press Release arm)"; self.status = ck["msg"]; self._hold_quiet()
            except Overload as e:
                ck["aborted"] = str(e); self._overload(e); ck["msg"] = f"stopped by load sensing: {e}. The arm holds still (press Release arm)"
            except Exception as e:
                ck["aborted"] = str(e); ck["msg"] = f"error: {e}"; self.status = f"error: {e}"; self._hold_quiet()
            finally:
                for n in ck["order"]:
                    r = ck["joints"].get(n)
                    if r is None: ck["joints"][n] = dict(status="untested", issues=[])
                    elif r.get("status") == "running": r["status"] = "untested"
                ck["running"], ck["done"], ck["current"] = False, True, None; self.running = False
        threading.Thread(target=job, daemon=True).start()

    # ---------- fully automatic: find the grey cylinders with OpenCV, put each one in the pink bowl, keep watching and repeat ----------
    CYL_GRASP_H = 0.022          # grip mid-height of the cylinder (about 45 mm tall), metres above the table
    CYL_SEEN_H = 0.022           # height the blob's centre is taken to be at when its pixel is turned into a table position

    def bowl_px(self):
        """The pink bowl as camera 1 sees it right now: dict(u, v, r) in pixels, or None."""
        fr = self.get_frame(0)
        return vision.find_bowl(fr) if fr is not None else None

    def find_cylinders_world(self):
        """Grey cylinders outside the bowl, as table positions: list of dict(x, y, u, v, area), nearest to the arm first. Only what the arm can reach and the bowl rule allows."""
        fr = self.get_frame(0)
        if fr is None or self.z_table is None: return []
        out = []
        for d in vision.find_cylinders(fr, self.bowl_px()):
            try: x, y = self.px2xy(d["u"], d["v"], 0, self.CYL_SEEN_H)
            except Exception: continue
            if math.hypot(x - 0.0388, y) < 0.10 or math.hypot(x - 0.0388, y) > 0.33: continue               # outside the arm's useful reach ring
            if self.near_bowl(x, y, self.z_table + 0.004): continue                                         # too close for the open gripper: the bowl rule
            out.append(dict(x=float(x), y=float(y), u=d["u"], v=d["v"], area=d["area"]))
        return sorted(out, key=lambda t: math.hypot(t["x"] - 0.0388, t["y"]))

    def pick_cyl(self, a, x, y):
        """Grip a grey cylinder standing on the table at (x, y): open, hover, go down to mid-height, close slowly while watching the arm, lift. No yaw needed (it is round)."""
        zt, c = self.z_table, self.cfg; zg = zt + self.CYL_GRASP_H
        tip0 = self.tip_now(a); near = self.near_bowl(tip0[0], tip0[1], tip0[2], 0.03) or self.near_bowl(x, y, zt + c["travel"], 0.05)
        self.status = "opening gripper"; self.grip(a, 100, 0.6)
        if near and self.bowl_geom():
            hh, mh = c.get("bowl_h", 0.076) + 0.05, c.get("bowl_h", 0.076) + 0.03; self.status = "lifting clear of the bowl"
            self.goto_xyz(a, float(tip0[0]), float(tip0[1]), zt + hh, 0.0, raw=True, min_h=mh)
            self.status = "moving above the cylinder (high, clear of the bowl)"; self.goto_xyz(a, x, y, zt + hh, 0.0, min_h=mh)
            self.goto_xyz(a, x, y, zt + c["travel"], 0.0, dur=1.2)
        else: self.status = "moving above the cylinder"; self.goto_xyz(a, x, y, zt + c["travel"], 0.0)
        self.status = "going down to the cylinder"; self.goto_xyz(a, x, y, zg, 0.0, dur=2.2)
        self._wait_stop(0.3); self.status = "closing on the cylinder"
        r = self.squeeze(a); gap, ld = r["gap"], r["load"]; a.set_grip_torque(450)
        if r["event"] == "pushed":
            self.grip(a, 100, 0.6); self.goto_xyz(a, x, y, zt + c["travel"], 0.0, dur=1.2)
            raise GraspFailed(f"a jaw pushed the arm while closing ({r['why']}): the cylinder is probably not between the fingers")
        if gap < GRIP_MIN_GAP:
            self.goto_xyz(a, x, y, zt + c["travel"], 0.0, dur=1.2)
            raise GraspFailed(f"nothing between the fingers after closing (gap {gap:.0f} ticks, needs {GRIP_MIN_GAP}+): the spot is off")
        self._holding = True; self.status = f"holding a cylinder (finger gap {gap:.0f} ticks): lifting"
        self.goto_xyz(a, x, y, zt + c["travel"], 0.0, dur=2.0)
        if self.grip_gap(a) < GRIP_MIN_GAP: raise GraspFailed("the cylinder did not come up with the gripper")

    def auto_cylinders(self, dry=False):
        """Start the automatic loop. dry=True only hovers above the nearest cylinder (to check the aim) and stops."""
        if self._busy(): return
        self.check_cams()
        err = self.ready("bowl")
        if err: self.status = err; return
        self.abort = False; self.running = True; self.mode = "cylinders"; self.cycles = 0
        threading.Thread(target=self._cyl_job, args=(dry,), daemon=True).start()

    def camera_alive(self, cid=0):
        """A webcam that came back from a USB drop can deliver black pictures: never move the arm on those."""
        fr = self.get_frame(cid)
        return fr is not None and float(fr.mean()) > 15.0

    def search_pose(self, a):
        """The arm's TOP position (the hand goes to its full height to look for the cylinder): joints 1-4 at the middle of their calibrated range, which is the upright pose
        with the hand high and back (the same pose the joint check goes to), so camera 1 sees the whole table. The wrist roll and the gripper stay as they are."""
        cal = a.cal(); ids = [i for i in (1, 2, 3, 4) if i in a.ids]
        goal = {i: self.check_plan(cal, i)[0] for i in ids}
        full = lambda d: {i: (d[i] if i in d else a.pos.get(i, 0)) for i in range(1, 6)}
        if not self._path_clear(a, full({}), full(goal)): raise RuntimeError("the hand would touch the table on the way up to the search pose: lift the arm by hand first")
        self._check_path(self.q_now(a), self.q_of(a, {**a.pos, **goal}))                       # and never through the bowl
        far = max(abs(a.pos[i] - goal[i]) for i in ids)
        self.status = "raising the arm to its top position to look for cylinders"
        self._swing(a, goal, max(2.0, far / 100 * 0.7), 2, {"peak": 0})
        self._wait_stop(0.6)

    def _cyl_job(self, dry):
        """The loop: 1 go to the top position and LOOK for a grey cylinder; 2 found: open the gripper, move close, pick it up; 3 find the pink bowl, move close, drop it;
        4 back to the top position and look again (forever, until Stop)."""
        try:
            a = self._arm(); a.arm_motion(True); self.measure_empty(a); self.history.clear()
            fails, quiet = 0, 0
            while True:
                if self.abort: raise InterruptedError()
                if not self.camera_alive(0): self.status = "camera 1 is delivering a black picture (cover, privacy shutter or a USB drop): re-plug it, then start again"; break
                self.search_pose(a)                                                                 # 1 look from the top position
                items = []
                for _ in range(6):                                                                  # a few looks: a single frame can miss
                    items = self.find_cylinders_world()
                    if items or self.abort: break
                    self._wait_stop(0.4)
                if not items:
                    quiet += 1
                    if dry: self.status = "dry run: no grey cylinder outside the bowl is visible to camera 1"; break
                    self.status = f"no grey cylinder outside the bowl: watching from the top position (done so far: {self.cycles})"
                    self._wait_stop(2.0); continue
                quiet = 0; it = items[0]
                self.status = f"found a grey cylinder at ({it['x'] * 1000:.0f}, {it['y'] * 1000:.0f}) mm ({len(items)} outside the bowl): opening the gripper"
                self.grip(a, 100, 0.6)                                                              # 2 open BEFORE going close
                if dry:
                    self.pick_cyl_hover(a, it["x"], it["y"]); self.status = f"dry run done: hovered above the cylinder at ({it['x'] * 1000:.0f}, {it['y'] * 1000:.0f}) mm"; break
                try:
                    self.pick_cyl(a, it["x"], it["y"])
                    if self.zone_center("bowl") is None: raise GraspFailed("holding the cylinder but I cannot see the pink bowl: put it where camera 1 can see it")
                    self.status = "found the pink bowl: carrying the cylinder to it"; self.place(a, "bowl")     # 3 over the bowl, down, release
                except GraspFailed as e:
                    fails += 1; self.status = f"✗ {e}: going back up (failure {fails} of 3)"; self._recover(a)
                    if fails >= 3: self.status = f"gave up after 3 failed tries in a row. Last: {e}"; break
                    continue
                finally: self._holding = False
                fails = 0; self.cycles += 1; self.status = f"✔ cylinder number {self.cycles} is in the bowl: going back to the top position to look for the next"
        except InterruptedError: self.status = "stopped (arm holding position)"; self._hold_quiet()
        except Overload as e: self._overload(e)
        except Exception as e: self.status = f"error: {e}"; self._hold_quiet()
        finally: self.running = False; self._holding = False

    def go_search(self):
        """Just raise the arm to its top (search) position and stay there holding: to see what the hand camera sees from up there."""
        if self._busy(): return
        self.abort = False; self.running = True; self.mode = "search"
        def job():
            try:
                a = self._arm(); a.arm_motion(True); self.grip(a, 100, 0.6); self.search_pose(a); self.status = "at the top position (looking); the arm is holding"
            except InterruptedError: self.status = "stopped (arm holding position)"; self._hold_quiet()
            except Overload as e: self._overload(e)
            except Exception as e: self.status = f"error: {e}"; self._hold_quiet()
            finally: self.running = False
        threading.Thread(target=job, daemon=True).start()

    # ---------- object finder + follower: the hand sweeps across the table looking for the grey cylinder with the hand camera (camera 2), then keeps itself over it as it moves ----------
    FIND_H = 0.15                                        # hand height above the table while searching/following (gripper straight down)
    FIND_GRID_X, FIND_GRID_Y = (150, 200, 250), (-140, -80, -20, 40)      # mm, the sweep (serpentine) over the reachable table area
    FIND_BOX = (0.10, 0.30, -0.20, 0.12)                # x0, x1, y0, y1 metres: the hand never goes outside this box while following

    def hand_cam(self): return int(self.cfg.get("hand_cam", 1))

    def cyl_candidates(self, fr, near=None, gate=170):
        """Grey cylinders in a hand-camera picture (OpenCV colour + shape rules). With `near` (a pixel) only blobs within `gate` px of it, nearest first."""
        bowl = vision.find_bowl(fr, min_area=4000)
        c = vision.find_cylinders(fr, bowl, min_area=800, max_area=16000, min_solid=0.80, max_aspect=2.8)
        if near is not None:
            c = [d for d in c if math.hypot(d["u"] - near[0], d["v"] - near[1]) <= gate]; c.sort(key=lambda d: math.hypot(d["u"] - near[0], d["v"] - near[1]))
        return c

    def _servo_xy(self, a, x, y, hits):
        """One quick tracking step: IK for (x, y) at the finding height, then each joint moves at most 70 ticks towards it (no waiting for it to settle). False when out of reach."""
        x0, x1, y0, y1 = self.FIND_BOX; x, y = min(x1, max(x0, x)), min(y1, max(y0, y))
        if self.bowl_geom() and self.near_bowl(x, y, self.z_table + self.FIND_H, 0.02): return False
        q = self.kin.ik([x, y, self.z_table + self.FIND_H], roll=0.0, tilt=self.trim())
        if not q: return False
        q["wrist_roll"] = self.q_now(a)["wrist_roll"]; goal = {i: v for i, v in self.ticks(a, q).items() if i in a.ids}
        self._guard(a, hits)
        a.goto({i: a.pos[i] + max(-70, min(70, v - a.pos[i])) for i, v in goal.items()})
        return True

    def finder(self):
        """Start the finder: sweep across the table with the hand camera, lock on the grey cylinder, follow it while it moves, search again if it is lost. Stop ends it."""
        if self._busy(): return
        self.abort = False; self.running = True; self.mode = "finder"
        threading.Thread(target=self._finder_job, daemon=True).start()

    def _finder_job(self):
        try:
            a = self._arm(); a.arm_motion(True); zt, hc = self.z_table, self.hand_cam(); hits = {}
            if zt is None: raise RuntimeError("table height unknown: press Tune, Find by touching")
            grid = [(x, y) for j, y in enumerate(self.FIND_GRID_Y) for x in (self.FIND_GRID_X if j % 2 == 0 else self.FIND_GRID_X[::-1])]
            self.grip(a, 100, 0.6); cx, cy = [float(v) for v in self.tip_now(a)[:2]]
            self.status = "finder: lifting the hand, gripper down"; self.goto_xyz(a, cx, cy, zt + max(self.FIND_H, 0.12), 0.0, raw=True, keep_roll=True)
            state, wi, last, lost_t, J, found_n = "search", 0, None, 0.0, None, 0
            while True:
                if self.abort: raise InterruptedError()
                fr = self.get_frame(hc)
                if fr is None or float(fr.mean()) < 15: self.status = "finder: the hand camera (camera 2) shows a black picture: check it and start again"; break
                if state == "search":
                    x, y = grid[wi % len(grid)]; self.status = f"finder: searching, sweeping across the table, stop {wi % len(grid) + 1}/{len(grid)}"
                    try: self.goto_xyz(a, x / 1000, y / 1000, zt + self.FIND_H, 0.0, raw=True, keep_roll=True)
                    except RuntimeError: wi += 1; continue
                    self._wait_stop(0.4); seen = []
                    for _ in range(4):
                        c = self.cyl_candidates(self.get_frame(hc)); seen.append(c[0] if c else None); self._wait_stop(0.12)
                    ok = [d for d in seen if d]
                    if len(ok) >= 3: last = (float(np.median([d["u"] for d in ok])), float(np.median([d["v"] for d in ok]))); state = "probe"; self.status = f"finder: found a grey cylinder at pixel ({last[0]:.0f}, {last[1]:.0f}): measuring how the picture moves with the hand"
                    else: wi += 1
                elif state == "probe":
                    tip = self.tip_now(a); x0, y0 = float(tip[0]), float(tip[1]); d = 0.02; cols = []
                    for dx, dy in ((d, 0.0), (0.0, d)):
                        self.goto_xyz(a, x0 + dx, y0 + dy, zt + self.FIND_H, 0.0, raw=True, keep_roll=True); self._wait_stop(0.5)
                        c = self.cyl_candidates(self.get_frame(hc), last, 260)
                        if not c: cols = []; break
                        cols.append(((c[0]["u"] - last[0]) / d, (c[0]["v"] - last[1]) / d))
                    self.goto_xyz(a, x0, y0, zt + self.FIND_H, 0.0, raw=True, keep_roll=True); self._wait_stop(0.4)
                    if len(cols) == 2:
                        M = np.array(cols).T                                            # pixels of the cylinder per metre the hand moves (2x2)
                        if abs(np.linalg.det(M)) > 4e5 and all(200 < np.hypot(*c) < 20000 for c in cols): J = M; state = "track"; self.status = f"finder: locked on the cylinder, picture moves {np.hypot(*cols[0]) / 1000:.1f} / {np.hypot(*cols[1]) / 1000:.1f} px per mm: following it"; lost_t = 0.0
                    if J is None or state != "track": self.status = "finder: lost it while measuring: searching again"; state = "search"; wi += 1
                elif state == "track":
                    c = self.cyl_candidates(fr, last)
                    if c:
                        lost_t = 0.0; last = (c[0]["u"], c[0]["v"]); e = np.array([last[0] - fr.shape[1] / 2, last[1] - fr.shape[0] / 2])
                        if np.hypot(*e) > 12:                                           # closer than 12 px: leave it alone
                            dxy = -np.linalg.solve(J, e) * 0.6; n = np.hypot(*dxy)
                            if n > 0.03: dxy *= 0.03 / n
                            tip = self.tip_now(a)
                            if not self._servo_xy(a, float(tip[0] + dxy[0]), float(tip[1] + dxy[1]), hits): self.status = "finder: the cylinder is out of the arm's reach there: waiting"
                            else: self.status = f"finder: following the cylinder (off centre by {np.hypot(*e):.0f} px)"
                        else: self.status = "finder: the hand is over the cylinder"
                    else:
                        lost_t = lost_t or time.time()
                        if time.time() - lost_t > 2.5: self.status = "finder: lost the cylinder: sweeping again"; state = "search"; J = None; lost_t = 0.0
                    self._beat = time.time(); self._wait_stop(0.12)
        except InterruptedError: self.status = "stopped (arm holding position)"; self._hold_quiet()
        except Overload as e: self._overload(e)
        except Exception as e: self.status = f"error: {e}"; self._hold_quiet()
        finally: self.running = False

    def go_look(self, x, y, h):
        """Move the hand, gripper straight down, to (x, y) metres at height h above the table and hold there: to see what the camera on the gripper sees from that pose."""
        if self._busy(): return
        self.abort = False; self.running = True; self.mode = "look"
        def job():
            try:
                a = self._arm(); a.arm_motion(True); self.grip(a, 100, 0.6)
                self.status = f"moving the hand (gripper down) to ({x * 1000:.0f}, {y * 1000:.0f}) mm, {h * 1000:.0f} mm above the table"
                cx, cy = [float(v) for v in self.tip_now(a)[:2]]
                self.goto_xyz(a, cx, cy, self.z_table + max(h, 0.12), 0.0, raw=True, keep_roll=True)
                self.goto_xyz(a, x, y, self.z_table + h, 0.0, raw=True, keep_roll=True); self._wait_stop(0.8)
                self.status = f"hand at ({x * 1000:.0f}, {y * 1000:.0f}) mm, {h * 1000:.0f} mm up, gripper down; holding"
            except InterruptedError: self.status = "stopped (arm holding position)"; self._hold_quiet()
            except Overload as e: self._overload(e)
            except Exception as e: self.status = f"error: {e}"; self._hold_quiet()
            finally: self.running = False
        threading.Thread(target=job, daemon=True).start()

    def pick_cyl_hover(self, a, x, y):
        zt, c = self.z_table, self.cfg; self.grip(a, 100, 0.6); self.goto_xyz(a, x, y, zt + c["travel"], 0.0)

    def release(self):
        self.abort = True
        a = self.get_arm()
        if a: a.arm_motion(False)
        self.status = "released (torque off)"

    def limp_now(self, a):
        """The plain 'make it limp' button: stop whatever runs and switch torque OFF on all six motors at once, without lowering the arm first and without needing the
        dashboard to see the arm. `a` is the follower Arm even when it is offline. Says plainly how many motors confirmed (a silent motor may still be stiff)."""
        self.abort = True
        if a is None: self.status = "no follower arm found: nothing to release"; return
        n = a.limp_now()
        if n >= len(NAMES): self.status = "✓ torque is off on all six motors: the arm is limp (it was not lowered first)"
        elif n: self.status = f"torque off confirmed on {n} of 6 motors: the others did not answer and may still be STIFF. Switch the follower's power supply off to be sure"
        else: self.status = "I sent 'torque off' but NO motor answered, so I cannot tell: the arm may still be STIFF. Switch the follower's power supply off to make it limp"

    def _tilt_state(self, a):
        try:
            if not a or not a.online or a.cal() is None: return None
            s, lat = self.tool_tilt(a); return dict(now=round(s - self.cfg.get("pitch_trim_deg", 0.0), 1), lat=round(lat, 1), trim=self.cfg.get("pitch_trim_deg", 0.0), raw=round(s, 1))
        except Exception: return None

    def state(self):
        c = self.cfg; a = self.get_arm(); now = time.time()
        loc = self.locate() if self.usable() else None
        cams = [dict(cal=bool(self.models[i] or (i == 0 and self.H is not None)), rms=(self.models[i] or {}).get("rms"), sees=bool(self.founds[i]) and now - self._ft[i] < 2.0) for i in range(self.ncam)]
        bz = self.zone_center("bowl") if self.z_table is not None else None
        return dict(ncam=self.ncam, cams=cams, cam_mode=str(c.get("cam_mode", "auto")),
                    fusion=dict(cams=[i + 1 for i in loc["cams"]], spread_mm=round(loc["spread"] * 1000)) if loc else None, cam_chk=[dict(c) for c in self.cam_chk],
                    kc_mm=[round(loc["x"] * 1000), round(loc["y"] * 1000)] if loc else None, kc_z_mm=(None if not loc or loc.get("z") is None else round(loc["z"] * 1000)), kc_gap_mm=(None if not loc or loc.get("gap") is None else round(loc["gap"] * 1000)), bowl_mm=[round(bz[0] * 1000), round(bz[1] * 1000), round(bz[2] * 1000)] if bz else None,
                    check=self.check, cam_cal=any(self.models), cam_rms=(self.models[0] or {}).get("rms"), z_table_mm=None if self.z_table is None else round(self.z_table * 1000), limp=bool(a and a.online and not a.torque_on),     # an arm the dashboard cannot reach is NOT known to be limp (a silent motor keeps its last torque)
                    arm_silent=a is None,
                    auto={k: v for k, v in self.auto.items()}, taught=len(c["points"]), fit_mm=self.err_mm, z_table=self.z_table, ready=self.ready() is None, why=self.ready(), why_bowl=self.ready("bowl"),
                    zones={n: dict(p=z["p"], drop=z["drop"], r=z["r"]) for n, z in c["zones"].items()}, here=self.zone_of_world(loc["x"], loc["y"]) if loc else None,
                    align=dict(n=len(self.align_spots), r_mm=sorted(round(1000 * sp['r']) for sp in self.align_spots), gap_mm=(None if self.z_table is None else round(1000 * (self.cfg.get('base_z', BASE_Z) - self.z_table))), undo=bool(self.cfg.get('align_backup'))),
                    tilt=self._tilt_state(a), status=self.status, log=[m for _, m in list(self.history)[-14:]], why_screen=self.ready_screensaver(), tip_mm=(lambda t: None if t is None else [round(1000 * float(v)) for v in t])(self._tip_or_none(a)), grip_gap=self._gap_or_none(a), kc_held=(lambda g: g is not None and GRIP_MIN_GAP <= g <= 900)(self._gap_or_none(a)), running=self.running, mode=self.mode, cycles=self.cycles,
                    found=[{k: round(v, 1) for k, v in d.items()} for d in self.found[:1]],
                    bowl_rim_mm=[round(self.rim["x"] * 1000), round(self.rim["y"] * 1000), round(self.rim["r"] * 1000)] if self.rim else None,
                    params={**{k: c.get(k, 0.0) for k in ("roll_offset", "grasp_dz", "travel", "off_x", "off_y", "bowl_clear")}, "auto_bowl": bool(c.get("auto_bowl", True))}, ready_bowl=self.ready("bowl") is None)
