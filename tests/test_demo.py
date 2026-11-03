import os
import pathlib
import sys

import pytest

from so101 import demo, ports


@pytest.fixture()
def bus():
    demo.install()
    fake_t = [1000.0]
    real_clock = demo.clock
    demo.clock = lambda: fake_t[0]
    demo.reset()
    import scservo_sdk as sdk
    ph = sdk.PortHandler(demo.FOLLOWER)
    assert ph.openPort() and ph.setBaudRate(1000000)
    yield sdk, ph, sdk.PacketHandler(0), fake_t
    demo.clock = real_clock
    demo.uninstall()


def test_demo_ports_only():
    demo.install()
    try:
        got = ports.list_ports(lister=lambda: [type("P", (), {"device": "/dev/ttyACM0", "description": "", "vid": 0x1a86, "pid": 1, "serial_number": "REAL", "manufacturer": None, "location": None})()],
                               platform_os="linux")
        assert [p.path for p in got] == ["demo://follower", "demo://leader"]       # the real lister was never even consulted
        assert all(p.likely_servo_board and p.serial for p in got)
    finally:
        demo.uninstall()
    assert ports.list_ports(lister=lambda: [], platform_os="linux") == []


def test_fake_sdk_replaces_the_real_one_and_never_opens_a_device():
    demo.install()
    try:
        import scservo_sdk as sdk
        assert getattr(sdk, "IS_DEMO", False)
        assert sdk.PortHandler("/dev/ttyACM0").openPort() is False                 # a real path simply does not exist in the demo
        assert sdk.PortHandler("demo://nope").openPort() is False
    finally:
        demo.uninstall()
    assert "IS_DEMO" not in dir(sys.modules.get("scservo_sdk", object))


def test_ping_and_read_position(bus):
    sdk, ph, pk, _ = bus
    for i in range(1, 7):
        model, result, _err = pk.ping(ph, i)
        assert result == 0 and model == 777
    assert pk.ping(ph, 7)[1] != 0
    pos, result, _ = pk.read2ByteTxRx(ph, 1, 56)
    assert result == 0 and 1900 < pos < 2200
    assert pk.read1ByteTxRx(ph, 1, 40)[0] == 0                                     # torque off at start


def test_torque_off_hand_moves_joint(bus):
    sdk, ph, pk, t = bus
    pk.write1ByteTxRx(ph, 1, 55, 0)
    pk.write2ByteTxRx(ph, 1, 31, 20)                 # any homing offset = "calibrated": the simulated hand starts moving the limp arm
    seen = []
    for k in range(30):
        t[0] += 0.1                                  # the hand works on joint 1 during the first 4 s
        seen.append(pk.read2ByteTxRx(ph, 1, 56)[0])
    assert max(seen) - min(seen) > 500
    # ... and while it is another joint's turn, joint 1 holds still
    t[0] += 4.0
    a = pk.read2ByteTxRx(ph, 1, 56)[0]
    t[0] += 0.5
    assert abs(pk.read2ByteTxRx(ph, 1, 56)[0] - a) < 5


def test_uncalibrated_limp_arm_sits_still(bus):
    sdk, ph, pk, t = bus
    a = pk.read2ByteTxRx(ph, 2, 56)[0]
    t[0] += 3.3
    assert pk.read2ByteTxRx(ph, 2, 56)[0] == a


def test_torque_on_follows_goal(bus):
    sdk, ph, pk, t = bus
    cur = pk.read2ByteTxRx(ph, 3, 56)[0]
    pk.write2ByteTxRx(ph, 3, 46, 900)
    pk.write2ByteTxRx(ph, 3, 42, cur)
    pk.write1ByteTxRx(ph, 3, 40, 1)
    pk.write2ByteTxRx(ph, 3, 42, cur + 300)
    t[0] += 0.1
    mid = pk.read2ByteTxRx(ph, 3, 56)[0]
    assert cur < mid < cur + 300                     # slewing at 900 ticks/s, not jumping
    t[0] += 1.0
    assert pk.read2ByteTxRx(ph, 3, 56)[0] == cur + 300
    assert pk.read1ByteTxRx(ph, 3, 40)[0] == 1


def test_goal_is_clamped_to_the_limits(bus):
    sdk, ph, pk, t = bus
    pk.write1ByteTxRx(ph, 2, 55, 0)
    pk.write2ByteTxRx(ph, 2, 9, 1500); pk.write2ByteTxRx(ph, 2, 11, 2500)
    pk.write1ByteTxRx(ph, 2, 55, 1)
    pk.write1ByteTxRx(ph, 2, 40, 1)
    pk.write2ByteTxRx(ph, 2, 42, 4000)
    t[0] += 5
    assert pk.read2ByteTxRx(ph, 2, 56)[0] == 2500


def test_connect_subset_changes_ping(bus):
    sdk, ph, pk, _ = bus
    assert demo.connect(demo.FOLLOWER, [1, 2, 3, 4]) == [1, 2, 3, 4]
    assert pk.ping(ph, 4)[1] == 0 and pk.ping(ph, 5)[1] != 0 and pk.ping(ph, 6)[1] != 0
    demo.connect(demo.FOLLOWER, [1, 2, 3, 4, 5, 6])
    assert pk.ping(ph, 6)[1] == 0


def test_eeprom_writes_need_the_unlock(bus):
    sdk, ph, pk, _ = bus
    demo.connect(demo.FOLLOWER, [1])
    pk.write1ByteTxRx(ph, 1, 5, 6)                    # locked: ignored
    assert pk.ping(ph, 1)[1] == 0 and pk.ping(ph, 6)[1] != 0
    pk.write1ByteTxRx(ph, 1, 55, 0)
    pk.write1ByteTxRx(ph, 1, 5, 6)                    # unlocked: the motor now answers as ID 6
    assert pk.ping(ph, 1)[1] != 0 and pk.ping(ph, 6)[1] == 0
    assert pk.write1ByteTxRx(ph, 1, 55, 1)[0] != 0    # the old ID no longer hears the lock write: it must use the NEW id
    assert pk.write1ByteTxRx(ph, 6, 55, 1)[0] == 0


def test_baud_register_changes_what_answers(bus):
    sdk, ph, pk, _ = bus
    demo.connect(demo.FOLLOWER, [1])
    pk.write1ByteTxRx(ph, 1, 55, 0)
    pk.write1ByteTxRx(ph, 1, 6, 1)                    # 500000
    assert pk.ping(ph, 1)[1] != 0                     # nobody answers at 1 Mbps any more
    assert ph.setBaudRate(500000) and pk.ping(ph, 1)[1] == 0
    assert ph.setBaudRate(76800) is False             # like the real SDK


def test_unplugged_adapter_cannot_be_opened_and_is_not_listed(bus):
    sdk, ph, pk, _ = bus
    demo.set_port_present(demo.LEADER, False)
    assert [p.path for p in ports.list_ports()] == [demo.FOLLOWER]
    assert sdk.PortHandler(demo.LEADER).openPort() is False
    demo.set_port_present(demo.LEADER, True)
    assert sdk.PortHandler(demo.LEADER).openPort() is True


def test_unplugging_the_usb_cable_raises_like_a_real_serial_port(bus):
    sdk, ph, pk, _ = bus
    demo.set_port_present(demo.FOLLOWER, False)
    with pytest.raises(OSError):
        pk.read2ByteTxRx(ph, 1, 56)


def test_install_sandboxes_home_and_uninstall_restores_it(tmp_path, monkeypatch):
    import os
    monkeypatch.setenv("HOME", str(tmp_path / "realhome"))
    monkeypatch.setenv("SO101_HOME", str(tmp_path / "realhome" / ".so101"))
    demo.install()
    try:
        assert os.environ["HOME"].endswith("demo/home")
        assert os.environ["SO101_HOME"].endswith("demo/home/.so101")
    finally:
        demo.uninstall()
    assert os.environ["HOME"] == str(tmp_path / "realhome")
    assert os.environ["SO101_HOME"] == str(tmp_path / "realhome" / ".so101")


def test_load_voltage_temperature_are_plausible(bus):
    sdk, ph, pk, _ = bus
    assert 30 <= pk.read1ByteTxRx(ph, 1, 63)[0] <= 40
    assert pk.read1ByteTxRx(ph, 1, 62)[0] in range(50, 130)
    assert pk.read2ByteTxRx(ph, 1, 60)[0] & 1023 < 100


def test_frame_is_a_640x480_picture_with_a_red_keychain():
    f = demo.frame(0, 1.0)
    assert f.shape == (480, 640, 3) and f.dtype.name == "uint8"
    import numpy as np
    import vision
    found = vision.detect(f)
    assert found, "the demo keychain should be found by the real detector"
    assert not np.array_equal(demo.frame(0, 1.0), demo.frame(0, 9.0))
    assert not np.array_equal(demo.frame(0, 1.0), demo.frame(1, 1.0))


def test_list_cameras_marks_in_use():
    demo.install()
    try:
        cams = demo.list_cameras(in_use=["demo://camera/0"])
        assert [c.in_use for c in cams] == [True, False, False]
    finally:
        demo.uninstall()


def test_a_demo_that_restarts_itself_keeps_its_sandbox(tmp_path, monkeypatch):
    """Restarting inside the demo sandbox used to nest a second, empty sandbox (calibration and added cameras vanished)."""
    sandbox = tmp_path / "demo" / "home" / ".so101"
    sandbox.mkdir(parents=True)
    (sandbox / "marker.txt").write_text("kept")
    monkeypatch.setenv("SO101_HOME", str(sandbox))
    demo._sandbox(fresh=False)
    assert pathlib.Path(os.environ["SO101_HOME"]) == sandbox and (sandbox / "marker.txt").read_text() == "kept"
    assert not (sandbox / "demo").exists()                                                          # nothing nested inside it
