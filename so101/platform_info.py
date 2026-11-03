"""Detect the operating system, Raspberry Pi model, Python/uv and whether this user may open serial ports.

Everything that touches the machine is injectable so the Linux/Windows/Pi cases can be tested anywhere."""
import dataclasses
import os
import platform as _platform
import shutil
import sys
from typing import Callable, List, Optional

SERIAL_GROUPS = ("dialout", "uucp")      # Debian/Ubuntu/Pi OS/Fedora use dialout, Arch uses uucp


@dataclasses.dataclass
class PlatformInfo:
    os: str                                  # "macos" | "linux" | "windows"
    os_version: str
    arch: str
    is_pi: bool
    pi_model: Optional[str]
    python: str
    uv: bool
    in_dialout: Optional[bool]               # None where the question does not exist (macOS, Windows)
    serial_examples: List[str]
    camera_backend: str
    notes: List[str]

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


def serial_examples(os_name: str) -> List[str]:
    return {"macos": ["/dev/tty.usbmodem*", "/dev/tty.wchusbserial*"],
            "linux": ["/dev/ttyACM*", "/dev/ttyUSB*"],
            "windows": ["COM3"]}.get(os_name, [])


def parse_pi_model(text) -> Optional[str]:
    """The text of /proc/device-tree/model (NUL terminated) -> 'Raspberry Pi 5 Model B Rev 1.0', or None if it is another board."""
    if not text:
        return None
    t = text.replace("\x00", "").strip()
    return t if t.startswith("Raspberry Pi") else None


def _os_name(system: str) -> str:
    return {"darwin": "macos", "linux": "linux", "windows": "windows"}.get(system.lower(), system.lower())


def _default_read(path: str) -> str:
    with open(path, "r", errors="replace") as f:
        return f.read()


def _default_groups() -> List[str]:
    try:
        import grp
        names = []
        for gid in set(os.getgroups()) | {os.getgid()}:
            try:
                names.append(grp.getgrgid(gid).gr_name)
            except KeyError:
                pass
        return names
    except ImportError:                      # Windows has no grp
        return []


def _os_pretty(read_file: Callable[[str], str]) -> str:
    try:
        for line in read_file("/etc/os-release").splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return ""


def detect(system=None, machine=None, read_file=None, which=None, groups=None, version=None) -> PlatformInfo:
    system = system or _platform.system()
    machine = machine or _platform.machine()
    read_file = read_file or _default_read
    which = which or shutil.which
    name = _os_name(system)

    pi_model = None
    if name == "linux":
        try:
            pi_model = parse_pi_model(read_file("/proc/device-tree/model"))
        except Exception:
            pi_model = None

    if version is not None:
        os_version = version
    elif name == "macos":
        os_version = _platform.mac_ver()[0]
    elif name == "linux":
        os_version = _os_pretty(read_file) or _platform.release()
    else:
        os_version = _platform.version()

    in_dialout: Optional[bool] = None
    if name == "linux":
        names = groups if groups is not None else _default_groups()
        in_dialout = any(g in names for g in SERIAL_GROUPS)
        if groups is None and hasattr(os, "geteuid") and os.geteuid() == 0:
            in_dialout = True                # root can open any port

    notes: List[str] = []
    if pi_model:
        notes.append(f"{pi_model}: USB cameras and the arm adapters work the same as on a PC. Use a good 5 V power supply.")
    if name == "linux" and in_dialout is False:
        notes.append("Your user is not in the 'dialout' group, so Linux will refuse to open the arm's serial port.")
    if name == "windows":
        notes.append("Windows support is untested: if something breaks, please open an issue with the output of `so101 doctor`.")

    camera_backend = {"macos": "AVFoundation", "linux": "V4L2", "windows": "DirectShow (DSHOW)"}.get(name, "default")
    return PlatformInfo(os=name, os_version=os_version, arch=machine, is_pi=bool(pi_model), pi_model=pi_model,
                        python=".".join(str(p) for p in sys.version_info[:3]),
                        uv=bool(which("uv")), in_dialout=in_dialout, serial_examples=serial_examples(name),
                        camera_backend=camera_backend, notes=notes)
