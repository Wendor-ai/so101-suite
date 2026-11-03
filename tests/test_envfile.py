"""The .env reader: settings stay out of the repo, the real environment wins, demo mode and tests never read a real file."""
import os
import subprocess
import sys

import pytest

from so101 import envfile

REAL_ROOT = envfile.REPO_ROOT


@pytest.fixture(autouse=True)
def no_repo_env(monkeypatch, tmp_path_factory):
    """A developer's real .env in the repo folder must not change what these tests see."""
    monkeypatch.setattr(envfile, "REPO_ROOT", tmp_path_factory.mktemp("repo"))


def test_parse_understands_the_usual_forms():
    text = "\n".join([
        "# a comment", "", "PLAIN=value", "export EXPORTED=yes", "SPACED = padded value  ",
        "DOUBLE=\"two words # not a comment\"", "SINGLE='$NOT_EXPANDED'", "TRAILING=abc # a comment", "EMPTY=",
        "BASE=alpha", "USES=${BASE}/beta and $BASE", "FROM_ENV=$OUTSIDE", "not a setting", "1BAD=x", "UNCLOSED=\"oops",
    ])
    got = envfile.parse(text, {"OUTSIDE": "env-value"})
    assert got == {"PLAIN": "value", "EXPORTED": "yes", "SPACED": "padded value", "DOUBLE": "two words # not a comment", "SINGLE": "$NOT_EXPANDED",
                   "TRAILING": "abc", "EMPTY": "", "BASE": "alpha", "USES": "alpha/beta and alpha", "FROM_ENV": "env-value"}


def test_unknown_variables_expand_to_nothing_not_to_an_error():
    assert envfile.parse("A=$NOPE-x") == {"A": "-x"}


def test_load_never_replaces_the_real_environment(tmp_path):
    f = tmp_path / "my.env"
    f.write_text("FOLLOWER_ID=from_file\nCAMERA_INDEX=2\n")
    env = {"SO101_ENV_FILE": str(f), "SO101_HOME": str(tmp_path / "none"), "FOLLOWER_ID": "from_shell"}
    added = envfile.load(env, argv=["so101", "start"])
    assert env["FOLLOWER_ID"] == "from_shell" and env["CAMERA_INDEX"] == "2" and added == ["CAMERA_INDEX"]


def test_earlier_files_win_over_later_ones(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    (home / ".env").write_text("A=home\nB=home\n")
    explicit = tmp_path / "explicit.env"
    explicit.write_text("A=explicit\n")
    env = {"SO101_ENV_FILE": str(explicit), "SO101_HOME": str(home)}
    envfile.load(env, argv=["so101", "start"])
    assert env["A"] == "explicit" and env["B"] == "home"


def test_a_missing_or_unreadable_file_is_not_an_error(tmp_path):
    env = {"SO101_ENV_FILE": str(tmp_path / "missing.env"), "SO101_HOME": str(tmp_path / "none")}
    assert envfile.load(env, argv=["so101", "start"]) == []
    bad = tmp_path / "binary.env"
    bad.write_bytes(b"\xff\xfe\x00A=1")
    assert envfile.collect({"SO101_ENV_FILE": str(bad), "SO101_HOME": str(tmp_path / "none")}) == {}      # not UTF-8: skipped, not fatal


@pytest.mark.parametrize("argv, extra", [(["so101", "start", "--demo"], {}), (["so101", "demo"], {}), (["so101", "start"], {"SO101_DEMO": "1"}),
                                         (["so101", "start"], {"SO101_NO_DOTENV": "1"})])
def test_demo_mode_and_tests_never_read_a_real_file(tmp_path, argv, extra):
    f = tmp_path / "real.env"
    f.write_text("CAMERA_URL=http://192.168.1.99:8000/raw.mjpg\n")
    env = {"SO101_ENV_FILE": str(f), "SO101_HOME": str(tmp_path / "none"), **extra}
    assert envfile.load(env, argv=argv) == [] and "CAMERA_URL" not in env


def test_the_test_suite_itself_runs_with_dotenv_switched_off():
    assert os.environ.get("SO101_NO_DOTENV") == "1"


@pytest.mark.skipif(sys.platform == "win32", reason="the shell scripts need bash")
def test_shell_output_is_quoted_so_a_value_cannot_run_code(tmp_path):
    f = tmp_path / "x.env"
    f.write_text("SAFE=a b\nTRICKY=$(touch pwned); `touch pwned2` 'q'\n")
    env = {**os.environ, "SO101_ENV_FILE": str(f), "SO101_HOME": str(tmp_path / "none"), "SO101_NO_DOTENV": "0"}
    out = subprocess.run([sys.executable, "-c", "import sys; from so101.cli import main; sys.exit(main(['env', '--shell']))"], capture_output=True, text=True, env=env, cwd=tmp_path,
                         timeout=60, check=True).stdout
    check = subprocess.run(["bash", "-c", out + '\nprintf "%s|%s" "$SAFE" "$TRICKY"'], capture_output=True, text=True, cwd=tmp_path, timeout=30, check=True).stdout
    assert check.startswith("a b|") and "touch pwned" in check
    assert not (tmp_path / "pwned").exists() and not (tmp_path / "pwned2").exists()


def test_the_example_file_sets_nothing_until_you_edit_it():
    assert envfile.parse((REAL_ROOT / ".env.example").read_text()) == {}
