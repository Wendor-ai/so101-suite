"""Read a `.env` file into the environment, so ports, camera addresses and names stay out of the repo.

Files, in this order (a name set by an earlier source is never changed by a later one):
  1. the real environment: `FOLLOWER_ID=other so101 start` always wins
  2. the file named by SO101_ENV_FILE, if set
  3. `.env` in the repo folder
  4. `.env` in your data folder (~/.so101, or SO101_HOME)
A `.env` is not read in demo mode or when SO101_NO_DOTENV=1 (the tests set it), so a real address can never leak into a demo or a test.
`so101 env` shows which files were found and which names they set; `so101 env --shell` prints `export` lines for the scripts in scripts/."""
import os
import pathlib
import re
import shlex
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
_VAR = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")


def parse(text, environ=None):
    """{name: value} from the text of a .env file.

    Understands `NAME=value`, `export NAME=value`, 'single' (literal) and "double" quotes, `#` comments (a whole line, or after a space following an
    unquoted value) and `$NAME` / `${NAME}` taken from earlier lines or from `environ`. Lines it does not understand are skipped, never fatal."""
    environ = os.environ if environ is None else environ
    out = {}

    def expand(s):
        return _VAR.sub(lambda m: out.get(m.group(1) or m.group(2), environ.get(m.group(1) or m.group(2), "")), s)

    for raw in text.splitlines():
        if raw.lstrip().startswith("#"):
            continue
        m = _LINE.match(raw)
        if not m:
            continue
        name, rest = m.group(1), m.group(2).strip()
        if rest[:1] in ("'", '"'):
            end = rest.find(rest[0], 1)
            if end == -1:
                continue                                              # an unclosed quote: skip the line
            value = rest[1:end] if rest[0] == "'" else expand(rest[1:end])
        else:
            value = expand(re.split(r"\s#", rest, maxsplit=1)[0].strip())
        out[name] = value
    return out


def files(environ=None):
    """The .env files that exist, in the order they are read."""
    environ = os.environ if environ is None else environ
    wanted = []
    if environ.get("SO101_ENV_FILE"):
        wanted.append(pathlib.Path(environ["SO101_ENV_FILE"]).expanduser())
    wanted.append(REPO_ROOT / ".env")
    wanted.append(pathlib.Path(environ.get("SO101_HOME") or "~/.so101").expanduser() / ".env")
    seen, found = set(), []
    for p in wanted:
        try:
            key = p.resolve()
            if key not in seen and p.is_file():
                seen.add(key)
                found.append(p)
        except OSError:
            continue
    return found


def collect(environ=None):
    """{name: value} that the .env files would ADD to `environ` (names it already has are left alone)."""
    environ = os.environ if environ is None else environ
    merged = dict(environ)
    added = {}
    for p in files(environ):
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for name, value in parse(text, merged).items():
            if name not in merged:
                merged[name] = added[name] = value
    return added


def disabled(environ=None, argv=None):
    environ = os.environ if environ is None else environ
    argv = sys.argv if argv is None else argv
    return environ.get("SO101_NO_DOTENV") == "1" or environ.get("SO101_DEMO") == "1" or "--demo" in argv or argv[1:2] == ["demo"]


LOADED = []          # the names `import so101` took from a .env file (values stay in the environment, never printed)


def load(environ=None, argv=None):
    """Put the .env settings into the environment (never replacing a name that is already set). Returns the names it added."""
    real = environ is None
    environ = os.environ if real else environ
    if disabled(environ, argv):
        return []
    added = collect(environ)
    environ.update(added)
    if real:
        LOADED[:] = sorted(added)
    return sorted(added)


def report(shell=False, out=print):
    """`so101 env`: which .env files were found and which names they set (never the values). With shell=True: `export` lines for the scripts in scripts/."""
    added = {name: os.environ[name] for name in LOADED if name in os.environ}      # taken when `import so101` ran
    added.update(collect())                                                         # (or taken now, if that was switched off)
    if shell:
        for name, value in added.items():
            out(f"export {name}={shlex.quote(value)}")
        return 0
    found = files()
    out("\n".join(str(p) for p in found) if found else "no .env file found (copy .env.example to .env)")
    out("names set by it: " + (", ".join(sorted(added)) or "none"))
    return 0
