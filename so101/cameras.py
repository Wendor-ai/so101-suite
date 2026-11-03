"""Find cameras and say, in a sentence, why one does not work. Nothing here ever raises into the UI."""
import dataclasses
import glob as _glob
import json
import os
import platform as _platform
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, List, Optional

MAX_INDEX = 5          # macOS / Windows: probe camera indices 0..4
BY_PATH = "/dev/v4l/by-path/*-usb-*-video-index0"


@dataclasses.dataclass
class CameraInfo:
    source: object                    # int index, device path or URL
    kind: str                         # "usb" | "network"
    name: str
    width: int = 0
    height: int = 0
    in_use: bool = False              # already used by this app
    err: str = ""                     # why it could not be opened, when it could not

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


@dataclasses.dataclass
class ProbeResult:
    ok: bool
    width: int = 0
    height: int = 0
    err: str = ""


class SysFs:
    """The few filesystem questions camera detection asks (injectable so Linux can be tested on a Mac)."""
    def glob(self, pattern): return sorted(_glob.glob(pattern))
    def realpath(self, p): return os.path.realpath(p)
    def exists(self, p): return os.path.exists(p)
    def access(self, p): return os.access(p, os.R_OK | os.W_OK)

    def read(self, p):
        try:
            with open(p) as f:
                return f.read()
        except OSError:
            return None


def kind_of(source) -> str:
    return "network" if str(source).startswith(("http://", "https://")) else "usb"


def conv_source(v):
    """'0' -> 0, anything else stays as it is (device paths and URLs are strings)."""
    return int(v) if isinstance(v, str) and v.isdigit() else v


def _os_name(platform_os):
    return platform_os or {"darwin": "macos", "linux": "linux", "windows": "windows"}.get(_platform.system().lower(), "linux")


def _is_demo(source) -> bool:
    return str(source).startswith("demo://")


def default_opener(source, platform_os=None):
    import cv2
    name = _os_name(platform_os)
    if isinstance(source, str) and source.startswith("/dev/"):
        return cv2.VideoCapture(source, cv2.CAP_V4L2)
    if name == "windows" and isinstance(source, int):
        return cv2.VideoCapture(source, cv2.CAP_DSHOW)
    return cv2.VideoCapture(source)


def _mac_names() -> List[str]:
    try:
        out = subprocess.run(["system_profiler", "SPCameraDataType", "-json"], capture_output=True, text=True, timeout=6).stdout
        return [d.get("_name", "") for d in json.loads(out).get("SPCameraDataType", [])]
    except Exception:
        return []


def probe_source(source, opener: Optional[Callable] = None, platform_os: Optional[str] = None, sysfs: Optional[SysFs] = None) -> ProbeResult:
    """Open a camera, grab one picture, close it. Never raises: `err` is a sentence a beginner can act on."""
    name, sysfs = _os_name(platform_os), sysfs or SysFs()
    if _is_demo(source):
        return ProbeResult(True, 640, 480, "")
    if str(source).startswith(("http://", "https://")):
        return probe_url(str(source))
    path = isinstance(source, str) and source.startswith("/dev/")
    if path and not sysfs.exists(source):
        return ProbeResult(False, 0, 0, "That camera is not plugged in: its device file is missing. Plug it in (try another USB port) and look again.")
    if path and not sysfs.access(source):
        return ProbeResult(False, 0, 0, "Linux does not let your user open the camera. Run this once, then log out and back in: sudo usermod -aG video $USER")
    cap = None
    try:
        cap = (opener or (lambda s: default_opener(s, name)))(source)
        if not cap.isOpened():
            if name == "macos":
                err = "Could not open the camera. Either macOS blocked camera access (allow your terminal in System Settings → Privacy & Security → Camera, then restart the app) or another app is using the camera."
            elif name == "windows":
                err = "Could not open the camera. It is in use by another app, or Windows blocked access: check Settings → Privacy & security → Camera."
            else:
                err = "Camera is in use by another app (or it was just unplugged). Close the other app, or unplug and re-plug the camera."
            return ProbeResult(False, 0, 0, err)
        frame = None
        for _ in range(5):                       # the first reads after opening are often empty
            ok, f = cap.read()
            if ok and f is not None:
                frame = f
                break
            time.sleep(0.05)
        if frame is None:
            return ProbeResult(False, 0, 0, "The camera opened but sends no picture. Unplug it, plug it in again, or try another USB port.")
        return ProbeResult(True, int(frame.shape[1]), int(frame.shape[0]), "")
    except Exception as e:
        return ProbeResult(False, 0, 0, f"Could not open the camera: {str(e)[:120] or type(e).__name__}.")
    finally:
        try:
            if cap is not None:
                cap.release()
        except Exception:
            pass


def probe_url(url: str, timeout: float = 3.0, urlopen: Optional[Callable] = None) -> ProbeResult:
    """Fetch one picture from a network camera (an MJPEG stream or a JPEG snapshot URL). Never raises."""
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return ProbeResult(False, 0, 0, "That is not a valid address. It should look like http://192.168.1.20:8000/raw.mjpg")
    if u.scheme not in ("http", "https") or not u.hostname:
        return ProbeResult(False, 0, 0, "Network cameras need an address that starts with http:// or https://, for example http://192.168.1.20:8000/raw.mjpg")
    host = u.hostname
    try:
        import cv2
        import numpy as np
        r = (urlopen or urllib.request.urlopen)(url, timeout=timeout)
        try:
            ctype = (r.headers.get("Content-Type") or "").lower() if hasattr(r, "headers") else ""
            data = _first_jpeg(r, ctype, timeout)
        finally:
            try:
                r.close()
            except Exception:
                pass
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR) if data else None
        if frame is None:
            return ProbeResult(False, 0, 0, f"{host} answered, but not with a picture. Network cameras must send an MJPEG stream or a JPEG image.")
        return ProbeResult(True, int(frame.shape[1]), int(frame.shape[0]), "")
    except urllib.error.HTTPError as e:
        return ProbeResult(False, 0, 0, f"{host} answered with an error ({e.code}). Check the address, especially the part after the port number.")
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        reason = getattr(e, "reason", e)
        if "timed out" in str(reason).lower():
            return ProbeResult(False, 0, 0, f"Can't reach {host}: no answer within {timeout:g} seconds. Is the other computer on, and on the same network?")
        return ProbeResult(False, 0, 0, f"Can't reach {host}: {str(reason)[:80]}. Is the other computer on, and on the same network?")
    except Exception as e:
        return ProbeResult(False, 0, 0, f"Can't read a picture from {host}: {str(e)[:80]}.")


def _first_jpeg(r, ctype: str, timeout: float) -> bytes:
    """One JPEG from a response: the whole body for image/jpeg, the first part for an MJPEG multipart stream."""
    if "multipart" in ctype:
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = r.readline()
            if not line:
                return b""
            if line.lower().startswith(b"content-length:"):
                n = int(line.split(b":")[1])
                while r.readline().strip():
                    pass
                data = b""
                while len(data) < n:
                    chunk = r.read(n - len(data))
                    if not chunk:
                        return b""
                    data += chunk
                return data
        return b""
    return r.read(4_000_000)


def list_cameras(platform_os: Optional[str] = None, in_use=(), opener: Optional[Callable] = None, sysfs: Optional[SysFs] = None,
                 names: Optional[Callable[[], List[str]]] = None, limit: Optional[int] = None) -> List[CameraInfo]:
    """USB cameras this computer can see. Sources already used by the app are listed as in_use and never opened again.
    Demo mode lists only the synthetic cameras."""
    demo = sys.modules.get("so101.demo")
    if demo is not None and demo.is_demo():
        return demo.list_cameras(in_use)
    name, sysfs = _os_name(platform_os), sysfs or SysFs()
    busy = {str(s) for s in in_use}
    out: List[CameraInfo] = []

    def add(source, label):
        if limit is not None and len(out) >= limit:
            return
        if str(source) in busy:
            out.append(CameraInfo(source=source, kind="usb", name=label, in_use=True))
            return
        r = probe_source(source, opener=opener, platform_os=name, sysfs=sysfs)
        if r.ok or name == "linux":                 # on Linux the device exists even when it cannot be opened: show it with the reason
            out.append(CameraInfo(source=source, kind="usb", name=label, width=r.width, height=r.height, err=r.err))

    if name == "linux":
        paths = sysfs.glob(BY_PATH)
        for p in paths:
            real = sysfs.realpath(p)
            node = os.path.basename(real)
            label = (sysfs.read(f"/sys/class/video4linux/{node}/name") or "").strip().split(": ")[0] or f"USB camera {len(out) + 1}"
            add(p, label)
        if not paths:                               # no by-path directory: fall back to USB capture nodes
            for dev in sorted(sysfs.glob("/dev/video*")):
                node = os.path.basename(dev)
                if (sysfs.read(f"/sys/class/video4linux/{node}/index") or "").strip() != "0":
                    continue
                if "/usb" not in sysfs.realpath(f"/sys/class/video4linux/{node}/device"):
                    continue
                add(dev, (sysfs.read(f"/sys/class/video4linux/{node}/name") or "").strip().split(": ")[0] or f"USB camera {len(out) + 1}")
    else:
        labels = (names or (_mac_names if name == "macos" else (lambda: [])))()
        for i in range(MAX_INDEX):
            add(i, labels[i] if i < len(labels) and labels[i] else f"Camera {i}")
    return out
