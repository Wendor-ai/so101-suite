#!/usr/bin/env bash
# Dashboard: live camera + arm telemetry. Open http://localhost:8000 (or the Pi's IP from your laptop).
source "$(dirname "$0")/_env.sh"
(sleep 2; command -v open >/dev/null && open http://localhost:8000) &
exec python app/server.py --camera "$CAMERA_INDEX" "$@"
