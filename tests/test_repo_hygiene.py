"""Nothing private may ever be committed to this public repo.

This fails when a tracked file is a secret file or one of the owner's private lab files, or when a tracked text file carries a value that looks
personal (a real home-network address, someone's e-mail, a real USB serial number, a home folder, a token). Placeholders used in the docs and
tests are listed below on purpose: add to the lists only for an obviously fake value."""
import pathlib
import re
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent

FORBIDDEN_PATHS = [
    r"(^|/)\.env($|\.(?!example$))", r"^config\.sh$", r"(^|/)\.so101/",
    r"^calibration/(state[^/]*|samples)/", r"^calibration/[^/]+\.json$", r"^calibration/.*\.(jpg|jpeg|png)$",
    r"^docs/(photos/|HISTORY\.md$|USER_RULES\.md$|SETUP\.md$|superpowers/)", r"^analysis/", r"^app/deferred/", r"^tests/frames/",
    r"(^|/)\.(cloudflare|wrangler)/", r"^env/", r"^yolo/", r"^scripts/setup_linux\.sh$", r"^tests/test_(teleop|teleop_map|camera_gate)\.py$",
    r"\.(pem|key|p12|pfx|keystore)$", r"(^|/)id_(rsa|ed25519|ecdsa)(\.pub)?$",
]

SKIP_CONTENT = re.compile(r"(^app/vendor/|^uv\.lock$|pnpm-lock\.yaml$|package-lock\.json$|\.stl$|\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|pdf)$|^LICENSE$|^tests/test_repo_hygiene\.py$)")

PLACEHOLDER_IPS = {"192.168.1.20", "192.168.1.50", "192.168.1.77", "192.168.1.99"}
PLACEHOLDER_HOMES = {"demo", "you", "user", "username", "yourname", "name", "runner", ".so101"}
SECRETS = re.compile(r"\b(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{32,}|hf_[A-Za-z0-9]{30,}"
                     r"|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)")
PRIVATE_IP = re.compile(r"(?<![\d.])(192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?![\d])")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
OK_EMAIL_DOMAINS = ("example.com", "example.org", "users.noreply.github.com", "anthropic.com")
HOME_DIR = re.compile(r"/(?:Users|home)/([A-Za-z0-9._<>-]+)")
USB_SERIAL = re.compile(r"(?:usbmodem|wchusbserial|usbserial-?)([0-9A-Za-z]{6,})")
FAKE_SERIAL = re.compile(r"^(?:X+|0+|5A0+1|TESTSERIAL\d+|[A-Z]*SERIAL\d*)$")


def tracked():
    try:
        out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("not a git checkout")
    return [f for f in out.decode("utf-8", "surrogateescape").split("\0") if f]


def test_no_private_or_secret_file_is_tracked():
    bad = [f for f in tracked() if any(re.search(p, f) for p in FORBIDDEN_PATHS)]
    assert not bad, "private or secret files are tracked (move them to .gitignore and `git rm --cached` them): " + ", ".join(bad)


def test_the_example_env_file_is_the_only_env_file_tracked():
    assert [f for f in tracked() if re.search(r"(^|/)\.env", f)] == [".env.example"]


def test_no_tracked_text_file_carries_a_private_looking_value():
    problems = []
    for f in tracked():
        if SKIP_CONTENT.search(f):
            continue
        try:
            text = (ROOT / f).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for n, line in enumerate(text.splitlines(), 1):
            where = f"{f}:{n}"
            if SECRETS.search(line):
                problems.append(f"{where}: looks like a key or token")
            problems += [f"{where}: home-network address {m.group(0)}" for m in PRIVATE_IP.finditer(line) if m.group(0) not in PLACEHOLDER_IPS]
            problems += [f"{where}: e-mail address {m.group(0)}" for m in EMAIL.finditer(line) if not m.group(0).lower().endswith(OK_EMAIL_DOMAINS)]
            problems += [f"{where}: home folder of {m.group(1)}" for m in HOME_DIR.finditer(line) if m.group(1) not in PLACEHOLDER_HOMES]
            problems += [f"{where}: USB serial number {m.group(1)}" for m in USB_SERIAL.finditer(line) if not FAKE_SERIAL.match(m.group(1))]
    assert not problems, "private-looking values in tracked files (use a placeholder, or put the real value in .env):\n" + "\n".join(problems[:40])
