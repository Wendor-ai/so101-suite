"""/api/state is heavy to build, so the server serves one copy to every caller for up to 120 ms. A write must never be hidden by that copy.

The rest of the suite runs with the cache switched off (SO101_NO_STATE_CACHE, see conftest.py) because tests change state in-process and read it straight back."""
import pytest


@pytest.fixture(autouse=True)
def cache_on(srv):
    old = srv.server.STATE_TTL
    srv.server.STATE_TTL = 5.0                # long enough that nothing in this file can outlive it by accident
    srv.server.STATE_CACHE[0] = 0.0
    yield
    srv.server.STATE_TTL = old
    srv.server.STATE_CACHE[0] = 0.0


def test_two_reads_inside_the_window_share_one_copy(srv):
    first = srv.get("/api/state").json
    srv.server.PP.status = "a status that was set after the first read"
    assert srv.get("/api/state").json["pp"]["status"] == first["pp"]["status"]


def test_a_write_clears_the_copy_so_the_next_read_sees_it(srv, tmp_path, monkeypatch):
    monkeypatch.setattr(srv.server, "VIZ_FILE", tmp_path / "viz.json")      # never the real file
    srv.get("/api/state")
    srv.post("/api/viz", {"joint": "elbow_flex", "offset": 12.5})
    assert srv.get("/api/state").json["viz"]["offset"]["elbow_flex"] == 12.5


def test_a_stale_copy_is_rebuilt_once_the_window_has_passed(srv):
    srv.get("/api/state")
    srv.server.PP.status = "set after the copy was made"
    srv.server.STATE_CACHE[0] -= 10.0         # pretend the copy is 10 s old
    assert srv.get("/api/state").json["pp"]["status"] == "set after the copy was made"
