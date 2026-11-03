"""The inspector's data source: a bounded, in-memory log of what the app and the motors say to each other.

Off by default. While off, every call costs one boolean check. Entries only ever hold motor ids, register numbers and values,
API paths, status codes and log text (with the home folder shown as '~'); nothing is written to disk or sent anywhere."""
import collections
import heapq
import json
import logging
import os
import threading
import time
from typing import Iterable, Optional

from . import registers

enabled = False          # record bus / http / log entries
raw = False              # also record raw packet bytes (needs `enabled`)
DEFAULT_MAX = 5000
_lock = threading.Lock()
_buf: collections.deque = collections.deque(maxlen=DEFAULT_MAX)          # events: writes, failures, logs, user actions (kept long)
_routine: collections.deque = collections.deque(maxlen=DEFAULT_MAX * 2)  # healthy repeating polls (a 10 Hz poll would flush the events in seconds)
_seq = 0
_dropped = 0
_home = os.path.expanduser("~")

_RESULT_TEXT = {-1: "port busy", -2: "send failed", -3: "bad reply", -4: "bad command", -6: "no answer (timeout)", -7: "corrupt reply", -9: "not available"}
_FAULTS = {1: "voltage", 2: "sensor", 4: "temperature", 8: "current", 16: "angle", 32: "overload"}


# ---------------------------------------------------------------- control
def set_enabled(on: bool) -> None:
    global enabled
    enabled = bool(on)


def set_raw(on: bool) -> None:
    global raw
    raw = bool(on)


def set_max(n: int) -> None:
    global _buf
    global _routine
    n = max(100, min(100000, int(n)))
    with _lock:
        _buf = collections.deque(_buf, maxlen=n)
        _routine = collections.deque(_routine, maxlen=n * 2)


def clear() -> None:
    global _dropped
    with _lock:
        _buf.clear()
        _routine.clear()
        _dropped = 0


def reset() -> None:
    """Back to the factory state (tests)."""
    global enabled, raw, _seq, _dropped, _buf, _routine
    with _lock:
        enabled = raw = False
        _seq = _dropped = 0
        _buf = collections.deque(maxlen=DEFAULT_MAX)
        _routine = collections.deque(maxlen=DEFAULT_MAX * 2)


def _scrub(v):
    if isinstance(v, str):
        home = os.path.expanduser("~")
        for h in {home, _home}:
            if h and h != "~" and h in v:
                v = v.replace(h, "~")
    return v


# ---------------------------------------------------------------- recording
def record(kind: str, **fields) -> None:
    if not enabled:
        return
    global _seq, _dropped
    ok = bool(fields.pop("ok", True))
    ms = round(float(fields.pop("ms", 0.0)), 2)
    item = {"kind": kind, "ok": ok, "ms": ms}
    item.update({k: _scrub(v) for k, v in fields.items()})
    routine = ok and (kind == "raw" or (kind == "bus" and fields.get("op") in ("read1", "read2", "ping")) or (kind == "http" and fields.get("method") == "GET"))
    with _lock:
        _seq += 1
        item["seq"], item["t"] = _seq, round(time.time(), 3)
        ring = _routine if routine else _buf
        if len(ring) == ring.maxlen:
            _dropped += 1
        ring.append(item)


def log(level: str, source: str, msg: str) -> None:
    if not enabled:
        return
    record("log", ok=level != "error", level=level if level in ("info", "warn", "error") else "info", source=source, msg=str(msg)[:400])


def record_http(method: str, path: str, status: int, size: int, t0: Optional[float]) -> None:
    """One line per API request. Static files, camera streams and the inspector's own polling are not recorded."""
    if not enabled:
        return
    p = path.split("?")[0]
    if p.startswith(("/suite/", "/vendor/", "/assets/", "/stream", "/raw", "/dashboard")) or p == "/" or p.startswith("/api/suite/trace"):
        return
    record("http", method=method, path=p, status=status, size=size, ok=status < 400, ms=(time.perf_counter() - t0) * 1000 if t0 else 0.0)


# ---------------------------------------------------------------- reading
def snapshot(since: int = 0, kinds: Optional[Iterable[str]] = None, limit: int = 500) -> dict:
    kinds = set(kinds) if kinds else None
    limit = max(1, min(int(limit or 500), 20000))
    with _lock:
        want = lambda i: i["seq"] > since and (kinds is None or i["kind"] in kinds)
        items = list(heapq.merge((i for i in _buf if want(i)), (i for i in _routine if want(i)), key=lambda i: i["seq"]))   # both rings are in seq order
        out = {"enabled": enabled, "raw": raw, "seq": _seq, "dropped": _dropped}
    out["items"] = items[:limit] if since else items[-limit:]          # polling with `since` never skips ahead; the first load shows the newest
    return out


def _line(i: dict) -> str:
    t = time.strftime("%H:%M:%S", time.localtime(i["t"])) + f".{int((i['t'] % 1) * 1000):03d}"
    k = i["kind"]
    if k == "bus":
        what = f"{i['op']} id={i.get('id')} reg={i.get('addr')} {i.get('reg', '')} value={i.get('value')}"
    elif k == "raw":
        what = f"{i['dir']} {i['hex']}"
    elif k == "http":
        what = f"{i['method']} {i['path']} -> {i['status']} ({i['size']} bytes)"
    else:
        what = f"[{i.get('level')}] {i.get('source')}: {i.get('msg')}"
    err = f"  ERR {i['err']}" if i.get("err") else ""
    return f"{t}  {k:4s}  {what}  {'ok' if i['ok'] else 'FAIL'}  {i['ms']} ms{err}"


def export(format: str = "json") -> str:
    snap = snapshot(limit=100000)
    if format == "ndjson":
        return "\n".join(json.dumps(i) for i in snap["items"]) + ("\n" if snap["items"] else "")
    if format == "text":
        return "\n".join(_line(i) for i in snap["items"]) + ("\n" if snap["items"] else "")
    return json.dumps(snap, indent=1)


CONTENT_TYPES = {"json": "application/json", "ndjson": "application/x-ndjson", "text": "text/plain; charset=utf-8"}


# ---------------------------------------------------------------- instrumentation
class _TracedPacketHandler:
    """Delegates everything to the real PacketHandler and records the decoded bus operations."""
    def __init__(self, pk, port: str):
        self._pk, self._port = pk, port

    def __getattr__(self, name):
        return getattr(self._pk, name)

    def _call(self, op: str, mid: int, addr, fn, *args):
        if not enabled:
            return fn(*args)
        t0 = time.perf_counter()
        try:
            res = fn(*args)
        except Exception as e:
            record("bus", port=self._port, op=op, id=mid, addr=addr, reg=registers.name_of(addr) if addr is not None else "", value=None, ok=False,
                   err=f"{type(e).__name__}: {str(e)[:80]}", ms=(time.perf_counter() - t0) * 1000)
            raise
        ms = (time.perf_counter() - t0) * 1000
        if op == "ping":
            value, result, err = res
        elif op.startswith("read"):
            value, result, err = res
        else:
            result, err = res
            value = args[-1]
        text = ""
        if result != 0:
            text = _RESULT_TEXT.get(result, f"comm error {result}")
        elif err:
            text = "motor fault: " + ", ".join(v for k, v in _FAULTS.items() if err & k) if any(err & k for k in _FAULTS) else f"motor status {err}"
        record("bus", port=self._port, op=op, id=mid, addr=addr, reg=registers.name_of(addr) if addr is not None else "Model_Number", value=value,
               ok=result == 0, err=text, ms=ms)
        return res

    def ping(self, port, mid): return self._call("ping", mid, 3, self._pk.ping, port, mid)
    def read1ByteTxRx(self, port, mid, addr): return self._call("read1", mid, addr, self._pk.read1ByteTxRx, port, mid, addr)
    def read2ByteTxRx(self, port, mid, addr): return self._call("read2", mid, addr, self._pk.read2ByteTxRx, port, mid, addr)
    def write1ByteTxRx(self, port, mid, addr, v): return self._call("write1", mid, addr, self._pk.write1ByteTxRx, port, mid, addr, v)
    def write2ByteTxRx(self, port, mid, addr, v): return self._call("write2", mid, addr, self._pk.write2ByteTxRx, port, mid, addr, v)


def wrap_packet_handler(pk, port: str):
    return _TracedPacketHandler(pk, port)


def wrap_port_handler(ph, name: str):
    """Record raw bytes (only while `raw` is on) by wrapping the SDK's low-level write/read of this port. A no-op for ports without them."""
    if not (hasattr(ph, "writePort") and hasattr(ph, "readPort")):
        return ph
    orig_w, orig_r = ph.writePort, ph.readPort

    def writePort(packet):
        n = orig_w(packet)
        if raw and enabled:
            record("raw", port=name, dir="tx", hex=bytes(packet).hex(" "))
        return n

    def readPort(length):
        data = orig_r(length)
        if raw and enabled and data:
            record("raw", port=name, dir="rx", hex=bytes(data).hex(" "))
        return data
    ph.writePort, ph.readPort = writePort, readPort
    return ph


class BufferHandler(logging.Handler):
    """Feeds Python log records into the buffer (root logger)."""
    def emit(self, rec: logging.LogRecord) -> None:
        if not enabled:
            return
        try:
            level = "error" if rec.levelno >= logging.ERROR else "warn" if rec.levelno >= logging.WARNING else "info"
            log(level, rec.name, rec.getMessage())
        except Exception:
            pass


def install_logging() -> None:
    root = logging.getLogger()
    if not any(isinstance(h, BufferHandler) for h in root.handlers):
        if not root.handlers:                                   # keep warnings visible on stderr like before
            sh = logging.StreamHandler()
            sh.setLevel(logging.WARNING)
            root.addHandler(sh)
        root.addHandler(BufferHandler(level=logging.INFO))
    logging.getLogger("so101").setLevel(logging.INFO)


def pkt_hex(mid: int, instr: int, params: Iterable[int], error: Optional[int] = None) -> str:
    """The bytes of an STS packet (used by the demo bus to show what a real one would look like)."""
    params = list(params)
    body = [mid, len(params) + 2, instr if error is None else error] + params
    return bytes([0xFF, 0xFF] + body + [(~sum(body)) & 0xFF]).hex(" ")
