"""The Suite's HTTP routes, added to the legacy stdlib server (app/server.py) with one hook: `handle(h, method, path, body)`.

handle() writes the response on `h` (a BaseHTTPRequestHandler) and returns True when it owns the path, False otherwise (the legacy
routes then carry on). All /api/suite/*, /api/demo/*, /api/m/*, /suite/*, /stream/<i>.mjpg, /raw/<i>.mjpg, /dashboard and / live here.
Responses are JSON with a human sentence in "error" when something is refused; nothing here shows a stack trace to a user."""
import json
import mimetypes
import os
import pathlib
import re
import sys
import threading
import time
import traceback
import urllib.parse
from typing import Optional

from . import LICENSE_ID, REPO_URL, __version__, checklist, defaults, modules as modules_mod, paths, platform_info, roles, trace
from . import cameras as cameras_mod
from . import ports as ports_mod

MAX_BODY = 1_000_000
IDENTIFY_TIMEOUT = 60.0
DETECT_TTL = 30.0
STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
                ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
                ".stl": "model/stl", ".urdf": "application/xml", ".xml": "application/xml", ".woff2": "font/woff2", ".woff": "font/woff",
                ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".map": "application/json"}


class Ctx:
    """What the routes (and module backends) can reach. `arms`, `cams`, `PP` and `TELE` are read from the live server module each time
    because it rebinds them while starting up."""
    def __init__(self):
        self.server = None
        self.store = None
        self.demo = False
        self.camera_origin = "auto"          # "cli" | "store" | "auto": where the running cameras came from
        self.args = None
        self.argv = []
        self.httpd = None
        self.restart_fn = None               # replaceable (tests)
        self.modules_dir = paths.MODULES_DIR
        self.suite_dir = paths.SUITE_DIR
        self.identify = {"state": "idle", "message": "", "port": None}
        self.identify_timeout = IDENTIFY_TIMEOUT
        self._detected = {"t": 0.0, "items": [], "busy": False}
        self._platform = None
        self._lock = threading.RLock()

    def attach(self, server, store, demo=False, camera_origin="auto", args=None, argv=(), httpd=None):
        self.server, self.store, self.demo, self.camera_origin = server, store, bool(demo), camera_origin
        self.args, self.argv, self.httpd = args, list(argv), httpd
        self.identify = {"state": "idle", "message": "", "port": None}
        self._detected = {"t": 0.0, "items": [], "busy": False}
        self._platform = None

    arms = property(lambda self: self.server.arms if self.server else {})
    cams = property(lambda self: self.server.cams if self.server else [])
    PP = property(lambda self: self.server.PP if self.server else None)
    TELE = property(lambda self: self.server.TELE if self.server else None)


ctx = Ctx()


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


# ================================================================= response helpers
def _send(h, status: int, body: bytes, ctype: str, headers=None, method: str = "GET"):
    h.send_response(status)
    h.send_header("Content-Type", ctype)
    h.send_header("Content-Length", str(len(body)))
    for k, v in (headers or {}).items():
        h.send_header(k, v)
    h.end_headers()
    if method != "HEAD":
        h.wfile.write(body)


def _json(h, status: int, obj, method: str = "GET"):
    body = json.dumps(obj).encode()
    _send(h, status, body, "application/json", {"Cache-Control": "no-store"}, method)
    return len(body)


def _redirect(h, location: str, method: str = "GET"):
    _send(h, 302, b"", "text/plain", {"Location": location, "Cache-Control": "no-store"}, method)


def _read_body(h) -> dict:
    n = int(h.headers.get("Content-Length") or 0)
    if n > MAX_BODY:
        raise ApiError(413, "That request is too big.")
    raw = h.rfile.read(n) if n else b""
    if not raw.strip():
        return {}
    try:
        d = json.loads(raw)
    except ValueError:
        raise ApiError(400, "The request body is not valid JSON.")
    if not isinstance(d, dict):
        raise ApiError(400, "The request body must be a JSON object.")
    return d


def _tilde(text: str) -> str:
    return paths.tilde(text) if isinstance(text, str) else text


# ================================================================= state gathering
def _platform() -> dict:
    if ctx._platform is None:
        ctx._platform = platform_info.detect().to_dict()
    return ctx._platform


def _roles_file():
    return getattr(ctx.server, "ROLES_FILE", pathlib.Path("~/.so101_roles.json").expanduser())


def ports_view() -> list:
    out = []
    arms = dict(ctx.arms)
    for p in ports_mod.list_ports():
        p.owned_by_app = p.path in arms
        p.role = arms[p.path].role if p.owned_by_app else roles.lookup(_roles_file(), p.key, p.path)
        out.append(p.to_dict())
    return out


def _arm_for(role: Optional[str] = None, port: Optional[str] = None):
    arms = dict(ctx.arms)
    if port:
        if port in arms:
            return arms[port]
        for p in ports_mod.list_ports():                       # the stable key works too
            if p.key == port and p.path in arms:
                return arms[p.path]
        return None
    if role:
        mine = [a for a in arms.values() if a.role == role]
        return next((a for a in mine if a.online), mine[0] if mine else None)
    return None


def _store_cameras() -> list:
    lst = ctx.store.get("cameras.list") if ctx.store else None
    return [c for c in (lst or []) if isinstance(c, dict) and c.get("source") not in (None, "")]


def _detect_refresh():
    try:
        running = [str(c.src) for c in ctx.cams]
        items = cameras_mod.list_cameras(in_use=running)
    except Exception:
        items = []
    ctx._detected = {"t": time.time(), "items": items, "busy": False}


def detected_cameras(force: bool = False) -> list:
    """Cameras this computer can see (cached: probing opens devices). A stale cache refreshes in the background."""
    d = ctx._detected
    stale = time.time() - d["t"] > DETECT_TTL
    if force:
        _detect_refresh()
    elif stale and not d["busy"]:
        d["busy"] = True
        threading.Thread(target=_detect_refresh, daemon=True).start()
    running = {str(c.src) for c in ctx.cams} | {str(c["source"]) for c in _store_cameras()}
    return [c for c in ctx._detected["items"] if not c.in_use and str(c.source) not in running]


def cameras_view() -> list:
    """The configured cameras with their live status: running ones first, then saved ones that need a restart to start."""
    entries = {str(c["source"]): c for c in _store_cameras()}
    PP, out, seen = ctx.PP, [], set()
    for i, c in enumerate(ctx.cams):
        e = entries.get(str(c.src), {})
        seen.add(str(c.src))
        out.append({"id": e.get("id") or f"cam{i}", "name": e.get("name") or f"Camera {i + 1}", "source": str(c.src), "kind": cameras_mod.kind_of(c.src),
                    "index": i, "ok": bool(c.ok), "fps": round(c.fps, 1), "err": c.err, "age": round(min(c.age, 999), 1), "pending": False,
                    "calibrated": bool(PP and i < len(PP.models) and (PP.models[i] is not None or (i == 0 and getattr(PP, "H", None) is not None)))})
    for src, e in entries.items():
        if src not in seen:
            out.append({"id": e.get("id"), "name": e.get("name") or "Camera", "source": src, "kind": cameras_mod.kind_of(src), "index": None, "ok": False, "fps": 0.0,
                        "err": "Restart the app to start this camera.", "age": 999, "pending": True, "calibrated": False})
    return out


def _restart_needed() -> bool:
    running = [str(c.src) for c in ctx.cams]
    saved = [str(c["source"]) for c in _store_cameras()]
    return ctx.camera_origin != "cli" and bool(saved or ctx.camera_origin == "store") and saved != running


def build_snapshot() -> dict:
    """The checklist input (format documented in so101/checklist.py), from the live server."""
    plat = dict(_platform())
    if ctx.demo:
        plat["in_dialout"] = None                              # the demo opens no serial port, so permission does not matter
    by_role = {}
    for a in ctx.arms.values():
        cur = by_role.get(a.role)
        if cur is None or (a.online and not cur.online):
            by_role[a.role] = a

    def arm(a):
        return None if a is None else {"port": a.path, "online": bool(a.online), "motor_ids": sorted(a.ids) if a.online else [], "calibrated": a.cal() is not None, "err": a.err, "role_confirmed": bool(getattr(a, "role_confirmed", True))}
    cams = [{"ok": c["ok"], "calibrated": c["calibrated"], "err": c["err"]} for c in cameras_view()]
    progress = ctx.store.get("progress", {}) if ctx.store else {}
    return {"platform": {k: plat.get(k) for k in ("os", "python", "uv", "in_dialout")},
            "ports": [{"path": p["path"], "likely_servo_board": p["likely_servo_board"], "role": p["role"]} for p in ports_view()],
            "arms": {"follower": arm(by_role.get("follower")), "leader": arm(by_role.get("leader"))},
            "cameras": {"detected": len(detected_cameras()), "configured": cams},
            "progress": progress if isinstance(progress, dict) else {}}


def uncalibrated_roles() -> list:
    return sorted({a.role for a in ctx.arms.values() if a.online and a.cal() is None})


def _modules(discover_only_enabled: bool = False):
    disabled = defaults.get("adv.disabledModules", ctx.store, [])
    disabled = disabled if isinstance(disabled, list) else []
    if defaults.get("adv.modulesEnabled", ctx.store, True) is False:       # the "Allow modules" switch in Settings: everything off
        disabled = [m.id for m in modules_mod.discover(ctx.modules_dir, disabled=[])]
    return modules_mod.discover(ctx.modules_dir, disabled=disabled)


def info() -> dict:
    unc = uncalibrated_roles()
    prompted = bool(defaults.get("ui.calibrationPrompted", ctx.store))
    return {"version": __version__, "license": LICENSE_ID, "demo": ctx.demo, "repo": REPO_URL, "modules": len(_modules()),
            "onboarded": bool(defaults.get("ui.onboarded", ctx.store)), "first_calibration_needed": bool(unc) and not prompted, "uncalibrated": unc,
            "trace": {"enabled": trace.enabled, "raw": trace.raw}}


# ================================================================= settings
SETTING_GROUPS = ("ui", "safety", "adv")
SAFETY_WRITABLE = {"confirm_before_move", "speed_preset", "stop_shortcut"}
ENUMS = {"ui.theme": {"auto", "dark", "light"}, "ui.guide": {"beginner", "expert"}, "ui.units": {"deg", "norm", "lerobot"}, "ui.textSize": {"small", "normal", "large"},
         "safety.speed_preset": {"gentle", "normal"}, "adv.logLevel": {"info", "debug", "warn"}}
_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,40}$")


def settings_view() -> dict:
    eff = defaults.load(ctx.store)
    return {g: {k: v for k, v in eff[g].items() if k != "_doc"} for g in SETTING_GROUPS}


def _check_setting(group: str, key: str, value, default):
    name = f"{group}.{key}"
    if not _KEY_RE.match(key):
        return f"'{key}' is not a valid setting name."
    if group == "safety" and key not in SAFETY_WRITABLE:
        return f"{name} is a built-in safety limit and can't be changed here. You can change confirm_before_move, speed_preset and stop_shortcut."
    if default is not None:
        ok = (isinstance(value, bool) if isinstance(default, bool) else isinstance(value, (int, float)) and not isinstance(value, bool) if isinstance(default, (int, float))
              else isinstance(value, str) if isinstance(default, str) else isinstance(value, list) if isinstance(default, list) else True)
        if not ok:
            return f"{name} must be a {'true/false value' if isinstance(default, bool) else 'number' if isinstance(default, (int, float)) else 'text' if isinstance(default, str) else 'list'}."
    elif not (isinstance(value, (bool, int, float)) or (isinstance(value, str) and len(value) <= 200) or (isinstance(value, list) and len(value) <= 50 and all(isinstance(x, str) and len(x) <= 64 for x in value))):
        return f"{name} must be true/false, a number, short text or a short list of text."
    if isinstance(value, str) and len(value) > 200:
        return f"{name} is too long."
    if name in ENUMS and value not in ENUMS[name]:
        return f"{name} must be one of: {', '.join(sorted(ENUMS[name]))}."
    return None


def settings_update(body: dict) -> dict:
    flat = {}
    for k, v in body.items():
        if isinstance(v, dict) and k in SETTING_GROUPS:
            flat.update({f"{k}.{kk}": vv for kk, vv in v.items()})
        elif isinstance(k, str) and "." in k:
            flat[k] = v
        else:
            raise ApiError(400, f"Unknown setting '{k}'. Settings live under ui, safety and adv, for example {{\"ui\": {{\"theme\": \"dark\"}}}} or {{\"ui.theme\": \"dark\"}}.")
    base = defaults.defaults()
    for dotted, v in flat.items():
        group, _, key = dotted.partition(".")
        if group not in SETTING_GROUPS or not key:
            raise ApiError(400, f"Unknown setting '{dotted}'. Settings live under ui, safety and adv.")
        err = _check_setting(group, key, v, base[group].get(key))
        if err:
            raise ApiError(400, err)
    for dotted, v in flat.items():
        ctx.store.set(dotted, v)
    return settings_view()


# ================================================================= diagnostics
def _redact_url(src: str) -> str:
    if src.startswith(("http://", "https://")):
        u = urllib.parse.urlsplit(src)
        return f"{u.scheme}://<host>{u.path}"
    return ports_mod.redact_port_path(src)


def diagnostics_text() -> str:
    """What 'Copy diagnostics' copies. No personal data: no serial numbers, no names, hosts or IPs, home folders shown as '~'."""
    pl = _platform()
    lines = [f"SO-101 Suite {__version__} ({LICENSE_ID})  demo={ctx.demo}", f"time: {time.strftime('%Y-%m-%d %H:%M:%S %z')}", ""]
    lines += ["[platform]", f"os: {pl['os']} {pl['os_version']} ({pl['arch']})", f"raspberry pi: {pl['pi_model'] or 'no'}", f"python: {pl['python']}   uv: {'yes' if pl['uv'] else 'no'}",
              f"serial permission (dialout): {pl['in_dialout']}", f"camera backend: {pl['camera_backend']}", ""]
    lines.append("[versions]")
    for mod in ("cv2", "numpy", "serial"):
        try:
            m = __import__(mod)
            lines.append(f"{mod}: {getattr(m, '__version__', getattr(m, 'VERSION', '?'))}")
        except Exception as e:
            lines.append(f"{mod}: not importable ({type(e).__name__})")
    sdk = sys.modules.get("scservo_sdk")
    lines.append(f"scservo_sdk: {'simulated (demo)' if getattr(sdk, 'IS_DEMO', False) else 'real' if sdk else 'not loaded'}")
    lines += ["", "[ports]"]
    for p in ports_view():
        lines.append(f"{ports_mod.redact_port_path(p['path'])}  vid:pid={p['vid'] if p['vid'] is None else format(p['vid'], '04x')}:{p['pid'] if p['pid'] is None else format(p['pid'], '04x')}  "
                     f"servo-board={p['likely_servo_board']}  role={p['role']}  owned-by-app={p['owned_by_app']}")
    if not lines[-1].strip() or lines[-1] == "[ports]":
        lines.append("(none)")
    lines += ["", "[arms]"]
    for a in ctx.arms.values():
        st = a.state()
        lines.append(f"{st['role']}: online={st['online']} motors={[j['id'] for j in st['joints']]} calibrated={st['calibrated']} calib-step={st['calib'].get('step')} "
                     f"volt={st['volt']} faults={st['faults']} err={_tilde(st.get('err', ''))!r}")
    if not ctx.arms:
        lines.append("(no arm threads yet)")
    lines += ["", "[cameras]"]
    for c in cameras_view():
        lines.append(f"{c['kind']} {_redact_url(c['source'])}: ok={c['ok']} fps={c['fps']} calibrated={c['calibrated']} err={_tilde(c['err'])!r}")
    if not ctx.cams:
        lines.append("(none)")
    lines += ["", "[checklist]"]
    res = checklist.build(build_snapshot())
    for it in res["items"]:
        lines.append(f"[{it['status']:4s}] {it['id']}: {it['detail']}")
    lines.append(f"next: {res['summary']['next']}   ({res['summary']['ok']} of {res['summary']['total']} ok)")
    lines += ["", "[modules]"]
    for m in _modules():
        lines.append(f"{m.id} {m.version} enabled={m.enabled}" + (f" ERROR: {m.error}" if m.error else ""))
    tr = trace.snapshot(limit=1)
    lines += ["", f"inspector: recording={tr['enabled']} raw={tr['raw']} entries-seen={tr['seq']}", f"data folder: {paths.tilde(paths.data_dir())}"]
    return "\n".join(lines) + "\n"


# ================================================================= identify an adapter by unplugging it
def _identify_bind(key: str, path: str):
    st = ctx.identify
    cur = [p.key for p in ports_mod.list_ports()]
    roles.assign(_roles_file(), key, st["role"], other_keys=cur)
    for a in list(ctx.arms.values()):                          # live arms pick up their (possibly swapped) roles at once
        a.role = ctx.server.role_for(a.path)
        a.ensure_default()
    st.update(state="done", port=path, message=f"Got it. This adapter is now the {st['role']} arm.")


def identify_tick():
    with ctx._lock:
        _identify_tick()


def _identify_watch(st):
    """Keep looking while an identify is waiting, so it works for scripts that poll rarely (the UI polls too)."""
    while ctx.identify is st and st["state"] in ("unplug", "replug"):
        try:
            identify_tick()
        except Exception:
            return
        time.sleep(0.1)


def _identify_tick():
    st = ctx.identify
    if st["state"] not in ("unplug", "replug"):
        return
    if time.time() - st["started"] > ctx.identify_timeout:
        st.update(state="error", message="That took too long, so I stopped. Press Start to try again, and unplug the USB cable of the arm's controller board within a minute.")
        return
    cur = {p.key: p.path for p in ports_mod.list_ports()}
    if st["state"] == "unplug":
        st["baseline"].update({k: v for k, v in cur.items() if k not in st["baseline"]})
        gone = set(st["baseline"]) - set(cur)
        if len(gone) == 1:
            st.update(state="replug", vanished=next(iter(gone)), message="Got it, that one disappeared. Now plug the same USB cable back in.")
        elif len(gone) > 1:
            st["message"] = "Two adapters disappeared. Plug them both back in, then unplug only the one you want to identify."
    else:
        newcomers = set(cur) - set(st["baseline"])
        if st["vanished"] in cur:
            _identify_bind(st["vanished"], cur[st["vanished"]])
        elif len(newcomers) == 1:                              # same adapter, different USB socket: its key changed with the socket
            k = next(iter(newcomers))
            _identify_bind(k, cur[k])


def api_identify(method: str, body: dict) -> dict:
    st = ctx.identify
    if method == "POST":
        action = body.get("action")
        if action == "cancel":
            ctx.identify = {"state": "idle", "message": "Cancelled.", "port": None}
        elif action == "start":
            role = body.get("role")
            if role not in roles.ROLES:
                raise ApiError(400, "Say which arm this is: role must be 'follower' or 'leader'.")
            now = {p.key: p.path for p in ports_mod.list_ports()}
            if not now:
                ctx.identify = {"state": "error", "message": "No USB adapter is plugged in yet. Plug the arm's controller board into this computer first, then press Start.", "port": None}
            else:
                ctx.identify = {"state": "unplug", "role": role, "started": time.time(), "baseline": now, "port": None,
                                "message": f"Unplug the USB cable of the {role} arm's controller board now. Leave the other arm plugged in."}
                threading.Thread(target=_identify_watch, args=(ctx.identify,), daemon=True).start()
        else:
            raise ApiError(400, "action must be 'start' or 'cancel'.")
    identify_tick()
    st = ctx.identify
    return {"state": st["state"], "message": st["message"], "port": st.get("port"), "role": st.get("role")}


def api_role(body: dict) -> dict:
    role, port = body.get("role"), body.get("port")
    if role not in roles.ROLES:
        raise ApiError(400, "role must be 'follower' or 'leader'.")
    why = _motion_blocked()
    if why:
        raise ApiError(409, why)
    listed = ports_mod.list_ports()
    match = next((p for p in listed if p.path == port or p.key == port), None)
    if match is None:
        raise ApiError(404, "That adapter is not plugged in. Plug it in, then try again.")
    roles.assign(_roles_file(), match.key, role, other_keys=[p.key for p in listed])
    for a in list(ctx.arms.values()):
        a.role = ctx.server.role_for(a.path)
        a.ensure_default()
    return {"ok": True, "ports": ports_view()}


def _motion_blocked() -> Optional[str]:
    """A sentence when something is moving or calibrating (so roles / restarts must wait), else None."""
    if ctx.TELE is not None and ctx.TELE.on:
        return "The leader arm is driving the follower: press Stop first."
    if ctx.PP is not None and ctx.PP.running:
        return "Pick & place is running: press Stop first."
    for a in ctx.arms.values():
        if a.calib["step"] in ("center", "sweep"):
            return "A calibration is running: finish or cancel it first."
        if a.wiggling:
            return "An arm is running a test movement: wait until it ends."
    return None


# ================================================================= motors
def api_motors(body: dict) -> dict:
    action = body.get("action")
    if action not in ("scan", "set_id", "ping", "wiggle"):
        raise ApiError(400, "action must be scan, set_id, ping or wiggle.")
    arm = _arm_for(role=body.get("role"), port=body.get("port"))
    if arm is None:
        raise ApiError(404, "No arm is connected on that port or with that role. Plug it in and wait a few seconds.")
    Refused = ctx.server.Refused
    try:
        if action == "scan":
            ids = arm.motor_scan()
            n = len(ids)
            return {"ok": True, "ids": ids, "baud": arm.scan_baud, "port": arm.path,
                    "message": (f"{n} motor{'s' if n != 1 else ''} answered (ID{'s' if n != 1 else ''} {', '.join(map(str, ids))})." if n else
                                "No motor answered at any speed. Check the board's power supply and the motor cables.")}
        if action == "set_id":
            return arm.motor_set_id(body.get("id"))
        if body.get("id") is None:
            raise ApiError(400, "Say which motor: id is a number from 1 to 6.")
        try:
            mid = int(body["id"])
        except (TypeError, ValueError):
            raise ApiError(400, "id must be a number from 1 to 6.")
        return arm.ping_motor(mid) if action == "ping" else arm.wiggle_motor(mid)
    except Refused as e:
        raise ApiError(409, str(e))


# ================================================================= cameras
def api_cameras_post(body: dict) -> dict:
    action = body.get("action")
    if action not in ("add", "remove", "rename"):
        raise ApiError(400, "action must be add, remove or rename.")
    if ctx.camera_origin == "cli" and action != "rename":
        raise ApiError(409, "This app was started with --camera, --camera-url or CAMERA_URL, which override the saved camera list. Start it without those options to add or remove cameras here.")
    store = ctx.store
    lst = _store_cameras()
    if not lst and ctx.camera_origin != "cli":                  # seed the saved list with the cameras that are running now, so they survive the next restart
        lst = [{"id": c["id"], "name": c["name"], "source": cameras_mod.conv_source(c["source"])} for c in cameras_view() if not c["pending"]]
    if action == "add":
        raw = body.get("source")
        if raw is None or str(raw).strip() == "":
            raise ApiError(400, "Say which camera to add: a device (from the detected list) or an address like http://192.168.1.20:8000/raw.mjpg.")
        src = cameras_mod.conv_source(str(raw).strip())
        if any(str(c["source"]) == str(src) for c in lst):
            raise ApiError(409, "That camera is already added.")
        if not body.get("force") and not any(str(c.src) == str(src) for c in ctx.cams):
            r = cameras_mod.probe_source(src)
            if not r.ok:
                raise ApiError(400, r.err)
        n = 1 + max([int(str(c.get("id", "cam0"))[3:] or 0) for c in lst if str(c.get("id", "")).startswith("cam") and str(c["id"])[3:].isdigit()] + [-1])
        name = str(body.get("name") or "").strip()[:60]
        if not name:
            hit = next((c for c in ctx._detected["items"] if str(c.source) == str(src)), None)
            name = hit.name if hit else f"Camera {len(lst) + 1}"
        lst.append({"id": f"cam{n}", "name": name, "source": src})
    else:
        cid = body.get("id")
        hit = next((c for c in lst if c.get("id") == cid or (body.get("source") is not None and str(c["source"]) == str(body["source"]))), None)
        if hit is None:
            raise ApiError(404, "There is no such camera in the saved list.")
        if action == "remove":
            lst.remove(hit)
        else:
            name = str(body.get("name") or "").strip()[:60]
            if not name:
                raise ApiError(400, "Give the camera a name.")
            hit["name"] = name
    store.set("cameras.list", lst)
    ctx._detected["t"] = 0.0
    return {"ok": True, "cameras": cameras_view(), "restart_needed": action != "rename"}


def _snapshot_jpeg(i: int, annotated: bool):
    cams = ctx.cams
    if i < 0 or i >= len(cams):
        raise ApiError(404, f"There is no camera {i}. The cameras are numbered from 0; this app has {len(cams)}.")
    c = cams[i]
    jpg = (c.jpg if annotated else c.raw_jpg) if c.ok else None
    if jpg:
        return jpg, {"X-Camera-Ok": "1"}
    reason = c.err or "no picture yet"
    import cv2
    import numpy as np
    img = np.full((480, 640, 3), 40, np.uint8)
    cv2.putText(img, f"Camera {i + 1}: no picture", (30, 220), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(img, reason[:60], (30, 270), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1, cv2.LINE_AA)
    return cv2.imencode(".jpg", img)[1].tobytes(), {"X-Camera-Ok": "0", "X-Camera-Error": reason.encode("ascii", "replace").decode()[:200]}


def _stream(h, i: int, raw: bool):
    cams = ctx.cams
    if i < 0 or i >= len(cams):
        _json(h, 404, {"error": f"There is no camera {i}."})
        return
    attr = "raw_jpg" if raw else "jpg"
    h.send_response(200)
    h.send_header("Content-Type", "multipart/x-mixed-replace; boundary=f")
    h.send_header("Cache-Control", "no-store")
    h.end_headers()
    try:
        last = None
        while True:
            jpg = getattr(cams[i], attr)
            if jpg and jpg is not last:
                h.wfile.write(b"--f\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(jpg) + jpg + b"\r\n")
                last = jpg
            time.sleep(0.03)
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass


# ================================================================= static files
def _safe_file(base: pathlib.Path, rel: str) -> Optional[pathlib.Path]:
    rel = urllib.parse.unquote(rel)
    if "\x00" in rel or "\\" in rel:
        return None
    parts = [p for p in rel.split("/") if p != ""]
    if any(p == ".." or p.startswith(".") for p in parts):
        return None
    base = base.resolve()
    f = (base / "/".join(parts)).resolve() if parts else base
    try:
        f.relative_to(base)
    except ValueError:
        return None
    return f if f.is_file() else None


def _static(h, base: pathlib.Path, rel: str, method: str, cache: str):
    f = _safe_file(base, rel)
    if f is None:
        _send(h, 404, b"not found", "text/plain", method=method)
        return
    ctype = STATIC_TYPES.get(f.suffix.lower()) or mimetypes.guess_type(str(f))[0] or "application/octet-stream"
    _send(h, 200, f.read_bytes(), ctype, {"Cache-Control": cache}, method)


# ================================================================= routing
def handle(h, method: str, path: str, body: Optional[dict] = None) -> bool:
    u = urllib.parse.urlsplit(path)
    p, q = u.path, urllib.parse.parse_qs(u.query)
    t0 = getattr(h, "_t0", None)
    try:
        if method in ("GET", "HEAD"):
            if p == "/":
                _redirect(h, "/dashboard" if defaults.get("ui.onboarded", ctx.store) else "/suite/", method)
                return True
            if p in ("/dashboard", "/dashboard/"):
                _static(h, paths.APP_DIR, "index.html", method, "no-cache")
                return True
            if p == "/suite":
                _redirect(h, "/suite/", method)
                return True
            if p == "/favicon.ico":                                              # browsers always ask; the pages carry their own inline icon
                h.send_response(204); h.send_header("Content-Length", "0"); h.send_header("Cache-Control", "max-age=86400"); h.end_headers()
                return True
            if p.startswith("/suite/"):
                rel = p[len("/suite/"):]
                if rel.startswith("modules/"):                                   # /suite/modules/<id>/<file>: a module's own UI files
                    mid, _, fil = rel[len("modules/"):].partition("/")
                    f = modules_mod.ui_file(ctx.modules_dir, mid, urllib.parse.unquote(fil))
                    if f is None:
                        _send(h, 404, b"not found", "text/plain", method=method)
                    else:
                        _send(h, 200, f.read_bytes(), STATIC_TYPES.get(f.suffix.lower(), "application/octet-stream"), {"Cache-Control": "no-cache"}, method)
                elif rel.startswith("vendor/"):
                    _static(h, paths.APP_DIR / "vendor", rel[len("vendor/"):], method, "public, max-age=3600")
                elif rel.startswith("assets/"):
                    _static(h, paths.APP_DIR / "assets", rel[len("assets/"):], method, "public, max-age=3600")
                else:
                    f = ctx.suite_dir / "index.html"
                    if rel in ("", "index.html") and not f.is_file():
                        _send(h, 404, b"<!doctype html><meta charset=utf-8><title>SO-101 Suite</title><p>The Suite web app is not installed in this copy (app/suite/index.html is missing). "
                                      b"The classic dashboard is at <a href=/dashboard>/dashboard</a>.", "text/html; charset=utf-8", method=method)
                    else:
                        _static(h, ctx.suite_dir, rel or "index.html", method, "no-cache")
                return True
            for prefix, raw in (("/stream/", False), ("/raw/", True)):
                if p.startswith(prefix) and p.endswith(".mjpg") and method == "GET":
                    try:
                        i = int(p[len(prefix):-5])
                    except ValueError:
                        i = -1
                    _stream(h, i, raw)
                    return True
        if not (p.startswith(("/api/suite/", "/api/demo/", "/api/m/"))):
            return False
        if method in ("POST", "PUT", "DELETE") and body is None:
            body = _read_body(h)
        body = body or {}
        size = _api(h, method, p, q, body)
        trace.record_http(method, path, getattr(h, "_status", 200), size or 0, t0)
        return True
    except ApiError as e:
        size = _json(h, e.status, {"error": e.message, **e.extra}, method)
        trace.record_http(method, path, e.status, size, t0)
        return True
    except (BrokenPipeError, ConnectionResetError):
        return True
    except Exception as e:
        print(f"[suite_api] {method} {path}\n{traceback.format_exc()}", file=sys.stderr)
        trace.log("error", "api", f"{method} {p}: {type(e).__name__}: {str(e)[:120]}")
        try:
            _json(h, 500, {"error": "Something went wrong inside the app. Try again; if it keeps happening, open Help, press Copy diagnostics and share that."}, method)
        except Exception:
            pass
        return True


def _api(h, method: str, p: str, q: dict, body: dict) -> int:
    """Route one /api/... call. Returns the number of bytes sent."""
    def ok(obj, status=200):
        h._status = status
        return _json(h, status, obj, method)

    if p.startswith("/api/m/"):
        rest = p[len("/api/m/"):]
        mid, _, sub = rest.partition("/")
        mod = next((m for m in _modules() if m.id == mid), None)
        if mod is None:
            raise ApiError(404, f"There is no module called '{mid}'. Look at the Modules page for the installed ones.")
        status, payload = modules_mod.dispatch(mod, method, sub, body, ctx)
        return ok(payload, status)

    route = p[len("/api/suite/"):] if p.startswith("/api/suite/") else None

    if p.startswith("/api/demo/"):
        if not ctx.demo:
            raise ApiError(404, "This only exists in demo mode.")
        from . import demo
        act = p[len("/api/demo/"):]
        if method != "POST":
            raise ApiError(405, "Use POST.")
        port = body.get("port")
        if port not in demo.DEFAULT_PORTS and port not in demo.present_ports():
            raise ApiError(400, "port must be one of the demo adapters: " + ", ".join(demo.DEFAULT_PORTS))
        if act == "connect":
            ids = body.get("ids")
            if not isinstance(ids, list) or not all(isinstance(i, int) and 1 <= i <= 252 for i in ids):
                raise ApiError(400, "ids must be a list of motor IDs, for example [1, 2, 3].")
            now = demo.connect(port, ids)
            for a in ctx.arms.values():
                if a.path == port:
                    a.online = False                                           # the arm re-reads which motors answer
            return ok({"ok": True, "ids": now})
        if act == "usb":
            demo.set_port_present(port, bool(body.get("plugged", True)))
            return ok({"ok": True, "plugged": bool(body.get("plugged", True)), "ports": [x["path"] for x in ports_view()]})
        raise ApiError(404, "Unknown demo action.")

    if route is None:
        raise ApiError(404, "Unknown API path.")
    if route == "info" and method == "GET":
        return ok(info())
    if route == "platform" and method == "GET":
        return ok(_platform())
    if route == "ports" and method == "GET":
        return ok({"ports": ports_view()})
    if route == "cameras":
        if method == "GET":
            return ok({"cameras": cameras_view(), "detected": [c.to_dict() for c in detected_cameras(force=bool(q.get("refresh")))],
                       "restart_needed": _restart_needed(), "origin": ctx.camera_origin})
        if method == "POST":
            return ok(api_cameras_post(body))
    if route.startswith("snapshot/") and route.endswith(".jpg") and method == "GET":
        try:
            i = int(route[len("snapshot/"):-4])
        except ValueError:
            raise ApiError(404, "Use /api/suite/snapshot/<camera number>.jpg, for example 0.jpg.")
        jpg, hdr = _snapshot_jpeg(i, bool(q.get("annotated")))
        h._status = 200
        _send(h, 200, jpg, "image/jpeg", {**hdr, "Cache-Control": "no-store"}, method)
        return len(jpg)
    if route == "checklist" and method == "GET":
        return ok(checklist.build(build_snapshot()))
    if route == "progress":
        cur = ctx.store.get("progress", {})
        cur = cur if isinstance(cur, dict) else {}
        if method == "POST":
            upd = {body["key"]: body.get("value", True)} if "key" in body else dict(body)
            for k, v in upd.items():
                if not isinstance(k, str) or not re.match(r"^[a-z][a-z0-9_.\-]{0,80}$", k) or not isinstance(v, bool):
                    raise ApiError(400, "Progress is a set of true/false ticks, for example {\"assembly.done\": true}.")
            cur.update(upd)
            ctx.store.set("progress", cur)
        return ok(cur)
    if route == "onboarded" and method == "POST":
        v = body.get("value")
        if not isinstance(v, bool):
            raise ApiError(400, "value must be true or false.")
        ctx.store.set("ui.onboarded", v)
        return ok({"onboarded": v})
    if route == "identify" and method in ("GET", "POST"):
        return ok(api_identify(method, body))
    if route == "role" and method == "POST":
        return ok(api_role(body))
    if route == "motors" and method == "POST":
        return ok(api_motors(body))
    if route == "modules" and method == "GET":
        return ok({"modules": [m.to_dict() for m in _modules()]})
    if route == "restart" and method == "POST":
        why = _motion_blocked()
        if why:
            raise ApiError(409, "Not restarting now. " + why)
        n = ok({"ok": True, "restarting": True})
        threading.Timer(0.6, _do_restart).start()
        return n
    if route == "settings":
        if method == "GET":
            return ok(settings_view())
        if method == "POST":
            return ok(settings_update(body))
    if route == "defaults" and method == "GET":
        return ok({"defaults": defaults.defaults(), "effective": defaults.load(ctx.store)})
    if route == "diagnostics" and method == "GET":
        data = diagnostics_text().encode()
        h._status = 200
        _send(h, 200, data, "text/plain; charset=utf-8", {"Cache-Control": "no-store"}, method)
        return len(data)
    if route == "trace" and method == "GET":
        kinds = [k for k in (q.get("kinds") or [""])[0].split(",") if k]
        return ok({**trace.snapshot(since=int((q.get("since") or ["0"])[0] or 0), kinds=kinds or None, limit=int((q.get("limit") or ["500"])[0] or 500)),
                   "max": trace._buf.maxlen})
    if route == "trace" and method == "POST":
        if "max" in body:
            try:
                trace.set_max(int(body["max"]))
            except (TypeError, ValueError):
                raise ApiError(400, "max must be a number of entries, for example 5000.")
        if "enabled" in body:
            trace.set_enabled(bool(body["enabled"]))
        if "raw" in body:
            trace.set_raw(bool(body["raw"]))
        if body.get("clear"):
            trace.clear()
        return ok({**trace.snapshot(limit=1), "items": [], "max": trace._buf.maxlen})
    if route == "trace/export" and method == "GET":
        fmt = (q.get("format") or ["json"])[0]
        if fmt not in trace.CONTENT_TYPES:
            raise ApiError(400, "format must be json, ndjson or text.")
        data = trace.export(fmt).encode()
        h._status = 200
        _send(h, 200, data, trace.CONTENT_TYPES[fmt], {"Content-Disposition": f'attachment; filename="so101-trace.{"txt" if fmt == "text" else fmt}"', "Cache-Control": "no-store"}, method)
        return len(data)
    raise ApiError(404, f"Unknown API path {p} ({method}). See docs/API.md for the list.")


def _do_restart():
    """Replace this process with a fresh copy of itself (the motors keep their torque; the new process reads the real state on start)."""
    if ctx.restart_fn:
        return ctx.restart_fn()
    os.environ["SO101_RESTARTING"] = "1"
    try:
        if ctx.httpd:
            ctx.httpd.server_close()
    except Exception:
        pass
    argv = list(getattr(sys, "orig_argv", None) or [sys.executable] + sys.argv)        # exactly the command that started this process
    os.execv(sys.executable, [sys.executable] + argv[1:])
