#!/usr/bin/env bash
# Run ON the Pi. At desktop login (labwc/Wayland) it starts the Pi's own dashboard server (it serves the overhead
# camera at /raw.mjpg for the Mac) and a fullscreen Chromium.
# Usage: pi_kiosk_setup.sh [URL]   URL = what the Pi screen shows (default: the Pi's own dashboard,
#        e.g. pass http://<mac-ip>:8000 to show the Mac's dashboard, which controls the arm).
# Fixed cameras: put CAMERA_INDEX=/dev/v4l/by-path/<A> and CAMERA2=/dev/v4l/by-path/<B> in .env on the Pi (see .env.example).
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
VIEW="${1:-http://localhost:8000}"
mkdir -p ~/.config/labwc
A=~/.config/labwc/autostart; touch "$A"
sed -i '/# so101-dashboard/d' "$A"
cat >> "$A" <<EOT
SO101_LOG=/tmp/so101-supervisor.log $DIR/scripts/supervise.sh --port 8000 --camera-only >/tmp/so101-app.log 2>&1 & # so101-dashboard (supervised: restarts itself if it ever crashes or hangs)
sh -c 'sleep 6; chromium --kiosk --noerrdialogs --disable-infobars $VIEW' & # so101-dashboard
EOT
echo "Installed. Pi screen will show $VIEW after reboot or log out/in."
