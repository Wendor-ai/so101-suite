"""The "what's connected / what's left" checklist: a pure function from a plain-JSON snapshot to a list of items.

This file is the single source of truth. app/suite/js/mock/ ports it to JavaScript and must pass the SAME cases
(tests/checklist_cases.json), so keep the snapshot simple JSON and keep the rules below easy to port.

SNAPSHOT (every key is optional; a missing key means "nothing / unknown / false")
    {
      "platform": {"os": "linux"|"macos"|"windows", "python": "3.12.4", "uv": true, "in_dialout": true|false|null},
      "ports":    [{"path": "/dev/ttyACM0", "likely_servo_board": true, "role": "follower"|"leader"|null}],
      "arms":     {"follower": null | ARM, "leader": null | ARM},
      "cameras":  {"detected": 0, "configured": [{"ok": true, "calibrated": false, "err": ""}]},
      "progress": {"assembly.done": false, "cameras.skipped": false}     (the old spellings assembly_done / cameras_skipped are accepted too)
    }
    ARM = {"port": "...", "online": true, "motor_ids": [1,2,3,4,5,6], "calibrated": false, "err": "", "role_confirmed": true}
    role_confirmed false = the app only GUESSED which arm this is (missing counts as true, so old snapshots keep working)
    "detected" = cameras found but not yet added. A null arm means the app has no arm for that role (not connected / not found).

OUTPUT
    {"items": [CheckItem], "summary": {"ok": n, "total": n, "next": id|null}}
    CheckItem = {"id", "group": "computer"|"arms"|"cameras"|"calibration"|"extras", "title" (a state: "Follower calibrated"), "action" (what to do: "Calibrate the follower arm"; use it for headings and the Next step),
                 "status": "ok"|"todo"|"warn"|"fail"|"skip", "detail": sentence, "fix": null | {"label", "page"}}
    page is one of assemble|motors|calibrate|cameras|setup. Every todo/warn/fail item has a detail and a fix; skip items may have fix null.
    summary.total counts items that are not "skip"; summary.next is the id of the first item that is neither "ok" nor "skip".

RULES, in item order
    python               fail if major.minor < 3.10, else ok
    uv                   ok if installed, else skip (the app runs without it)
    serial_permission    in_dialout false -> fail with the exact command; true -> ok; null -> skip (macOS/Windows)
    adapter_found        ok if there is at least one port, else todo
    arm_roles            an online arm whose role the app only guessed -> todo ("tell the app which arm is which"); all confirmed -> ok; no online arm -> skip
    follower_connected   arm online -> ok; arm present but offline -> fail; no arm but a port exists -> todo ("not connected yet"); nothing -> todo
    follower_motors      online and IDs 1-6 all answer -> ok; online with missing IDs -> fail naming them; otherwise todo
    follower_calibrated  arm.calibrated -> ok; connected and not calibrated -> todo; not connected -> todo
    leader_*             same three rules, but no arm at all -> skip (a leader is optional); an arm that is present follows the follower rules
    camera_found         configured + detected >= 1 -> ok, else todo; skip when progress "cameras.skipped" and nothing is configured
    camera_working       any configured camera ok -> ok; configured but none ok -> fail with its err; only detected -> todo; none -> todo
    camera_mapped        any configured camera calibrated -> ok, else todo (same skip rule as camera_found)
    assembly_done        progress "assembly.done" -> ok; or the follower answers with all six motors (inferred) -> ok; else todo
"""
import re
from typing import Optional

IDS = [1, 2, 3, 4, 5, 6]
ORDER = ["python", "uv", "serial_permission", "adapter_found", "arm_roles", "follower_connected", "follower_motors", "follower_calibrated",
         "leader_connected", "leader_motors", "leader_calibrated", "camera_found", "camera_working", "camera_mapped", "assembly_done"]
GROUPS = {"python": "computer", "uv": "computer", "serial_permission": "computer", "adapter_found": "arms", "arm_roles": "arms",
          "follower_connected": "arms", "follower_motors": "arms", "follower_calibrated": "calibration",
          "leader_connected": "arms", "leader_motors": "arms", "leader_calibrated": "calibration",
          "camera_found": "cameras", "camera_working": "cameras", "camera_mapped": "cameras", "assembly_done": "extras"}
TITLES = {"python": "Python 3.10 or newer", "uv": "uv installed", "serial_permission": "Permission to use serial ports",
          "adapter_found": "USB adapter found", "arm_roles": "Leader and follower named", "follower_connected": "Follower arm connected",
          "follower_motors": "Follower motors answer (IDs 1-6)", "follower_calibrated": "Follower calibrated",
          "leader_connected": "Leader arm connected (optional)", "leader_motors": "Leader motors answer (IDs 1-6)",
          "leader_calibrated": "Leader calibrated", "camera_found": "Camera found", "camera_working": "Camera shows a picture",
          "camera_mapped": "Camera mapped to the table", "assembly_done": "Arm assembled"}
ACTIONS = {"python": "Install a newer Python",
           "uv": "Install uv",
           "serial_permission": "Allow serial ports",
           "adapter_found": "Plug in the USB adapter",
           "arm_roles": "Tell the app which arm is which",
           "follower_connected": "Connect the follower arm",
           "follower_motors": "Fix the follower motors", "follower_calibrated": "Calibrate the follower arm", "leader_connected": "Connect the leader arm", "leader_motors": "Fix the leader motors", "leader_calibrated": "Calibrate the leader arm", "camera_found": "Add a camera", "camera_working": "Get a camera picture", "camera_mapped": "Map the camera to the table", "assembly_done": "Build the arm"}
FIX_SETUP = {"label": "How to connect", "page": "setup"}


def _fix(label, page):
    return {"label": label, "page": page}


def _get(d, *path, default=None):
    for p in path:
        if not isinstance(d, dict) or p not in d or d[p] is None:
            return default
        d = d[p]
    return d


def _version(v) -> tuple:
    nums = re.findall(r"\d+", str(v or ""))
    return (int(nums[0]) if nums else 0, int(nums[1]) if len(nums) > 1 else 0)


def _ids_text(ids) -> str:
    return ", ".join(str(i) for i in ids)


def build(snap: dict) -> dict:
    snap = snap or {}
    plat, ports = _get(snap, "platform", default={}), _get(snap, "ports", default=[])
    arms = _get(snap, "arms", default={})
    follower, leader = arms.get("follower"), arms.get("leader")
    cams = _get(snap, "cameras", "configured", default=[])
    detected = int(_get(snap, "cameras", "detected", default=0) or 0)
    progress = _get(snap, "progress", default={})
    assembly_ticked = bool(progress.get("assembly.done") or progress.get("assembly_done"))
    cameras_skipped = bool(progress.get("cameras.skipped") or progress.get("cameras_skipped"))
    res = {}

    def put(id_, status, detail, fix=None):
        res[id_] = {"id": id_, "group": GROUPS[id_], "title": TITLES[id_], "action": ACTIONS[id_], "status": status, "detail": detail, "fix": fix}

    # --- computer ---
    py = str(plat.get("python") or "")
    if _version(py) >= (3, 10):
        put("python", "ok", f"Python {py} is fine.")
    else:
        put("python", "fail", f"Python {py or '(unknown)'} is too old: this app needs Python 3.10 or newer. Run the setup script again, it installs a suitable Python for you.",
            _fix("Run setup again", "setup"))
    if plat.get("uv"):
        put("uv", "ok", "uv is installed. It keeps the app and its Python up to date.")
    else:
        put("uv", "skip", "uv is not installed. The app runs without it; install it later if you want easy updates.")
    dialout = plat.get("in_dialout")
    if dialout is False:
        put("serial_permission", "fail", "Linux does not let your user open serial ports yet. Run this once in a terminal, then log out and log back in: sudo usermod -aG dialout $USER",
            _fix("Show me how", "setup"))
    elif dialout is True:
        put("serial_permission", "ok", "Your user is allowed to use serial ports.")
    else:
        put("serial_permission", "skip", "Nothing to set up: this computer lets you use serial ports without extra permission.")

    # --- adapter ---
    n = len(ports)
    if n:
        likely = sum(1 for p in ports if p.get("likely_servo_board"))
        extra = "" if likely else " None of them looks like the usual servo adapter, but if your arm answers below that is fine."
        put("adapter_found", "ok", f"{n} USB serial adapter{'s' if n != 1 else ''} found.{extra}")
    else:
        put("adapter_found", "todo", "No USB adapter found yet. Plug the USB cable from the motor controller board into this computer, and plug the board's power supply into the wall.",
            FIX_SETUP)

    # --- are the roles confirmed? (a wrong guess would save a calibration in the wrong place) ---
    guessed = [(r, a) for r, a in (("follower", follower), ("leader", leader)) if a and a.get("online") and a.get("role_confirmed") is False]
    if guessed:
        r, a = guessed[0]
        put("arm_roles", "todo", f"The app guessed that the arm on {a.get('port') or 'this USB port'} is the {r} arm. Tell it which arm is which, so each calibration is saved in the right place.",
            _fix("Tell the app", "motors"))
    elif any(a and a.get("online") for a in (follower, leader)):
        put("arm_roles", "ok", "You told the app which arm is the leader and which is the follower.")
    else:
        put("arm_roles", "skip", "Nothing to name yet: no arm is connected.")

    # --- arms ---
    def arm_items(role, arm, optional):
        name = role.capitalize()
        cid, mid, cal = f"{role}_connected", f"{role}_motors", f"{role}_calibrated"
        if arm is None and optional:
            put(cid, "skip", "Optional. A leader arm lets you move the follower by hand. Skip this if you only have one arm.")
            put(mid, "skip", "Only needed when a leader arm is connected.")
            put(cal, "skip", "Only needed when a leader arm is connected.")
            return
        online = bool(arm and arm.get("online"))
        ids = sorted(set(int(i) for i in (arm or {}).get("motor_ids") or []))
        if online:
            put(cid, "ok", f"The {role} arm is connected.")
        elif arm is not None:
            why = f" ({arm['err']})" if arm.get("err") else ""
            put(cid, "fail", f"The adapter is plugged in but no motor answers{why}. Check that the board's power supply is plugged in and that every 3-pin cable is clicked in all the way.",
                _fix("Check the motors", "motors"))
        elif n:
            put(cid, "todo", f"An adapter is plugged in, but the app is not talking to the {role} arm through it yet. Give it a few seconds; if this stays, check the board's power supply and the cables.",
                _fix("Check the motors", "motors"))
        else:
            put(cid, "todo", f"Plug in the {role} arm first: USB cable from its controller board to this computer, and the board's power supply.", FIX_SETUP)
        if online:
            missing = [i for i in IDS if i not in ids]
            if not missing:
                put(mid, "ok", f"All six {role} motors answer (IDs 1 to 6).")
            else:
                put(mid, "fail", f"{len(ids)} of 6 {role} motors answer. Missing IDs: {_ids_text(missing)}. Check the cable going to those motors, or give a new motor its ID in Motor IDs.",
                    _fix("Set motor IDs", "motors"))
        else:
            put(mid, "todo", f"Waiting for the {role} arm to connect first.", FIX_SETUP if not n else _fix("Check the motors", "motors"))
        if arm and arm.get("calibrated"):
            put(cal, "ok", f"The {role} arm is calibrated: 0 is the middle of each joint's range.")
        elif online:
            put(cal, "todo", f"The {role} arm is not calibrated yet. Calibration teaches the arm where the middle of each joint is, and it takes about two minutes.",
                _fix("Calibrate", "calibrate"))
        else:
            put(cal, "todo", f"Connect the {role} arm first, then calibrate it.", FIX_SETUP if not n else _fix("Check the motors", "motors"))

    arm_items("follower", follower, False)
    arm_items("leader", leader, True)

    # --- cameras ---
    skipped = cameras_skipped and not cams
    if skipped:
        for cid in ("camera_found", "camera_working", "camera_mapped"):
            put(cid, "skip", "You chose to skip cameras. They are only needed for pick & place.")
    else:
        if cams or detected:
            put("camera_found", "ok", f"{len(cams) + detected} camera{'s' if len(cams) + detected != 1 else ''} found.")
        else:
            put("camera_found", "todo", "No camera found. Plug in a USB camera, or add a network camera (for example one on a Raspberry Pi). Cameras are only needed for pick & place.",
                _fix("Add a camera", "cameras"))
        working = [c for c in cams if c.get("ok")]
        if working:
            put("camera_working", "ok", "A camera is delivering pictures.")
        elif cams:
            err = next((c.get("err") for c in cams if c.get("err")), "") or "no picture yet"
            put("camera_working", "fail", f"The camera is added but shows no picture: {err}.", _fix("Fix the camera", "cameras"))
        elif detected:
            put("camera_working", "todo", "A camera was found but it is not added yet. Add it to see its picture.", _fix("Add the camera", "cameras"))
        else:
            put("camera_working", "todo", "Waiting for a camera to be found.", _fix("Add a camera", "cameras"))
        if any(c.get("calibrated") for c in cams):
            put("camera_mapped", "ok", "A camera is mapped to the table, so the arm can reach what the camera sees.")
        elif working:
            put("camera_mapped", "todo", "Teach the camera where the table is by clicking on its picture. Pick & place needs this.", _fix("Map the camera", "cameras"))
        else:
            put("camera_mapped", "todo", "Needs a working camera first.", _fix("Add a camera", "cameras"))

    # --- assembly ---
    if assembly_ticked:
        put("assembly_done", "ok", "You marked the arm as built.")
    elif follower and follower.get("online") and all(i in set(follower.get("motor_ids") or []) for i in IDS):
        put("assembly_done", "ok", "All six motors answer, so the arm is built.")
    else:
        put("assembly_done", "todo", "Build the arm with the assembly guide, then tick it off. Skip this if your arm is already built.", _fix("Open the assembly guide", "assemble"))

    items = [res[i] for i in ORDER]
    nxt: Optional[str] = next((it["id"] for it in items if it["status"] not in ("ok", "skip")), None)
    return {"items": items, "summary": {"ok": sum(1 for it in items if it["status"] == "ok"),
                                         "total": sum(1 for it in items if it["status"] != "skip"), "next": nxt}}
