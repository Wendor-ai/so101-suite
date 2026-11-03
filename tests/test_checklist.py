import json
import pathlib

import pytest

from so101 import checklist

CASES = json.loads((pathlib.Path(__file__).parent / "checklist_cases.json").read_text())


def by_id(res):
    return {i["id"]: i for i in res["items"]}


def test_there_are_enough_shared_cases():
    assert len(CASES) >= 10
    names = {c["name"] for c in CASES}
    for needed in ("nothing_connected", "linux_user_not_in_dialout", "follower_with_four_of_six_motors", "follower_ok_uncalibrated",
                   "everything_ok", "camera_found_but_not_working", "camera_mapped", "assembly_ticked_nothing_else", "windows_everything_ok"):
        assert needed in names


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_case(case):
    res = checklist.build(case["snapshot"])
    got = by_id(res)
    assert res["summary"]["next"] == case["expect"]["next"]
    for id_, status in case["expect"]["statuses"].items():
        assert got[id_]["status"] == status, f"{id_}: {got[id_]}"


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shape_and_every_open_item_has_a_sentence_and_a_fix(case):
    res = checklist.build(case["snapshot"])
    assert [i["id"] for i in res["items"]] == checklist.ORDER
    for it in res["items"]:
        assert it["group"] in ("computer", "arms", "cameras", "calibration", "extras")
        assert it["status"] in ("ok", "todo", "warn", "fail", "skip")
        assert isinstance(it["detail"], str) and len(it["detail"]) > 10
        if it["status"] in ("todo", "warn", "fail"):
            assert it["fix"] and it["fix"]["page"] in ("assemble", "motors", "calibrate", "cameras", "setup") and it["fix"]["label"]
    s = res["summary"]
    assert s["ok"] == sum(1 for i in res["items"] if i["status"] == "ok")
    assert s["total"] == sum(1 for i in res["items"] if i["status"] != "skip")


def case(name):
    return next(c for c in CASES if c["name"] == name)["snapshot"]


def test_nothing_connected_next_is_adapter():
    assert checklist.build(case("nothing_connected"))["summary"]["next"] == "adapter_found"


def test_linux_not_in_dialout_has_exact_fix():
    it = by_id(checklist.build(case("linux_user_not_in_dialout")))["serial_permission"]
    assert it["status"] == "fail" and "sudo usermod -aG dialout $USER" in it["detail"]


def test_follower_with_four_of_six_motors_names_missing_ids():
    it = by_id(checklist.build(case("follower_with_four_of_six_motors")))["follower_motors"]
    assert it["status"] == "fail" and "5, 6" in it["detail"] and "4 of 6" in it["detail"]
    assert it["fix"]["page"] == "motors"


def test_leader_is_optional():
    got = by_id(checklist.build(case("leader_optional_absent_and_cameras_skipped")))
    assert [got[i]["status"] for i in ("leader_connected", "leader_motors", "leader_calibrated")] == ["skip"] * 3


def test_all_ok_next_is_none():
    res = checklist.build(case("everything_ok"))
    assert res["summary"]["next"] is None and res["summary"]["ok"] == res["summary"]["total"]


def test_missing_keys_are_tolerated():
    assert checklist.build({})["summary"]["next"] in ("python", "adapter_found")
    assert checklist.build(None)["items"]


def test_camera_error_text_is_shown():
    it = by_id(checklist.build(case("camera_found_but_not_working")))["camera_working"]
    assert "in use by another app" in it["detail"]
