import json

from so101 import paths
from so101.store import Store


def test_set_get_dotted(tmp_path):
    s = Store(tmp_path / "c.json")
    s.set("ui.theme", "dark")
    s.set("ui.onboarded", True)
    s.set("cameras.list", [{"id": "a"}])
    assert s.get("ui.theme") == "dark"
    assert s.get("ui") == {"theme": "dark", "onboarded": True}
    assert s.get("missing.key", 5) == 5
    assert s.get("ui.theme.deeper", "d") == "d"          # a string has no children: default, not a crash
    assert s.all()["cameras"]["list"] == [{"id": "a"}]


def test_survives_restart(tmp_path):
    p = tmp_path / "c.json"
    Store(p).set("progress.assembly_done", True)
    assert Store(p).get("progress.assembly_done") is True


def test_corrupt_file_is_quarantined(tmp_path):
    p = tmp_path / "config.json"
    p.write_text("{ this is not json")
    s = Store(p)
    assert s.all() == {}
    assert (tmp_path / "config.json.bad").read_text() == "{ this is not json"
    s.set("a", 1)                                        # and the store works again
    assert json.loads(p.read_text()) == {"a": 1}


def test_atomic_write_leaves_no_temp_files(tmp_path):
    d = tmp_path / "data"
    s = Store(d / "c.json")
    for i in range(5):
        s.set("n", i)
    assert [f.name for f in d.iterdir()] == ["c.json"]


def test_non_object_json_is_quarantined(tmp_path):
    p = tmp_path / "c.json"
    p.write_text("[1, 2]")
    assert Store(p).all() == {}
    assert (tmp_path / "c.json.bad").exists()


def test_delete_and_update(tmp_path):
    s = Store(tmp_path / "c.json")
    s.update({"ui": {"theme": "dark"}, "adv": {"x": 1}})
    s.update({"ui": {"accent": "blue"}})
    assert s.get("ui") == {"theme": "dark", "accent": "blue"}
    s.delete("ui.theme")
    assert s.get("ui") == {"accent": "blue"}


def test_data_dir_honours_env_and_is_created(isolated_home):
    d = paths.data_dir()
    assert d == isolated_home / ".so101" and d.is_dir()


def test_repo_paths_exist():
    assert paths.APP_DIR.is_dir() and paths.REPO_ROOT.is_dir()
    assert paths.SUITE_DIR == paths.APP_DIR / "suite"
    assert paths.MODULES_DIR == paths.REPO_ROOT / "modules"


def test_tilde_hides_home(isolated_home):
    assert paths.tilde(isolated_home / "x" / "y.json") == "~/x/y.json" or paths.tilde(isolated_home / "x" / "y.json").startswith("~")
    assert str(isolated_home) not in paths.tilde(isolated_home / "x")
