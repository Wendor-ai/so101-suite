"""SO-101 dashboard: live camera + joint telemetry for every arm found. Stdlib server, works on macOS and Pi.
Run: python app/server.py [--port 8000] [--camera 0]"""
import argparse, collections, glob, json, math, os, pathlib, re, shutil, sys, threading, time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.dirname(_HERE), _HERE):                      # repo root (`import so101`) and app/ (`import pickplace`) work however this file is started
    if _p not in sys.path: sys.path.insert(0, _p)
from so101 import demo as _demo
if "--demo" in sys.argv or os.environ.get("SO101_DEMO") == "1":   # demo mode: the fake motor bus must be installed BEFORE scservo_sdk is imported
    _demo.install(fresh=not os.environ.get("SO101_RESTARTING"))
import cv2
import numpy as np
import scservo_sdk as sdk
from pickplace import PickPlace
from so101 import defaults as _defaults, ports as _ports, roles as _roles, trace, suite_api
from kin import ARM
try:                                                   # the real SDK; the demo's fake one has no such module
    import scservo_sdk.port_handler as _sph
    _sph.LATENCY_TIMER = 4      # the SDK waits (2 x this + 2) ms for a missing reply: 34 ms at its default 16. One lost reply per second froze the leader -> follower loop for 34 ms (the 'worst gap' of 50 ms): now 10 ms
except ImportError: pass
_SYNC_READ = hasattr(sdk, "GroupSyncRead")            # the real SDK reads every motor in one packet; the demo's simulated one does not
sys.setswitchinterval(0.0005)       # default 5 ms: every blocking serial call gave the GIL away and could wait 5 ms to get it back from the busy camera threads (latency of the leader -> follower loop)

JOINTS = {1: "shoulder_pan", 2: "shoulder_lift", 3: "elbow_flex", 4: "wrist_flex", 5: "wrist_roll", 6: "gripper"}
PORT_GLOBS = ["/dev/ttyACM*", "/dev/ttyUSB*", "/dev/tty.usbmodem*", "/dev/tty.wchusb*", "/dev/tty.usbserial*"]
HERE = os.path.dirname(os.path.abspath(__file__))
CALIB_ROOT = pathlib.Path(os.environ.get("HF_LEROBOT_CALIBRATION", "~/.cache/huggingface/lerobot/calibration")).expanduser()
CALIB_DIRS = {"follower": ("robots/so_follower", os.environ.get("FOLLOWER_ID", "my_follower")),
              "leader": ("teleoperators/so_leader", os.environ.get("LEADER_ID", "my_leader"))}
MID, MIN_SPAN = 2047, 150
ROLES_FILE = pathlib.Path("~/.so101_roles.json").expanduser()
IGN_FILE = pathlib.Path("~/.so101_ignored.json").expanduser()
def _ign_load():
    try: return {n for n in json.loads(IGN_FILE.read_text()) if n in JOINTS.values()}
    except Exception: return set()
IGNORED = _ign_load()      # motors the person chose to work WITHOUT (switched off and left out of teleop, pick & place, checks and problems); saved in ~/.so101_ignored.json


def ignore_set(joint, on):
    if joint not in JOINTS.values(): return
    (IGNORED.add if on else IGNORED.discard)(joint)
    IGN_FILE.write_text(json.dumps(sorted(IGNORED)))
    for a in list(arms.values()): a.apply_ignore()

VIZ_FILE = pathlib.Path("~/.so101_viz.json").expanduser()


def viz_load():
    try: return json.loads(VIZ_FILE.read_text())
    except Exception: return {"flip": {}, "offset": {}}


def viz_set(d):
    """Per-joint visual tweaks so the 3D twin matches the real arm's mounting (flip direction, add offset degrees)."""
    v, j = viz_load(), d.get("joint")
    if j in JOINTS.values():
        if "flip" in d: v.setdefault("flip", {})[j] = bool(d["flip"])
        if "offset" in d: v.setdefault("offset", {})[j] = float(d["offset"])
        VIZ_FILE.write_text(json.dumps(v))
    return v


def cal_path(role, suffix=""):
    sub, cid = CALIB_DIRS[role]
    return CALIB_ROOT / sub / f"{cid}{suffix}.json"


def role_for(port, set_to=None):
    """Remember which role (follower/leader) each USB adapter plays. First arm = follower, second = leader.
    Keyed by the adapter's stable identity (so101.ports.port_key), not the path; legacy path keys are migrated on read."""
    return _roles.role_for(ROLES_FILE, port, set_to if set_to in CALIB_DIRS else None)


class TLock:
    """A lock that never waits forever: a wedged serial transfer becomes an error instead of a frozen dashboard."""
    def __init__(self, t=3.0): self._l, self.t = threading.Lock(), t

    def __enter__(self):
        if not self._l.acquire(timeout=self.t): raise TimeoutError("the motor bus is busy (a serial transfer is stuck)")

    def __exit__(self, *a): self._l.release()


FAULT_BITS = {1: "voltage", 2: "sensor", 4: "temperature", 8: "current", 16: "angle", 32: "overload"}


class Refused(RuntimeError):
    """A request the arm will not carry out right now. The message is a sentence for the user."""


TELE_FILE = pathlib.Path("~/.so101_teleop.json").expanduser()


def teleop_cfg():
    """Measured alignment, saved by the 'Align arms' box: {"k": {joint: offset ticks}, "grip": {"closed": leader reading with the trigger fully closed, "open": fully open}}."""
    try: return json.loads(TELE_FILE.read_text())
    except Exception: return {}


P_BASE = {1: 28, 2: 28, 3: 28, 4: 40}      # follower position gain at smoothness 0 (fastest, 16 = the calm default is reached at 100)


def smooth_gain(i, smooth): return int(round(P_BASE.get(i, 16) - (P_BASE.get(i, 16) - 16) * smooth / 100.0))


def teleop_cfg_set(**kw):
    c = teleop_cfg(); c.update(kw); TELE_FILE.write_text(json.dumps(c))


RANGE_TOL = 60       # ticks (5 degrees): how far apart the two ends' offsets may be before a swept range is called inconsistent


def teleop_params(fc, lc, cfg=None):
    """How a LEADER reading becomes a FOLLOWER goal. Both arms are SO-101s: one tick is the same physical angle (360/4095) on both, so for the arm joints the scale is exactly 1 and
    the saved ranges only line the two arms up (an offset). The old map stretched the leader's swept range onto the follower's: when a calibration sweep was incomplete (2026-11-01: the
    leader's pan range was 2005 ticks against the follower's 2721) the follower turned 1.36x as far and sat 40-50 degrees too far to the right. The gripper (a trigger vs a jaw)
    keeps the proportional map."""
    P = {}
    for n in JOINTS.values():
        l, f = lc[n], fc[n]; flip = bool(l.get("drive_mode")) != bool(f.get("drive_mode"))
        lmin, lmax, fmin, fmax = l["range_min"], l["range_max"], f["range_min"], f["range_max"]
        if n == "gripper":                        # the trigger's REAL closed/open readings (the saved sweep ends were never reached: 1926..2359 live vs 1879..2389 saved, so the jaw stopped 14 degrees short)
            g = (cfg or {}).get("grip") or {}
            P[n] = dict(kind="prop", flip=flip, l=(g.get("closed", lmin), g.get("open", lmax)), f=(fmin, fmax)); continue
        sign = -1 if flip else 1
        ka, kb = (fmax + lmin, fmin + lmax) if flip else (fmin - lmin, fmax - lmax)        # the offset that lines up the minimum ends / the maximum ends
        ok = abs(ka - kb) <= RANGE_TOL; kmeas = ((cfg or {}).get("k") or {}).get(n)         # an offset measured with both arms in the same pose beats the one inferred from the ranges
        P[n] = dict(kind="shift", sign=sign, k=kmeas if kmeas is not None else (ka + kb) / 2 if ok else ka, measured=kmeas is not None, flo=fmin, fhi=fmax, consistent=ok or kmeas is not None, lspan=lmax - lmin, fspan=fmax - fmin)
    return P


def map_raw(P, n, raw):
    p = P[n]
    if p["kind"] == "prop":
        t = min(1.0, max(0.0, (raw - p["l"][0]) / max(1, p["l"][1] - p["l"][0])))
        if p["flip"]: t = 1 - t
        return int(p["f"][0] + t * (p["f"][1] - p["f"][0]))
    return int(min(p["fhi"], max(p["flo"], p["sign"] * raw + p["k"])))


class JointFault(RuntimeError):
    """A follower joint tripped the teleop guard. Carries WHICH joint and why, so the dashboard can point at it instead of showing a sentence."""
    def __init__(self, joint, what, value, text):
        super().__init__(text); self.joint, self.what, self.value = joint, what, value


class Arm(threading.Thread):
    """Owns one serial port: polls joint positions, runs the wiggle demo."""
    def __init__(self, path):
        super().__init__(daemon=True)
        self.path, self.lock = path, TLock()
        self.err, self.scan_baud, self.stopped = "", None, False  # why the last connect failed, baud rate of the last motor scan, set to end the thread (tests)
        self.fault, self._rec, self._busy_n = {}, [], 0          # motor protection flags, recovery timestamps, consecutive 'bus busy' polls
        self.role, self.notice, self._cc = role_for(path), ("", 0), (None, None)
        self.key = _ports.key_for_path(path)                      # stable identity of the adapter (survives ttyACM0/1 swapping)
        self.torque_on = False
        self._tbad = {}
        self.load, self.temp = {}, {}          # per-motor load (-1000..1000, 0.1% of max torque) and temperature, refreshed 10x/second
        self.pos, self.ids, self.volt, self.online, self.wiggling = {}, [], 0.0, False, False
        self.slow_n = 0; self.temp_t = {}
        self._gsr, self._gsr_ids, self.pose_n = None, [], 0       # cached sync-read group, the ids it was built for, number of position reads so far
        self.gone = False                        # set when its USB port vanished for good: the thread ends and scan_arms forgets it
        self.alive, self.ignored = set(), []     # motors that answered; names of motors the person ignores (they are NOT in ids, so nothing drives, polls or guards them)
        self.missing, self._rj = [], 0.0       # joints that did NOT answer at connect (never silently dropped), last re-ping time
        self._lh = {}                          # joint id -> when its load first crossed the push limit (a problem only once it lasts)
        self.calib = {"step": "idle"}
        self.ph = trace.wrap_port_handler(sdk.PortHandler(path), path); self.pk = trace.wrap_packet_handler(sdk.PacketHandler(0), path)

    @property
    def online(self): return self._online

    @online.setter
    def online(self, v):
        if self.__dict__.get("_online") is not v: trace.log("info" if v else "warn", "arm", f"{self.role} arm {'connected' if v else 'offline'}")
        self._online = v

    def connect(self):
        if os.environ.get("SO101_NO_REAL_PORTS") and not str(self.path).startswith("demo://"): self.err = "real serial ports are switched off (SO101_NO_REAL_PORTS)"; return False   # tests must never touch a real arm
        if not self.ph.openPort(): self.err = "could not open the serial port"; return False
        self.ph.setBaudRate(1000000)
        self.alive = {i for i in JOINTS if any(self.pk.ping(self.ph, i)[1] == 0 for _ in range(3))}
        self._refresh_ids()
        self.err = "" if self.alive else "no motor answered at 1 Mbit/s"
        for i in self.alive:                                              # run() calls connect() while holding the bus lock, so no second `with self.lock` here
            if JOINTS[i] in IGNORED: self.pk.write1ByteTxRx(self.ph, i, 40, 0)               # an ignored motor is left limp, never holding or pushing
        if self.missing:                                               # loud, in the log AND on the dashboard until it answers
            print(f"[arm {self.path}] NO ANSWER from: {', '.join(self.missing)}. Check its cable and power", flush=True)
            self._say(f"{', '.join(self.missing)} does not answer: check its cable and power")
        self.torque_on = any(self.pk.read1ByteTxRx(self.ph, i, 40)[0] for i in self.ids)   # report the REAL state: motors keep torque across restarts
        self.ensure_default()
        return bool(self.ids)

    def _refresh_ids(self):
        """ids = motors that answered and are not ignored; missing = motors that did not answer and are not ignored."""
        self.ids = [i for i in JOINTS if i in self.alive and JOINTS[i] not in IGNORED]
        self.missing = [JOINTS[i] for i in JOINTS if i not in self.alive and JOINTS[i] not in IGNORED]
        self.ignored = [JOINTS[i] for i in JOINTS if JOINTS[i] in IGNORED]

    def apply_ignore(self):
        """The person changed which motors to ignore: switch the newly ignored ones off and rebuild the lists."""
        try:
            with self.lock:
                if self.online:
                    for i in self.alive:
                        if JOINTS[i] in IGNORED: self.pk.write1ByteTxRx(self.ph, i, 40, 0)
        except Exception: pass
        self._refresh_ids()

    def _read_pos(self):
        """All motor positions in one packet (GroupSyncRead). Falls back to one read per motor if the sync read fails. Counts reads in pose_n so the page and tests can measure the real rate."""
        ids = [i for i in JOINTS if i in self.alive]            # ignored motors included: the 3D page must keep showing their real angle (2026-11-01: an ignored wrist roll showed 0 degrees)
        if not ids: return
        try:
            if _SYNC_READ:                                       # the demo's simulated SDK has no sync read: it reads one motor at a time
                if self._gsr is None or self._gsr_ids != ids:
                    g = sdk.GroupSyncRead(self.ph, self.pk, 56, 2)
                    for i in ids: g.addParam(i)
                    self._gsr, self._gsr_ids = g, ids
                if self._gsr.txRxPacket() == sdk.COMM_SUCCESS:
                    for i in ids:
                        if self._gsr.isAvailable(i, 56, 2): self.pos[i] = self._gsr.getData(i, 56, 2)
                    self.pose_n += 1; return
        except Exception: self._gsr = None
        for i in ids:
            p, r, _ = self.pk.read2ByteTxRx(self.ph, i, 56)
            if r == 0: self.pos[i] = p
        self.pose_n += 1

    def run(self):
        t_off, t_slow = time.time(), 0.0
        while not self.stopped and not self.gone:
            if self.online: t_off = time.time()
            elif str(self.path).startswith("/dev/") and not os.path.exists(self.path) and time.time() - t_off > 10: self.gone = True; break      # its USB port vanished for good (not a Windows COMn name, not a demo adapter)
            try:
                if not self.online:
                    with self.lock:                                      # the motor scan / ID tools hold the bus while they work
                        self.online = self.connect()
                        if not self.online: self.ph.closePort()
                    if not self.online: time.sleep(2); continue
                if not (TELE.on and self.role == "leader"):
                    with self.lock: self._read_pos()                      # FAST (every cycle): all positions in ONE sync-read packet (while teleop runs it reads the leader itself and fills .pos)
                if time.time() - t_slow >= (0.2 if TELE.on else 0.1):     # SLOW (10 Hz, 5 Hz while teleop runs): status flags, load, temperature, voltage. The lock is taken per register read, never for the whole sweep: the teleop loop waits at most one read (~1 ms)
                    t_slow = time.time()
                    for i in list(self.ids):
                        with self.lock: st, r, _ = self.pk.read1ByteTxRx(self.ph, i, 65)
                        if r == 0: self.fault[i] = st & 63
                        with self.lock: l, r, _ = self.pk.read2ByteTxRx(self.ph, i, 60)
                        if r == 0: self.load[i] = -(l & 1023) if l & 1024 else (l & 1023)
                        with self.lock: t, r, _ = self.pk.read1ByteTxRx(self.ph, i, 63)
                        if r == 0:                                        # ignore a one-off corrupted byte: a real temperature never jumps >10 °C in 0.1 s
                            if i not in self.temp or abs(t - self.temp[i]) <= 10 or self._tbad.get(i, 0) >= 3: self.temp[i] = t; self._tbad[i] = 0; self.temp_t[i] = time.time()
                            else: self._tbad[i] = self._tbad.get(i, 0) + 1
                    for i in [i for i in self.temp if time.time() - self.temp_t.get(i, 0) > 3]: self.temp.pop(i, None)       # a temperature that could not be re-read for 3 s is UNKNOWN, not "still 61 C" (a stale value blocked teleop as 'too warm' while the motor read 46 C)
                    if self.ids:
                        with self.lock: v, r, _ = self.pk.read1ByteTxRx(self.ph, self.ids[0], 62)
                        if r == 0: self.volt = v / 10
                    self.slow_n += 1                                      # lets the teleop guard count each fresh load/temperature reading once
                self._busy_n = 0; self._heal(); self._rejoin()
                if self.calib["step"] == "sweep":
                    for i, p in self.pos.items():
                        lo, hi = self.calib["ranges"][JOINTS[i]]
                        self.calib["ranges"][JOINTS[i]] = [min(lo, p), max(hi, p)]
            except TimeoutError:                                          # someone else holds the bus: skip this poll; if it stays stuck for ~6 s, reconnect
                self._busy_n += 1
                if self._busy_n == 1: trace.log("warn", "arm", f"{self.role}: the motor bus is busy, skipping a poll")
                if self._busy_n > 30: self.online, self._busy_n = False, 0
            except Exception as e:
                msg = f"{type(e).__name__}: {str(e)[:100]}"
                if msg != self.err: trace.log("error", "arm", f"{self.role}: {msg}")
                if time.time() - getattr(self, "_errt", 0) > 5:         # say WHY the arm just went 'offline' (it used to be silent)
                    self._errt = time.time(); import traceback; traceback.print_exc()
                self.online, self.err = False, msg
            time.sleep(0.008 if _SYNC_READ else 0.033)                # without one-packet reads (the demo's simulated bus) a fast loop would only burn CPU

    def _rejoin(self):
        """A joint that did not answer at connect is re-pinged every 2 s: when its cable is fixed it joins by itself, and we say so."""
        if not self.missing or time.time() - self._rj < 2: return
        self._rj = time.time()
        with self.lock:
            back = [i for i in JOINTS if JOINTS[i] in self.missing and self.pk.ping(self.ph, i)[1] == 0]
            for i in back: self.alive.add(i)
        if back:
            self._refresh_ids()
            self._say(f"{', '.join(JOINTS[i] for i in back)} is back" + (f"; still no answer from {', '.join(self.missing)}" if self.missing else ""))
            print(f"[arm {self.path}] answered again: {[JOINTS[i] for i in back]}; still missing: {self.missing}", flush=True)

    def _heal(self):
        """A motor that tripped its protection (overload, current, temperature…) stops answering until torque is toggled: do that, at most 4 times a minute, and say so."""
        bad = {i: f for i, f in self.fault.items() if f}
        if not bad or not self.torque_on or self.wiggling or self.calib["step"] != "idle": return
        now = time.time()
        hot = {i for i in bad if self.temp.get(i, 0) >= self.HOT_C - 5}      # still hot: re-arming it only heats it more, so its torque stays OFF until it is below 55 °C
        if hot:
            with self.lock:
                for i in hot: self.pk.write1ByteTxRx(self.ph, i, 40, 0)
            if now - getattr(self, "_hot_say", 0) > 10:
                self._hot_say = now; self._say(", ".join(f"{JOINTS[i]} is {self.temp.get(i)} °C" for i in hot) + ": its torque is kept off until it is below 55 °C")
            bad = {i: f for i, f in bad.items() if i not in hot}
            if not bad: return
        self._rec = [t for t in self._rec if now - t < 60]
        names = ", ".join(f"{JOINTS[i]} {'/'.join(v for k, v in FAULT_BITS.items() if f & k)}" for i, f in bad.items())
        if len(self._rec) >= 4: return self._say(f"{names}: keeps tripping its protection. Something is jamming or hot: free the arm, then press Reset")
        if self._rec and now - self._rec[-1] < 2.5: return
        self._rec.append(now)
        with self.lock:
            for i in bad:
                p, r, _ = self.pk.read2ByteTxRx(self.ph, i, 56)
                self.pk.write1ByteTxRx(self.ph, i, 40, 0)
                if r == 0: self.pk.write2ByteTxRx(self.ph, i, 42, p)
                self.pk.write1ByteTxRx(self.ph, i, 40, 1)
        self._say(f"{names}: protection tripped: torque re-armed, the arm holds where it is")

    def _eeprom(self, fn):
        for i in self.ids: self.pk.write1ByteTxRx(self.ph, i, 55, 0)
        fn()
        for i in self.ids: self.pk.write1ByteTxRx(self.ph, i, 55, 1)

    def calib_start(self):
        role = self.role
        if not self.online or self.wiggling: return
        if self.missing: return self._say(f"Cannot calibrate: {', '.join(self.missing)} does not answer (a calibration would silently leave it out). Fix its cable first")
        with self.lock:
            def reset():
                for i in self.ids:
                    self.pk.write1ByteTxRx(self.ph, i, 40, 0); self.pk.write1ByteTxRx(self.ph, i, 33, 0)
                    self.pk.write2ByteTxRx(self.ph, i, 31, 0); self.pk.write2ByteTxRx(self.ph, i, 9, 0)
                    self.pk.write2ByteTxRx(self.ph, i, 11, 4095)
            self._eeprom(reset)
        self.calib = {"step": "center", "role": role, "id": CALIB_DIRS[role][1]}

    def calib_center(self):
        if self.calib["step"] != "center": return
        homing = {}
        with self.lock:
            def home():
                for i in self.ids:
                    off = self.pk.read2ByteTxRx(self.ph, i, 56)[0] - MID
                    homing[i] = off
                    self.pk.write2ByteTxRx(self.ph, i, 31, off if off >= 0 else (1 << 11) | -off)
            self._eeprom(home)
        time.sleep(0.2)
        self.calib.update(step="sweep", homing=homing, error=None,
                          ranges={JOINTS[i]: [MID, MID] for i in self.ids})

    def calib_finish(self):
        if self.calib["step"] != "sweep": return
        ranges = dict(self.calib["ranges"]); ranges["wrist_roll"] = [0, 4095]
        stuck = [n for n, (lo, hi) in ranges.items() if hi - lo < MIN_SPAN]
        if stuck:
            self.calib["error"] = "Move these joints through their full range: " + ", ".join(stuck); return
        with self.lock:
            def limits():
                for i in self.ids:
                    lo, hi = ranges[JOINTS[i]]
                    self.pk.write2ByteTxRx(self.ph, i, 9, lo); self.pk.write2ByteTxRx(self.ph, i, 11, hi)
            self._eeprom(limits)
        sub, cid = CALIB_DIRS[self.calib["role"]]
        path = CALIB_ROOT / sub / f"{cid}.json"; path.parent.mkdir(parents=True, exist_ok=True)
        data = {JOINTS[i]: {"id": i, "drive_mode": 0, "homing_offset": self.calib["homing"][i],
                            "range_min": ranges[JOINTS[i]][0], "range_max": ranges[JOINTS[i]][1]} for i in self.ids}
        path.write_text(json.dumps(data, indent=4))
        self.ensure_default()                                    # the first calibration is the restore point from the start
        self.calib.update(step="done", ranges=ranges, saved=str(path), error=None)

    def calib_cancel(self):
        self.calib = {"step": "idle"}

    # --- saved calibration, default snapshot, restore ---
    def cal(self):
        p = cal_path(self.role)
        try: key = (p, p.stat().st_mtime)
        except OSError: return None
        if self._cc[0] != key: self._cc = (key, json.loads(p.read_text()))
        return self._cc[1]

    def ensure_default(self):
        """The first calibration found becomes the default; later calibrations never overwrite it."""
        cur, dflt = cal_path(self.role), cal_path(self.role, ".default")
        if cur.exists() and not dflt.exists(): shutil.copy(cur, dflt)

    def _say(self, text): self.notice = (text, time.time()); trace.log("info", "arm", text)

    def set_default(self):
        cur = cal_path(self.role)
        if not cur.exists(): return self._say("No calibration to save as default yet")
        shutil.copy(cur, cal_path(self.role, ".default")); self._say("Current calibration saved as default")

    def restore_default(self):
        dflt = cal_path(self.role, ".default")
        if not self.online or self.calib["step"] in ("center", "sweep") or not dflt.exists():
            return self._say("No default calibration saved yet" if not dflt.exists() else "Arm busy")
        data = json.loads(dflt.read_text())
        with self.lock:
            def write():
                for i in self.ids:
                    c = data.get(JOINTS[i])
                    if not c: continue
                    off = c["homing_offset"]
                    self.pk.write1ByteTxRx(self.ph, i, 40, 0); self.pk.write1ByteTxRx(self.ph, i, 33, 0)
                    self.pk.write2ByteTxRx(self.ph, i, 31, off if off >= 0 else (1 << 11) | -off)
                    self.pk.write2ByteTxRx(self.ph, i, 9, c["range_min"]); self.pk.write2ByteTxRx(self.ph, i, 11, c["range_max"])
            self._eeprom(write)
        shutil.copy(dflt, cal_path(self.role)); self.calib = {"step": "idle"}
        self._say("Default calibration restored to the motors")

    def read_loads(self):
        """Fresh load reading for every motor (used by the safety guard during autonomous moves)."""
        out = {}
        with self.lock:
            for i in self.ids:
                l, r, _ = self.pk.read2ByteTxRx(self.ph, i, 60)
                if r == 0: out[i] = -(l & 1023) if l & 1024 else (l & 1023)
        return out

    def read_pos(self):
        """Fresh position of every motor right now (the background poll is only 10 Hz)."""
        out = {}
        with self.lock:
            for i in self.ids:
                p, r, _ = self.pk.read2ByteTxRx(self.ph, i, 56)
                if r == 0: out[i] = p
        return out

    def set_grip_torque(self, v):
        with self.lock: self.pk.write2ByteTxRx(self.ph, 6, 48, int(v))

    def hold_here(self):
        """Stop pushing: command every motor to where it is right now (keeps holding, no torque spike)."""
        with self.lock:
            for i in self.ids:
                p, r, _ = self.pk.read2ByteTxRx(self.ph, i, 56)
                if r == 0: self.pk.write2ByteTxRx(self.ph, i, 42, p)

    def goto(self, goals):
        with self.lock:
            for i, t in goals.items():
                if i in self.ids: self.pk.write2ByteTxRx(self.ph, i, 42, int(t))

    def limp_now(self):
        """Torque OFF on all six motors right now, whether or not they answered at connect (a motor that does not answer may still be listening, and one that is
        silent keeps its last torque, so the arm can be stiff while the dashboard cannot see it). No lowering first. Returns how many motors confirmed it."""
        done = 0
        try:
            with self.lock:
                if not getattr(self.ph, "is_open", False):
                    if not self.ph.openPort(): return 0
                    self.ph.setBaudRate(1000000)
                for i in JOINTS:
                    for _ in range(2):
                        if self.pk.write1ByteTxRx(self.ph, i, 40, 0)[1] == 0: done += 1; break
        except Exception: pass
        self.torque_on = False
        return done

    def arm_motion(self, on):
        """Torque on (holding the current pose, smooth dynamics, gripper force capped) or off."""
        if not on:
            self.limp_now(); return
        self.torque_on = on
        with self.lock:
            for i in self.ids:
                if on:
                    cur = self.pk.read2ByteTxRx(self.ph, i, 56)[0]
                    self.pk.write1ByteTxRx(self.ph, i, 41, 25); self.pk.write2ByteTxRx(self.ph, i, 46, 900)
                    self.pk.write1ByteTxRx(self.ph, i, 21, 16)                                        # position P gain back to the calm 16 (teleop raises it)
                    self.pk.write2ByteTxRx(self.ph, i, 48, 450 if i == 6 else 1000)          # torque limit: the gripper's force is capped, the others get full torque back (teleop lowers the wrist roll's)
                    self.pk.write2ByteTxRx(self.ph, i, 42, cur)
                self.pk.write1ByteTxRx(self.ph, i, 40, 1 if on else 0)

    def nudge(self, name):
        """Move ONE joint a few degrees and back, so you can see which part of the twin it drives."""
        ids = {v: k for k, v in JOINTS.items()}; i = ids.get(name)
        if i not in self.ids or self.wiggling or not self.online or self.calib["step"] in ("center", "sweep"): return
        self.wiggling = True
        def job():
            try:
                with self.lock:
                    lo, hi = self.pk.read2ByteTxRx(self.ph, i, 9)[0], self.pk.read2ByteTxRx(self.ph, i, 11)[0]
                    cur = self.pk.read2ByteTxRx(self.ph, i, 56)[0]
                    self.pk.write1ByteTxRx(self.ph, i, 41, 20); self.pk.write2ByteTxRx(self.ph, i, 46, 250)
                    self.pk.write2ByteTxRx(self.ph, i, 42, cur); self.pk.write1ByteTxRx(self.ph, i, 40, 1)
                for tgt in (cur + 130, cur - 130, cur):
                    with self.lock: self.pk.write2ByteTxRx(self.ph, i, 42, max(lo + 5, min(hi - 5, tgt)))
                    time.sleep(1.1)
            finally:
                with self.lock: self.pk.write1ByteTxRx(self.ph, i, 40, 0)
                self.wiggling = False
        threading.Thread(target=job, daemon=True).start()

    def wiggle(self):
        if self.wiggling or not self.online or self.calib["step"] in ("center", "sweep"): return
        self.wiggling = True
        def job():
            amp = {1: 120, 2: 120, 3: 120, 4: 150, 5: 450, 6: 300}
            try:
                with self.lock:
                    start = {i: self.pk.read2ByteTxRx(self.ph, i, 56)[0] for i in self.ids}
                    for i in self.ids:
                        self.pk.write1ByteTxRx(self.ph, i, 41, 20); self.pk.write2ByteTxRx(self.ph, i, 46, 400)
                        self.pk.write2ByteTxRx(self.ph, i, 42, start[i]); self.pk.write1ByteTxRx(self.ph, i, 40, 1)
                for _ in range(3):
                    for d in (1, -1, 0):
                        with self.lock:
                            for i in self.ids:
                                self.pk.write2ByteTxRx(self.ph, i, 42, max(0, min(4095, start[i] + d * amp[i])))
                        time.sleep(0.9)
            finally:
                with self.lock:
                    for i in self.ids: self.pk.write1ByteTxRx(self.ph, i, 40, 0)
                self.wiggling = False
        threading.Thread(target=job, daemon=True).start()

    # --- motor tools (Motor IDs / Test motors pages): read-only ping, gentle wiggle, bus scan, ID change ---
    def _busy_reason(self):
        """Why the bus must be left alone right now (None = free)."""
        if self.calib["step"] in ("center", "sweep"): return "A calibration is running: finish or cancel it first."
        if self.wiggling: return "The arm is running a test movement: wait until it ends."
        if TELE.on: return "The leader arm is driving the follower: press Stop first."
        if PP and PP.running: return "Pick & place is running: press Stop first."
        return None

    def ping_motor(self, mid):
        """Read-only: does motor `mid` answer, and what does it say? Never moves or writes anything."""
        mid = int(mid)
        if mid not in JOINTS: raise Refused("Motor IDs on the SO-101 are 1 to 6.")
        if not self.online: raise Refused("This arm is offline: check its USB cable and that the board's power supply is plugged in.")
        t0 = time.perf_counter(); name = JOINTS[mid].replace("_", " ")
        try:
            with self.lock:
                _, r, _ = self.pk.ping(self.ph, mid)
                if r == 0:
                    pos, rp, _ = self.pk.read2ByteTxRx(self.ph, mid, 56); ld, rl, _ = self.pk.read2ByteTxRx(self.ph, mid, 60)
                    tmp, rt, _ = self.pk.read1ByteTxRx(self.ph, mid, 63); vlt, rv, _ = self.pk.read1ByteTxRx(self.ph, mid, 62)
        except TimeoutError: raise Refused("The motor bus is busy: try again in a moment.")
        ms = round((time.perf_counter() - t0) * 1000, 1)
        if r != 0: return {"ok": False, "id": mid, "joint": JOINTS[mid], "position": None, "load_pct": None, "temp_c": None, "volt": None, "ms": ms,
                           "message": f"Motor {mid} ({name}) did not answer. Check its cable, the board's power supply and that its ID is {mid}."}
        load = -(ld & 1023) if ld & 1024 else (ld & 1023)
        return {"ok": True, "id": mid, "joint": JOINTS[mid], "position": pos if rp == 0 else None, "load_pct": round(abs(load) / 10, 1) if rl == 0 else None,
                "temp_c": tmp if rt == 0 else None, "volt": vlt / 10 if rv == 0 else None, "ms": ms,
                "message": f"Motor {mid} ({name}) answered in {ms:g} ms."}

    def wiggle_motor(self, mid):
        """Move ONE joint about 10 degrees (gripper: less, with a low torque cap), slowly, there and back, and report what really happened.
        The motor ends in the torque state it started in (limp stays limp, holding stays holding). Nothing else is touched."""
        mid = int(mid)
        if mid not in JOINTS: raise Refused("Motor IDs on the SO-101 are 1 to 6.")
        if not self.online: raise Refused("This arm is offline: check its USB cable and that the board's power supply is plugged in.")
        why = self._busy_reason()
        if why: raise Refused(why)
        name = JOINTS[mid].replace("_", " ")
        if mid not in self.ids: raise Refused(f"Motor {mid} ({name}) is not answering, so it can't be moved. Ping it first, and check its cable, the power supply and its ID.")
        self.wiggling = True
        moved, peak, aborted, was_on, cur, saved = 0, 0.0, "", False, None, {}
        try:
            try:
                with self.lock:
                    cur, r, _ = self.pk.read2ByteTxRx(self.ph, mid, 56)
                    if r != 0: raise Refused(f"Motor {mid} ({name}) did not answer just now: check its cable.")
                    lo, hi = self.pk.read2ByteTxRx(self.ph, mid, 9)[0], self.pk.read2ByteTxRx(self.ph, mid, 11)[0]
                    was_on = bool(self.pk.read1ByteTxRx(self.ph, mid, 40)[0])
                    saved = {41: self.pk.read1ByteTxRx(self.ph, mid, 41)[0], 46: self.pk.read2ByteTxRx(self.ph, mid, 46)[0], 48: self.pk.read2ByteTxRx(self.ph, mid, 48)[0]}
                    self.pk.write1ByteTxRx(self.ph, mid, 41, 20); self.pk.write2ByteTxRx(self.ph, mid, 46, 250)
                    if mid == 6: self.pk.write2ByteTxRx(self.ph, mid, 48, min(saved[48] or 1000, 300))      # the gripper pinches gently
                    self.pk.write2ByteTxRx(self.ph, mid, 42, cur); self.pk.write1ByteTxRx(self.ph, mid, 40, 1)  # torque on AT the present position: no jump
                amp = 80 if mid == 6 else 110
                a, b = (lo + 5, hi - 5) if hi - lo > 100 else (0, 4095)                                          # stay inside the calibrated range when there is one
                hits = 0
                for tgt in [max(a, min(b, g)) for g in (cur + amp, cur - amp, cur)]:
                    with self.lock: self.pk.write2ByteTxRx(self.ph, mid, 42, tgt)
                    t_end, settled = time.time() + 2.5, 0
                    while time.time() < t_end:
                        time.sleep(0.05)
                        with self.lock: p, rp, _ = self.pk.read2ByteTxRx(self.ph, mid, 56); ld, rl, _ = self.pk.read2ByteTxRx(self.ph, mid, 60)   # fresh reads, not the 10 Hz poll
                        if rp == 0: moved = max(moved, abs(p - cur)); settled = settled + 1 if abs(p - tgt) <= 6 else 0
                        if rl == 0:
                            pct = abs(-(ld & 1023) if ld & 1024 else (ld & 1023)) / 10; peak = max(peak, pct)
                            hits = hits + 1 if (pct >= 70 and mid != 6) else 0
                        if hits >= 3: aborted = f"it was pushing at {peak:.0f}% of its strength"; break
                        if settled >= 2: break
                    if aborted: break
            finally:
                with self.lock:
                    if cur is not None:
                        end = cur
                        if aborted:
                            p, rp, _ = self.pk.read2ByteTxRx(self.ph, mid, 56); end = p if rp == 0 else cur          # stop pushing: hold where it is
                        self.pk.write2ByteTxRx(self.ph, mid, 42, end)
                        for reg, v in saved.items():
                            if reg == 41: self.pk.write1ByteTxRx(self.ph, mid, 41, v)
                            else: self.pk.write2ByteTxRx(self.ph, mid, reg, v)
                        if not was_on: self.pk.write1ByteTxRx(self.ph, mid, 40, 0)                                  # it started limp: it ends limp
        except TimeoutError: raise Refused("The motor bus is busy: try again in a moment.")
        finally: self.wiggling = False
        deg = round(moved * 360 / 4095, 1)
        if aborted: msg, ok = f"Motor {mid} ({name}) stopped early because {aborted}. Something may be blocking it: free the arm and try again.", False
        elif deg >= 4: msg, ok = f"Motor {mid} ({name}) moved {deg:.0f} degrees and came back. It works.", True
        else: msg, ok = f"Motor {mid} ({name}) did not move ({deg:g} degrees). Check its cable and the board's power supply, and that its ID is {mid}.", False
        return {"ok": ok, "id": mid, "joint": JOINTS[mid], "moved_deg": deg, "peak_load_pct": round(peak, 1), "message": msg}

    def _sweep(self, first_only):
        """[(baud, id)] of every motor that answers, over the usual baud rates. Only pings: nothing is written."""
        rates, ids, hits = _defaults.get("serial.scan_baud_rates"), range(1, 17), []
        try:
            with self.lock:
                try:
                    for b in rates:
                        if not self.ph.setBaudRate(b): continue                     # the SDK has no driver for some rates (76800): skip them
                        hits += [(b, i) for i in ids if self.pk.ping(self.ph, i)[1] == 0]
                        if hits and first_only: break
                finally: self.ph.setBaudRate(_defaults.get("serial.baud"))
        except TimeoutError: raise Refused("The motor bus is busy: try again in a moment.")
        except Refused: raise
        except Exception as e: raise Refused(f"Could not talk to the adapter ({type(e).__name__}): is the USB cable still plugged in?")
        return hits

    def motor_scan(self):
        """Which motor IDs answer on this adapter? Tries the usual baud rates, 1 Mbit/s first, and stops at the first one with answers.
        Read-only. Returns the sorted IDs; self.scan_baud is the baud rate they answered at."""
        why = self._busy_reason()
        if why: raise Refused(why)
        hits = self._sweep(first_only=True)
        self.scan_baud = hits[0][0] if hits else None
        return sorted(i for _, i in hits)

    def motor_set_id(self, new_id):
        """Give the ONE motor on this bus a new ID (and set it to 1 Mbit/s). Refuses unless exactly one motor answers at any baud rate."""
        try: new_id = int(new_id)
        except (TypeError, ValueError): raise Refused("Give the new ID as a number from 1 to 6.")
        if not 1 <= new_id <= 252: raise Refused("A motor ID must be between 1 and 252 (the SO-101 uses 1 to 6).")
        why = self._busy_reason()
        if why: raise Refused(why)
        hits = self._sweep(first_only=False)
        if not hits: raise Refused("No motor answered at any speed. Check that the board's power supply is plugged in and the motor's cable is clicked in, then try again.")
        if len(hits) > 1:
            raise Refused(f"{len(hits)} motors answer (IDs {', '.join(str(i) for _, i in hits)}). Plug in only the one motor you want to set, unplug the others, and try again.")
        baud, old = hits[0]; goal = _defaults.get("serial.baud")
        if old == new_id and baud == goal: return {"ok": True, "changed": False, "old_id": old, "new_id": new_id, "baud": baud, "message": f"The motor already has ID {new_id}."}
        note = ""
        try:
            with self.lock:
                try:
                    self.ph.setBaudRate(baud)
                    self.pk.write1ByteTxRx(self.ph, old, 40, 0)                      # torque off
                    self.pk.write1ByteTxRx(self.ph, old, 55, 0)                      # unlock the saved settings
                    if old != new_id: self.pk.write1ByteTxRx(self.ph, old, 5, new_id)  # ID (register 5): from now on the motor answers to the new one
                    self.pk.write1ByteTxRx(self.ph, new_id, 6, 0)                    # baud code 0 = 1 Mbit/s
                    self.ph.setBaudRate(goal)
                    if self.pk.ping(self.ph, new_id)[1] != 0:                        # some motors switch speed only after a power cycle
                        self.ph.setBaudRate(baud)
                        if self.pk.ping(self.ph, new_id)[1] != 0: raise Refused(f"The new ID was written but the motor no longer answers. Unplug its cable, plug it in again, and press Scan.")
                        note = " Unplug and replug the motor's power once so it switches to the new speed."
                    self.pk.write1ByteTxRx(self.ph, new_id, 55, 1)                   # lock again, with the NEW id
                finally: self.ph.setBaudRate(goal)
        except TimeoutError: raise Refused("The motor bus is busy: try again in a moment.")
        except Refused: raise
        except Exception as e: raise Refused(f"Could not talk to the adapter ({type(e).__name__}): is the USB cable still plugged in?")
        self.online = False                                                          # reconnect: the arm re-reads which motors answer
        self._say(f"Motor ID changed: {old} -> {new_id}")
        return {"ok": True, "changed": True, "old_id": old, "new_id": new_id, "baud": goal, "message": f"Done: the motor's ID is now {new_id}.{note}"}

    @property
    def role_confirmed(self):
        """True once the PERSON said which arm this is (a first-seen guess is not enough to decide where a calibration is saved)."""
        return DEMO or _roles.is_confirmed(ROLES_FILE, self.key, self.path)

    PUSH_LIMIT, PUSH_LIMIT_ROLL, PUSH_SECONDS, HOT_C = 700, 850, 1.5, 60

    def problems(self):
        """Everything wrong with this arm right now, as data (joint + kind + numbers). The dashboard words it, points at the joint on the 3D arm and lists the fix.
        Kinds: missing (no answer), hot, push (load held at the limit), fault (motor's own protection flag), teleop_stop (the leader->follower guard stopped)."""
        out, now = [], time.time()
        if len(self.missing) >= 3:                                                   # most or all silent = the bus, power or the first cable, not six broken motors: ONE problem, not six
            out.append({"joint": "shoulder_pan", "kind": "no_bus", "count": len(self.missing), "total": len(JOINTS)})
        else:
            for n in self.missing: out.append({"joint": n, "kind": "missing"})
        for i in self.ids:
            n, t, ld, flags = JOINTS[i], self.temp.get(i), self.load.get(i), self.fault.get(i, 0)
            hot = t is not None and t >= self.HOT_C - 5 and not (PP and PP.cfg.get("ignore_heat"))        # same limit that blocks teleop and keeps a tripped motor off (unless the heat checks are switched off)
            if hot: out.append({"joint": n, "kind": "hot", "value": t, "tripped": bool(flags & 4)})
            whats = [w for bit, w in FAULT_BITS.items() if flags & bit and not (bit == 4 and hot)]      # all of one motor's flags in ONE problem (voltage+sensor+current+... came together)
            if whats: out.append({"joint": n, "kind": "fault", "whats": whats, "value": t})
            lim = self.PUSH_LIMIT_ROLL if i == 5 else self.PUSH_LIMIT
            if i != 6 and ld is not None and abs(ld) >= lim:                      # the gripper holds things hard on purpose
                since = self._lh.setdefault(i, now)
                if now - since >= self.PUSH_SECONDS: out.append({"joint": n, "kind": "push", "value": round(abs(ld) / 10)})
            else: self._lh.pop(i, None)
        if self.volt and ((self.role == "follower" and self.volt < 9) or (self.role == "leader" and self.volt > 10)):       # the follower runs on 12 V, the leader on about 7 V (measured)
            out.append({"joint": "shoulder_pan", "kind": "role_swap", "value": round(self.volt, 1), "role": self.role})
        if self.role == "follower" and not TELE.on and 5 in self.ids:
            gap = TELE.roll_gap()
            if gap is not None and gap > TELE.ROLL_GAP_DEG: out.append({"joint": "wrist_roll", "kind": "apart", "value": round(gap)})
        tf = TELE.fault
        if tf and self.role == "follower": out.append({"joint": tf["joint"], "kind": "teleop_stop", "what": tf["what"], "value": tf["value"], "ago": round(now - tf["t"])})
        return out

    def state(self):
        cal = self.cal()
        return {"port": self.path, "role": self.role, "role_confirmed": self.role_confirmed, "online": self.online, "problems": self.problems(),
                "torque_on": self.torque_on, "ignored": self.ignored,
                "calibrated": cal is not None, "has_default": cal_path(self.role, ".default").exists(),
                "cal": {n: [c["range_min"], c["range_max"]] for n, c in cal.items()} if cal else None,
                "missing": self.missing, "notice": self.notice[0] if time.time() - self.notice[1] < 6 else "", "volt": self.volt, "wiggling": self.wiggling, "err": self.err,
                "calib": {k: v for k, v in self.calib.items() if k != "homing"},
                "faults": {JOINTS[i]: [v for k, v in FAULT_BITS.items() if f & k] for i, f in self.fault.items() if f},
                "joints": [{"id": i, "name": JOINTS[i], "pos": self.pos.get(i), "load": self.load.get(i), "temp": self.temp.get(i), "ignored": JOINTS[i] in IGNORED} for i in JOINTS if i in self.alive]}


class Camera(threading.Thread):
    """Reads a local webcam (int index) or another dashboard's raw MJPEG stream (URL). Tracks freshness so the UI can say
    when the feed is dead instead of silently showing a stale/black picture."""
    def __init__(self, src, cid=0):
        super().__init__(daemon=True)
        self.cid = cid
        self.src, self.jpg, self.raw_jpg, self.frame = src, None, None, None
        self.last_t, self.err, self.fps, self._n, self._t0 = 0.0, "waiting for first frame", 0.0, 0, time.time()
        self._lost, self.stopped = False, False

    @property
    def age(self): return time.time() - self.last_t if self.last_t else 1e9

    @property
    def ok(self): return self.age < 2.5

    def _fail(self, msg):
        self.err = msg
        if not self._lost: self._lost = True; trace.log("warn", "camera", f"camera {self.cid + 1} lost: {msg}")

    def _push(self, frame, raw=None):
        if self._lost: self._lost = False; trace.log("info", "camera", f"camera {self.cid + 1} is back")
        self.frame, self.last_t, self.err = frame, time.time(), ""
        self.raw_jpg = raw or cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])[1].tobytes()
        self.jpg = cv2.imencode(".jpg", PP.annotate(frame.copy(), self.cid), [cv2.IMWRITE_JPEG_QUALITY, 70])[1].tobytes() if PP else self.raw_jpg
        self._n += 1
        if time.time() - self._t0 >= 2: self.fps, self._n, self._t0 = self._n / (time.time() - self._t0), 0, time.time()

    def _run_url(self):
        while True:
            try:
                r = urllib.request.urlopen(self.src, timeout=4)         # socket timeout: a dead peer raises instead of hanging
                while True:
                    line = r.readline()
                    if not line: raise EOFError("camera stream closed")
                    if line.lower().startswith(b"content-length:"):
                        n = int(line.split(b":")[1])
                        while r.readline().strip(): pass
                        data = b""
                        while len(data) < n:
                            chunk = r.read(n - len(data))
                            if not chunk: raise EOFError("camera stream closed")
                            data += chunk
                        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
                        if frame is not None: self._push(frame, data)
            except Exception as e:
                self._fail(f"can't reach {self.src.split('/')[2]}: {str(e)[:60]}"); time.sleep(1.5)

    def _run_local(self):
        try: os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)       # pictures yield the CPU to the motors (a small computer can run at load 6 on 4 threads)
        except Exception: pass
        cap, _last = None, 0.0
        while True:
            if cap is None or not cap.isOpened():
                cap = cv2.VideoCapture(self.src, cv2.CAP_V4L2) if isinstance(self.src, str) else cv2.VideoCapture(self.src)
                cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG")); cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480); cap.set(cv2.CAP_PROP_FPS, 30)
            if not cap.grab(): self._fail("camera not delivering frames"); cap.release(); cap = None; time.sleep(2); continue      # grab = take the next frame off the camera WITHOUT decoding it
            now = time.time()
            if now - _last < (1 / 3 if TELE.on else 1 / 15): continue          # at most 15 processed frames a second (3 while leader -> follower runs): decoding + annotating + JPEG-encoding every frame at 30 fps took most of a core and starved the arm threads
            ok, frame = cap.retrieve()
            if not ok: continue
            _last = now; self._push(frame)

    def _run_demo(self):
        from so101 import demo
        i = int(str(self.src).rsplit("/", 1)[1])
        while not self.stopped: self._push(demo.frame(i)); time.sleep(1 / 15)

    def run(self):
        if str(self.src).startswith("demo://"): self._run_demo()
        elif isinstance(self.src, str) and self.src.startswith("http"): self._run_url()
        else: self._run_local()


arms, cam, cams, PP = {}, None, [], None
DEMO = getattr(sdk, "IS_DEMO", False)                       # True when the simulated motor bus is installed (never opens a real device)
STATE_CACHE = [0.0, b""]
STATE_TTL = 0.0 if os.environ.get("SO101_NO_STATE_CACHE") == "1" else 0.12      # the tests switch the cache off: they change state in-process and read it straight back


class Teleop(threading.Thread):
    """The leader arm drives the follower: every follower joint copies the matching leader joint (LeRobot's range mapping).
    Safety layers: slew limit (a fast hand never makes the follower jump), load + temperature guard on the follower, the table is a floor the tip may not go below,
    and the bowl keep-out. If anything trips, the follower holds where it is and the reason is shown."""
    HZ, SLEW_PS, SLEW_SYNC_PS, LOAD_LIMIT = 120, 2400, 240, 700      # loop rate; max follower speed in ticks/s (2400 = 210 deg/s) and the gentle catch-up speed (240 = 21 deg/s)

    def __init__(self):
        super().__init__(daemon=True)
        self.on, self.msg, self.hz, self.blocked, self.synced = False, "", 0.0, "", False
        self.fault = None                        # {joint, what, value, t} of the last guard stop, kept until the user starts again or dismisses it
        self.beat = time.time(); self.ms = 0.0          # ms of work per cycle (moving average): the latency the loop itself adds
        self.dts = collections.deque(maxlen=300)         # the last 300 cycle periods (s): shows stalls that an average hides

    ROLL_GAP_DEG = 90          # the wrist roll twists its own cable: never ask it to catch up more than a quarter turn at once (2026-11-01: 267 degrees apart, 83 C)

    def roll_gap(self):
        """Degrees between where the follower's wrist roll is and where teleop would send it (the leader's roll mapped like conv() below); None when unknown."""
        f, l = self.pair()
        if not f or not l or 5 not in f.ids or 5 not in l.ids or 5 not in f.pos or 5 not in l.pos: return None
        fc, lc = f.cal(), l.cal()
        if not fc or not lc: return None
        return abs(map_raw(teleop_params(fc, lc, teleop_cfg()), "wrist_roll", l.pos[5]) - f.pos[5]) * 360 / 4095

    def align(self, act):
        """The 'Align arms' box. match = both arms are held in the SAME pose: save, per joint, the offset that makes the follower copy the leader exactly from here.
        grip_closed / grip_open = the leader trigger is squeezed fully closed / released fully open right now: remember that reading as the end."""
        if self.on: self.stop_following("stopped to change the alignment")
        f, l = self.pair()
        if not f or not l: return
        c = teleop_cfg()
        if act == "match_reset": c.pop("k", None); c.pop("grip", None); TELE_FILE.write_text(json.dumps(c)); f._say("Alignment reset to the saved calibration"); return
        if act == "match":
            fc, lc = f.cal(), l.cal(); k = dict(c.get("k") or {})
            for i in JOINTS:
                n = JOINTS[i]
                if n == "gripper" or i not in f.ids or i not in l.ids or i not in f.pos or i not in l.pos: continue
                sign = -1 if bool(lc[n].get("drive_mode")) != bool(fc[n].get("drive_mode")) else 1
                k[n] = int(f.pos[i] - sign * l.pos[i])
            c["k"] = k; TELE_FILE.write_text(json.dumps(c)); f._say("Poses matched: the follower now copies the leader from this pose"); l._say("Poses matched"); return
        if 6 in l.pos:
            g = dict(c.get("grip") or {}); g["closed" if act == "grip_closed" else "open"] = int(l.pos[6]); c["grip"] = g; TELE_FILE.write_text(json.dumps(c))
            l._say(f"Trigger {'closed' if act == 'grip_closed' else 'open'} end saved: {l.pos[6]}")

    def align_state(self):
        """Live numbers for the 'Align arms' box: per arm joint how far (degrees) the follower is from where the leader tells it to be, and the two trigger readings."""
        f, l = self.pair()
        if not f or not l or not f.cal() or not l.cal(): return None
        P = teleop_params(f.cal(), l.cal(), teleop_cfg()); out = {}
        for i, n in JOINTS.items():
            if i not in f.pos or i not in l.pos: continue
            if n == "gripper": out[n] = {"leader": l.pos[i], "follower": f.pos[i], "want": map_raw(P, n, l.pos[i])}
            else: out[n] = {"diff": round((map_raw(P, n, l.pos[i]) - f.pos[i]) * 360 / 4095, 1), "measured": P[n].get("measured", False)}
        notes = [f"{n}: the leader travels {round(p['lspan'] * 360 / 4095)} degrees, the follower {round(p['fspan'] * 360 / 4095)}: lined up at the minimum end (use Match poses to line them up exactly)" for n, p in P.items() if p["kind"] == "shift" and not p["consistent"] and n not in IGNORED]
        if "wrist_roll" in IGNORED: notes.append("wrist_roll: ignored, so it is neither driven nor followed; every other joint follows the leader")
        mp = {n: ({"kind": "prop", "flip": q["flip"], "l": list(q["l"]), "f": list(q["f"])} if q["kind"] == "prop" else {"kind": "shift", "sign": q["sign"], "k": q["k"], "flo": q["flo"], "fhi": q["fhi"]}) for n, q in P.items()}
        return {"joints": out, "grip": teleop_cfg().get("grip"), "matched": sorted((teleop_cfg().get("k") or {})), "notes": notes, "map": mp, "smooth": float(teleop_cfg().get("smooth", 40))}

    def pair(self):
        lst = list(arms.values())
        return (next((a for a in lst if a.role == "follower" and a.online), None), next((a for a in lst if a.role == "leader" and a.online), None))

    def why_not(self):
        f, l = self.pair()
        if not l and not f: return "No arms are connected"
        if not l: return "Plug the leader arm into this computer's USB first (only the follower is connected)"
        if not f: return "The follower arm is not connected"
        for a, n in ((f, "follower"), (l, "leader")):
            if a.missing: return f"The {n}'s {', '.join(a.missing)} does not answer: check its cable and power (teleop would skip it)"
        if f.cal() is None or l.cal() is None: return "Both arms need a calibration first (Arms tab)"
        warm = [] if (PP and PP.cfg.get("ignore_heat")) else [f"{JOINTS[i]} {t} °C" for i, t in f.temp.items() if i in f.ids and t >= f.HOT_C - 5]
        if warm: return f"The follower's {', '.join(warm)} is too warm: let it cool below {f.HOT_C - 5} °C first"
        gap = self.roll_gap()
        if gap is not None and gap > self.ROLL_GAP_DEG: return f"The leader's wrist roll is {gap:.0f}° away from the follower's: the follower would twist its own cable. Turn the leader's wrist roll to match first"
        if any(a.calib["step"] != "idle" for a in (f, l)) or f.wiggling or l.wiggling: return "An arm is busy (calibration or test)"
        if PP and PP.running: return "Pick & place is running: press Stop first"
        return None

    def start_following(self):
        if self.on: return
        err = self.why_not()
        if err: self.msg = err; return
        self.msg, self.blocked, self.synced, self.on, self.beat, self.fault = "starting…", "", False, True, time.time(), None

    def stop_following(self, why="stopped"):
        if self.on: self.msg = why
        self.on = False

    def state(self):
        f, l = self.pair()
        return {"on": self.on, "msg": self.msg, "hz": round(self.hz), "blocked": self.blocked, "synced": self.synced, "ms": round(self.ms, 1), "p95_ms": round(1000 * float(sorted(self.dts)[int(0.95 * len(self.dts))]) if len(self.dts) > 20 else 0, 1), "max_ms": round(1000 * max(self.dts), 1) if self.dts else 0, "why": None if self.on else self.why_not(), "both": bool(f and l)}

    def run(self):
        while True:
            if not self.on: time.sleep(0.1); continue
            try: self._session()
            except Exception as e:
                self.msg = f"stopped: {e}"
                if isinstance(e, JointFault): self.fault = {"joint": e.joint, "what": e.what, "value": e.value, "t": time.time()}
            finally:
                self.on = False
                try:
                    f, _ = self.pair()
                    if f:
                        f.hold_here()                                             # keep holding where it is: never drops
                        with f.lock:
                            for i in f.ids: f.pk.write1ByteTxRx(f.ph, i, 21, 16)      # calm gain again for everything else
                except Exception: pass

    def _session(self):
        f, l = self.pair(); err = self.why_not()
        if err: raise RuntimeError(err)
        fc, lc = f.cal(), l.cal(); ids = [i for i in JOINTS if i in f.ids and i in l.ids]
        with l.lock:                                                              # the leader must be limp so a hand can move it
            for i in l.ids: l.pk.write1ByteTxRx(l.ph, i, 40, 0)
        l.torque_on = False
        f.arm_motion(True)                                                        # follower holds its pose
        sm = float(teleop_cfg().get("smooth", 40)); sm_t = time.time()            # SMOOTHNESS 0-100 (the slider in 'Align arms'): 0 = raw and fastest, 100 = smoothest; read live
        with f.lock:                                                              # ...but for teleop it must TRACK, not glide: no acceleration ramp (254 = fastest) and no speed cap; the slew limit below is the safety
            for i in ids:
                f.pk.write1ByteTxRx(f.ph, i, 41, 254); f.pk.write2ByteTxRx(f.ph, i, 46, 3000)
                f.pk.write1ByteTxRx(f.ph, i, 21, smooth_gain(i, sm))                              # position P gain: 16 tracks slowly (113 ms behind the leader), 28-40 follows faster but shakes: the smoothness slider blends
        roll_free = bool(PP and PP.cfg.get("ignore_heat"))                        # the person chose to ignore the roll heat and keep the follower's roll following the leader
        if roll_free and 5 in ids:
            with f.lock: f.pk.write2ByteTxRx(f.ph, 5, 48, 500)                    # the roll pushes at most half torque: a cable that holds it back neither overheats it nor stops the other joints
        TP = teleop_params(fc, lc, teleop_cfg())
        def conv(i, raw): return map_raw(TP, JOINTS[i], raw)
        fast = hasattr(l.pk, "syncReadTx") and hasattr(f.pk, "syncWriteTxOnly")   # ONE packet to read the whole leader, ONE to write the whole follower (was a read + a write per motor, each waiting for an answer)
        lg = sdk.GroupSyncRead(l.ph, l.pk, 56, 2) if fast else None
        if lg is not None:
            for i in ids: lg.addParam(i)
        fw = sdk.GroupSyncWrite(f.ph, f.pk, 42, 2) if fast else None
        lpos = {}
        def read_leader():
            """Fills lpos; returns how many motors did not answer."""
            with l.lock:
                if lg is not None:                                                    # a failed sync read is skipped (the next cycle is 10 ms away); the old per-motor fallback could wait 35 ms for EACH motor
                    if lg.txRxPacket() != sdk.COMM_SUCCESS: return len(ids)
                    bad = 0
                    for i in ids:
                        if lg.isAvailable(i, 56, 2): lpos[i] = lg.getData(i, 56, 2)
                        else: bad += 1
                    return bad
                bad = 0
                for i in ids:
                    p, r, _ = l.pk.read2ByteTxRx(l.ph, i, 56)
                    if r == 0: lpos[i] = p
                    else: bad += 1
                return bad
        def write_follower(new):
            with f.lock:
                if fw is not None:
                    fw.clearParam()
                    for i, v in new.items(): v = int(v); fw.addParam(i, [v & 0xFF, (v >> 8) & 0xFF])
                    fw.txPacket()
                else:
                    for i, v in new.items(): f.pk.write2ByteTxRx(f.ph, i, 42, int(v))
        read_leader(); l.pos.update(lpos)
        with f.lock:
            goal = {i: float(f.pk.read2ByteTxRx(f.ph, i, 56)[0]) for i in ids}
        check = bool(PP and PP.z_table is not None)
        if check:                                                                 # joint angles for the table/bowl check without re-reading the calibration files on every cycle
            pcal, pflip, poff = PP._conv(f); ARMJ = {"shoulder_pan": 1, "shoulder_lift": 2, "elbow_flex": 3, "wrist_flex": 4, "wrist_roll": 5}
            def qf(d):
                raw = {**f.pos, **d}; q = {}
                for n in ARM:
                    c = pcal[n]; mid = (c["range_min"] + c["range_max"]) / 2; deg = (raw[ARMJ[n]] - mid) * 360 / 4095
                    q[n] = math.radians((-deg if pflip.get(n) else deg) + poff.get(n, 0.0))
                return q
            tipof = lambda d: [float(v) for v in PP.kin.fk(qf(d))[0]]
        tip_prev = None; filt = {}                                                # low-pass state per joint (starts at the first leader reading, so a big gap stays a big gap for the gentle catch-up)
        lost, hits, k, t_hz, n_hz = 0, {}, 0, time.time(), 0
        seen_slow, t_prev = f.slow_n, time.time()
        self.msg = "the follower is moving to the leader's pose: keep the area around it clear"
        while self.on:
            t0 = time.time(); k += 1; self.beat = t0
            bad = read_leader(); l.pos.update(lpos); l.pose_n += 1                     # the page and the Align box read the leader from l.pos
            if not f.online or not l.online: raise RuntimeError("an arm was disconnected")
            lost = lost + 1 if bad == len(ids) else 0
            if lost >= (40 if lg is not None else 10): raise RuntimeError("lost the leader arm (USB?)")      # about half a second of failed reads
            target = {i: conv(i, lpos[i]) for i in ids if i in lpos}
            dt = min(0.05, max(0.001, t0 - t_prev)); t_prev = t0
            if t0 - sm_t > 0.5:                                                   # the slider moved? re-apply the gains
                sm_t = t0; nsm = float(teleop_cfg().get("smooth", 40))
                if nsm != sm:
                    sm = nsm
                    with f.lock:
                        for i in ids: f.pk.write1ByteTxRx(f.ph, i, 21, smooth_gain(i, sm))
            tau = sm * 1.2 / 1000.0; al = 1.0 if tau < 1e-4 else 1.0 - math.exp(-dt / tau)     # exponential low-pass: time constant 0 .. 120 ms removes the hand's jitter and the encoder noise
            raw = dict(target)                                                    # the unfiltered leader pose: the 'has the follower caught up' test must see the real gap
            for i in target: filt[i] = filt.get(i, target[i]) + al * (target[i] - filt.get(i, target[i])); target[i] = filt[i]
            slew = max(1.0, (self.SLEW_PS if self.synced else self.SLEW_SYNC_PS) * dt)   # gentle until the follower has caught up with the leader; per SECOND, so the loop rate does not change the speed
            new = {i: goal[i] + max(-slew, min(slew, target[i] - goal[i])) for i in target}
            for i in new:                                                         # stay inside the follower's calibrated range
                n = JOINTS[i]; new[i] = max(fc[n]["range_min"] + 3, min(fc[n]["range_max"] - 3, new[i]))
            self.blocked = ""
            if check and all(i in new for i in (1, 2, 3, 4, 5)):
                try:
                    cur = tip_prev if tip_prev is not None else tipof(goal); tip = tipof(new)                              # ONE forward-kinematics call per cycle (the last cycle's tip is remembered)
                    floor = lambda t: t[2] < PP.z_table + 0.003 and t[2] < cur[2] - 1e-4                                  # at/below table height and still going down
                    bowl = lambda t: PP.bowl_blocked(*t) and not (PP.bowl_blocked(*cur) and t[2] >= cur[2] - 0.002)         # inside the bowl zone (leaving it upward is fine)
                    for bad_, joints, why in ((floor, (2, 3, 4), "the gripper is at table height: lift the leader to go on"), (bowl, (1, 2, 3, 4), "the bowl is in the way: the follower will not go there")):
                        if bad_(tip):
                            lo, hi = 0.0, 1.0                                                                             # go as far towards the leader as is allowed, not just stop
                            for _ in range(7):
                                mid = (lo + hi) / 2; cand = {**new, **{i: goal[i] + mid * (new[i] - goal[i]) for i in joints}}
                                if bad_(tipof(cand)): hi = mid
                                else: lo = mid
                            for i in joints: new[i] = goal[i] + lo * (new[i] - goal[i])
                            self.blocked = why; tip = tipof(new)
                    tip_prev = tip
                except Exception: tip_prev = None
            goal = {**goal, **new}
            write_follower(new)
            if not self.synced and all(abs(f.pos.get(i, goal[i]) - raw[i]) < 45 for i in raw if i != 6):
                self.synced = True; self.msg = "following the leader"
            if self.synced and not self.blocked and self.msg != "following the leader": self.msg = "following the leader"
            if f.slow_n != seen_slow:                                             # load sensing on the follower, always: every FRESH reading (10 Hz, from the arm thread: no extra bus time here) counts once
                seen_slow = f.slow_n
                for i, ld in list(f.load.items()):
                    if i == 6 or i not in f.ids or (i == 5 and roll_free): continue
                    hits[i] = hits.get(i, 0) + 1 if abs(ld) >= (850 if i == 5 else self.LOAD_LIMIT) else 0
                    if hits[i] >= 3: raise JointFault(JOINTS[i], "push", round(abs(ld) / 10), f"{JOINTS[i]} is pushing at {abs(ld) / 10:.0f}% torque (against the table or something): the follower holds still")
                for i, t in list(f.temp.items()):
                    if i in f.ids and t >= 68 and not (PP and PP.cfg.get("ignore_heat")): raise JointFault(JOINTS[i], "hot", t, f"{JOINTS[i]} is hot ({t} °C): the follower holds still")
            self.dts.append(dt); n_hz += 1; self.ms = 0.9 * self.ms + 0.1 * (time.time() - t0) * 1000
            if time.time() - t_hz >= 1.0: self.hz, n_hz, t_hz = n_hz / (time.time() - t_hz), 0, time.time()
            time.sleep(max(0.0, 1.0 / self.HZ - (time.time() - t0)))

TELE = Teleop()
REMOTE = []      # arms mirrored (view-only) from another dashboard, e.g. the Mac's arm shown on the Pi screen


def poll_remote(url):
    global REMOTE
    while True:
        try:
            d = json.load(urllib.request.urlopen(url.rstrip("/") + "/api/state", timeout=2))
            REMOTE = [dict(a, remote=True, notice="") for a in d["arms"]]
        except Exception: REMOTE = []
        time.sleep(0.1)

def PP_run_safe(fn):
    try: PP.status = "aligning the model…"; fn()
    except Exception as e: PP.status = f"error: {e}"


_stop = threading.Event()


def stop_background():
    """End the arm / camera / discovery threads (used by tests that start several servers in one process)."""
    _stop.set()
    for a in list(arms.values()): a.stopped = True
    for c in cams: c.stopped = True


def scan_arms():
    while not _stop.is_set():
        for p in [p for p, a in arms.items() if a.gone]: del arms[p]                  # a port that vanished for good: forget its card
        if DEMO: found = _demo.present_ports()                                   # demo: only the simulated adapters, the real system is never asked
        elif os.environ.get("SO101_NO_REAL_PORTS"): found = []                  # tests: never look at, let alone open, a real serial device
        else:
            found = [p for pat in PORT_GLOBS for p in glob.glob(pat)]
            try: found += [p.path for p in _ports.list_ports() if p.likely_servo_board and p.path not in found]   # Windows (COMn) and other names
            except Exception: pass
        for p in found:
            if p.startswith("/dev/cu.") or p in arms: continue
            arms[p] = Arm(p); arms[p].start()
        time.sleep(3)


def pp_state():
    """PP.state(), but a problem in it (for example an arm that is connected yet not calibrated) must never take the whole /api/state down."""
    try: return PP.state() if PP else None
    except Exception as e: trace.log("error", "pickplace", f"state: {type(e).__name__}: {str(e)[:100]}"); return None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype):
        if self.command != "GET": STATE_CACHE[0] = 0.0                  # something was just changed: the next /api/state must show it, not the copy built up to 120 ms ago
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        if trace.enabled: trace.record_http(self.command, self.path, code, len(body), getattr(self, "_t0", None))

    def _suite(self, method):
        """The suite's own routes (/, /dashboard, /suite/*, /api/suite/*, /api/m/*, /stream/<i>.mjpg ...). False = not ours, carry on with the legacy routes."""
        self._t0 = time.perf_counter()
        return suite_api.handle(self, method, self.path, None)

    def do_HEAD(self):
        if not self._suite("HEAD"): self.send(404, b"", "text/plain")

    def do_PUT(self):
        if not self._suite("PUT"): self.send(404, b"not found", "text/plain")

    def do_DELETE(self):
        if not self._suite("DELETE"): self.send(404, b"not found", "text/plain")

    def do_GET(self):
        try: os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 8)        # answering the page is less urgent than driving the arm
        except Exception: pass
        if self._suite("GET"): return
        if self.path == "/":
            self.send(200, open(os.path.join(HERE, "index.html"), "rb").read(), "text/html")
        elif self.path.startswith("/vendor/"):
            f = os.path.join(HERE, "vendor", os.path.basename(self.path))
            if os.path.isfile(f): self.send(200, open(f, "rb").read(), "application/javascript")
            else: self.send(404, b"not found", "text/plain")
        elif self.path.startswith("/assets/so101/"):
            f = os.path.join(HERE, "assets", "so101", os.path.basename(self.path))
            ct = "model/stl" if f.endswith(".stl") else "application/xml"
            if os.path.isfile(f): self.send(200, open(f, "rb").read(), ct)
            else: self.send(404, b"not found", "text/plain")
        elif self.path == "/api/pose":                                   # light, fast: just the joint positions (the page polls this at display rate)
            self.send(200, json.dumps({"t": time.time(), "arms": {a.path: {"role": a.role, "online": a.online, "n": a.pose_n, "pos": {JOINTS[i]: p for i, p in list(a.pos.items()) if i in a.alive}} for a in list(arms.values())}}).encode(), "application/json")
        elif self.path == "/api/health":
            self.send(200, json.dumps({"ok": True, "t": time.time(), "arms": len(arms), "job": bool(PP and PP.running), "teleop": TELE.on}).encode(), "application/json")
        elif self.path == "/api/state":
            if time.time() - STATE_CACHE[0] > STATE_TTL: STATE_CACHE[:] = [time.time(), json.dumps({"camera": cam.ok, "camera_age": round(min(cam.age, 999), 1), "camera_err": cam.err, "camera_fps": round(cam.fps, 1), "camera_src": str(cam.src), "cameras": [{"ok": c.ok, "age": round(min(c.age, 999), 1), "fps": round(c.fps, 1), "err": c.err, "src": str(c.src)} for c in cams], "viz": viz_load(), "pp": pp_state(), "teleop": TELE.state(), "align": TELE.align_state(), "arms": [a.state() for a in arms.values()] + REMOTE}).encode()]      # one build serves every client within 120 ms (the state is heavy: 30-110 ms, and it starved the arm threads)
            self.send(200, STATE_CACHE[1], "application/json")
        elif self.path.split("?")[0] in ("/stream.mjpg", "/raw.mjpg", "/stream2.mjpg", "/raw2.mjpg"):
            nm = self.path.split("?")[0]; attr = "raw_jpg" if "/raw" in nm else "jpg"; cx = cams[1] if "2" in nm and len(cams) > 1 else cam
            self.send_response(200); self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=f"); self.end_headers()
            try:
                last = None
                while True:
                    jpg = getattr(cx, attr)
                    if jpg and jpg is not last:
                        self.wfile.write(b"--f\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(jpg) + jpg + b"\r\n"); last = jpg
                    time.sleep(0.03)
            except (BrokenPipeError, ConnectionResetError): pass
        else: self.send(404, b"not found", "text/plain")

    def do_POST(self):
        if self._suite("POST"): return
        if self.path.startswith("/api/wiggle/"):
            idx = int(self.path.rsplit("/", 1)[1]); lst = list(arms.values())
            if idx < len(lst): lst[idx].wiggle()
            self.send(200, b"{}", "application/json")
        elif self.path.startswith("/api/calib/"):
            idx, action = self.path.split("/")[3:5]
            n = int(self.headers.get("Content-Length", 0)); body = json.loads(self.rfile.read(n) or b"{}")
            lst = list(arms.values())
            if int(idx) < len(lst):
                a = lst[int(idx)]
                {"start": a.calib_start, "center": a.calib_center,
                 "finish": a.calib_finish, "cancel": a.calib_cancel,
                 "restore": a.restore_default, "set_default": a.set_default}.get(action, lambda: None)()
            self.send(200, b"{}", "application/json")
        elif self.path.startswith("/api/pp/"):
            n = int(self.headers.get("Content-Length", 0)); b = json.loads(self.rfile.read(n) or b"{}"); act = self.path.rsplit("/", 1)[1]
            try:
                if act == "teach": PP.teach(b["u"], b["v"])
                elif act == "zone": PP.set_point(b["name"], b["u"], b["v"])
                elif act == "auto": PP.auto_start() if b.get("on", True) else PP.auto_stop()
                elif act == "clear": PP.clear_points()
                elif act == "undo": PP.undo_point()
                elif act == "param": PP.set_param(b["k"], b["v"])
                elif act == "run": PP.run(b.get("mode", "hover"), b.get("cycles", 1))
                elif act == "goto": PP.goto_robot(b["x"] / 1000, b["y"] / 1000, b.get("z", 30) / 1000)
                elif act == "probe": PP.probe_table(b.get("x", 200) / 1000, b.get("y", -90) / 1000)
                elif act == "autocal": PP.calib_auto()
                elif act == "check": PP.check_joints(set(b.get("joints") or []))
                elif act == "finder": TELE.stop_following("stopped"); PP.finder()
                elif act == "look": TELE.stop_following("stopped"); PP.go_look(float(b.get("x", 180)) / 1000, float(b.get("y", 0)) / 1000, float(b.get("h", 170)) / 1000)
                elif act == "search": TELE.stop_following("stopped"); PP.go_search()
                elif act == "cylinders": TELE.stop_following("stopped"); PP.auto_cylinders(bool(b.get("dry")))
                elif act == "limp_now": TELE.stop_following("arm released"); PP.limp_now(next((x for x in arms.values() if x.role == "follower"), None))
                elif act == "grip": PP.set_grip(float(b.get("pct", 100)))
                elif act == "vertical": PP.vertical_set() if b.get("do") == "set" else PP.vertical_reset()
                elif act == "align":
                    do = b.get("do")
                    if do == "record": PP.align_record(b.get("r", 22))
                    elif do == "fit": threading.Thread(target=lambda: PP_run_safe(PP.align_fit), daemon=True).start()
                    elif do == "clear": PP.align_clear()
                    elif do == "undo": PP.align_undo()
                    elif do == "apply": PP.apply_offsets({"wrist_flex": math.radians(float(b.get("wrist", 0))), "shoulder_lift": math.radians(float(b.get("lift", 0))), "elbow_flex": math.radians(float(b.get("elbow", 0)))}, float(b.get("z_mm", -20)) / 1000, b.get("why", ""))
                elif act == "stop": TELE.stop_following("stopped"); PP.stop()
                elif act == "reset": TELE.stop_following("reset"); PP.reset()
                elif act == "release": TELE.stop_following("arm released"); PP.release()
                elif act == "rest": TELE.stop_following("arm released"); PP.rest()
                elif act == "scan": PP.calib_tip()
                elif act == "screensaver": PP.screensaver()
            except Exception as e: PP.status = f"error: {e}"
            self.send(200, b"{}", "application/json")
        elif self.path.startswith("/api/teleop/"):
            act = self.path.rsplit("/", 1)[1]
            if act == "start": TELE.start_following()
            elif act == "dismiss": TELE.fault = None
            elif act in ("match", "match_reset", "grip_closed", "grip_open"): TELE.align(act)
            elif act == "smooth": teleop_cfg_set(smooth=max(0.0, min(100.0, float(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}").get("value", 40)))))
            else: TELE.stop_following("stopped by you")
            self.send(200, b"{}", "application/json")
        elif self.path == "/api/ignore":
            n = int(self.headers.get("Content-Length", 0)); b = json.loads(self.rfile.read(n) or b"{}")
            TELE.stop_following("restarted: the set of ignored motors changed")
            ignore_set(b.get("joint"), bool(b.get("on", True)))
            self.send(200, b"{}", "application/json")
        elif self.path == "/api/viz":
            n = int(self.headers.get("Content-Length", 0)); viz_set(json.loads(self.rfile.read(n) or b"{}"))
            self.send(200, b"{}", "application/json")
        elif self.path.startswith("/api/nudge/"):
            idx, name = self.path.split("/")[3:5]; lst = list(arms.values())
            if int(idx) < len(lst) and not TELE.on: lst[int(idx)].nudge(name)
            self.send(200, b"{}", "application/json")
        elif self.path.startswith("/api/role/"):
            n = int(self.headers.get("Content-Length", 0)); body = json.loads(self.rfile.read(n) or b"{}")
            lst = list(arms.values()); idx = int(self.path.rsplit("/", 1)[1])
            if idx < len(lst): lst[idx].role = role_for(lst[idx].path, body.get("role")); lst[idx].ensure_default()
            self.send(200, b"{}", "application/json")
        else: self.send(404, b"not found", "text/plain")


def build_parser():
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=_defaults.get("server.port"))
    ap.add_argument("--host", default="0.0.0.0", help="address to listen on (the legacy server keeps 0.0.0.0 so existing setups, such as a Pi screen showing this dashboard, keep working; `so101 start` listens on 127.0.0.1 unless you pass --host)")
    ap.add_argument("--camera", default=os.environ.get("CAMERA_INDEX"), help="local camera: index or device path (overrides the saved camera list)")
    ap.add_argument("--camera2", default=os.environ.get("CAMERA2", ""), help="optional second local camera (index or device path)")
    ap.add_argument("--camera-only", action="store_true", help="lean mode (e.g. on the Pi): just serve the camera streams, no vision or arms")
    ap.add_argument("--remote", default=os.environ.get("SO101_REMOTE", ""), help="mirror the arms of another dashboard (view-only)")
    ap.add_argument("--camera-url", default=os.environ.get("CAMERA_URL", ""), help="comma-separated raw MJPEG URLs of remote cameras (e.g. the Pi's /raw.mjpg,/raw2.mjpg)")
    ap.add_argument("--demo", action="store_true", help="simulated arms and cameras: no hardware needed, no real device is ever opened")
    return ap


def pick_cameras(a, store):
    """Where the cameras come from: command line / env (legacy) > the saved list (store key cameras.list) > the first camera found. -> (sources, origin)"""
    conv = lambda v: int(v) if str(v).isdigit() else v
    urls = [u.strip() for u in a.camera_url.split(",") if u.strip()]
    if urls or a.camera is not None or a.camera2:
        return urls or [conv(a.camera if a.camera is not None else "0")] + ([conv(a.camera2)] if a.camera2 else []), "cli"
    saved = [conv(c["source"]) for c in (store.get("cameras.list") or []) if isinstance(c, dict) and c.get("source") not in (None, "")]
    if saved: return saved, "store"
    if DEMO: return list(_demo.CAMERA_SOURCES[:_demo.N_CAMERAS]), "auto"
    try:
        from so101 import cameras as _cams
        found = _cams.list_cameras(limit=1)
        if found: return [found[0].source], "auto"
    except Exception: pass
    return [0], "auto"                                          # nothing found: the camera tile will say so instead of hiding


def setup(argv=None):
    """Parse the arguments, start every background thread and return (httpd, args). Nothing is served until httpd.serve_forever()."""
    global sdk, DEMO, cams, cam, PP
    from so101.store import Store
    a = build_parser().parse_args(argv)
    if a.demo and not getattr(sdk, "IS_DEMO", False):            # the demo bus was not installed when this module was imported
        _demo.install(fresh=not os.environ.get("SO101_RESTARTING")); sdk = sys.modules["scservo_sdk"]
    DEMO = getattr(sdk, "IS_DEMO", False)
    if DEMO and not _demo.is_demo(): _demo.install(fresh=False)
    httpd = ThreadingHTTPServer((a.host, a.port), H)            # bind FIRST: if the port is taken (another dashboard is running) nothing else starts, so no serial port is opened twice
    trace.install_logging(); store = Store()
    srcs, origin = pick_cameras(a, store)
    if isinstance(srcs[0], int): cv2.VideoCapture(srcs[0]).release()  # macOS: camera permission prompt must come from the main thread
    cams = [Camera(src, i) for i, src in enumerate(srcs)]; cam = cams[0]
    if not a.camera_only:
        PP = PickPlace(lambda: next((x for x in arms.values() if x.role == "follower" and x.online), None), lambda i=0: cams[i].frame if i < len(cams) else None, viz_load, len(cams))
    if PP: PP.external_busy = lambda: TELE.on; PP.viz_set = viz_set
    def tele_watch():
        while True:
            time.sleep(1.0)
            if TELE.on and time.time() - TELE.beat > 4.0: TELE.on, TELE.msg = False, "stopped: the leader link stalled"
    def trace_watch():                                           # one inspector log line whenever a job or the leader -> follower link starts or stops
        prev = (False, False)
        while True:
            time.sleep(0.25); now = (bool(PP and PP.running), TELE.on)
            if now[0] != prev[0]: trace.log("info", "job", f"pick & place {'started: ' + str(PP.mode) if now[0] else 'stopped'}")
            if now[1] != prev[1]: trace.log("info", "teleop", "leader -> follower " + ("started" if now[1] else "stopped"))
            prev = now
    threading.Thread(target=tele_watch, daemon=True).start()
    threading.Thread(target=trace_watch, daemon=True).start()
    TELE.start()
    for c in cams: c.start()
    if a.remote: threading.Thread(target=poll_remote, args=(a.remote,), daemon=True).start()
    if not a.camera_only: threading.Thread(target=scan_arms, daemon=True).start()
    suite_api.ctx.attach(sys.modules[__name__], store, demo=DEMO, camera_origin=origin, args=a, argv=list(argv) if argv is not None else sys.argv[1:], httpd=httpd)
    trace.set_max(store.get("adv.traceMax", 5000)); trace.set_raw(store.get("adv.traceRaw", False)); trace.set_enabled(store.get("adv.trace", False))
    return httpd, a


def main(argv=None):
    httpd, a = setup(argv)
    print(f"SO-101 dashboard on http://{a.host}:{httpd.server_address[1]}" + ("  (demo: simulated hardware)" if DEMO else ""), flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
