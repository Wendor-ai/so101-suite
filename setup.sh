#!/usr/bin/env bash
# SO-101 Suite setup for macOS, Linux and Raspberry Pi.
#
#   ./setup.sh              install everything, detect your hardware, open the app
#   ./setup.sh --no-start   install only (start later with: uv run so101 start)
#   ./setup.sh --dry-run    show what would happen, change nothing
#
# Safe to run again at any time. It never needs sudo: uv (the Python tool that installs everything else) goes into your
# own folder (~/.local/bin), and the project's Python packages go into ./.venv. The only thing that may need sudo is
# letting your Linux user open serial ports; the script prints that one command instead of running it for you.
set -euo pipefail

cd "$(dirname "$0")"

START=1
DRY=0
PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then note "(dry run) $*"; else "$@"; fi; }

say "SO-101 Suite setup"
note "Folder: $(pwd)"
OS="$(uname -s)"
case "$OS" in
  Darwin) note "macOS detected." ;;
  Linux)  if [ -r /proc/device-tree/model ] && grep -qa "Raspberry Pi" /proc/device-tree/model 2>/dev/null; then
            note "Raspberry Pi detected: $(tr -d '\0' < /proc/device-tree/model)."
          else note "Linux detected."; fi ;;
  *) note "This script is for macOS, Linux and Raspberry Pi. On Windows use setup.ps1."; exit 1 ;;
esac

# --- 1. uv -------------------------------------------------------------------------------------------------------
say "1/3  Checking uv (installs Python and the packages)"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if command -v uv >/dev/null 2>&1; then
  note "uv is already installed: $(uv --version)"
else
  note "uv is not installed. Installing it into ~/.local/bin (no sudo needed) ..."
  if command -v curl >/dev/null 2>&1; then
    run sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
  elif command -v wget >/dev/null 2>&1; then
    run sh -c 'wget -qO- https://astral.sh/uv/install.sh | sh'
  else
    note "I need curl or wget to download uv, and neither is installed. Install one of them, then run this again."
    exit 1
  fi
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if [ "$DRY" = 0 ] && ! command -v uv >/dev/null 2>&1; then
    note "uv was installed but is not on this shell's PATH yet. Open a new terminal and run ./setup.sh again."
    exit 1
  fi
fi

# --- 2. packages ---------------------------------------------------------------------------------------------------
say "2/3  Installing the app (Python 3.12 and the packages go into ./.venv; this can take a minute)"
run uv sync

# --- 3. serial permission (Linux only) ---------------------------------------------------------------------------
if [ "$OS" = "Linux" ]; then
  say "3/3  Checking permission to use the arm's USB port"
  if id -nG | tr ' ' '\n' | grep -qxE 'dialout|uucp'; then
    note "Your user can use serial ports. Good."
  else
    note "Your user is not allowed to open serial ports yet, so Linux would refuse to talk to the arm."
    note "Run this ONE command once, then log out and log back in:"
    note ""
    note "    sudo usermod -aG dialout \$USER"
    note ""
    note "(Until then the app still starts, and its checklist shows the same fix.)"
  fi
else
  say "3/3  Nothing else to set up on this computer"
fi

# --- start ---------------------------------------------------------------------------------------------------------
if [ "$START" = 1 ]; then
  say "Starting the app: it looks at your hardware and opens the right page"
  note "Stop it any time with Ctrl+C. Start it again later with: uv run so101 start"
  if [ "$DRY" = 1 ]; then note "(dry run) uv run so101 setup ${PASSTHROUGH[*]:-}"; exit 0; fi
  exec uv run so101 setup ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
else
  say "All set"
  note "Start the app with:  uv run so101 start"
  note "Try it without any hardware:  uv run so101 demo"
fi
