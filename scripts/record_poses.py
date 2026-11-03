#!/usr/bin/env python3
"""Hands-free pose recorder for the model alignment. While the follower is limp and you hold it still for ~2 s, the pose is saved
(joint readings straight from the motors) and a 'ding' plays on the Mac's speaker. Output: calibration/samples/session.jsonl"""
import json, os, subprocess, sys, time, urllib.request
URL = "http://localhost:8000/api/state"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "calibration", "samples", "session.jsonl")
SNAP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "calibration", "samples")
def snap(n):
    """photograph both cameras at this pose (raw frames, straight from the dashboard)"""
    for cam, path in ((1, "/raw.mjpg"), (2, "/raw2.mjpg")):
        try:
            r = urllib.request.urlopen("http://localhost:8000" + path, timeout=4); buf = r.read(300000); a = buf.find(b"\xff\xd8"); b = buf.find(b"\xff\xd9", a)
            if a >= 0 and b > a: open(os.path.join(SNAP, f"pose_{n:02d}_cam{cam}.jpg"), "wb").write(buf[a:b + 2])
        except Exception as e: print("  (camera", cam, "snapshot failed:", e, ")", flush=True)
def ding(n):
    try: subprocess.Popen(["afplay", "/System/Library/Sounds/Glass.aiff"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception: pass
last, ref, since, count = None, None, None, sum(1 for _ in open(OUT)) if os.path.exists(OUT) else 0
print(f"recording poses into {os.path.abspath(OUT)} (already {count})", flush=True)
while True:
    time.sleep(0.15)
    try:
        d = json.load(urllib.request.urlopen(URL, timeout=3)); f = next(a for a in d["arms"] if a["role"] == "follower")
        if d["pp"]["limp"] is not True: ref = since = None; continue
        pos = {j["id"]: j["pos"] for j in f["joints"]}
        if len(pos) < 6 or any(v is None for v in pos.values()): continue
    except Exception: continue
    if ref is None or max(abs(pos[i] - ref[i]) for i in (1, 2, 3, 4, 5)) > 3: ref, since = pos, time.time(); continue        # still moving
    if time.time() - since >= 2.0 and (last is None or max(abs(pos[i] - last[i]) for i in (1, 2, 3, 4, 5)) >= 20):
        count += 1; last = dict(pos)
        with open(OUT, "a") as fh: fh.write(json.dumps({"n": count, "t": time.time(), "raw": pos}) + "\n")
        print(f"pose {count} recorded: {pos}", flush=True); snap(count); ding(count)
