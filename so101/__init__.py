"""SO-101 Suite: detection, configuration, checklist, modules, demo bus, HTTP API and CLI for the SO-101 robot arm."""
import os as _os
_os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")     # OpenCV prints scary warnings while we look for cameras; real errors still show
from . import envfile as _envfile                        # noqa: E402  (a .env file fills in settings before anything reads the environment)
_envfile.load()
__version__ = "0.1.0"
LICENSE_ID = "AGPL-3.0-or-later"
REPO_URL = "https://github.com/Wendor-ai/so101-suite"
