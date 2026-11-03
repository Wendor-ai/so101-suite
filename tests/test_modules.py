import json
import pathlib

from so101 import modules, paths



def make(tmp_path, name, manifest=None, backend=None, raw=None):
    d = tmp_path / name
    d.mkdir()
    if raw is not None:
        (d / "module.json").write_text(raw)
    elif manifest is not None:
        (d / "module.json").write_text(json.dumps(manifest))
    if backend is not None:
        (d / "backend.py").write_text(backend)
    return d


def test_discovers_hello():
    mods = {m.id: m for m in modules.discover(paths.MODULES_DIR)}
    hello = mods["hello"]
    assert hello.error is None and hello.enabled and hello.backend == "backend.py"
    assert hello.pages[0]["script"] == "ui.js"
    assert hello.to_dict()["path"] == "modules/hello"


def test_bad_manifest_listed_with_error(tmp_path):
    make(tmp_path, "broken", raw="{ nope")
    make(tmp_path, "nofile")
    make(tmp_path, "good", {"id": "good", "name": "Good"})
    mods = {m.id: m for m in modules.discover(tmp_path)}
    assert mods["broken"].error and "JSON" in mods["broken"].error
    assert mods["nofile"].error and "module.json" in mods["nofile"].error
    assert mods["good"].error is None


def test_backend_exception_is_500_json_not_crash(tmp_path):
    make(tmp_path, "boom", {"id": "boom", "backend": "backend.py"}, "def handle(method, path, body, ctx):\n    raise ValueError('kaboom')\n")
    m = modules.discover(tmp_path)[0]
    status, payload = modules.dispatch(m, "GET", "x", {}, object())
    assert status == 500 and "kaboom" in payload["error"] and payload["module"] == "boom"


def test_backend_wrong_return_type_is_500(tmp_path):
    make(tmp_path, "odd", {"id": "odd", "backend": "backend.py"}, "def handle(method, path, body, ctx):\n    return 'nope'\n")
    assert modules.dispatch(modules.discover(tmp_path)[0], "GET", "", {}, None)[0] == 500


def test_syntax_error_in_backend_is_500(tmp_path):
    make(tmp_path, "syn", {"id": "syn", "backend": "backend.py"}, "def handle(:\n")
    assert modules.dispatch(modules.discover(tmp_path)[0], "GET", "", {}, None)[0] == 500


def test_id_validation(tmp_path):
    for i, bad in enumerate(["Hello", "1abc", "a", "has-dash", "x" * 40, "../etc", "ok space"]):
        d = tmp_path / f"d{i}"
        d.mkdir()
        (d / "module.json").write_text(json.dumps({"id": bad}))
    for m in modules.discover(tmp_path):
        assert m.error and "not allowed" in m.error, m
    assert modules.ID_RE.match("hello") and modules.ID_RE.match("my_mod_2")


def test_folder_must_match_id(tmp_path):
    make(tmp_path, "folder_a", {"id": "folder_b"})
    assert "must match" in modules.discover(tmp_path)[0].error


def test_dispatch_hello_backend():
    hello = next(m for m in modules.discover(paths.MODULES_DIR) if m.id == "hello")

    class Ctx:
        arms, demo = {}, True
    status, payload = modules.dispatch(hello, "POST", "greet", {"name": "Ada"}, Ctx())
    assert status == 200 and payload["message"] == "Hello, Ada!"
    assert modules.dispatch(hello, "GET", "nope", {}, Ctx())[0] == 404


def test_disabled_and_broken_modules_do_not_run(tmp_path):
    make(tmp_path, "off", {"id": "off", "backend": "backend.py"}, "def handle(m, p, b, c):\n    return 200, {}\n")
    m = modules.discover(tmp_path, disabled=["off"])[0]
    assert m.enabled is False and modules.dispatch(m, "GET", "", {}, None)[0] == 403
    broken = modules.discover(make(tmp_path, "x", raw="[").parent)[-1]
    assert modules.dispatch(broken, "GET", "", {}, None)[0] == 503


def test_ui_file_serving_rules(tmp_path):
    d = make(tmp_path, "uimod", {"id": "uimod"})
    for name in ("ui.js", "style.css", "data.json", "a.svg", "b.png", "secret.py", "notes.md"):
        (d / name).write_text("x")
    (d / "sub").mkdir()
    (d / "sub" / "deep.js").write_text("x")
    (tmp_path / "outside.js").write_text("x")
    ok = lambda rel: modules.ui_file(tmp_path, "uimod", rel)
    assert ok("ui.js") and ok("style.css") and ok("data.json") and ok("a.svg") and ok("b.png") and ok("sub/deep.js")
    assert ok("secret.py") is None and ok("notes.md") is None and ok("missing.js") is None
    assert ok("../outside.js") is None and ok("sub/../../outside.js") is None and ok("%2e%2e/outside.js") is None and ok(".hidden.js") is None
    assert modules.ui_file(tmp_path, "../x", "ui.js") is None and modules.ui_file(tmp_path, "Bad", "ui.js") is None
