from types import SimpleNamespace as NS

from so101 import ports


def lp(device, vid=None, pid=None, serial=None, desc="n/a", manufacturer=None, location=None):
    return NS(device=device, description=desc, vid=vid, pid=pid, serial_number=serial, manufacturer=manufacturer, location=location)


def lister_of(*items):
    return lambda: list(items)


def test_mac_filters_cu_and_bluetooth():
    items = [lp("/dev/cu.usbmodemTESTSERIAL0011", 0x1a86, 0x55d3, "TESTSERIAL001"),
             lp("/dev/tty.usbmodemTESTSERIAL0011", 0x1a86, 0x55d3, "TESTSERIAL001"),
             lp("/dev/cu.Bluetooth-Incoming-Port"), lp("/dev/tty.Bluetooth-Incoming-Port"),
             lp("/dev/cu.debug-console"), lp("/dev/tty.debug-console")]
    got = ports.list_ports(lister=lister_of(*items), platform_os="macos")
    assert [p.path for p in got] == ["/dev/tty.usbmodemTESTSERIAL0011"]     # tty, one entry, no cu, no Bluetooth/debug
    assert got[0].likely_servo_board is True


def test_mac_cu_only_lister_is_mapped_to_tty():
    # pyserial on macOS reports the /dev/cu.* callout device; the app opens the /dev/tty.* one (as the legacy dashboard does)
    got = ports.list_ports(lister=lister_of(lp("/dev/cu.wchusbserialTESTSERIAL0021", 0x1a86, 0x7523, "TESTSERIAL002")), platform_os="macos")
    assert [p.path for p in got] == ["/dev/tty.wchusbserialTESTSERIAL0021"]


def test_linux_acm_listed_ttyS_dropped():
    items = [lp("/dev/ttyACM0", 0x1a86, 0x55d3, "A1"), lp("/dev/ttyS0"), lp("/dev/ttyS1"), lp("/dev/ttyAMA0"),
             lp("/dev/ttyUSB0", 0x10c4, 0xea60, "B2")]
    got = ports.list_ports(lister=lister_of(*items), platform_os="linux")
    assert [p.path for p in got] == ["/dev/ttyACM0", "/dev/ttyUSB0"]


def test_linux_keeps_acm_without_vid():
    got = ports.list_ports(lister=lister_of(lp("/dev/ttyACM1")), platform_os="linux")
    assert [p.path for p in got] == ["/dev/ttyACM1"]


def test_windows_com_ports():
    items = [lp("COM3", 0x1a86, 0x55d3, "W1", desc="USB-Enhanced-SERIAL CH343 (COM3)"),
             lp("COM4", desc="Standard Serial over Bluetooth link (COM4)"),
             lp("COM11", 0x0403, 0x6001, "FT1", desc="USB Serial Port (COM11)")]
    got = ports.list_ports(lister=lister_of(*items), platform_os="windows")
    assert [p.path for p in got] == ["COM3", "COM11"]
    assert all(p.likely_servo_board for p in got)


def test_key_uses_serial_when_present():
    p = ports.PortInfo(path="/dev/ttyACM0", description="", vid=0x1a86, pid=0x55d3, serial="ABC123", manufacturer=None, location="1-2")
    assert ports.port_key(p) == "ABC123"


def test_key_falls_back_to_vid_pid_location_then_path():
    p = ports.PortInfo(path="/dev/ttyUSB0", description="", vid=0x1a86, pid=0x7523, serial=None, manufacturer=None, location="1-2.3")
    assert ports.port_key(p) == "1a86:7523@1-2.3"
    q = ports.PortInfo(path="/dev/ttyUSB0", description="", vid=None, pid=None, serial=None, manufacturer=None, location=None)
    assert ports.port_key(q) == "/dev/ttyUSB0"


def test_key_stable_when_acm_order_swaps():
    boot1 = [lp("/dev/ttyACM0", 0x1a86, 0x55d3, "FOLLOWER-SN"), lp("/dev/ttyACM1", 0x1a86, 0x55d3, "LEADER-SN")]
    boot2 = [lp("/dev/ttyACM0", 0x1a86, 0x55d3, "LEADER-SN"), lp("/dev/ttyACM1", 0x1a86, 0x55d3, "FOLLOWER-SN")]
    k1 = {p.path: p.key for p in ports.list_ports(lister=lister_of(*boot1), platform_os="linux")}
    k2 = {p.path: p.key for p in ports.list_ports(lister=lister_of(*boot2), platform_os="linux")}
    assert k1["/dev/ttyACM0"] == k2["/dev/ttyACM1"] == "FOLLOWER-SN"
    assert k1["/dev/ttyACM1"] == k2["/dev/ttyACM0"] == "LEADER-SN"
    assert ports.key_for_path("/dev/ttyACM1", lister=lister_of(*boot2), platform_os="linux") == "FOLLOWER-SN"


def test_duplicate_serials_get_the_location_added():
    items = [lp("/dev/ttyUSB0", 0x1a86, 0x7523, "0001", location="1-1"), lp("/dev/ttyUSB1", 0x1a86, 0x7523, "0001", location="1-2")]
    keys = [p.key for p in ports.list_ports(lister=lister_of(*items), platform_os="linux")]
    assert len(set(keys)) == 2


def test_diff_ports():
    assert ports.diff_ports({"a", "b"}, {"b", "c"}) == ({"a"}, {"c"})
    assert ports.diff_ports({"a"}, {"a"}) == (set(), set())


def test_likely_servo_board():
    assert ports.likely_servo_board(0x1a86, 0x55d3) and ports.likely_servo_board(0x10c4, 0xea60) and ports.likely_servo_board(0x0403, 0x6001)
    assert not ports.likely_servo_board(0x2341, 0x0043) and not ports.likely_servo_board(None, None)


def test_lister_errors_do_not_crash():
    def boom():
        raise OSError("no serial subsystem")
    assert ports.list_ports(lister=boom, platform_os="linux") == []


def test_redact_hides_serials_in_paths():
    assert ports.redact_port_path("/dev/tty.wchusbserialTESTSERIAL0011") == "/dev/tty.wchusbserial*"
    assert ports.redact_port_path("/dev/ttyACM0") == "/dev/ttyACM0"
    assert ports.redact_port_path("COM3") == "COM3"


def test_to_dict_fields():
    d = ports.PortInfo(path="/dev/ttyACM0", description="d", vid=1, pid=2, serial="s", manufacturer="m", location="1-1").to_dict()
    for k in ("path", "description", "vid", "pid", "serial", "manufacturer", "likely_servo_board", "role", "owned_by_app", "key"):
        assert k in d
