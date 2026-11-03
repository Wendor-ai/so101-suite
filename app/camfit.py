"""Camera calibration from a keychain carried by the arm, WITHOUT assuming the keychain's centre is where the arm's tip is.

Why: Auto-calibrate pairs the arm's forward-kinematics tip position with the pixel of the keychain it holds. Two things made the old fit wrong by ~3 cm on the table
(measured 2026-10-30, docs/LEARNINGS.md section 18): the clamped part of the keychain is not at the tip (an unknown offset `s` fixed in the gripper), and the gripper
hides part of the keychain so its visible centre is shifted. Here the offset `s` (3 numbers in the tool frame) is fitted together with the cameras, half-hidden
detections count less, and table points (tip on the keychain, taught by hand) can be added as extra data.

An observation is a dict: cam (int), T (tip xyz, world), R (3x3 tool rotation, world), uv (pixel), partial (bool), kind ("held" = carried in the gripper, "touch" = tip on it).
Pure numpy + OpenCV (no scipy).
"""
import cv2
import numpy as np

SIGMA = dict(held=1.5, held_partial=5.0, touch=4.0)          # pixel noise assumed per kind: a half-hidden keychain's centre is much less trustworthy
S_PRIOR_XY, S_PRIOR_Z = 0.04, 0.02                          # the clamp offset is small: a few cm sideways at most, up to 2 cm along the tool (a keychain clamped by its end hangs a little)


def _project(theta_cam, pts, size):
    f, rv, tv = theta_cam[0], theta_cam[1:4], theta_cam[4:7]
    K = np.array([[f, 0, size[0] / 2], [0, f, size[1] / 2], [0, 0, 1.0]])
    return cv2.projectPoints(np.asarray(pts, float).reshape(-1, 1, 3), rv.reshape(3, 1), tv.reshape(3, 1), K, None)[0].reshape(-1, 2)


def _lm(fun, x0, steps=80):
    """Levenberg-Marquardt with a numerical Jacobian. Small problems only (about 20 unknowns)."""
    x = np.array(x0, float); lam = 1e-2; r = fun(x); cost = float(r @ r)
    for _ in range(steps):
        J = np.empty((len(r), len(x)))
        for k in range(len(x)):
            h = 1e-5 * max(1.0, abs(x[k]))
            xp = x.copy(); xp[k] += h; J[:, k] = (fun(xp) - r) / h
        A = J.T @ J; g = J.T @ r; improved = False
        for _ in range(8):
            try: dx = np.linalg.solve(A + lam * np.diag(np.diag(A) + 1e-9), -g)
            except np.linalg.LinAlgError: lam *= 10; continue
            rn = fun(x + dx); cn = float(rn @ rn)
            if cn < cost: x, r, cost, lam, improved = x + dx, rn, cn, max(lam / 3, 1e-9), True; break
            lam *= 4
        if not improved or np.linalg.norm(dx) < 1e-9: break
    return x, cost


def fit(obs, init, size=(640, 480), fit_offset=True):
    """obs: list of observation dicts. init: {cam: dict(f, rvec, tvec)} starting guesses (the old model, or any rough one).
    Returns dict(models={cam: dict(K, rvec, tvec, rms, n)}, s=[sx, sy, sz] metres in the tool frame, rms_all=px, used={cam: n})."""
    cams = sorted({o["cam"] for o in obs if o["cam"] in init})
    if not cams: raise ValueError("no observations for any camera")
    byc = {c: [o for o in obs if o["cam"] == c] for c in cams}
    sig = lambda o: SIGMA["touch"] if o.get("kind") == "touch" else (SIGMA["held_partial"] if o.get("partial") else SIGMA["held"])
    theta0 = [0.0, 0.0, 0.0] if fit_offset else []
    for c in cams: theta0 += [init[c]["f"], *init[c]["rvec"], *init[c]["tvec"]]
    n_s = 3 if fit_offset else 0

    def residuals(theta):
        s = theta[:3] if fit_offset else np.zeros(3); out = []
        for k, c in enumerate(cams):
            th = theta[n_s + 7 * k: n_s + 7 * k + 7]
            P = np.array([np.asarray(o["T"], float) + (np.asarray(o["R"], float).reshape(3, 3) @ s if o.get("kind", "held") == "held" else 0.0) for o in byc[c]])
            uv = np.array([o["uv"] for o in byc[c]], float); w = np.array([1.0 / sig(o) for o in byc[c]])
            out.append(((_project(th, P, size) - uv) * w[:, None]).ravel())
            out.append(np.array([(th[0] - init[c]["f"]) / (0.35 * init[c]["f"])]))            # focal length stays near the previous estimate unless the data insist
        if fit_offset: out.append(np.array([s[0] / S_PRIOR_XY, s[1] / S_PRIOR_XY, s[2] / S_PRIOR_Z]))
        return np.concatenate(out)

    theta, _ = _lm(residuals, np.array(theta0, float))
    s = theta[:3] if fit_offset else np.zeros(3); models = {}; allr = []
    for k, c in enumerate(cams):
        th = theta[n_s + 7 * k: n_s + 7 * k + 7]
        P = np.array([np.asarray(o["T"], float) + (np.asarray(o["R"], float).reshape(3, 3) @ s if o.get("kind", "held") == "held" else 0.0) for o in byc[c]])
        err = np.linalg.norm(_project(th, P, size) - np.array([o["uv"] for o in byc[c]], float), axis=1)
        good = np.array([not o.get("partial") for o in byc[c]]); allr += list(err)
        models[c] = dict(K=[[float(th[0]), 0.0, size[0] / 2], [0.0, float(th[0]), size[1] / 2], [0.0, 0.0, 1.0]], rvec=[float(v) for v in th[1:4]], tvec=[float(v) for v in th[4:7]],
                         rms=float(np.sqrt(np.mean((err[good] if good.any() else err) ** 2))), n=len(byc[c]))
    return dict(models=models, s=[float(v) for v in s], rms_all=float(np.sqrt(np.mean(np.square(allr)))), used={c: len(byc[c]) for c in cams})


def rough_init(obs, size=(640, 480), f0=450.0):
    """A starting camera pose from the observations alone (assumes the keychain is at the tip): OpenCV's single-view calibration, as before."""
    out = {}
    for c in sorted({o["cam"] for o in obs}):
        P = np.float32([o["T"] for o in obs if o["cam"] == c]).reshape(-1, 1, 3); uv = np.float32([o["uv"] for o in obs if o["cam"] == c]).reshape(-1, 1, 2)
        if len(P) < 6: continue
        K0 = np.array([[f0, 0, size[0] / 2], [0, f0, size[1] / 2], [0, 0, 1.0]])
        flags = cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_FIX_PRINCIPAL_POINT | cv2.CALIB_FIX_ASPECT_RATIO | cv2.CALIB_ZERO_TANGENT_DIST | cv2.CALIB_FIX_K1 | cv2.CALIB_FIX_K2 | cv2.CALIB_FIX_K3
        rms, K, _, rv, tv = cv2.calibrateCamera([P], [uv], size, K0, np.zeros(5), flags=flags)
        out[c] = dict(f=float(K[0, 0]), rvec=[float(v) for v in rv[0].ravel()], tvec=[float(v) for v in tv[0].ravel()])
    return out


def table_point(model, uv, z_world):
    """Where a pixel lands on the horizontal plane z = z_world through a model dict (K, rvec, tvec)."""
    K = np.array(model["K"]); R = cv2.Rodrigues(np.array(model["rvec"], float))[0]; t = np.array(model["tvec"], float)
    d = R.T @ np.linalg.solve(K, np.array([uv[0], uv[1], 1.0])); C = -R.T @ t
    return (C + (z_world - C[2]) / d[2] * d)[:2]


def stability(obs, init, result, size=(640, 480), z_world=0.0, max_drop=12, seed=0):
    """How much the table map of each camera moves when ONE observation is left out (millimetres, worst spot of the work area). Small = well pinned down.
    Probed on the real work area (tip positions x 150..300, y -120..60 mm on the table), not on the picture corners, where a tiny camera change moves the table map a lot.
    A camera that swings by more than ~15 mm is flagged weak by the caller: its few observations decide the result."""
    rng = np.random.default_rng(seed); out = {}; fit0 = result["models"]
    area = [(x / 1000, y / 1000) for x in (150, 200, 250, 300) for y in (-120, -60, 0, 60)]
    for c in fit0:
        K = np.array(fit0[c]["K"]); rv = np.array(fit0[c]["rvec"], float).reshape(3, 1); tv = np.array(fit0[c]["tvec"], float).reshape(3, 1)
        pix = [cv2.projectPoints(np.float32([[x, y, z_world]]).reshape(-1, 1, 3), rv, tv, K, None)[0].reshape(2) for x, y in area]
        base = np.array([table_point(fit0[c], p, z_world) for p in pix]); worst = 0.0
        idx = [k for k, o in enumerate(obs) if o["cam"] == c]
        drop = list(rng.choice(idx, min(max_drop, len(idx)), replace=False)) if len(idx) > max_drop else idx
        start = {cc: dict(f=fit0[cc]["K"][0][0], rvec=fit0[cc]["rvec"], tvec=fit0[cc]["tvec"]) for cc in fit0}
        for k in drop:
            sub = [o for j, o in enumerate(obs) if j != k]
            if sum(1 for o in sub if o["cam"] == c) < 6: continue
            try: r = fit(sub, start, size)
            except Exception: continue
            if c not in r["models"]: continue
            moved = np.array([table_point(r["models"][c], p, z_world) for p in pix]); worst = max(worst, float(np.max(np.linalg.norm(moved - base, axis=1))) * 1000)
        out[c] = worst
    return out
