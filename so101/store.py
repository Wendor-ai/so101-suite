"""A tiny JSON config store with dotted keys ("ui.theme"). Writes are atomic; a corrupt file is moved aside, never fatal."""
import json
import os
import pathlib
import tempfile
import threading
from typing import Any

from . import paths


class Store:
    def __init__(self, path=None):
        self.path = pathlib.Path(path) if path else paths.data_dir() / "config.json"
        self._lock = threading.RLock()
        self._data = self._load()

    # --- file handling ---
    def _load(self) -> dict:
        try:
            raw = self.path.read_text()
        except FileNotFoundError:
            return {}
        except OSError:
            return {}
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("config root must be an object")
            return data
        except ValueError:
            self._quarantine()
            return {}

    def _quarantine(self):
        bad = self.path.with_name(self.path.name + ".bad")
        try:
            os.replace(self.path, bad)
        except OSError:
            pass

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), prefix=self.path.name + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(self._data, f, indent=2, sort_keys=True)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # --- access ---
    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            node: Any = self._data
            for part in key.split("."):
                if not isinstance(node, dict) or part not in node:
                    return default
                node = node[part]
            return _copy(node)

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            parts = key.split(".")
            node = self._data
            for part in parts[:-1]:
                if not isinstance(node.get(part), dict):
                    node[part] = {}
                node = node[part]
            node[parts[-1]] = _copy(value)
            self._save()

    def delete(self, key: str) -> None:
        with self._lock:
            parts = key.split(".")
            node = self._data
            for part in parts[:-1]:
                node = node.get(part)
                if not isinstance(node, dict):
                    return
            if parts[-1] in node:
                del node[parts[-1]]
                self._save()

    def update(self, tree: dict) -> None:
        """Deep-merge a nested dict into the store."""
        with self._lock:
            _merge(self._data, tree)
            self._save()

    def all(self) -> dict:
        with self._lock:
            return _copy(self._data)


def _copy(v):
    return json.loads(json.dumps(v))


def _merge(dst: dict, src: dict) -> dict:
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _merge(dst[k], v)
        else:
            dst[k] = _copy(v)
    return dst
