"""Red rectangular keychain detector for the overhead camera (OpenCV colour threshold + shape checks)."""
import cv2
import numpy as np


def detect(frame, min_area=500, max_area=4000, min_fill=0.72, min_aspect=1.3, max_round=0.62):
    """Return candidate red rectangles, best first: dict(u, v, angle, w, h, area, score). angle = long-axis direction in image degrees.
    A red BOWL must never pass as the keychain (it did, 2026-11-01): the keychain is small (526-1656 px measured in both cameras), clearly oblong (aspect 1.35-1.96)
    and fills little of its enclosing circle (0.47-0.59); the bowl is big (5044-12443 px), round (aspect 1.0-1.5) and fills 0.64-0.90 of it. Failing to see the keychain is safe, picking the bowl is not."""
    hsv = cv2.cvtColor(cv2.GaussianBlur(frame, (5, 5), 0), cv2.COLOR_BGR2HSV)
    m = cv2.inRange(hsv, (0, 120, 70), (8, 255, 255)) | cv2.inRange(hsv, (172, 120, 70), (180, 255, 255))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    out = []
    for c in cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        a = cv2.contourArea(c)
        if not min_area <= a <= max_area: continue
        (u, v), (w, h), ang = cv2.minAreaRect(c)
        if min(w, h) < 8: continue
        fill = a / (w * h)                       # how rectangular the blob is
        ar = max(w, h) / min(w, h)
        if fill < min_fill or ar > 3.2 or ar < min_aspect: continue
        if a / (np.pi * cv2.minEnclosingCircle(c)[1] ** 2) > max_round: continue      # a round blob is a bowl, not a keychain
        if w < h: ang += 90                      # long-axis angle
        out.append(dict(u=float(u), v=float(v), angle=float(ang % 180), w=float(max(w, h)), h=float(min(w, h)), area=float(a), score=float(fill), partial=min_fill < 0.72))
    return sorted(out, key=lambda d: -d["score"] * d["area"])


ZCOL = {"tray": (255, 160, 60), "bowl": (200, 110, 255)}


def draw(frame, found, zones=None, taught=()):
    for k, d in enumerate(found):
        box = cv2.boxPoints(((d["u"], d["v"]), (d["w"], d["h"]), d["angle"])).astype(int)
        col = (80, 220, 120) if k == 0 else (140, 140, 140)
        cv2.polylines(frame, [box], True, col, 2)
        if k == 0: cv2.putText(frame, "keychain (partly hidden)" if d.get("partial") else "keychain", (int(d["u"]) - 30, int(d["v"]) - 22), cv2.FONT_HERSHEY_SIMPLEX, .5, col, 1, cv2.LINE_AA)
    for n, z in (zones or {}).items():
        if not z["p"]: continue
        c = ZCOL.get(n, (255, 255, 255)); p = (int(z["p"][0]), int(z["p"][1]))
        cv2.circle(frame, p, int(z["r"]), c, 2); cv2.drawMarker(frame, p, c, cv2.MARKER_CROSS, 14, 2)
        cv2.putText(frame, n, (p[0] - 18, p[1] - int(z["r"]) - 6), cv2.FONT_HERSHEY_SIMPLEX, .55, c, 2, cv2.LINE_AA)
    for i, p in enumerate(taught):
        cv2.circle(frame, (int(p["u"]), int(p["v"])), 6, (255, 80, 220), 2); cv2.putText(frame, str(i + 1), (int(p["u"]) + 8, int(p["v"]) + 4), cv2.FONT_HERSHEY_SIMPLEX, .5, (255, 80, 220), 1, cv2.LINE_AA)
    return frame


def find_bowl(frame, min_area=6000):
    """The pale-pink bowl: hue near red/pink with low saturation (the white table is blue-ish). Returns dict(u, v, r) or None."""
    hsv = cv2.cvtColor(cv2.GaussianBlur(frame, (9, 9), 0), cv2.COLOR_BGR2HSV)
    m = (((hsv[..., 0] < 12) | (hsv[..., 0] > 150)) & (hsv[..., 1] >= 12) & (hsv[..., 1] <= 110) & (hsv[..., 2] > 150)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8)); m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    cs = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
    if not cs: return None
    c = max(cs, key=cv2.contourArea); a = cv2.contourArea(c)
    if a < min_area: return None
    M = cv2.moments(c)
    return dict(u=float(M["m10"] / M["m00"]), v=float(M["m01"] / M["m00"]), r=float(np.sqrt(a / np.pi)))


def bowl_rim_points(frame, min_area=8000):
    """Outline of the whole pale-pink bowl, rim included (looser colour limits than find_bowl, which only needs its bright floor).
    Returns every 3rd contour point (u, v) or None."""
    hsv = cv2.cvtColor(cv2.GaussianBlur(frame, (9, 9), 0), cv2.COLOR_BGR2HSV)
    m = (((hsv[..., 0] < 14) | (hsv[..., 0] > 145)) & (hsv[..., 1] >= 10) & (hsv[..., 1] <= 150) & (hsv[..., 2] > 110)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8)); m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    cs = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]
    if not cs: return None
    c = max(cs, key=cv2.contourArea)
    return c[::3, 0, :] if cv2.contourArea(c) >= min_area else None


def find_fingertip(frame):
    """Pixel of the fingertips in a top-down camera picture: the LOWEST point of the black gripper, which is the black blob entering from the top edge.
    Used to calibrate the table map from the arm's own known positions (no keychain: a held keychain is half hidden and biases the result)."""
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = (hsv[..., 2] < 70).astype(np.uint8) * 255                        # black: the table, the red keychain and the pale cables are all brighter
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)); mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask)
    cand = [i for i in range(1, n) if stats[i, 1] <= 2 and stats[i, 4] > 1500 and stats[i, 1] + stats[i, 3] < frame.shape[0] * 0.8]
    if not cand: return None
    i = max(cand, key=lambda k: stats[k, 4]); ys, xs = np.where(lab == i); k = int(ys.max()); low = xs[ys >= k - 3]
    return dict(u=float(np.median(low)), v=float(k), area=int(stats[i, 4]))

def find_cylinders(frame, bowl=None, min_area=600, max_area=4500, min_solid=0.82, max_aspect=2.4):
    """Grey (bluish-grey plastic) cylinders lying on the white table, seen by the overhead camera. Returns dicts(u, v, w, h, area, box), biggest/most compact first.
    Colour: hue 92-125, saturation 28-90, value 95-175 (measured 2026-11-01: cylinder tops H 106-110 S 39-53 V 134-144; the white table is S 18 V 196, black cables and arms V < 80).
    Thin cables are removed by a 7x7 opening; the big grey pipe fitting is rejected by size; anything whose centre lies inside the pink bowl (`bowl` = dict(u, v, r) in pixels) is already
    in the bowl and is ignored."""
    hsv = cv2.cvtColor(cv2.GaussianBlur(frame, (5, 5), 0), cv2.COLOR_BGR2HSV)
    m = cv2.inRange(hsv, (92, 28, 95), (125, 90, 175))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8)); m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    out = []
    for c in cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        a = cv2.contourArea(c)
        if not min_area <= a <= max_area: continue
        hull = cv2.contourArea(cv2.convexHull(c))
        if hull <= 0 or a / hull < min_solid: continue                      # compact blobs only (a cable, or a cable crossing a blob, is not)
        (u, v), (w, h), ang = cv2.minAreaRect(c)
        if min(w, h) < 12 or max(w, h) / max(1.0, min(w, h)) > max_aspect: continue
        M = cv2.moments(c); cu, cv_ = M["m10"] / M["m00"], M["m01"] / M["m00"]
        if bowl and np.hypot(cu - bowl["u"], cv_ - bowl["v"]) < 1.05 * bowl["r"]: continue          # already in the bowl
        out.append(dict(u=float(cu), v=float(cv_), w=float(max(w, h)), h=float(min(w, h)), area=float(a), box=cv2.boxPoints(((u, v), (w, h), ang)).astype(int).tolist()))
    return sorted(out, key=lambda d: -d["area"])

def find_fingertip_diff(ref, frame, min_area=250, thresh=38):
    """Fingertip by DIFFERENCE: `ref` is a picture taken with the arm folded at rest, `frame` the same view with the arm reaching onto the table. Everything that did not move
    (the other arm, cables, the computer, the bowl) cancels; what is left is the follower arm, entering from the top, and its lowest point is the fingertip. (The old black-blob
    finder took the largest dark blob touching the top edge: with the leader arm and black cables in the picture it gave a 65 mm fit error, 2026-11-01.)"""
    a = cv2.GaussianBlur(ref, (5, 5), 0); b = cv2.GaussianBlur(frame, (5, 5), 0)
    m = (cv2.absdiff(a, b).max(axis=2) > thresh).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)); m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    cand = [i for i in range(1, n) if stats[i, 4] >= min_area]
    if not cand: return None
    i = max(cand, key=lambda k: stats[k, 1] + stats[k, 3])                   # the blob that reaches lowest in the picture is the arm's
    ys, xs = np.where(lab == i); k = int(ys.max()); low = xs[ys >= k - 3]
    return dict(u=float(np.median(low)), v=float(k), area=int(stats[i, 4]))

