import importlib
import json

from so101 import defaults, paths
from so101.store import Store


def test_defaults_file_is_valid_and_documented():
    d = defaults.defaults()
    for section in ("serial", "calibration", "safety", "cameras", "server", "ui"):
        assert isinstance(d[section]["_doc"], str) and len(d[section]["_doc"]) > 20, section
    assert d["serial"]["motor_ids"] == {"shoulder_pan": 1, "shoulder_lift": 2, "elbow_flex": 3, "wrist_flex": 4, "wrist_roll": 5, "gripper": 6}
    assert d["serial"]["scan_baud_rates"] == [1000000, 500000, 250000, 128000, 115200, 76800, 57600, 38400]
    assert d["server"]["port"] == 8000 and d["ui"]["onboarded"] is False and d["ui"]["calibrationPrompted"] is False
    assert d["cameras"] == {**d["cameras"], "width": 640, "height": 480, "fps": 30, "fourcc": "MJPG", "jpeg_quality": 75, "stale_after_s": 2.5}


def test_no_personal_calibration_numbers_ship_as_defaults():
    text = json.dumps(defaults.defaults())
    for forbidden in ("homing", "range_min", "range_max", "z_table", "1837", "3298"):   # one arm's numbers: every arm differs
        assert forbidden not in text


def test_load_merges_user_overrides(tmp_path):
    s = Store(tmp_path / "c.json")
    s.set("ui.theme", "dark")
    s.set("cameras.list", [{"id": "a"}])
    s.set("unrelated.x", 1)
    eff = defaults.load(s)
    assert eff["ui"]["theme"] == "dark" and eff["ui"]["accent"] == "orange"      # override + untouched default
    assert eff["cameras"]["width"] == 640 and eff["cameras"]["list"] == [{"id": "a"}]
    assert "unrelated" not in eff
    assert defaults.defaults()["ui"]["theme"] == "auto"                         # defaults themselves are never mutated


def test_get_dotted():
    assert defaults.get("safety.load_limit_pct") == 70
    assert defaults.get("nope.nothing", default=3) == 3


def test_defaults_equal_the_legacy_constants(isolated_home):
    """The dashboard hard-codes these. If someone changes one side, this fails."""
    server = importlib.import_module("server")
    d = defaults.defaults()
    assert server.MID == d["calibration"]["mid_ticks"]
    assert server.MIN_SPAN == d["calibration"]["min_span_ticks"]
    assert {v: k for k, v in server.JOINTS.items()} == d["serial"]["motor_ids"]
    assert server.CALIB_DIRS["follower"][1] == d["calibration"]["follower_id"]
    assert server.CALIB_DIRS["leader"][1] == d["calibration"]["leader_id"]
    t = server.Teleop
    hz = d["safety"]["teleop_hz"]                                                    # the server counts the slew in ticks per SECOND, the defaults per step
    assert t.HZ == hz and t.SLEW_PS == d["safety"]["teleop_slew_ticks"] * hz and t.SLEW_SYNC_PS == d["safety"]["teleop_slew_sync_ticks"] * hz
    assert t.LOAD_LIMIT == d["safety"]["load_limit_pct"] * 10                      # the dashboard counts in 0.1% units
    pp = importlib.import_module("pickplace")
    assert pp.LOAD_LIMIT == d["safety"]["load_limit_pct"] * 10 and pp.TEMP_LIMIT == d["safety"]["temp_limit_c"]
    src = (paths.APP_DIR / "server.py").read_text()                                 # two guards are literals inside Teleop._session
    assert f"({d['safety']['wrist_roll_load_limit_pct'] * 10} if i == 5" in src
    assert f"t >= {d['safety']['temp_limit_c']}" in src
