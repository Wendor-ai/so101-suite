from so101 import platform_info as pi


def files(mapping):
    def read(path):
        if path in mapping:
            return mapping[path]
        raise FileNotFoundError(path)
    return read


def which_none(_):
    return None


def test_macos_arm64():
    info = pi.detect(system="Darwin", machine="arm64", read_file=files({}), which=lambda n: "/opt/homebrew/bin/uv" if n == "uv" else None, version="15.1")
    assert info.os == "macos" and info.arch == "arm64" and info.is_pi is False
    assert info.os_version == "15.1"
    assert info.uv is True
    assert info.in_dialout is None                       # no such thing on a Mac
    assert "/dev/tty.usbmodem*" in info.serial_examples
    assert info.camera_backend == "AVFoundation"


def test_raspberry_pi_5():
    model = "Raspberry Pi 5 Model B Rev 1.0\x00"
    info = pi.detect(system="Linux", machine="aarch64",
                     read_file=files({"/proc/device-tree/model": model, "/etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n'}),
                     which=which_none, groups=["pi", "dialout", "video"])
    assert info.os == "linux" and info.is_pi is True
    assert info.pi_model == "Raspberry Pi 5 Model B Rev 1.0"
    assert info.os_version == "Debian GNU/Linux 12 (bookworm)"
    assert info.in_dialout is True
    assert info.uv is False
    assert info.camera_backend == "V4L2"
    assert any("Raspberry Pi" in n for n in info.notes)


def test_linux_user_missing_dialout():
    info = pi.detect(system="Linux", machine="x86_64", read_file=files({}), which=which_none, groups=["alice", "sudo"])
    assert info.in_dialout is False
    assert info.is_pi is False and info.pi_model is None
    assert "/dev/ttyACM*" in info.serial_examples


def test_linux_arch_uucp_counts_as_serial_group():
    info = pi.detect(system="Linux", machine="x86_64", read_file=files({}), which=which_none, groups=["alice", "uucp"])
    assert info.in_dialout is True


def test_windows():
    info = pi.detect(system="Windows", machine="AMD64", read_file=files({}), which=which_none, version="10.0.22631")
    assert info.os == "windows"
    assert info.in_dialout is None
    assert info.serial_examples == ["COM3"]
    assert info.camera_backend.startswith("DirectShow")
    assert info.arch == "AMD64"


def test_parse_pi_model():
    assert pi.parse_pi_model("Raspberry Pi 4 Model B Rev 1.5\x00") == "Raspberry Pi 4 Model B Rev 1.5"
    assert pi.parse_pi_model("Some Other Board") is None
    assert pi.parse_pi_model("") is None
    assert pi.parse_pi_model(None) is None


def test_serial_examples():
    assert pi.serial_examples("macos") == ["/dev/tty.usbmodem*", "/dev/tty.wchusbserial*"]
    assert pi.serial_examples("linux") == ["/dev/ttyACM*", "/dev/ttyUSB*"]
    assert pi.serial_examples("windows") == ["COM3"]


def test_to_dict_has_spec_fields():
    d = pi.detect(system="Linux", machine="x86_64", read_file=files({}), which=which_none, groups=[]).to_dict()
    for k in ("os", "os_version", "arch", "is_pi", "pi_model", "python", "uv", "in_dialout", "serial_examples", "camera_backend", "notes"):
        assert k in d
    assert d["python"].count(".") >= 1


def test_real_detect_runs_here():
    info = pi.detect()
    assert info.os in ("macos", "linux", "windows")
