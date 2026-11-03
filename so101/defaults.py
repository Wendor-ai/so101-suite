"""Factory defaults (defaults/so101.defaults.json) and the effective values: defaults deep-merged with the user's own changes.

The legacy dashboard (app/server.py) keeps its own constants; tests/test_defaults.py asserts both agree so they cannot drift."""
import copy
import json
from typing import Any

from . import paths

_cache = None


def defaults() -> dict:
    """The defaults file as a dict (a fresh copy each time)."""
    global _cache
    if _cache is None:
        _cache = json.loads(paths.DEFAULTS_FILE.read_text())
    return copy.deepcopy(_cache)


def _merge(base: dict, over: dict) -> dict:
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = copy.deepcopy(v)
    return base


def load(store=None) -> dict:
    """Effective configuration: the defaults plus the user's overrides of the same sections from the Store (if given)."""
    eff = defaults()
    if store is not None:
        mine = store.all()
        _merge(eff, {k: v for k, v in mine.items() if k in eff and isinstance(v, dict)})
    return eff


def get(key: str, store=None, default: Any = None) -> Any:
    """Effective value of a dotted key, e.g. get('safety.load_limit_pct')."""
    node: Any = load(store)
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node
