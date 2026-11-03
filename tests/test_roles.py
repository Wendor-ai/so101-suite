import json
from types import SimpleNamespace as NS

from so101 import roles


def lister(*serials_by_path):
    return lambda: [NS(device=p, description="", vid=0x1a86, pid=0x55d3, serial_number=s, manufacturer=None, location=None) for p, s in serials_by_path]


def test_first_adapter_is_follower_second_is_leader(tmp_path):
    f = tmp_path / "roles.json"
    ls = lister(("/dev/ttyACM0", "SN-A"), ("/dev/ttyACM1", "SN-B"))
    assert roles.role_for(f, "/dev/ttyACM0", lister=ls, platform_os="linux") == "follower"
    assert roles.role_for(f, "/dev/ttyACM1", lister=ls, platform_os="linux") == "leader"
    saved = json.loads(f.read_text())
    assert {k: v for k, v in saved.items() if k != roles.CONFIRMED} == {"SN-A": "follower", "SN-B": "leader"}          # keyed by the adapter, not the path
    assert roles.CONFIRMED not in saved                                                                                    # a first-seen guess is NOT confirmed


def test_roles_survive_the_adapters_swapping_paths(tmp_path):
    f = tmp_path / "roles.json"
    boot1 = lister(("/dev/ttyACM0", "SN-A"), ("/dev/ttyACM1", "SN-B"))
    boot2 = lister(("/dev/ttyACM0", "SN-B"), ("/dev/ttyACM1", "SN-A"))
    roles.role_for(f, "/dev/ttyACM0", lister=boot1, platform_os="linux")
    roles.role_for(f, "/dev/ttyACM1", lister=boot1, platform_os="linux")
    assert roles.role_for(f, "/dev/ttyACM0", lister=boot2, platform_os="linux") == "leader"     # SN-B is the leader wherever it shows up
    assert roles.role_for(f, "/dev/ttyACM1", lister=boot2, platform_os="linux") == "follower"


def test_legacy_path_keys_are_migrated_on_read(tmp_path):
    f = tmp_path / "roles.json"
    f.write_text(json.dumps({"/dev/tty.wchusbserialTESTSERIAL0011": "follower", "/dev/tty.wchusbserialTESTSERIAL0021": "leader"}))
    ls = lister(("/dev/cu.wchusbserialTESTSERIAL0011", "TESTSERIAL001"), ("/dev/cu.wchusbserialTESTSERIAL0021", "TESTSERIAL002"))
    assert roles.role_for(f, "/dev/tty.wchusbserialTESTSERIAL0021", lister=ls, platform_os="macos") == "leader"
    assert roles.role_for(f, "/dev/tty.wchusbserialTESTSERIAL0011", lister=ls, platform_os="macos") == "follower"
    saved = json.loads(f.read_text())
    assert saved == {"TESTSERIAL001": "follower", "TESTSERIAL002": "leader"}


def test_set_to_rebinds(tmp_path):
    f = tmp_path / "roles.json"
    ls = lister(("/dev/ttyACM0", "SN-A"))
    assert roles.role_for(f, "/dev/ttyACM0", lister=ls, platform_os="linux") == "follower"
    assert roles.role_for(f, "/dev/ttyACM0", "leader", lister=ls, platform_os="linux") == "leader"


def test_assign_swaps_the_other_holder(tmp_path):
    f = tmp_path / "roles.json"
    f.write_text(json.dumps({"A": "follower", "B": "leader"}))
    out = roles.assign(f, "B", "follower", other_keys=["A", "B"])
    assert {k: v for k, v in out.items() if k != roles.CONFIRMED} == {"A": "leader", "B": "follower"}


def test_a_guessed_role_is_not_confirmed_until_the_person_sets_it(tmp_path):
    f = tmp_path / "roles.json"
    ls = lister(("/dev/ttyACM0", "SN-A"))
    assert roles.role_for(f, "/dev/ttyACM0", lister=ls, platform_os="linux") == "follower"          # the app guessed
    assert roles.is_confirmed(f, "SN-A", "/dev/ttyACM0") is False                                   # ...so it must still ask (the Pi's only arm was really the LEADER)
    roles.role_for(f, "/dev/ttyACM0", "leader", lister=ls, platform_os="linux")                       # the person says so
    assert roles.is_confirmed(f, "SN-A", "/dev/ttyACM0") is True and roles.lookup(f, "SN-A") == "leader"


def test_naming_one_arm_confirms_the_other_by_elimination(tmp_path):
    f = tmp_path / "roles.json"
    f.write_text(json.dumps({"A": "follower", "B": "leader"}))
    assert roles.is_confirmed(f, "A") is False and roles.is_confirmed(f, "B") is False
    roles.assign(f, "A", "leader", other_keys=["A", "B"])
    assert roles.is_confirmed(f, "A") is True and roles.is_confirmed(f, "B") is True


def test_lookup_is_a_pure_read(tmp_path):
    f = tmp_path / "roles.json"
    assert roles.lookup(f, "X") is None and not f.exists()
    f.write_text(json.dumps({"/dev/ttyACM0": "leader"}))
    assert roles.lookup(f, "SN", "/dev/ttyACM0") == "leader"
