#!/usr/bin/env bash
# Copies calibration backups from ./calibration into LeRobot's calibration folder on THIS machine
# (follower -> robots/so_follower, leader -> teleoperators/so_leader). Use it to move YOUR OWN calibration to
# a Pi or another laptop. Also installs the *.default.json restore points used by "Restore default".
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${HF_LEROBOT_CALIBRATION:-$HOME/.cache/huggingface/lerobot/calibration}"
shopt -s nullglob
fol=("$HERE"/calibration/my_follower*.json); lea=("$HERE"/calibration/my_leader*.json)
if [ ${#fol[@]} -eq 0 ] && [ ${#lea[@]} -eq 0 ]; then
  echo "No calibration backups in $HERE/calibration (expected my_follower.json / my_leader.json)."
  echo "Calibrate in the app first (Calibrate page), then copy the files from $ROOT here."; exit 1
fi
mkdir -p "$ROOT/robots/so_follower" "$ROOT/teleoperators/so_leader"
[ ${#fol[@]} -gt 0 ] && cp "${fol[@]}" "$ROOT/robots/so_follower/"
[ ${#lea[@]} -gt 0 ] && cp "${lea[@]}" "$ROOT/teleoperators/so_leader/"
echo "Installed calibrations into $ROOT"
