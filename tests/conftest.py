"""Shared test setup. Tests never touch the real home folder and never open a real serial device."""
import os
import sys
import pathlib

import pytest

os.environ["SO101_NO_DOTENV"] = "1"       # set before anything imports so101: a developer's real .env (ports, camera addresses) never reaches a test
os.environ["SO101_NO_STATE_CACHE"] = "1"  # /api/state is rebuilt on every request in tests (tests/test_state_cache.py turns the 120 ms cache back on)

ROOT = pathlib.Path(__file__).resolve().parent.parent
for p in (str(ROOT), str(ROOT / "app"), str(ROOT / "tests")):
    if p not in sys.path:
        sys.path.insert(0, p)


@pytest.fixture(scope="session", autouse=True)
def _session_home(tmp_path_factory):
    """Even module-scoped fixtures (a demo server) run with a private HOME: nothing ever touches the owner's files."""
    mp = pytest.MonkeyPatch()
    home = tmp_path_factory.mktemp("session_home")
    for k, v in (("HOME", home), ("USERPROFILE", home), ("SO101_HOME", home / ".so101"), ("HF_LEROBOT_CALIBRATION", home / "calibration")):
        mp.setenv(k, str(v))
    mp.delenv("SO101_DEMO", raising=False)
    mp.setenv("SO101_NO_REAL_PORTS", "1")     # enforced in app/server.py: no real serial device is ever scanned or opened by a test
    yield
    mp.undo()


@pytest.fixture(autouse=True)
def isolated_home(tmp_path_factory, monkeypatch):
    """Every test gets its own SO101_HOME and HOME so nothing can read or write the owner's files."""
    home = tmp_path_factory.mktemp("home")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("SO101_HOME", str(home / ".so101"))
    monkeypatch.setenv("HF_LEROBOT_CALIBRATION", str(home / "calibration"))
    monkeypatch.delenv("SO101_DEMO", raising=False)
    monkeypatch.delenv("CAMERA_URL", raising=False)
    monkeypatch.delenv("CAMERA_INDEX", raising=False)
    return home


@pytest.fixture(scope="module")
def srv():
    """One real demo server per test module (simulated arms and cameras, ephemeral port, never a real device)."""
    from helpers import start_demo_server, stop_demo_server
    s = start_demo_server()
    yield s
    stop_demo_server(s)
