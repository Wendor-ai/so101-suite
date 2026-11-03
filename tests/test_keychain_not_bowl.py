"""A red bowl must never be picked as the keychain (docs/LEARNINGS.md, section 22).

The pictures are drawn here, not photographed, so the test needs no photo of anyone's room. Sizes and shapes follow what was
measured on real cameras: keychain 526-1656 px and clearly oblong (aspect 1.35-1.96), bowl 5044-12443 px and round.
Failing to see the keychain is safe; picking the bowl is not."""
import cv2
import numpy as np
import pytest

import vision

RED_BGR = (0, 0, 200)
TABLE_BGR = (235, 235, 235)
STRICT = {}
LOOSE = {"min_area": 250, "min_fill": 0.45}          # the second pass, for a keychain that is partly hidden


def picture(keychain=None, bowl=None):
    img = np.full((480, 640, 3), TABLE_BGR, np.uint8)
    if bowl:
        cv2.circle(img, bowl[:2], bowl[2], RED_BGR, -1)
    if keychain:
        cv2.fillConvexPoly(img, cv2.boxPoints(keychain).astype(np.int32), RED_BGR)
    return img


def spots(img, **kw):
    return [(round(d["u"]), round(d["v"])) for d in vision.detect(img, **kw)]


def near(found, u, v, tol=4):
    return len(found) == 1 and abs(found[0][0] - u) <= tol and abs(found[0][1] - v) <= tol


@pytest.mark.parametrize("size", [(34, 20), (44, 26), (60, 30)])
@pytest.mark.parametrize("angle", [0, 25, 70, 115])
@pytest.mark.parametrize("kw", [STRICT, LOOSE], ids=["strict", "loose"])
def test_the_keychain_alone_is_found(size, angle, kw):
    assert near(spots(picture(keychain=((387, 120), size, angle)), **kw), 387, 120)


@pytest.mark.parametrize("radius", [45, 60, 75])
@pytest.mark.parametrize("kw", [STRICT, LOOSE], ids=["strict", "loose"])
def test_a_round_bowl_alone_is_never_the_keychain(radius, kw):
    assert spots(picture(bowl=(320, 300, radius)), **kw) == []


@pytest.mark.parametrize("kw", [STRICT, LOOSE], ids=["strict", "loose"])
def test_keychain_beside_a_bowl_is_the_only_thing_found(kw):
    assert near(spots(picture(keychain=((498, 150), (44, 26), 25), bowl=(250, 300, 60)), **kw), 498, 150)


@pytest.mark.xfail(strict=True, reason="known gap: a bowl cut by the picture's edge leaves a small oblong red patch that passes every filter. "
                                       "Fix idea: reject blobs that touch the border (not seeing the keychain is safe). Remove this mark when fixed.")
def test_a_bowl_cut_by_the_picture_edge_is_never_the_keychain():
    assert spots(picture(bowl=(650, 300, 55)), **STRICT) == []
