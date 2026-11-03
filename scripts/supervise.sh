#!/usr/bin/env bash
# Keeps the dashboard alive forever: restarts it if it crashes OR stops answering (a hung server looks exactly like a dead one).
# Usage (anywhere, any machine):  scripts/supervise.sh [server.py arguments]
#   Mac:  scripts/supervise.sh --port 8000      (CAMERA_URL=http://<pi>:8000/raw.mjpg,... goes in .env)
#   Pi:   scripts/supervise.sh --port 8000 --camera-only      (CAMERA_INDEX=<path A> and CAMERA2=<path B> go in .env)
# Motors keep their torque across a restart and the server reads the real state on start, so the arm never drops.
DIR="$(cd "$(dirname "$0")/.." && pwd)"; cd "$DIR" || exit 1
PORT=8000; prev=""; for a in "$@"; do [ "$prev" = "--port" ] && PORT="$a"; prev="$a"; done
LOG="${SO101_LOG:-/tmp/so101-supervisor.log}"
say() { echo "$(date '+%F %T') $*" | tee -a "$LOG" >&2; }
trap 'kill "$PID" 2>/dev/null; exit 0' INT TERM
while true; do
  "$DIR/.venv/bin/python" "$DIR/app/server.py" "$@" &
  PID=$!; say "dashboard started (pid $PID, port $PORT)"
  FAIL=0; sleep 14
  while kill -0 "$PID" 2>/dev/null; do
    if curl -s -m 4 "http://localhost:$PORT/api/health" >/dev/null; then FAIL=0; else FAIL=$((FAIL + 1)); fi
    if [ "$FAIL" -ge 3 ]; then say "dashboard stopped answering: restarting it"; kill -9 "$PID" 2>/dev/null; break; fi
    sleep 5
  done
  wait "$PID" 2>/dev/null; say "dashboard exited: restarting in 2 s"; sleep 2
done
