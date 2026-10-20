"""Geometry pipeline: boundary detection -> perspective correction -> orientation -> deskew -> manual adjustments."""
from __future__ import annotations

import time

import numpy as np

from .deskew import deskew, rotate_image
from .document_detection import detect_document, full_frame_corners
from .orientation import detect_orientation, rotate_quarter
from .perspective import four_point_transform, plan_output, validate_corners


def _is_full_frame(corners: np.ndarray, w: int, h: int, tol: float = 0.01) -> bool:
    ref = full_frame_corners(w, h)
    return bool(np.all(np.abs(corners - ref)[:, 0] <= tol * w) and np.all(np.abs(corners - ref)[:, 1] <= tol * h))


def run_geometry(
    img: np.ndarray,
    corners=None,
    auto_detect: bool = True,
    auto_orient: bool = True,
    auto_deskew: bool = True,
    manual_rotation: int = 0,
    manual_angle: float = 0.0,
) -> tuple[np.ndarray, dict]:
    """Return (corrected BGR image, report).

    * ``corners`` (user supplied, ORIGINAL pixel coordinates) always wins over auto detection.
    * ``manual_rotation`` (clockwise, multiple of 90) and ``manual_angle`` (degrees, positive = clockwise) are
      applied on top of the automatic corrections, so "rotate" buttons are always additive.
    """
    timings: dict[str, float] = {}
    h, w = img.shape[:2]
    report: dict = {"input_size": [w, h]}

    t0 = time.perf_counter()
    if corners is not None:
        used = validate_corners(corners, w, h)
        report["corners_source"] = "manual"
        report["detection"] = None
    elif auto_detect:
        det = detect_document(img)
        used = validate_corners(det.corners, w, h)
        report["corners_source"] = "auto" if det.detected else "full_frame"
        report["detection"] = det.to_dict()
    else:
        used = validate_corners(full_frame_corners(w, h), w, h)
        report["corners_source"] = "full_frame"
        report["detection"] = None
    timings["detect_ms"] = (time.perf_counter() - t0) * 1000
    report["corners"] = [[round(float(x), 2), round(float(y), 2)] for x, y in used]

    t0 = time.perf_counter()
    if _is_full_frame(used, w, h):
        out = img
        report["perspective"] = {"applied": False, "note": "Corners cover the whole image; no warp needed."}
    else:
        out, matrix = four_point_transform(img, used)
        plan = plan_output(used, (w, h))
        report["perspective"] = {
            "applied": True,
            "output_size": [out.shape[1], out.shape[0]],
            "size_method": plan["method"],
            "page_aspect_ratio": plan["aspect_ratio"],
            "homography": [[round(float(v), 6) for v in row] for row in matrix],
        }
    timings["perspective_ms"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    if auto_orient:
        ori = detect_orientation(out)
        if ori.reliable and ori.angle_cw:
            out = rotate_quarter(out, ori.angle_cw)
        report["orientation"] = {"enabled": True, **ori.to_dict(), "applied_cw": ori.angle_cw if ori.reliable else 0}
    else:
        report["orientation"] = {"enabled": False, "applied_cw": 0}
    timings["orientation_ms"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    if auto_deskew:
        out, skew = deskew(out)
        report["deskew"] = {"enabled": True, **skew.to_dict(), "applied": skew.reliable and skew.angle != 0.0}
    else:
        report["deskew"] = {"enabled": False, "applied": False}
    timings["deskew_ms"] = (time.perf_counter() - t0) * 1000

    if manual_rotation:
        out = rotate_quarter(out, manual_rotation)
    if manual_angle:
        out = rotate_image(out, -float(manual_angle))
    report["manual"] = {"rotation_cw": int(manual_rotation), "angle_cw": float(manual_angle)}
    report["output_size"] = [out.shape[1], out.shape[0]]
    report["timings_ms"] = {k: round(v, 1) for k, v in timings.items()}
    report["total_ms"] = round(sum(timings.values()), 1)
    return out, report
