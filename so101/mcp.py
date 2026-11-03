"""`so101 mcp`: a Model Context Protocol (MCP) server so an AI agent (Claude Code, Claude Desktop, Cursor ...) can use the SO-101 app.

It does not talk to the arm itself. It talks to the app's local HTTP API, the same one the web UI uses, so it works against the real app and
against `so101 demo`. Transport: MCP over stdio, which is newline-delimited JSON-RPC 2.0: one JSON object per line on stdin, one per line on
stdout, and NOTHING else on stdout (logs go to stderr). Pure standard library.

Safety model (see docs/MCP.md): the always-on tools only read, record a calibration click (which never moves the arm) or stop things.
Tools that can move an arm exist only when started with --allow-motion. This server can never start pick & place, never start
leader-to-follower and never write motor IDs. It releases torque only through so101_rest_arm (--allow-motion), which LOWERS the follower onto
the table first and lets go afterwards, and it never asks a person to touch an arm that is STIFF (the owner's standing rule: docs/LEARNINGS.md 17).
Whether an arm is stiff is read from the app (`/api/state` -> `pp.limp`), never assumed."""
from __future__ import annotations

import argparse
import base64
import http.client
import io
import json
import math
import os
import queue
import re
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, List, Optional, Tuple

from . import __version__

DEFAULT_URL = "http://127.0.0.1:8000"
SUPPORTED_PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
FALLBACK_PROTOCOL = "2025-06-18"
MAX_RESPONSE = 8_000_000                  # bytes read from the app in one answer
HTTP_TIMEOUT = 10.0
MOVE_TIMEOUT = 40.0                       # a test movement takes up to ~10 s
REST_TIMEOUT = 45.0                       # lowering the arm onto the table and letting go takes a few seconds; the app's own limit for a stuck job is much longer
REST_POLL = 0.3
MIN_SPAN = 150                            # the app wants a joint to travel at least this many ticks during calibration (app/server.py)

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR = -32700, -32600, -32601, -32602, -32603

INSTRUCTIONS = (
    "Tools for the SO-101 robot arm app. Safe order: so101_status (are the arms and cameras online? is the follower LIMP or STIFF?), then so101_checklist "
    "(what is the next step?), then so101_snapshot (look at a camera), then so101_teach_point (record a calibration click: the follower must be limp, "
    "and only then does a person move it by hand), and so101_stop whenever anything looks wrong. STANDING RULE: never ask a person to touch, hold, place or "
    "move anything near the arm while the follower is STIFF (so101_status says torque ON). Check so101_status first and say the state in the first line "
    "('the arm is limp now'). A stiff arm is made limp by so101_rest_arm (needs --allow-motion; it lowers the arm onto the table, then lets go) or by the person "
    "pressing 'Release arm' in the app while they keep their hands clear: tell them to take their hands off BEFORE you call it. Nothing here starts pick & place "
    "or the leader-to-follower link or writes motor IDs. Camera numbers start at 0 (the app's 'Camera 1' is camera 0). If a tool says it is switched off or "
    "refused, tell the person what it says instead of trying to work around it.")


class ToolError(Exception):
    """A failure the AI should read: a plain sentence, never a stack trace. Becomes a tool result with isError true."""


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code, self.message = code, message


# ================================================================= talking to the app
def normalize_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if url and "://" not in url:
        url = "http://" + url
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"'{url or ''}' is not an address I can use. Give the app's address, for example http://127.0.0.1:8000 (http or https only).")
    return url


_USB_SERIAL = re.compile(r"(usbmodem|wchusbserial|usbserial-?|SLAB_USBtoUART)[A-Za-z0-9._-]+")
_URL_HOST = re.compile(r"(https?://)[^/\s\"'<>]+")


def scrub_text(s: str) -> str:
    """Hide what must not leave the machine: the serial number macOS puts in an adapter's device name, and the host of a camera URL."""
    return _URL_HOST.sub(r"\1<host>", _USB_SERIAL.sub(r"\1*", s))


def scrub(obj: Any) -> Any:
    if isinstance(obj, str):
        return scrub_text(obj)
    if isinstance(obj, list):
        return [scrub(x) for x in obj]
    if isinstance(obj, dict):
        return {k: scrub(v) for k, v in obj.items() if k != "serial"}
    return obj


class App:
    """The app's HTTP API. Every failure becomes a ToolError with a sentence a beginner could act on."""

    def __init__(self, url: str, allow_motion: bool = False, timeout: float = HTTP_TIMEOUT):
        self.base = normalize_url(url)
        self.allow_motion = bool(allow_motion)
        self.timeout = timeout
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))      # a local app is never behind a proxy

    def _not_running(self) -> ToolError:
        return ToolError(f"The SO-101 app is not running at {self.base}: start it with `uv run so101 start` (or `uv run so101 demo` to try it without hardware). "
                         "If it runs on another address or port, restart this server with --url or set SO101_URL.")

    def _http_error(self, path: str, code: int, payload: bytes) -> ToolError:
        try:
            msg = json.loads(payload).get("error")
        except Exception:
            msg = None
        if isinstance(msg, str) and msg.strip():
            return ToolError(scrub_text(msg.strip()))
        if code == 404:
            return ToolError(f"The app at {self.base} does not know {path}. It may be an older version of the SO-101 app, or another program is listening on that address.")
        return ToolError(f"The app answered HTTP {code} for {path}. Try so101_diagnostics, or look at the app's Help page.")

    def request(self, method: str, path: str, body: Optional[dict] = None, timeout: Optional[float] = None) -> Tuple[Any, bytes]:
        data, headers = None, {"User-Agent": f"so101-mcp/{__version__}", "Accept": "*/*"}
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=timeout or self.timeout) as r:
                payload = r.read(MAX_RESPONSE + 1)
                if len(payload) > MAX_RESPONSE:
                    raise ToolError("The app sent more data than I can pass on (over 8 MB).")
                return r.headers, payload
        except urllib.error.HTTPError as e:
            raise self._http_error(path, e.code, e.read(65536))
        except (TimeoutError, socket.timeout):
            raise ToolError(f"The SO-101 app at {self.base} did not answer in time. It may be busy or stuck: try again, or look at so101_diagnostics.")
        except urllib.error.URLError as e:
            if isinstance(e.reason, (TimeoutError, socket.timeout)):
                raise ToolError(f"The SO-101 app at {self.base} did not answer in time. It may be busy or stuck: try again, or look at so101_diagnostics.")
            raise self._not_running()
        except (http.client.HTTPException, OSError):
            raise self._not_running()

    def get_json(self, path: str, timeout: Optional[float] = None) -> Any:
        return self._json(path, self.request("GET", path, timeout=timeout)[1])

    def post_json(self, path: str, body: Optional[dict] = None, timeout: Optional[float] = None) -> Any:
        return self._json(path, self.request("POST", path, body if body is not None else {}, timeout=timeout)[1])

    def get_text(self, path: str) -> str:
        return self.request("GET", path)[1].decode("utf-8", "replace")

    def try_json(self, path: str) -> Optional[Any]:
        """For extras that are nice to have (an older app may not have them): None instead of an error."""
        try:
            return self.get_json(path)
        except ToolError:
            return None

    @staticmethod
    def _json(path: str, payload: bytes) -> Any:
        try:
            return json.loads(payload.decode("utf-8") or "{}")
        except ValueError:
            raise ToolError(f"The app answered {path} with something that is not JSON. Is that address really the SO-101 app?")


# ================================================================= small helpers
def text(s: str) -> dict:
    return {"type": "text", "text": s}


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def jpeg_size(data: bytes) -> Optional[Tuple[int, int]]:
    """(width, height) of a JPEG from its header, or None."""
    if data[:2] != b"\xff\xd8":
        return None
    i, n = 2, len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        m = data[i + 1]
        if m == 0xFF:
            i += 1
        elif m in (0x00, 0x01) or 0xD0 <= m <= 0xD8:
            i += 2
        elif m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        else:
            i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
    return None


def _ids_text(ids: List[int]) -> str:
    ids = sorted(i for i in ids if isinstance(i, int))
    if ids == [1, 2, 3, 4, 5, 6]:
        return "all 6 motors answer"
    if not ids:
        return "no motor answers"
    missing = [i for i in range(1, 7) if i not in ids]
    return f"only motors {', '.join(map(str, ids))} answer" + (f" (missing {', '.join(map(str, missing))})" if missing else "")


def _first_sentence_case(s: str) -> str:
    s = s.strip()
    return s[:1].upper() + s[1:]


# ================================================================= summaries (plain text for the AI)
def _arm_line(i: int, a: dict) -> str:
    who = f"arm_index {i}: {a.get('role') or 'unknown role'}"
    if a.get("remote"):
        return f"- {who} arm, mirrored from another dashboard (view-only, cannot be controlled from here)."
    if not a.get("online"):
        why = scrub_text(a.get("err") or "")
        return f"- {who} arm: OFFLINE" + (f" ({why})." if why else " (no motor bus answers: check its USB cable and the board's power supply).")
    joints = a.get("joints") or []
    bits = ["online", "calibrated" if a.get("calibrated") else "NOT calibrated yet", _ids_text([j.get("id") for j in joints])]
    if a.get("volt") is not None:
        bits.append(f"supply {a['volt']:g} V")
    temps = [j["temp"] for j in joints if j.get("temp") is not None]
    if temps:
        bits.append(f"hottest motor {max(temps)} C")
    loads = [abs(j["load"]) / 10 for j in joints if j.get("load") is not None]
    if loads:
        bits.append(f"highest load {max(loads):.0f}%")
    faults = {k: v for k, v in (a.get("faults") or {}).items() if v}
    if faults:
        bits.append("FAULTS: " + "; ".join(f"{k} ({', '.join(v)})" for k, v in faults.items()))
    calib = a.get("calib") or {}
    step = calib.get("step")
    if step in ("center", "sweep"):
        extra = ""
        if step == "sweep":
            short = [k for k, r in (calib.get("ranges") or {}).items() if k != "wrist_roll" and isinstance(r, list) and len(r) == 2 and r[1] - r[0] < MIN_SPAN]
            extra = (f"; joints not moved enough yet: {', '.join(short)}" if short else "; every joint has moved enough, it can be finished")
        bits.append(f"CALIBRATION RUNNING (step '{step}': the arm is limp, the person moves it by hand{extra})")
        if calib.get("error"):
            bits.append(f"calibration problem: {calib['error']}")
    elif step == "done":
        bits.append("calibration just finished")
    if a.get("wiggling"):
        bits.append("running a test movement")
    return f"- {who} arm: " + ", ".join(bits) + "."


STIFF_TEXT = ("ON: the follower is STIFF (holding itself). Nobody may touch it, hold it or place anything near it. Ask the person to keep their hands off it, then call "
              "so101_rest_arm (needs --allow-motion) or ask them to press 'Release arm' in the app (it lowers the arm onto the table, then lets go). Wait until this says LIMP "
              "before any instruction that touches the arm.")


def summarize_state(state: dict, info: Optional[dict], base: str) -> str:
    head = f"SO-101 app at {base}"
    if info:
        head += f" (version {info.get('version')}, " + ("DEMO mode: simulated arms and cameras" if info.get("demo") else "real hardware") + ")"
    lines = [head + ".", ""]
    arms = state.get("arms") or []
    if arms:
        lines.append("Arms (arm_index is what so101_calibration takes):")
        lines += [_arm_line(i, a) for i, a in enumerate(arms)]
    else:
        lines.append("Arms: none found. Plug in an arm's USB controller board and its power supply (see so101_ports and so101_checklist).")
    cams = state.get("cameras") or []
    lines.append("")
    if cams:
        lines.append("Cameras (numbered from 0, as in so101_snapshot):")
        for i, c in enumerate(cams):
            kind = "network" if str(c.get("src", "")).startswith(("http://", "https://")) else "usb"
            lines.append(f"- camera {i} ({kind}): " + (f"picture OK, {c.get('fps', 0):g} fps." if c.get("ok") else f"NO PICTURE ({scrub_text(c.get('err') or 'no reason given')})."))
    else:
        lines.append("Cameras: none running.")
    pp = state.get("pp")
    lines.append("")
    if pp is None:
        lines.append("Pick & place engine: not running in this app (camera-only mode?), so camera mapping is not available.")
    else:
        lines.append("Pick & place: " + (f"RUNNING (mode {pp.get('mode')})" if pp.get("running") else "idle") + f'. App status line: "{scrub_text(str(pp.get("status") or ""))}"')
        taught, fit = int(pp.get("taught") or 0), pp.get("fit_mm")
        if taught >= 3:
            lines.append(f"Camera mapping (camera 0 to the table): taught from {taught} points" + (f", fit error {fit:.1f} mm (under 5 mm is good)" if fit is not None and taught > 3 else " (teach a 4th point to measure how good it is)") + ".")
        else:
            lines.append(f"Camera mapping (camera 0 to the table): " + ("calibrated by another method" if pp.get("cam_cal") else f"not done yet ({taught} of 3 points taught)") + ".")
        lines.append("Follower arm torque: " + ("off: the follower is LIMP (it can be moved by hand)." if pp.get("limp") else STIFF_TEXT))
        if pp.get("why"):
            lines.append(f"Not ready for pick & place because: {scrub_text(str(pp['why']))}")
    tele = state.get("teleop") or {}
    lines.append("Leader to follower: " + ("ON (the follower copies the leader)." if tele.get("on") else "off" + (f" ({tele['why']})." if tele.get("why") else ".")))
    return "\n".join(lines)


def summarize_checklist(ck: dict) -> str:
    items, summ = ck.get("items") or [], ck.get("summary") or {}
    nxt = next((i for i in items if i.get("id") == summ.get("next")), None)
    if nxt:
        fix = nxt.get("fix") or {}
        first = (f"{summ.get('ok')} of {summ.get('total')} checks are ok. NEXT STEP: {nxt.get('title')}. {nxt.get('detail')}"
                 + (f" In the app: {fix.get('label')} (the '{fix.get('page')}' page)." if fix else ""))
    else:
        first = f"{summ.get('ok')} of {summ.get('total')} checks are ok. Nothing is left to do: the setup is complete."
    return "\n".join([first, ""] + [f"[{it.get('status')}] {it.get('title')}: {it.get('detail')}" for it in items])


def summarize_cameras(d: dict) -> str:
    lines = ["Cameras the app uses (numbered from 0, the number so101_snapshot takes; the app's 'Camera 1' is camera 0):"]
    for c in d.get("cameras") or []:
        if c.get("pending"):
            lines.append(f"- '{c.get('name')}' ({c.get('kind')}): saved, but not running until the app restarts.")
        else:
            lines.append(f"- camera {c.get('index')} '{c.get('name')}' ({c.get('kind')}): " + (f"picture OK, {c.get('fps', 0):g} fps" if c.get("ok") else f"NO PICTURE ({scrub_text(c.get('err') or 'no reason given')})")
                         + (", table mapping done" if c.get("calibrated") else ", table mapping not done"))
    if not d.get("cameras"):
        lines.append("- none yet.")
    found = d.get("detected") or []
    if found:
        lines.append("Found on this computer but not added to the app yet (a person adds them on the Cameras page): " + "; ".join(
            f"{c.get('name')} ({c.get('width')}x{c.get('height')})" if not c.get("err") else f"{c.get('name')} ({scrub_text(c['err'])})" for c in found) + ".")
    if d.get("restart_needed"):
        lines.append("The saved camera list differs from the running one: the app needs a restart to apply it.")
    return "\n".join(lines)


def summarize_ports(d: dict) -> str:
    lines = ["USB serial adapters this computer can see:"]
    for p in d.get("ports") or []:
        lines.append(f"- {scrub_text(p.get('path', ''))}: " + ("looks like a servo controller board" if p.get("likely_servo_board") else "not recognised as a servo board")
                     + f", role {p.get('role') or 'not set'}, " + ("in use by the app" if p.get("owned_by_app") else "not in use by the app")
                     + (f" ({p['description']})" if p.get("description") else ""))
    if not d.get("ports"):
        lines.append("- none. Plug in the arm's USB controller board and its power supply, then check again.")
    return "\n".join(lines)


def summarize_platform(d: dict) -> str:
    lines = [f"Computer: {d.get('os')} {d.get('os_version')} ({d.get('arch')})" + (f", Raspberry Pi ({d['pi_model']})" if d.get("is_pi") else ""),
             f"Python {d.get('python')}, uv: {'yes' if d.get('uv') else 'no'}, camera backend: {d.get('camera_backend')}"]
    dial = d.get("in_dialout")
    if dial is False:
        lines.append("Serial permission: NOT granted. On Linux run `sudo usermod -aG dialout $USER`, then log out and in again.")
    elif dial:
        lines.append("Serial permission: ok.")
    lines += [f"Note: {n}" for n in d.get("notes") or []]
    return "\n".join(lines)


def summarize_modules(d: dict) -> str:
    lines = ["Modules (folders in modules/ that add pages or features):"]
    for m in d.get("modules") or []:
        lines.append(f"- {m.get('id')} v{m.get('version')}: {m.get('name')}" + (f" - {m['description']}" if m.get("description") else "")
                     + (" [enabled]" if m.get("enabled") else " [disabled]") + (f" ERROR: {m['error']}" if m.get("error") else ""))
    if not d.get("modules"):
        lines.append("- none installed.")
    return "\n".join(lines)


def format_trace_item(i: dict) -> str:
    t = time.strftime("%H:%M:%S", time.localtime(i.get("t", 0))) + f".{int((i.get('t', 0) % 1) * 1000):03d}"
    k = i.get("kind")
    if k == "bus":
        what = f"{i.get('op')} id={i.get('id')} reg={i.get('addr')} {i.get('reg', '')} value={i.get('value')}"
    elif k == "raw":
        what = f"{i.get('dir')} {i.get('hex')}"
    elif k == "http":
        what = f"{i.get('method')} {i.get('path')} -> {i.get('status')} ({i.get('size')} bytes)"
    else:
        what = f"[{i.get('level')}] {i.get('source')}: {i.get('msg')}"
    return scrub_text(f"#{i.get('seq')} {t} {k} {what} {'ok' if i.get('ok') else 'FAIL'} {i.get('ms')} ms" + (f" ERR {i['err']}" if i.get("err") else ""))


# ================================================================= the tools
def _busy_reason(state: dict) -> Optional[str]:
    pp, tele = state.get("pp") or {}, state.get("teleop") or {}
    if tele.get("on"):
        return "The leader arm is driving the follower. Call so101_stop first."
    if pp.get("running"):
        return "Pick & place is running. Call so101_stop first."
    return None


def t_status(app: App, args: dict) -> List[dict]:
    state = app.get_json("/api/state")
    info = app.try_json("/api/suite/info")
    raw = {k: v for k, v in state.items() if k != "viz"}                       # "viz" is only the 3D view's look
    return [text(summarize_state(state, info, app.base)), text("Raw state (JSON, the app's /api/state without the 3D view settings):\n" + dumps(scrub(raw)))]


def t_checklist(app: App, args: dict) -> List[dict]:
    return [text(summarize_checklist(app.get_json("/api/suite/checklist")))]


def t_diagnostics(app: App, args: dict) -> List[dict]:
    return [text(app.get_text("/api/suite/diagnostics"))]


def t_ports(app: App, args: dict) -> List[dict]:
    d = app.get_json("/api/suite/ports")
    d["ports"] = [{k: v for k, v in p.items() if k != "key"} for p in d.get("ports") or []]     # the key is the adapter's serial number
    return [text(summarize_ports(d)), text("Raw (JSON, serial numbers left out):\n" + dumps(scrub(d)))]


def t_cameras(app: App, args: dict) -> List[dict]:
    d = app.get_json("/api/suite/cameras")
    return [text(summarize_cameras(d)), text("Raw (JSON):\n" + dumps(scrub(d)))]


def t_platform(app: App, args: dict) -> List[dict]:
    d = app.get_json("/api/suite/platform")
    return [text(summarize_platform(d)), text("Raw (JSON):\n" + dumps(scrub(d)))]


def t_modules(app: App, args: dict) -> List[dict]:
    return [text(summarize_modules(app.get_json("/api/suite/modules")))]


def t_trace(app: App, args: dict) -> List[dict]:
    q = {"limit": args["limit"]}
    if args.get("since"):
        q["since"] = args["since"]
    if args.get("kinds"):
        q["kinds"] = ",".join(args["kinds"])
    d = app.get_json("/api/suite/trace?" + urllib.parse.urlencode(q))
    items = d.get("items") or []
    off = ("The Inspector is not recording, so there is nothing to read (recording is off by default and costs nothing while off). "
           "A person can turn it on in the app's Inspector page; this tool never turns it on.")
    if not d.get("enabled") and not items:
        return [text(off)]
    head = (f"Inspector recording is {'ON' if d.get('enabled') else 'OFF'}, raw bytes {'on' if d.get('raw') else 'off'}. {len(items)} entries shown (oldest first), newest entry is #{d.get('seq')}"
            f"{', ' + str(d['dropped']) + ' older ones were dropped' if d.get('dropped') else ''}. To read only newer entries call again with since={d.get('seq')}.")
    if not d.get("enabled"):
        head += " Recording is off now, so nothing new is being added."
    return [text("\n".join([head, ""] + [format_trace_item(i) for i in items]) if items else head + " No entries match.")]


def t_snapshot(app: App, args: dict) -> List[dict]:
    i = args["camera"]
    hdr, jpg = app.request("GET", f"/api/suite/snapshot/{i}.jpg" + ("?annotated=1" if args.get("annotated") else ""))
    alive = hdr.get("X-Camera-Ok") != "0"
    state = app.try_json("/api/state") or {}
    cams = state.get("cameras") or []
    c = cams[i] if i < len(cams) else {}
    if not alive or jpg[:2] != b"\xff\xd8":
        why = scrub_text(hdr.get("X-Camera-Error") or c.get("err") or "no reason given")
        raise ToolError(f"Camera {i} has no picture right now ({why}). Nothing was captured. Check the camera's cable or network address and the app's Cameras page; the app keeps trying to reconnect.")
    size = jpeg_size(jpg)
    line = f"Camera {i}: picture OK" + (f", {c['fps']:g} fps" if c.get("fps") is not None else "") + (f", {size[0]}x{size[1]} pixels" if size else "") + (", with the app's overlay drawn on it" if args.get("annotated") else "") + "."
    if size and size != (640, 480):
        line += f" The app's coordinates (so101_teach_point) are for a 640x480 picture, so scale pixel positions from this {size[0]}x{size[1]} picture to 640x480 first."
    else:
        line += " Pixel coordinates for so101_teach_point are in this picture: (0, 0) is the top-left corner, u goes right to 640, v goes down to 480."
    return [text(line), {"type": "image", "data": base64.b64encode(jpg).decode("ascii"), "mimeType": "image/jpeg"}]


def t_ping(app: App, args: dict) -> List[dict]:
    r = app.post_json("/api/suite/motors", {"action": "ping", "role": args["role"], "id": args["id"]})
    if not r.get("ok"):
        return [text(scrub_text(r.get("message") or f"Motor {args['id']} did not answer."))]
    return [text(f"{r.get('message')} Position {r.get('position')}, load {r.get('load_pct')}%, temperature {r.get('temp_c')} C, supply {r.get('volt')} V.")]


def _taught(state: dict) -> Optional[int]:
    pp = state.get("pp")
    return None if pp is None else int(pp.get("taught") or 0)


def t_teach(app: App, args: dict) -> List[dict]:
    u, v = args["u"], args["v"]
    before = app.get_json("/api/state")
    n0 = _taught(before)
    if n0 is None:
        raise ToolError("The arm engine (pick & place) is not running in this app, so a calibration point cannot be recorded. It is missing in camera-only mode.")
    busy = _busy_reason(before)
    if busy:
        raise ToolError("Point not recorded. " + busy)
    app.post_json("/api/pp/teach", {"u": u, "v": v})
    after = app.get_json("/api/state")
    n1 = _taught(after) or 0
    pp = after.get("pp") or {}
    if n1 > n0:
        fit = pp.get("fit_mm")
        if n1 < 3:
            nxt = (f"{3 - n1} more {'are' if 3 - n1 > 1 else 'is'} needed. Ask the person to move the gripper tip to a different spot on the table (at least 2 cm from the last one), "
                   "then take a new so101_snapshot of camera 0, find the tip in it, and call this tool again.")
        elif n1 == 3:
            nxt = "That is enough to map the table. Teach a 4th point at yet another spot to measure how good the mapping is (with exactly 3 points the fit always looks perfect)."
        else:
            nxt = f"Fit error {fit:.1f} mm (under 5 mm is good, over 10 mm is rough: undo the newest point or clear and redo)." if fit is not None else "The mapping is updated."
        return [text(f"Point {n1} recorded: picture position ({u:g}, {v:g}) is now matched to where the gripper tip really is. The arm did not move. {nxt}")]
    status = str(pp.get("status") or "").strip()
    why = _first_sentence_case(status[len("error:"):] if status.lower().startswith("error:") else status) or "the app gave no reason"
    hint = ""
    low = why.lower()
    if "not limp" in low:
        hint = (" The follower is STIFF, so nobody may touch it. It has to be lowered and made limp first: so101_rest_arm (needs --allow-motion), or the person presses 'Release arm' "
                "in the app with their hands clear. This tool never releases torque.")
    elif "hasn't moved" in low or "has not moved" in low:
        hint = " Ask the person to move the gripper tip to a different spot at least 2 cm away, then try again."
    elif "online/calibrated" in low:
        hint = " Connect and calibrate the follower arm first (see so101_checklist)."
    raise ToolError(f"The app did not record that point. It says: {scrub_text(why.rstrip('.'))}.{hint}")


def t_undo(app: App, args: dict) -> List[dict]:
    before = app.get_json("/api/state")
    n0 = _taught(before)
    if n0 is None:
        raise ToolError("The arm engine (pick & place) is not running in this app, so there are no calibration points.")
    busy = _busy_reason(before)
    if busy:
        raise ToolError("Nothing changed. " + busy)
    if n0 == 0:
        return [text("There were no calibration points to undo.")]
    app.post_json("/api/pp/undo", {})
    n1 = _taught(app.get_json("/api/state")) or 0
    return [text(f"Removed the newest calibration point. {n1} point{'s' if n1 != 1 else ''} left" + ("." if n1 >= 3 else f" ({3 - n1} more needed to map the table)."))]


def t_clear(app: App, args: dict) -> List[dict]:
    before = app.get_json("/api/state")
    n0 = _taught(before)
    if n0 is None:
        raise ToolError("The arm engine (pick & place) is not running in this app, so there are no calibration points.")
    busy = _busy_reason(before)
    if busy:
        raise ToolError("Nothing changed. " + busy)
    if n0 == 0:
        return [text("There were no calibration points to clear.")]
    app.post_json("/api/pp/clear", {})
    return [text(f"Cleared all {n0} calibration points. The camera mapping has to be taught again (at least 3 points).")]


def t_stop(app: App, args: dict) -> List[dict]:
    """Both calls are tried even if the first fails: the stop must get through whatever else is wrong."""
    done, failed = [], []
    for what, path in (("leader-to-follower copying", "/api/teleop/stop"), ("pick & place", "/api/pp/stop")):
        try:
            app.post_json(path, {})
            done.append(what)
        except ToolError as e:
            failed.append((what, str(e)))
    if not done:
        raise ToolError(failed[0][1])
    msg = "Stop sent: " + " and ".join(done) + " told to stop. The arm holds where it is (torque is not changed, nothing is moved)."
    state = app.try_json("/api/state") or {}
    if (state.get("pp") or {}).get("running") or (state.get("teleop") or {}).get("on"):
        msg += " The app still reports something running: ask the person to press Stop or Reset in the app. (The app also cancels stuck jobs by itself within about 30 seconds.)"
    if failed:
        msg += " " + "; ".join(f"The {w} stop did not go through ({m})" for w, m in failed) + "."
    return [text(msg)]


def t_wiggle(app: App, args: dict) -> List[dict]:
    r = app.post_json("/api/suite/motors", {"action": "wiggle", "role": args["role"], "id": args["id"]}, timeout=MOVE_TIMEOUT)
    msg = scrub_text(r.get("message") or "")
    if not r.get("ok"):
        raise ToolError(msg or f"Motor {args['id']} did not move.")
    return [text(f"{msg} Peak load {r.get('peak_load_pct')}%. The motor ended in the torque state it started in.")]


def _stiff_refusal(state: dict) -> Optional[str]:
    """The standing rule as a sentence, or None when it is safe to ask a person to touch the arm: only when the app SAYS the follower is limp (pp.limp true)."""
    pp = state.get("pp")
    if pp is None:
        return ("The app does not report whether the follower is limp (its arm engine is not running), so I cannot tell that the arm is safe to touch. "
                "Do not ask anyone to touch it. Look at so101_status and the app's Help page.")
    if pp.get("limp") is True:
        return None
    return ("The follower arm is STIFF (torque on, holding itself): nobody may touch it, and starting a calibration switches its torque off at once, which drops a raised arm. "
            "Ask the person to keep their hands off the arm, then call so101_rest_arm (needs --allow-motion): it lowers the arm onto the table and only then lets go. "
            "Or the person presses 'Release arm' in the app with their hands clear. Call this again when so101_status says the follower is LIMP.")


def t_rest_arm(app: App, args: dict) -> List[dict]:
    """POST /api/pp/rest, then wait until /api/state says pp.limp is true. The app answers {} even when it refuses, so the state is the only truth."""
    state = app.get_json("/api/state")
    pp = state.get("pp")
    if pp is None:
        raise ToolError("The arm engine (pick & place) is not running in this app, so the arm cannot be lowered. Nothing was changed. Do not ask anyone to touch the arm; see so101_status and the app's Help page.")
    if pp.get("limp") is True:
        return [text("The follower arm is already limp: nothing was moved. A person may move it by hand now.")]
    busy = _busy_reason(state)
    if busy:
        raise ToolError("Nothing was changed. " + busy + " The arm is STIFF meanwhile: nobody may touch it.")
    app.post_json("/api/pp/rest", {}, timeout=MOVE_TIMEOUT)
    t0, idle_since = time.monotonic(), None
    last = {}
    while time.monotonic() - t0 < REST_TIMEOUT:
        time.sleep(REST_POLL)
        last = (app.get_json("/api/state").get("pp") or {})
        if last.get("limp") is True:
            return [text("The follower arm is LIMP now, resting on the table (the app lowered it first, then let go). A person may move it by hand. "
                         "Tell them to take their hands off it again BEFORE anything switches the motors on (calibration clicks do not).")]
        if last.get("running"):
            idle_since = None
        else:                                               # the job ended and the arm is still stiff: the app refused or it was stopped
            idle_since = idle_since or time.monotonic()
            if time.monotonic() - idle_since > 1.5:
                break
    status = str(last.get("status") or "").strip()
    why = scrub_text(re.sub(r"\s*\(the arm is still STIFF[^)]*\)\.?", "", status[len("error:"):] if status.lower().startswith("error:") else status).strip().rstrip("."))
    raise ToolError(f"The arm was not made limp. The app says: {_first_sentence_case(why) or 'it gave no reason'}. The follower is still STIFF: nobody may touch it. "
                    "Tell the person to keep their hands and things away from it and to open the app's Help page. Do not try to release it any other way (never by cutting its power).")


def t_calibration(app: App, args: dict) -> List[dict]:
    idx, action = args["arm_index"], args["action"]
    state = app.get_json("/api/state")
    arms = state.get("arms") or []
    if idx >= len(arms) or arms[idx].get("remote"):
        raise ToolError(f"There is no arm with arm_index {idx} that can be calibrated here. The app has {len(arms)} arm(s); so101_status lists their arm_index.")
    arm = arms[idx]
    role = arm.get("role") or "unknown"
    step = (arm.get("calib") or {}).get("step", "idle")
    if action == "start":
        if not arm.get("online"):
            raise ToolError(f"The {role} arm is offline, so it cannot be calibrated. Check its USB cable and the board's power supply (so101_status, so101_ports).")
        busy = _busy_reason(state) or ("The arm is running a test movement: wait until it ends." if arm.get("wiggling") else None)
        if busy:
            raise ToolError("Not started. " + busy)
        if step in ("center", "sweep"):
            raise ToolError(f"A calibration is already running for the {role} arm (step '{step}'). Continue it with 'center' or 'finish', or stop it with 'cancel'.")
        refusal = _stiff_refusal(state)                      # the standing rule: nobody touches a stiff arm; and starting switches the torque off at once, which drops a raised arm
        if refusal:
            raise ToolError("Not started. " + refusal)
    elif action == "center" and step != "center":
        raise ToolError(f"The centre step only works right after 'start' (this arm's calibration step is '{step}').")
    elif action == "finish" and step != "sweep":
        raise ToolError(f"Finish only works after 'center' (this arm's calibration step is '{step}').")
    app.post_json(f"/api/calib/{idx}/{action}", {}, timeout=MOVE_TIMEOUT)
    now = (app.get_json("/api/state").get("arms") or [{}] * (idx + 1))[idx]
    calib = now.get("calib") or {}
    nstep = calib.get("step", "idle")
    if action == "start":
        if nstep != "center":
            raise ToolError("The app did not start the calibration (the arm may have gone offline). Check so101_status.")
        return [text(f"Calibration started on the {role} arm. It is LIMP (torque off, it was already limp and lowered) and its old calibration in the motors was reset. "
                     "Next: the person moves every joint to the middle of its range and keeps it there, then call this with action 'center'.")]
    if action == "center":
        if nstep != "sweep":
            raise ToolError("The app did not record the middle position. Check so101_status and try again, or cancel.")
        return [text("Middle position recorded (the joint zero points are now written to the motors). Next: the person moves EVERY joint slowly through its full range, "
                     "once each way. so101_status shows which joints still need more. Then call this with action 'finish'.")]
    if action == "finish":
        if calib.get("error"):
            raise ToolError(f"The calibration was not saved: {scrub_text(str(calib['error']))}. The person should keep moving those joints, then call 'finish' again.")
        return [text(f"Calibration saved for the {role} arm. The app's own calibration page can set it as the default (restore point).")]
    return [text(f"Calibration cancelled for the {role} arm. If it had already been started, the motors' old calibration was reset when it began: the person can bring it back with "
                 "'Restore default' on the app's Calibrate page, or run the calibration again. This tool does not re-enable torque.")]


# ================================================================= tool registry and argument checking
def _int(desc: str, lo: int, hi: int, default: Optional[int] = None) -> dict:
    d = {"type": "integer", "minimum": lo, "maximum": hi, "description": desc}
    if default is not None:
        d["default"] = default
    return d


ROLE = {"type": "string", "enum": ["follower", "leader"], "description": "Which arm: 'follower' (the arm that does the work) or 'leader' (the arm a person moves by hand)."}
MOTOR_ID = _int("Motor ID, 1 to 6 (1 shoulder pan, 2 shoulder lift, 3 elbow, 4 wrist flex, 5 wrist roll, 6 gripper).", 1, 6)


class Tool:
    def __init__(self, name: str, title: str, description: str, handler: Callable[[App, dict], List[dict]], properties: Optional[dict] = None,
                 required: Optional[List[str]] = None, motion: bool = False, read_only: bool = True, destructive: bool = False, idempotent: bool = False):
        self.name, self.title, self.description, self.handler, self.motion = name, title, description, handler, motion
        self.schema = {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}
        self.annotations = {"title": title, "readOnlyHint": read_only, "destructiveHint": destructive, "idempotentHint": idempotent, "openWorldHint": False}

    def listing(self) -> dict:
        return {"name": self.name, "title": self.title, "description": self.description, "inputSchema": self.schema, "annotations": self.annotations}


TOOLS: List[Tool] = [
    Tool("so101_status", "Arm, camera and job status",
         "Read-only. Call this FIRST. Says which arms are online and calibrated (with each arm's role and arm_index), which motors answer, which cameras have a picture, "
         "whether pick & place or the leader-to-follower link is running, and whether the camera-to-table mapping is taught. Returns a plain-text summary plus the raw JSON. Never moves or changes anything.",
         t_status, idempotent=True),
    Tool("so101_checklist", "Setup checklist and next step",
         "Read-only. The app's 'what is connected and what is left' checklist, with the single NEXT step spelled out. Use it to decide what to do or tell the person next. Never changes anything.",
         t_checklist, idempotent=True),
    Tool("so101_diagnostics", "Diagnostics report",
         "Read-only. The app's plain-text diagnostics report (computer, ports, motors, cameras, checklist, versions). Use it when something is wrong or before writing a bug report. "
         "It contains no serial numbers or personal data.", t_diagnostics, idempotent=True),
    Tool("so101_ports", "USB serial adapters",
         "Read-only. The USB serial adapters this computer sees, which look like an arm's controller board, and which arm role each is bound to. Use it when an arm shows offline. "
         "Serial numbers are left out. Never opens a port or changes a role.", t_ports, idempotent=True),
    Tool("so101_cameras", "Cameras",
         "Read-only. The cameras the app uses (with the camera number so101_snapshot takes), whether each has a picture, whether its table mapping is done, and cameras found but not added yet. "
         "Never adds, removes or restarts anything.", t_cameras, idempotent=True),
    Tool("so101_platform", "Computer details",
         "Read-only. The computer the app runs on: operating system, Raspberry Pi model, Python, uv, serial-port permission. Use it to explain an install or permission problem.",
         t_platform, idempotent=True),
    Tool("so101_trace", "Inspector log",
         "Read-only. The app's Inspector log: what the app and the motors said to each other (bus reads and writes, HTTP calls, log lines). Recording is OFF by default; then this says so, "
         "and a person has to turn it on in the Inspector page (this tool never does). Pass since=<seq from the last call> to read only new entries.",
         t_trace, idempotent=True, properties={
             "since": _int("Only entries newer than this sequence number (0 = from the start).", 0, 2 ** 53, 0),
             "kinds": {"type": "array", "items": {"type": "string", "enum": ["bus", "http", "log", "raw"]}, "description": "Only these kinds of entries (default: all)."},
             "limit": _int("Most entries to return (default 100, at most 500).", 1, 500, 100)}),
    Tool("so101_snapshot", "Look at a camera",
         "Read-only. Returns a JPEG picture from one camera plus a line with its status and fps, so you can SEE the table. Use it to check the table is visible, to find the gripper tip in the "
         "picture before so101_teach_point, or to check a calibration (annotated=true draws the app's overlay: taught points, bowl). camera is a number from 0 (the app's 'Camera 1'). "
         "If the camera has no picture it says so instead of returning one. Never moves anything.", t_snapshot, idempotent=True, properties={
             "camera": _int("Camera number, starting at 0 (see so101_cameras).", 0, 15, 0),
             "annotated": {"type": "boolean", "description": "Draw the app's overlay on the picture (taught points, bowl, no-go line). Default false.", "default": False}}),
    Tool("so101_modules", "Installed modules",
         "Read-only. The modules (folders in modules/) the app found: id, version, whether enabled, any error.", t_modules, idempotent=True),
    Tool("so101_ping_motor", "Ping one motor",
         "Read-only. Asks one motor (ID 1 to 6) on the follower or leader arm whether it answers, and reports its position, load, temperature and supply voltage. Never moves it or writes anything. "
         "The app refuses while a calibration, pick & place or leader-to-follower run is going. A motor that does not answer is a normal result, not an error.",
         t_ping, idempotent=True, properties={"role": ROLE, "id": MOTOR_ID}, required=["role", "id"]),
    Tool("so101_teach_point", "Record one calibration click",
         "Records ONE point of the camera-to-table mapping. You give the pixel (u, v) in camera 0's 640x480 picture where the gripper tip is right now ((0, 0) top-left); the app pairs it with the tip's real "
         "position computed from the arm's joint angles. It never moves the arm. The app refuses, and this returns its sentence, unless the follower is calibrated, LIMP (torque off: so101_status says LIMP; a stiff arm must not be touched, "
         "so lower it first with so101_rest_arm) and the tip has moved at least 1.5 cm since the last point. It needs 3 points at different spots; a 4th shows the fit error (under 5 mm is good). Use so101_snapshot first to find the tip in the picture.",
         t_teach, read_only=False, properties={
             "u": {"type": "number", "minimum": 0, "maximum": 640, "description": "Pixels from the left edge of camera 0's 640x480 picture."},
             "v": {"type": "number", "minimum": 0, "maximum": 480, "description": "Pixels from the top edge of camera 0's 640x480 picture."}}, required=["u", "v"]),
    Tool("so101_undo_point", "Undo the last calibration point",
         "Removes the newest calibration point. Use it if the last click was wrong. Never moves anything.", t_undo, read_only=False),
    Tool("so101_clear_points", "Clear all calibration points",
         "Removes ALL calibration points: the camera mapping has to be taught again. Only use it when the person asked or the mapping is clearly wrong. Never moves anything.",
         t_clear, read_only=False, destructive=True, idempotent=True),
    Tool("so101_stop", "Stop (safety)",
         "SAFETY, always available. Tells the app to stop pick & place and the leader-to-follower link, and to make the arm hold where it is. It does not release torque and does not move the arm to a pose. "
         "Call it at once if anything looks wrong. A stopped arm is still STIFF: nobody may touch it until so101_status says LIMP.", t_stop, read_only=False, idempotent=True),
    Tool("so101_wiggle_motor", "Wiggle one motor (moves the arm)",
         "MOTION, only available when the server was started with --allow-motion. Moves ONE motor about 10 degrees, slowly, there and back, so a person can see which physical joint a motor ID is. "
         "A person should be present and the space around the arm clear. The app refuses during calibration, pick & place or leader-to-follower, or when the arm is offline. "
         "It ends in the torque state it started in.", t_wiggle, read_only=False, motion=True, properties={"role": ROLE, "id": MOTOR_ID}, required=["role", "id"]),
    Tool("so101_rest_arm", "Lower the follower onto the table, then make it limp (moves the arm)",
         "MOTION, only available with --allow-motion. The ONLY way this server releases torque, and it does it safely: the follower LOWERS itself onto the table first and only then lets go, so nothing drops and nobody has to hold it "
         "(the same as the app's 'Release arm' button, POST /api/pp/rest). Use it when so101_status says the follower is STIFF and a person has to touch the arm (calibration, calibration clicks). Ask the person to take their HANDS OFF "
         "the arm BEFORE you call it, because the arm moves by itself; wait for the answer (up to about 45 seconds), then tell them the arm is limp. If the arm is already limp nothing happens. The app refuses, and this returns its sentence, "
         "when the follower is not online and calibrated or a job or the leader link is running; then the arm stays STIFF and nobody may touch it. Never starts pick & place or the leader-to-follower link.",
         t_rest_arm, read_only=False, motion=True, idempotent=True),
    Tool("so101_calibration", "Guided arm calibration (writes to the motors)",
         "MOTION, only available with --allow-motion. Drives the app's guided calibration for one arm (arm_index from so101_status). 'start' resets the arm's calibration in its motors and switches its torque off at once, which would drop a raised arm, "
         "so it is REFUSED unless /api/state says the follower is already LIMP (so101_status: 'LIMP'): if it is stiff, tell the person to keep their hands off the arm and call so101_rest_arm first. Never ask anyone to hold a stiff arm. "
         "Then the person moves every joint to mid-range and you call 'center'; then the person moves every joint through its full range and you call 'finish', which saves. 'cancel' stops (after 'start' the old calibration is already reset: "
         "'Restore default' on the app's Calibrate page brings it back). Never starts pick & place or the leader-to-follower link.",
         t_calibration, read_only=False, destructive=True, motion=True, properties={
             "arm_index": _int("Which arm, as listed by so101_status (0 is the first).", 0, 7),
             "action": {"type": "string", "enum": ["start", "center", "finish", "cancel"], "description": "start (only when the follower is limp), then center, then finish; cancel at any time."}}, required=["arm_index", "action"]),
]
MOTION_TOOL_NAMES = tuple(t.name for t in TOOLS if t.motion)


def _check(name: str, spec: dict, v: Any) -> Any:
    kind = spec.get("type")
    lo, hi = spec.get("minimum"), spec.get("maximum")
    rng = f" between {lo:g} and {hi:g}" if lo is not None and hi is not None else ""
    if kind in ("integer", "number"):
        ok = isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
        if ok and kind == "integer":
            ok = float(v).is_integer()
        if not ok:
            raise ToolError(f"'{name}' must be a {'whole number' if kind == 'integer' else 'number'}{rng} (you sent {v!r}).")
        if (lo is not None and v < lo) or (hi is not None and v > hi):
            raise ToolError(f"'{name}' must be{rng or ' in range'} (you sent {v:g}).")
        return int(v) if kind == "integer" else v
    if kind == "string":
        if not isinstance(v, str) or ("enum" in spec and v not in spec["enum"]):
            raise ToolError(f"'{name}' must be one of: {', '.join(spec['enum'])} (you sent {v!r})." if "enum" in spec else f"'{name}' must be text.")
        return v
    if kind == "boolean":
        if not isinstance(v, bool):
            raise ToolError(f"'{name}' must be true or false (you sent {v!r}).")
        return v
    if kind == "array":
        if not isinstance(v, list):
            raise ToolError(f"'{name}' must be a list, for example {json.dumps((spec.get('items') or {}).get('enum', ['a'])[:2])}.")
        return [_check(name, spec.get("items") or {}, x) for x in v]
    return v


def validate(schema: dict, args: dict) -> dict:
    props = schema.get("properties", {})
    unknown = [k for k in args if k not in props]
    if unknown:
        raise ToolError(f"Unknown argument{'s' if len(unknown) > 1 else ''}: {', '.join(unknown)}. This tool takes: {', '.join(props) or 'no arguments'}.")
    for k in schema.get("required", []):
        if k not in args:
            raise ToolError(f"Missing argument '{k}': {props[k].get('description', '')}")
    out = {k: _check(k, props[k], v) for k, v in args.items()}
    for k, p in props.items():
        if k not in out and "default" in p:
            out[k] = p["default"]
    return out


# ================================================================= the JSON-RPC loop
def log(msg: str) -> None:
    print(f"so101 mcp: {msg}", file=sys.stderr, flush=True)


class Server:
    def __init__(self, app: App, stdout):
        self.app, self.out = app, stdout
        self.tools = {t.name: t for t in TOOLS if app.allow_motion or not t.motion}
        self._wlock = threading.Lock()
        self._cancelled: set = set()
        self._inflight: set = set()
        self._queue: "queue.Queue[Any]" = queue.Queue()
        self._threads: List[threading.Thread] = []
        self.closed = False

    # -------- output
    def send(self, obj: Any) -> None:
        line = json.dumps(obj, ensure_ascii=True, separators=(",", ":"))      # ascii only: no stray newline or odd character can reach the protocol stream
        with self._wlock:
            try:
                self.out.write(line + "\n")
                self.out.flush()
            except (BrokenPipeError, ValueError, OSError):
                self.closed = True                                              # the client went away

    @staticmethod
    def _error(rid: Any, code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}

    # -------- one message in, at most one response out
    def dispatch(self, msg: Any) -> Optional[dict]:
        if not isinstance(msg, dict):
            return self._error(None, INVALID_REQUEST, "Invalid Request: each line must be one JSON object.")
        method, has_id, rid = msg.get("method"), "id" in msg, msg.get("id")
        if method is None and ("result" in msg or "error" in msg):
            return None                                                          # a reply to something we asked: we ask nothing
        if has_id and (isinstance(rid, bool) or not isinstance(rid, (int, float, str))):
            return self._error(None, INVALID_REQUEST, "Invalid Request: id must be a string or a number.")
        if not isinstance(method, str):
            return self._error(rid if has_id else None, INVALID_REQUEST, "Invalid Request: a method name is required.")
        params = msg.get("params")
        try:
            if params is not None and not isinstance(params, dict):
                raise RpcError(INVALID_PARAMS, "params must be a JSON object.")
            params = params or {}
            if not has_id:
                self.notification(method, params)
                return None
            return {"jsonrpc": "2.0", "id": rid, "result": self.request(method, params)}
        except RpcError as e:
            return self._error(rid, e.code, e.message) if has_id else None
        except Exception:
            log(traceback.format_exc())
            return self._error(rid, INTERNAL_ERROR, "Internal error in the SO-101 MCP server (details are in its log on stderr).") if has_id else None

    def notification(self, method: str, params: dict) -> None:
        rid = params.get("requestId")
        if method == "notifications/cancelled" and isinstance(rid, (int, float, str)) and rid in self._inflight:
            self._cancelled.add(rid)                                              # we cannot undo a call in flight, but we stop answering it
        # notifications/initialized and anything else: nothing to do, and a notification never gets a reply

    def request(self, method: str, params: dict) -> dict:
        if method == "initialize":
            asked = params.get("protocolVersion")
            return {"protocolVersion": asked if asked in SUPPORTED_PROTOCOLS else FALLBACK_PROTOCOL, "capabilities": {"tools": {}},
                    "serverInfo": {"name": "so101", "title": "SO-101 Suite", "version": __version__},
                    "instructions": INSTRUCTIONS + (" Motion tools are ON (--allow-motion): a person must be present." if self.app.allow_motion else " Motion tools are off; a person can restart this server with --allow-motion to enable them.")}
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": [t.listing() for t in self.tools.values()]}
        if method == "tools/call":
            return self.call_tool(params)
        raise RpcError(METHOD_NOT_FOUND, f"Method not found: {method}")

    def call_tool(self, params: dict) -> dict:
        name, args = params.get("name"), params.get("arguments")
        if not isinstance(name, str) or not name:
            raise RpcError(INVALID_PARAMS, 'tools/call needs a tool name, for example {"name": "so101_status", "arguments": {}}.')
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise RpcError(INVALID_PARAMS, "arguments must be a JSON object.")
        tool = self.tools.get(name)
        if tool is None:
            if name in MOTION_TOOL_NAMES:
                raise RpcError(INVALID_PARAMS, f"{name} is a motion tool and is switched off: this server was started without --allow-motion. Tell the person; only they can restart it with --allow-motion.")
            raise RpcError(INVALID_PARAMS, f"Unknown tool: {name}. Call tools/list to see the tools that are available.")
        try:
            return {"content": tool.handler(self.app, validate(tool.schema, args)), "isError": False}
        except ToolError as e:
            return {"content": [text(str(e))], "isError": True}
        except Exception:
            log(traceback.format_exc())
            return {"content": [text("Something went wrong inside the SO-101 MCP server (details are in its log on stderr). Try again; if it keeps happening, run so101_diagnostics and report that.")], "isError": True}

    # -------- the loop
    @staticmethod
    def _rid(msg: Any) -> Any:
        """The request id when it is a valid one (a string or a number), else None."""
        rid = msg.get("id") if isinstance(msg, dict) else None
        return rid if isinstance(rid, (int, float, str)) and not isinstance(rid, bool) else None

    def _answer(self, msg: Any) -> None:
        rid = self._rid(msg)
        if rid is None or rid not in self._cancelled:                           # a request the client cancelled is not even started
            resp = self.dispatch(msg)
            if resp is not None and (rid is None or rid not in self._cancelled):
                self.send(resp)
        self._cancelled.discard(rid)
        self._inflight.discard(rid)

    def _work(self) -> None:
        """Tool calls run one after another in arrival order (a teach followed by an undo must not swap places)."""
        while True:
            msg = self._queue.get()
            if msg is None:
                return
            self._answer(msg)

    def _start(self, target: Callable, *args: Any) -> None:
        th = threading.Thread(target=target, args=args, daemon=True)
        self._threads.append(th)
        th.start()

    def handle_line(self, line: str) -> None:
        try:
            msg = json.loads(line)
        except ValueError:
            self.send(self._error(None, PARSE_ERROR, "Parse error: that line is not valid JSON."))
            return
        if isinstance(msg, list):                                              # a batch (only the older protocol versions allow it)
            replies = [r for r in (self.dispatch(m) for m in msg) if r is not None]
            if not msg:
                self.send(self._error(None, INVALID_REQUEST, "Invalid Request: an empty batch."))
            elif replies:
                self.send(replies)
            return
        rid = self._rid(msg)
        if isinstance(msg, dict) and msg.get("method") == "tools/call" and rid is not None:
            self._inflight.add(rid)
            params = msg.get("params")
            if isinstance(params, dict) and params.get("name") == "so101_stop":
                self._start(self._answer, msg)                                  # stop never waits behind a slow call (a test movement takes seconds)
            else:
                self._queue.put(msg)
        else:
            self._answer(msg)

    def serve(self, stdin, drain_s: float = 30.0) -> None:
        worker = threading.Thread(target=self._work, daemon=True)
        worker.start()
        while not self.closed:
            line = stdin.readline()
            if not line:
                break
            line = line.strip()
            if line:
                self.handle_line(line)
        self._queue.put(None)                                                   # let the queued calls finish, then stop the worker
        deadline = time.time() + drain_s
        for th in [worker] + self._threads:
            th.join(max(0.0, deadline - time.time()))


def serve(url: str = DEFAULT_URL, allow_motion: bool = False, stdin=None, stdout=None, drain_s: float = 30.0) -> int:
    """Run the server until stdin closes. With no streams given it uses the real stdin/stdout (and moves every stray print to stderr)."""
    try:
        app = App(url, allow_motion)
    except ValueError as e:
        log(str(e))
        return 2
    real_stdout = sys.stdout
    own_in, own_out = stdin is None, stdout is None
    if own_out:
        stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", newline="\n", write_through=True)
        sys.stdout = sys.stderr                                              # anything that prints by accident goes to stderr, never into the protocol
    if own_in:
        stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace", newline="\n")
    log(f"version {__version__}, talking to {app.base}, motion tools {'ON' if allow_motion else 'off'}. Waiting for an MCP client on stdin.")
    try:
        Server(app, stdout).serve(stdin, drain_s)
    except KeyboardInterrupt:
        pass
    finally:
        for wrapper, own in ((stdout, own_out), (stdin, own_in)):
            if own:
                try:
                    if wrapper is stdout:
                        wrapper.flush()
                    wrapper.detach()                                         # let go without closing the process's real stdin/stdout
                except Exception:
                    pass
        sys.stdout = real_stdout
    return 0


def run(url: str, allow_motion: bool = False) -> int:
    return serve(url, allow_motion)


def add_arguments(p: argparse.ArgumentParser) -> None:
    p.add_argument("--url", default=os.environ.get("SO101_URL") or DEFAULT_URL, help="where the SO-101 app runs (default %(default)s; the environment variable SO101_URL also works)")
    p.add_argument("--allow-motion", action="store_true", help="also offer the tools that can move an arm (wiggle a motor, lower the arm and make it limp, guided calibration). Off by default.")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m so101.mcp", description="MCP server for the SO-101 app (stdio).")
    add_arguments(ap)
    a = ap.parse_args(argv)
    return run(a.url, a.allow_motion)


if __name__ == "__main__":
    sys.exit(main())
