"""Which adapter is the follower and which is the leader. Stored by the adapter's stable identity (PortInfo.key), not its path.

Older versions keyed the file by device path; those entries are still read and are migrated to the stable key the first time
the adapter is seen, so an existing setup keeps working."""
import json
import os
import pathlib
import tempfile
from typing import Optional

from . import ports

ROLES = ("follower", "leader")
CONFIRMED = "_confirmed"      # list of adapter keys whose role the person set (by unplugging, or by choosing). A first-seen guess is not in it.


def _mark(roles: dict, *keys) -> None:
    done = [k for k in roles.get(CONFIRMED, []) if isinstance(k, str)]
    for k in keys:
        if k not in done:
            done.append(k)
    roles[CONFIRMED] = done


def is_confirmed(file, key: str, path: Optional[str] = None) -> bool:
    done = load(file).get(CONFIRMED, [])
    return isinstance(done, list) and (key in done or (path is not None and path in done))


def load(file) -> dict:
    try:
        d = json.loads(pathlib.Path(file).read_text())
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save(file, roles: dict) -> None:
    file = pathlib.Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(file.parent), prefix=file.name + ".", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(roles, f)
    os.replace(tmp, file)


def role_for(file, path: str, set_to: Optional[str] = None, lister=None, platform_os=None) -> str:
    """The role of the adapter at `path`. First adapter seen = follower, the second = leader. `set_to` rebinds it."""
    roles = load(file)
    key = ports.key_for_path(path, lister=lister, platform_os=platform_os)
    if key != path and key not in roles and path in roles:        # legacy entry keyed by path: migrate it
        roles[key] = roles.pop(path)
    if set_to in ROLES:
        roles[key] = set_to
        _mark(roles, key)
    elif key not in roles:
        roles[key] = "leader" if "follower" in roles.values() else "follower"
    save(file, roles)
    return roles[key]


def lookup(file, key: str, path: Optional[str] = None) -> Optional[str]:
    """A pure read: the saved role of an adapter, or None if it has none yet (never writes)."""
    roles = load(file)
    return roles.get(key) or (roles.get(path) if path else None)


def assign(file, key: str, role: str, other_keys=()) -> dict:
    """Bind `key` to `role`. Any other listed adapter that held that role gets the opposite one (a swap), so there is never two of a kind."""
    if role not in ROLES:
        raise ValueError("role must be 'follower' or 'leader'")
    roles = load(file)
    opposite = "leader" if role == "follower" else "follower"
    for k in other_keys:
        if k != key and roles.get(k) == role:
            roles[k] = opposite
    roles[key] = role
    _mark(roles, key, *[k for k in other_keys if k != key])        # two roles only: naming one names the other by elimination
    save(file, roles)
    return roles
