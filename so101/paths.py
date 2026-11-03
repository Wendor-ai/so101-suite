"""Where things live: the repo, the app folders and the user's data folder."""
import os
import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
APP_DIR = REPO_ROOT / "app"
SUITE_DIR = APP_DIR / "suite"
MODULES_DIR = REPO_ROOT / "modules"
DEFAULTS_FILE = REPO_ROOT / "defaults" / "so101.defaults.json"


def data_dir() -> pathlib.Path:
    """The user's config folder: ~/.so101 (override with SO101_HOME). Created on first use."""
    d = pathlib.Path(os.environ.get("SO101_HOME") or "~/.so101").expanduser()
    d.mkdir(parents=True, exist_ok=True)
    return d


def tilde(p) -> str:
    """A path with the home folder replaced by '~' (for anything that may be pasted into a bug report)."""
    s = str(p)
    home = str(pathlib.Path("~").expanduser())
    if home and home != "~" and s.startswith(home):
        return "~" + s[len(home):]
    return s
