"""Demo mode: simulated hardware, so everything can be tried (and tested) without an arm.

* `install()` puts a fake `scservo_sdk` into sys.modules BEFORE app/server.py imports the real one. The fake talks to an
  in-memory bus of STS3215 motors and can never open a real serial device.
* `list_ports()` returns only the simulated adapters; `so101.ports.list_ports()` uses it while demo mode is on.
* Torque-on motors slew towards their goal. Torque-off motors are moved by a simulated "hand" (one joint at a time, a slow
  sine over its range) once they carry a homing offset, so calibration and leader -> follower can be demonstrated.
* `frame(i)` draws a synthetic camera picture (table, a bowl, a red keychain that drifts around).
"""
import math
import os
import pathlib
import random
import shutil
import sys
import threading
import time
import types
from typing import List

from . import trace

FOLLOWER, LEADER = "demo://follower", "demo://leader"
DEFAULT_PORTS = (FOLLOWER, LEADER)
SERIALS = {FOLLOWER: "DEMO-FOLLOWER-0001", LEADER: "DEMO-LEADER-0002"}
N_CAMERAS = 2                     # started with the app; a third one is "plugged in" so the Add camera flow can be tried
CAMERA_SOURCES = [f"demo://camera/{i}" for i in range(3)]

COMM_SUCCESS, COMM_RX_TIMEOUT, COMM_NOT_AVAILABLE = 0, -6, -9
MODEL_STS3215 = 777
BAUD_VALUES = {0: 1000000, 1: 500000, 2: 250000, 3: 128000, 4: 115200, 5: 76800, 6: 57600, 7: 38400}
SDK_BAUDS = {4800, 9600, 14400, 19200, 38400, 57600, 115200, 128000, 250000, 500000, 1000000}   # what the real SDK's setBaudRate accepts (76800 is not in it)

# STS3215 registers (docs/LEARNINGS.md section 2, plus ID/baud)
R_ID, R_BAUD, R_MIN, R_MAX, R_HOMING, R_MODE, R_TORQUE, R_ACCEL, R_GOAL, R_SPEED, R_TLIMIT, R_LOCK, R_POS, R_LOAD, R_VOLT, R_TEMP, R_STATUS = \
    5, 6, 9, 11, 31, 33, 40, 41, 42, 46, 48, 55, 56, 60, 62, 63, 65

REST_DELTA = {FOLLOWER: {1: -110, 2: 95, 3: -170, 4: 130, 5: 60, 6: 240}, LEADER: {1: 80, 2: -120, 3: 150, 4: -90, 5: -40, 6: -180}}
HAND_AMP = {1: 1000, 2: 900, 3: 950, 4: 900, 5: 1800, 6: 700}
HAND_SLOT = 4.0                   # seconds the simulated hand spends on each joint
HAND_SPEED = 2500                 # ticks per second the hand can move a joint
MOTOR_SPEED = 2000                # ticks per second when the speed register is 0 (maximum)

clock = time.monotonic            # tests replace this to move time by hand
_lock = threading.RLock()
_bus = None
_installed = False
_prev_sdk = None
_had_sdk = False
_saved_env = {}
_ENV_KEYS = ("HOME", "USERPROFILE", "SO101_HOME", "HF_LEROBOT_CALIBRATION")


def is_demo() -> bool:
    return _installed


class Motor:
    def __init__(self, port: str, mid: int, seed: int = 0):
        self.port, self.id = port, mid
        self.regs = bytearray(256)
        self.rng = random.Random(f"{port}{mid}{seed}")
        delta = REST_DELTA.get(port, {}).get(mid, 0)
        self.rest = 2047 + delta
        self.raw = float(self.rest)
        self.t = clock()
        self._w(3, 2, MODEL_STS3215)
        self._w(R_ID, 1, mid)
        self._w(R_BAUD, 1, 0)
        self._w(R_MIN, 2, 0)
        self._w(R_MAX, 2, 4095)
        self._w(R_TLIMIT, 2, 1000)
        self._w(R_LOCK, 1, 1)
        self._w(R_VOLT, 1, 74)
        self._w(R_TEMP, 1, 30 + mid % 3)
        self._w(R_GOAL, 2, int(self.raw))

    # --- raw register access ---
    def _w(self, addr, n, v):
        for k in range(n):
            self.regs[addr + k] = (int(v) >> (8 * k)) & 0xFF

    def _r(self, addr, n):
        return sum(self.regs[addr + k] << (8 * k) for k in range(n))

    @property
    def baud(self) -> int:
        return BAUD_VALUES.get(self.regs[R_BAUD], 1000000)

    @property
    def homing(self) -> int:
        v = self._r(R_HOMING, 2)
        return -(v & 2047) if v & 2048 else v

    # --- simulation ---
    def step(self, now: float, t0: float):
        dt = max(0.0, min(now - self.t, 1.0))
        self.t = now
        off = self.homing
        if self.regs[R_TORQUE]:
            lo, hi = self._r(R_MIN, 2), self._r(R_MAX, 2)
            goal = self._r(R_GOAL, 2)
            if hi > lo:
                goal = max(lo, min(hi, goal))
            speed = self._r(R_SPEED, 2) or MOTOR_SPEED
            target, rate = goal + off, speed
        elif off != 0:                                         # a hand moves the limp arm, one joint at a time
            slot = int((now - t0) / HAND_SLOT) % 6 + 1
            u = ((now - t0) % HAND_SLOT) / HAND_SLOT
            target = self.rest + (HAND_AMP.get(self.id, 800) * math.sin(2 * math.pi * u) if slot == self.id else 0.0)
            rate = HAND_SPEED
        else:                                                  # uncalibrated and limp: it just sits in its rest pose
            target, rate = self.raw, 0
        self.raw += max(-rate * dt, min(rate * dt, target - self.raw))
        pos = int(round(self.raw - off)) % 4096
        goal_pos = self._r(R_GOAL, 2)
        err = (goal_pos - pos) if self.regs[R_TORQUE] else 0
        load = min(260, int(abs(err) * 0.25 + self.rng.random() * 6))
        self._w(R_POS, 2, pos)
        self._w(R_LOAD, 2, load | (1024 if err < 0 else 0))
        self._w(R_TEMP, 1, 30 + self.id % 3 + int(load / 90))
        self.regs[R_STATUS] = 0


class _Port:
    def __init__(self, name: str, ids):
        self.name, self.present = name, True
        self.motors = {i: Motor(name, i) for i in ids}
        self.shelf = {}


class _Bus:
    def __init__(self, ports):
        self.t0 = clock()
        self.ports = {p: _Port(p, range(1, 7)) for p in ports}


def _motor(port_name: str, mid: int, baud: int):
    """The motor that would answer a packet to `mid` at `baud` on that port right now (or None)."""
    p = _bus.ports.get(port_name) if _bus else None
    if p is None or not p.present:
        return None
    m = p.motors.get(mid)
    if m is None or m.baud != baud:
        return None
    m.step(clock(), _bus.t0)
    return m


# ---------------------------------------------------------------- fake scservo_sdk
class PortHandler:
    def __init__(self, port_name):
        self.port_name, self.baudrate, self.is_open = port_name, 1000000, False

    def _exists(self):
        p = _bus.ports.get(self.port_name) if _bus else None
        return bool(p and p.present)

    def openPort(self):
        if not self._exists():
            return False
        self.is_open = True
        return True

    def closePort(self): self.is_open = False
    def clearPort(self): pass
    def setPortName(self, n): self.port_name = n
    def getPortName(self): return self.port_name
    def getBaudRate(self): return self.baudrate

    def setBaudRate(self, baudrate):
        if baudrate not in SDK_BAUDS or not self._exists():
            return False
        self.baudrate, self.is_open = baudrate, True
        return True


class PacketHandler:
    def __init__(self, protocol_end=0): self.protocol_end = protocol_end

    def _m(self, port, mid):
        if not getattr(port, "is_open", False):
            return None
        with _lock:
            p = _bus.ports.get(port.port_name) if _bus else None
            if p is not None and not p.present:
                raise OSError("device disconnected")             # what pyserial does when the USB cable is pulled
            return _motor(port.port_name, mid, port.baudrate)

    @staticmethod
    def _raw(port, mid, instr, params, found, reply=()):
        """What the packets would look like on a real wire (only built while the inspector's raw switch is on)."""
        if trace.raw and trace.enabled:
            trace.record("raw", port=port.port_name, dir="tx", hex=trace.pkt_hex(mid, instr, params))
            if found:
                trace.record("raw", port=port.port_name, dir="rx", hex=trace.pkt_hex(mid, 0, reply, error=0))

    def getTxRxResult(self, result): return "[TxRxResult] Communication success!" if result == COMM_SUCCESS else "[TxRxResult] There is no status packet!"
    def getRxPacketError(self, error): return ""

    def ping(self, port, mid):
        with _lock:
            m = self._m(port, mid)
            self._raw(port, mid, 1, [], m is not None)
            return (MODEL_STS3215, COMM_SUCCESS, 0) if m else (0, COMM_RX_TIMEOUT, 0)

    def broadcastPing(self, port):
        with _lock:
            found = {}
            p = _bus.ports.get(port.port_name) if _bus else None
            if p and p.present and getattr(port, "is_open", False):
                for mid, m in p.motors.items():
                    if m.baud == port.baudrate:
                        found[mid] = (MODEL_STS3215, 0)
            return found, COMM_SUCCESS

    def _read(self, port, mid, addr, n):
        with _lock:
            m = self._m(port, mid)
            v = m._r(addr, n) if m else 0
            self._raw(port, mid, 2, [addr, n], m is not None, [(v >> (8 * k)) & 0xFF for k in range(n)])
            return (v, COMM_SUCCESS, 0) if m else (0, COMM_RX_TIMEOUT, 0)

    def read1ByteTxRx(self, port, mid, addr): return self._read(port, mid, addr, 1)
    def read2ByteTxRx(self, port, mid, addr): return self._read(port, mid, addr, 2)

    def _write(self, port, mid, addr, n, value):
        with _lock:
            m = self._m(port, mid)
            self._raw(port, mid, 3, [addr] + [(int(value) >> (8 * k)) & 0xFF for k in range(n)], m is not None)
            if m is None:
                return COMM_RX_TIMEOUT, 0
            eeprom = addr < 40
            if eeprom and addr != R_LOCK and m.regs[R_LOCK] == 1:
                return COMM_SUCCESS, 0                          # a locked EEPROM silently ignores writes, like the real motor
            value = int(value)
            if addr == R_ID and n == 1:                          # the motor answers to its new ID from now on
                p = _bus.ports[port.port_name]
                if 0 <= value <= 252 and value not in p.motors:
                    p.motors[value] = p.motors.pop(mid)
                    p.motors[value].id = value
                    p.motors[value]._w(R_ID, 1, value)
                return COMM_SUCCESS, 0
            m._w(addr, n, value)
            return COMM_SUCCESS, 0

    def write1ByteTxRx(self, port, mid, addr, value): return self._write(port, mid, addr, 1, value)
    def write2ByteTxRx(self, port, mid, addr, value): return self._write(port, mid, addr, 2, value)


def _sdk_module():
    mod = types.ModuleType("scservo_sdk")
    mod.PortHandler, mod.PacketHandler = PortHandler, PacketHandler
    mod.COMM_SUCCESS, mod.COMM_RX_TIMEOUT, mod.COMM_NOT_AVAILABLE = COMM_SUCCESS, COMM_RX_TIMEOUT, COMM_NOT_AVAILABLE
    mod.IS_DEMO = True
    return mod


# ---------------------------------------------------------------- control
def _sandbox(fresh: bool) -> None:
    """Point HOME at a private folder so nothing the demo writes (calibration, roles, settings, run logs) can touch real files."""
    from . import paths
    cur = pathlib.Path(os.environ.get("SO101_HOME", ""))
    if cur.parts[-3:] == ("demo", "home", ".so101"):                      # the app restarted itself inside its own sandbox: keep it, do not nest another
        home, fresh = cur.parent, False
    else:
        home = paths.data_dir() / "demo" / "home"
    if fresh and home.exists() and home.parts[-2:] == ("demo", "home"):
        shutil.rmtree(home, ignore_errors=True)
    (home / ".so101").mkdir(parents=True, exist_ok=True)
    os.environ["HOME"] = os.environ["USERPROFILE"] = str(home)
    os.environ["SO101_HOME"] = str(home / ".so101")
    os.environ.pop("HF_LEROBOT_CALIBRATION", None)


def install(ports=DEFAULT_PORTS, fresh: bool = True, sandbox: bool = True) -> None:
    """Switch to simulated hardware. Call before importing scservo_sdk (and before app/server.py).
    fresh: start from an empty demo folder (False when the app restarts itself, so the demo keeps its state)."""
    global _bus, _installed, _prev_sdk, _had_sdk, _saved_env
    with _lock:
        if not _installed:
            _had_sdk, _prev_sdk = "scservo_sdk" in sys.modules, sys.modules.get("scservo_sdk")
            _saved_env = {k: os.environ.get(k) for k in _ENV_KEYS}
            if sandbox:
                _sandbox(fresh)
        _bus = _Bus(tuple(ports))
        sys.modules["scservo_sdk"] = _sdk_module()
        _installed = True


def uninstall() -> None:
    """Back to the real world (used by tests)."""
    global _bus, _installed, _prev_sdk, _had_sdk, _saved_env
    with _lock:
        if _installed:
            if _had_sdk and _prev_sdk is not None:
                sys.modules["scservo_sdk"] = _prev_sdk
            else:
                sys.modules.pop("scservo_sdk", None)
            for k, v in _saved_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        _bus, _installed, _prev_sdk, _had_sdk, _saved_env = None, False, None, False, {}


def reset() -> None:
    """Fresh motors on every demo port."""
    global _bus
    with _lock:
        if _bus is not None:
            _bus = _Bus(tuple(_bus.ports))


def connect(port: str, ids) -> List[int]:
    """Simulate plugging motors into a port: exactly `ids` are on the bus afterwards (unplugged ones are kept aside)."""
    with _lock:
        p = _bus.ports[port]
        want = {int(i) for i in ids}
        for mid in list(p.motors):
            if mid not in want:
                p.shelf[mid] = p.motors.pop(mid)
        for mid in want:
            if mid not in p.motors:
                p.motors[mid] = p.shelf.pop(mid, None) or Motor(port, mid)
        return sorted(p.motors)


def set_port_present(port: str, present: bool) -> None:
    """Simulate unplugging / re-plugging the USB cable of an adapter."""
    with _lock:
        _bus.ports[port].present = bool(present)


def motor_ids(port: str) -> List[int]:
    with _lock:
        return sorted(_bus.ports[port].motors)


def present_ports() -> List[str]:
    with _lock:
        return [n for n, p in (_bus.ports.items() if _bus else []) if p.present]


def list_ports():
    from .ports import PortInfo
    out = []
    with _lock:
        for n in present_ports():
            who = "follower" if n == FOLLOWER else "leader" if n == LEADER else n.split("//")[-1]
            out.append(PortInfo(path=n, description=f"Simulated {who} adapter (demo)", vid=0x1a86, pid=0x55d3,
                                serial=SERIALS.get(n, f"DEMO-{who.upper()}"), manufacturer="SO-101 Suite demo", location=f"demo-{who}"))
    return out


def list_cameras(in_use=()):
    from .cameras import CameraInfo
    busy = {str(s) for s in in_use}
    return [CameraInfo(source=s, kind="usb", name=f"Demo camera {i + 1}", width=640, height=480, in_use=s in busy) for i, s in enumerate(CAMERA_SOURCES)]


# ---------------------------------------------------------------- synthetic cameras
_base_cache = {}


def _base(i: int):
    import cv2
    import numpy as np
    if i not in _base_cache:
        h, w = 480, 640
        img = np.zeros((h, w, 3), np.uint8)
        y = np.linspace(0, 1, h)[:, None]
        table = np.array([236, 226, 214], np.float32) * (0.92 + 0.08 * (1 - y) if i == 0 else 0.85 + 0.12 * y)[..., None]    # pale blue-white table
        img[:] = np.clip(table, 0, 255).astype(np.uint8)
        cv2.rectangle(img, (0, 0), (w - 1, h - 1), (120, 110, 100), 6)
        cv2.circle(img, (470, 330), 84, (205, 190, 238), -1)          # pale pink bowl
        cv2.circle(img, (470, 330), 84, (160, 140, 200), 2)
        cv2.rectangle(img, (40, 400), (240, 416), (60, 200, 230), -1)  # yellow measuring tape
        for k in range(0, 200, 20):
            cv2.line(img, (40 + k, 400), (40 + k, 408), (30, 90, 110), 1)
        cv2.rectangle(img, (270, 18), (370, 70), (90, 90, 90), -1)     # the arm's base, seen from above
        _base_cache[i] = img
    return _base_cache[i]


def frame(i: int, t: float = None):
    """A synthetic 640x480 BGR picture for demo camera `i`: table, bowl, a red keychain moving slowly, and a label."""
    import cv2
    import numpy as np
    t = time.time() if t is None else t
    img = _base(i % 2).copy()
    cx, cy = 230 + 120 * math.cos(0.35 * t), 230 + 80 * math.sin(0.5 * t)
    box = cv2.boxPoints(((cx, cy), (48, 24), math.degrees(0.4 * t) % 180)).astype(np.int32)
    cv2.fillPoly(img, [box], (30, 30, 215))                           # red keychain
    cv2.putText(img, f"DEMO CAMERA {i}", (14, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (60, 60, 60), 2, cv2.LINE_AA)
    cv2.putText(img, "simulated picture", (14, 58), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (90, 90, 90), 1, cv2.LINE_AA)
    return img
