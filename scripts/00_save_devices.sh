#!/usr/bin/env bash
# Snapshots connected USB devices into devices.md. Run with arms + camera plugged in.
# Works on macOS and Linux (Pi 5).
cd "$(dirname "$0")/.."
{
  echo "# Detected devices ($(date -u +%F\ %T) UTC, $(uname -sm))"
  echo; echo "## Serial ports"
  ls /dev/tty.usb* /dev/cu.usb* /dev/tty.wchusb* /dev/cu.wchusb* /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || echo "none"
  echo; echo "## USB"
  if [ "$(uname)" = Darwin ]; then { system_profiler SPUSBDataType; ioreg -p IOUSB -l | grep -E "USB Product Name|USB Vendor Name"; }; else lsusb; fi
  echo; echo "## Cameras"
  source .venv/bin/activate && lerobot-find-cameras opencv 2>&1 | grep -v "^OpenCV"
} > devices.md
echo "saved devices.md"
