"""Drop-in modules: a folder in modules/ with a module.json, and optionally a backend.py and a UI script.

    modules/<id>/module.json   {id, name, description, version, author, license, requires:[...], pages:[{id,title,icon,script}], backend:"backend.py"|null}
    modules/<id>/backend.py    def handle(method, path, body, ctx) -> (status:int, payload)      (reached at /api/m/<id>/<path>)
    modules/<id>/ui.js         ES module for a page; served at /suite/modules/<id>/ui.js

A broken module is listed with `error` set and never stops the app."""
import dataclasses
import importlib.util
import json
import pathlib
import re
import sys
import threading
import traceback
from typing import List, Optional, Tuple

ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,31}$")
UI_EXTENSIONS = {".js", ".css", ".json", ".svg", ".png"}
_FILE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]*$")
_backends = {}
_backend_lock = threading.Lock()


@dataclasses.dataclass
class Module:
    id: str
    name: str = ""
    description: str = ""
    version: str = "0.0.0"
    author: str = ""
    license: str = ""
    requires: list = dataclasses.field(default_factory=list)
    pages: list = dataclasses.field(default_factory=list)
    backend: Optional[str] = None
    path: Optional[pathlib.Path] = None
    error: Optional[str] = None
    enabled: bool = True

    def to_dict(self) -> dict:
        d = dataclasses.asdict(self)
        d["path"] = f"modules/{self.path.name}" if self.path else None        # never an absolute path
        return d


def _bad(path: pathlib.Path, msg: str, **kw) -> Module:
    mid = path.name if ID_RE.match(path.name) else re.sub(r"[^a-z0-9_]", "_", path.name.lower())[:32] or "unknown"
    return Module(id=mid, name=kw.get("name") or path.name, path=path, error=msg, enabled=False)


def load_manifest(path: pathlib.Path) -> Module:
    mf = path / "module.json"
    if not mf.is_file():
        return _bad(path, "This folder has no module.json, so it is not a module yet.")
    try:
        d = json.loads(mf.read_text())
    except ValueError as e:
        return _bad(path, f"module.json is not valid JSON ({str(e)[:80]}).")
    if not isinstance(d, dict):
        return _bad(path, "module.json must contain one JSON object.")
    mid = d.get("id")
    if not isinstance(mid, str) or not ID_RE.match(mid):
        return _bad(path, f"The module id {mid!r} is not allowed: use lowercase letters, digits and underscores, starting with a letter (2 to 32 characters).", name=d.get("name"))
    if mid != path.name:
        return _bad(path, f"The folder name '{path.name}' must match the module id '{mid}'.", name=d.get("name"))
    backend, pages = d.get("backend"), d.get("pages") or []
    if backend is not None and (not isinstance(backend, str) or not _FILE_RE.match(backend) or not backend.endswith(".py") or not (path / backend).is_file()):
        return _bad(path, f"The backend file {backend!r} is missing or not a .py file in the module folder.", name=d.get("name"))
    if not isinstance(pages, list) or any(not isinstance(p, dict) or not isinstance(p.get("id"), str) or not isinstance(p.get("script"), str) or not _FILE_RE.match(p["script"]) for p in pages):
        return _bad(path, "pages must be a list of {id, title, icon, script} with a plain file name as script.", name=d.get("name"))
    return Module(id=mid, name=str(d.get("name") or mid), description=str(d.get("description") or ""), version=str(d.get("version") or "0.0.0"),
                  author=str(d.get("author") or ""), license=str(d.get("license") or ""), requires=list(d.get("requires") or []),
                  pages=[{"id": p["id"], "title": str(p.get("title") or p["id"]), "icon": str(p.get("icon") or ""), "script": p["script"]} for p in pages],
                  backend=backend, path=path)


def discover(modules_dir, disabled=()) -> List[Module]:
    modules_dir = pathlib.Path(modules_dir)
    out: List[Module] = []
    if not modules_dir.is_dir():
        return out
    for sub in sorted(modules_dir.iterdir()):
        if not sub.is_dir() or sub.name.startswith((".", "_")):
            continue
        try:
            m = load_manifest(sub)
        except Exception as e:                                           # nothing a module author does may stop the app
            m = _bad(sub, f"Could not read this module: {type(e).__name__}.")
        if m.id in disabled and not m.error:
            m.enabled = False
        out.append(m)
    return out


def _load_backend(m: Module):
    with _backend_lock:
        key = (m.id, str(m.path))
        if key not in _backends:
            spec = importlib.util.spec_from_file_location(f"so101_module_{m.id}", m.path / m.backend)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _backends[key] = mod
        return _backends[key]


def dispatch(module: Module, method: str, rest: str, body, ctx) -> Tuple[int, object]:
    """Run the module's backend. Always returns (status, JSON-able payload); a crash is a 500 with a sentence, never an exception."""
    if module.error:
        return 503, {"error": f"The module '{module.id}' can't run: {module.error}", "module": module.id}
    if not module.enabled:
        return 403, {"error": f"The module '{module.id}' is turned off. Turn it on in Settings, Advanced.", "module": module.id}
    if not module.backend:
        return 404, {"error": f"The module '{module.id}' has no backend.", "module": module.id}
    try:
        mod = _load_backend(module)
        res = mod.handle(method, rest, body if body is not None else {}, ctx)
        if not (isinstance(res, (tuple, list)) and len(res) == 2 and isinstance(res[0], int)):
            return 500, {"error": f"The module '{module.id}' returned something other than (status, payload).", "module": module.id}
        return int(res[0]), res[1]
    except Exception as e:
        print(f"[module {module.id}] {traceback.format_exc()}", file=sys.stderr)
        return 500, {"error": f"The module '{module.id}' had an error: {type(e).__name__}: {str(e)[:160]}", "module": module.id}


def ui_file(modules_dir, mid: str, rel: str) -> Optional[pathlib.Path]:
    """The file for GET /suite/modules/<id>/<rel>, or None. Only .js .css .json .svg .png inside the module's folder, no traversal."""
    if not ID_RE.match(mid or ""):
        return None
    parts = [p for p in (rel or "").split("/") if p != ""]
    if not parts or any(p in (".", "..") or p.startswith(".") or not _FILE_RE.match(p) for p in parts):
        return None
    base = (pathlib.Path(modules_dir) / mid).resolve()
    f = (base / "/".join(parts)).resolve()
    try:
        f.relative_to(base)
    except ValueError:
        return None
    return f if f.is_file() and f.suffix.lower() in UI_EXTENSIONS else None
