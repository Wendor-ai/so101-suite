import http.server
import threading
import urllib.error

import cv2
import numpy as np

from so101 import cameras


class FakeCap:
    def __init__(self, opened=True, frame=True, w=640, h=480):
        self.opened, self.has_frame, self.w, self.h, self.released = opened, frame, w, h, False

    def isOpened(self): return self.opened
    def read(self): return (True, np.zeros((self.h, self.w, 3), np.uint8)) if self.has_frame else (False, None)
    def release(self): self.released = True
    def get(self, prop): return 0


class FakeOpener:
    """opener(source) -> capture. `plan` maps source -> FakeCap kwargs; unknown sources do not open."""
    def __init__(self, plan): self.plan, self.calls = plan, []

    def __call__(self, source):
        self.calls.append(source)
        spec = self.plan.get(source)
        return FakeCap(**spec) if spec is not None else FakeCap(opened=False)


class FakeSysFs:
    def __init__(self, files=None, links=None, globs=None, readable=True):
        self.files, self.links, self.globs, self.readable = files or {}, links or {}, globs or {}, readable

    def glob(self, pattern): return sorted(self.globs.get(pattern, []))
    def realpath(self, p): return self.links.get(p, p)
    def read(self, p): return self.files.get(p)
    def exists(self, p): return p in self.files or p in self.links or any(p in v for v in self.globs.values())
    def access(self, p): return self.readable


A = "/dev/v4l/by-path/platform-xhci-hcd.0-usb-0:1:1.0-video-index0"
B = "/dev/v4l/by-path/platform-xhci-hcd.1-usb-0:2:1.0-video-index0"
PCI = "/dev/v4l/by-path/pci-0000:00:14.0-usb-0:3:1.0-video-index0"
CSI = "/dev/v4l/by-path/platform-1000800000.csi-video-index0"        # a Pi ribbon camera: not USB


def linux_fs():
    return FakeSysFs(globs={"/dev/v4l/by-path/*-usb-*-video-index0": [A, B]},
                     links={A: "/dev/video0", B: "/dev/video2"},
                     files={"/sys/class/video4linux/video0/name": "HD Webcam C270: HD Webcam\n", "/sys/class/video4linux/video2/name": "USB 2.0 Camera\n", A: "", B: ""})


def test_linux_uses_by_path_usb_only():
    op = FakeOpener({A: {}, B: {"w": 1280, "h": 720}})
    cams = cameras.list_cameras("linux", opener=op, sysfs=linux_fs())
    assert [c.source for c in cams] == [A, B]                      # stable names, never /dev/videoN
    assert cams[0].name == "HD Webcam C270" and cams[0].kind == "usb"          # sysfs says "Product: Manufacturer": we keep the product
    assert (cams[1].width, cams[1].height) == (1280, 720)
    assert all(c.in_use is False for c in cams)


def test_in_use_sources_skipped():
    op = FakeOpener({A: {}, B: {}})
    cams = cameras.list_cameras("linux", in_use=[A], opener=op, sysfs=linux_fs())
    assert A not in op.calls                                       # never opened a second time
    assert next(c for c in cams if c.source == A).in_use is True
    assert next(c for c in cams if c.source == B).in_use is False


def test_mac_probes_indices_and_uses_names():
    op = FakeOpener({0: {}, 1: {"w": 1920, "h": 1080}})
    cams = cameras.list_cameras("macos", opener=op, sysfs=FakeSysFs(), names=lambda: ["FaceTime HD Camera", "Logitech C920"])
    assert [(c.source, c.name, c.width) for c in cams] == [(0, "FaceTime HD Camera", 640), (1, "Logitech C920", 1920)]


def test_windows_probes_indices_without_names():
    op = FakeOpener({0: {}})
    cams = cameras.list_cameras("windows", opener=op, sysfs=FakeSysFs(), names=lambda: [])
    assert [(c.source, c.name) for c in cams] == [(0, "Camera 0")]


def test_limit_stops_early():
    op = FakeOpener({A: {}, B: {}})
    assert len(cameras.list_cameras("linux", opener=op, sysfs=linux_fs(), limit=1)) == 1
    assert op.calls == [A]


def test_probe_ok_reports_size():
    r = cameras.probe_source(0, opener=FakeOpener({0: {"w": 800, "h": 600}}), platform_os="macos")
    assert r.ok and (r.width, r.height) == (800, 600) and r.err == ""


def test_probe_busy_message():
    r = cameras.probe_source(A, opener=FakeOpener({}), platform_os="linux", sysfs=linux_fs())
    assert not r.ok and "in use by another app" in r.err


def test_probe_mac_blocked_message_mentions_privacy_settings():
    r = cameras.probe_source(0, opener=FakeOpener({}), platform_os="macos")
    assert not r.ok and "System Settings" in r.err and "Camera" in r.err


def test_probe_no_frame_message():
    r = cameras.probe_source(0, opener=FakeOpener({0: {"frame": False}}), platform_os="linux", sysfs=FakeSysFs())
    assert not r.ok and "no picture" in r.err.lower()


def test_probe_missing_device_and_permission():
    r = cameras.probe_source("/dev/v4l/by-path/gone-video-index0", opener=FakeOpener({}), platform_os="linux", sysfs=FakeSysFs())
    assert not r.ok and "not plugged in" in r.err
    r = cameras.probe_source(A, opener=FakeOpener({A: {}}), platform_os="linux", sysfs=FakeSysFs(files={A: ""}, readable=False))
    assert not r.ok and "video" in r.err and "usermod" in r.err


def test_probe_never_raises():
    def boom(_): raise RuntimeError("driver exploded")
    r = cameras.probe_source(0, opener=boom, platform_os="linux", sysfs=FakeSysFs())
    assert not r.ok and r.err


def test_probe_releases_the_camera():
    cap = FakeCap()
    cameras.probe_source(0, opener=lambda s: cap, platform_os="macos")
    assert cap.released


def test_probe_url_bad_host():
    def refuse(url, timeout): raise urllib.error.URLError("Connection refused")
    r = cameras.probe_url("http://127.0.0.1:9/raw.mjpg", timeout=1.0, urlopen=refuse)
    assert not r.ok and "reach" in r.err.lower()
    assert not cameras.probe_url("ftp://x/y").ok
    assert not cameras.probe_url("not a url").ok


def test_probe_url_real_unreachable_port_is_fast_and_polite():
    r = cameras.probe_url("http://127.0.0.1:9/raw.mjpg", timeout=1.0)
    assert not r.ok and "reach" in r.err.lower()


def test_probe_url_reads_a_jpeg_from_a_local_server():
    img = cv2.imencode(".jpg", np.full((120, 160, 3), 90, np.uint8))[1].tobytes()

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            self.send_response(200); self.send_header("Content-Type", "image/jpeg"); self.send_header("Content-Length", str(len(img))); self.end_headers(); self.wfile.write(img)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        r = cameras.probe_url(f"http://127.0.0.1:{srv.server_address[1]}/snap.jpg", timeout=2.0)
    finally:
        srv.shutdown()
    assert r.ok and (r.width, r.height) == (160, 120)


def test_probe_url_reads_an_mjpeg_stream():
    img = cv2.imencode(".jpg", np.full((60, 80, 3), 200, np.uint8))[1].tobytes()

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            self.send_response(200); self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=f"); self.end_headers()
            self.wfile.write(b"--f\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(img) + img + b"\r\n")
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        r = cameras.probe_url(f"http://127.0.0.1:{srv.server_address[1]}/raw.mjpg", timeout=2.0)
    finally:
        srv.shutdown()
    assert r.ok and (r.width, r.height) == (80, 60)


def test_to_dict_and_kind():
    c = cameras.CameraInfo(source="http://x/raw.mjpg", kind="network", name="n", width=1, height=2, in_use=False)
    assert c.to_dict()["kind"] == "network"
    assert cameras.kind_of("http://pi/raw.mjpg") == "network" and cameras.kind_of(0) == "usb" and cameras.kind_of(A) == "usb"
