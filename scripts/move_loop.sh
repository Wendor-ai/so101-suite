#!/usr/bin/env bash
# Keeps triggering the dashboard's wiggle demo on arm 1 until stopped (Ctrl-C / kill).
URL=${1:-http://localhost:8000}
trap 'exit 0' INT TERM
while true; do curl -s -X POST $URL/api/wiggle/0 >/dev/null; sleep 11; done
