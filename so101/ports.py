"""Serial ports: list them per OS, say which look like servo adapters, and give each one a stable identity.

Roles (follower/leader) are bound to PortInfo.key, never to the path: two identical adapters swap /dev/ttyACM0 and /dev/ttyACM1
between boots, but their USB serial numbers do not."""
import dataclasses
import platform as _platform
import re
import sys
from typing import Callable, Iterable, List, Optional, Set, Tuple

SERVO_VIDS = {0x1a86: "WCH (CH340/CH343)", 0x10c4: "Silicon Labs (CP210x)", 0x0403: "FTDI"}
_MAC_JUNK = ("bluetooth", "debug-console", "blth", "wlan-debug", "incoming-port")


@dataclasses.dataclass
class PortInfo:
    path: str
    description: str = ""
    vid: Optional[int] = None
    pid: Optional[int] = None
    serial: Optional[str] = None
    manufacturer: Optional[str] = None
    likely_servo_board: bool = False
    role: Optional[str] = None               # "follower" | "leader" | None (filled in by the API from the saved roles)
    owned_by_app: bool = False               # the running app already has a thread on this port: never open it again
    key: str = ""
    location: Optional[str] = None

    def __post_init__(self):
        self.likely_servo_board = self.likely_servo_board or likely_servo_board(self.vid, self.pid)
        if not self.key:
            self.key = port_key(self)

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


def likely_servo_board(vid, pid=None) -> bool:
    return vid in SERVO_VIDS


def port_key(info: PortInfo) -> str:
    """Stable identity: the USB serial number if the adapter has one, else vid:pid@usb-location, else the path."""
    if info.serial:
        return str(info.serial)
    if info.vid is not None and info.pid is not None and info.location:
        return f"{info.vid:04x}:{info.pid:04x}@{info.location}"
    return info.path


def diff_ports(before: Set[str], after: Set[str]) -> Tuple[Set[str], Set[str]]:
    """(removed, added) between two snapshots (paths or keys)."""
    before, after = set(before), set(after)
    return before - after, after - before


def redact_port_path(path: str) -> str:
    """Hide the adapter's serial number that macOS puts in the device name (for diagnostics that get pasted around)."""
    return re.sub(r"(usbmodem|wchusbserial|usbserial-?|SLAB_USBtoUART)[A-Za-z0-9._-]+", r"\1*", path)


def _get(o, name):
    return o.get(name) if isinstance(o, dict) else getattr(o, name, None)


def _default_lister():
    from serial.tools import list_ports as lp
    return lp.comports()


def _os_name(platform_os: Optional[str]) -> str:
    if platform_os:
        return platform_os
    return {"darwin": "macos", "linux": "linux", "windows": "windows"}.get(_platform.system().lower(), "linux")


def _demo_module():
    d = sys.modules.get("so101.demo")
    return d if d is not None and d.is_demo() else None


def list_ports(lister: Optional[Callable[[], Iterable]] = None, platform_os: Optional[str] = None) -> List[PortInfo]:
    """The serial ports that could be a servo adapter. In demo mode: only the simulated ones, the real system is never asked."""
    demo = _demo_module()
    if demo is not None:
        return demo.list_ports()
    name = _os_name(platform_os)
    try:
        raw = list(lister() if lister else _default_lister())
    except Exception:
        return []
    out, seen = [], set()
    for o in raw:
        path = str(_get(o, "device") or "")
        vid, pid = _get(o, "vid"), _get(o, "pid")
        desc = _get(o, "description") or ""
        low = path.lower()
        if not path:
            continue
        if name == "macos":
            if low.startswith("/dev/cu."):
                path = "/dev/tty." + path[len("/dev/cu."):]
                low = path.lower()
            if any(j in low for j in _MAC_JUNK):
                continue
            if vid is None and not re.search(r"usb|wch|slab", low):
                continue
        elif name == "linux":
            if vid is None and not re.search(r"/tty(ACM|USB)\d+$", path):
                continue
        elif name == "windows":
            if "bluetooth" in desc.lower() or not re.match(r"^COM\d+$", path, re.I):
                continue
        if path in seen:
            continue
        seen.add(path)
        out.append(PortInfo(path=path, description=str(desc), vid=vid, pid=pid, serial=_get(o, "serial_number") or None,
                            manufacturer=_get(o, "manufacturer") or None, location=_get(o, "location") or None))
    out.sort(key=lambda p: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", p.path)])   # natural order: COM3 before COM11
    # two adapters that report the same serial number (cheap clones) must still get different keys
    dup = {}
    for p in out:
        if p.serial:
            dup.setdefault(p.serial, []).append(p)
    for serial, group in dup.items():
        if len(group) > 1:
            for p in group:
                p.key = f"{serial}@{p.location or p.path}"
    return out


def key_for_path(path: str, lister=None, platform_os=None) -> str:
    """The stable key of the adapter currently at `path` (the path itself when it is not listed)."""
    for p in list_ports(lister=lister, platform_os=platform_os):
        if p.path == path:
            return p.key
    return path
