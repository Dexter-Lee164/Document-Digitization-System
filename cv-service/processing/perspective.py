"""Four-point perspective correction ("flattening" a photographed page)."""
from __future__ import annotations

import math

import cv2
import numpy as np

from .common import InvalidCornersError

MAX_OUTPUT_SIDE = 4500
MIN_SIDE_PX = 20.0


def order_corners(pts) -> np.ndarray:
    """Return the four points ordered TL, TR, BR, BL.

    Points are sorted clockwise around their centroid (guaranteeing a simple, non self-crossing polygon for
    any input order) and the sequence is rotated so it starts at the point with the smallest x + y (top-left).
    """
    arr = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    centre = arr.mean(axis=0)
    angles = np.arctan2(arr[:, 1] - centre[1], arr[:, 0] - centre[0])  # image y axis points down => clockwise
    ordered = arr[np.argsort(angles)]
    start = int(np.argmin(ordered[:, 0] + ordered[:, 1]))
    return np.roll(ordered, -start, axis=0).astype(np.float32)


def validate_corners(pts, width: int, height: int, tolerance: float = 0.02) -> np.ndarray:
    """Validate user/auto supplied corners against an image of ``width`` x ``height``.

    Raises InvalidCornersError with an actionable message. Returns ordered float32 corners clipped into the frame.
    """
    try:
        arr = np.asarray(pts, dtype=np.float32)
    except (TypeError, ValueError) as exc:
        raise InvalidCornersError("Corners must be four [x, y] number pairs.") from exc
    if arr.shape != (4, 2):
        raise InvalidCornersError("Exactly four corner points ([x, y] pairs) are required.")
    if not np.all(np.isfinite(arr)):
        raise InvalidCornersError("Corner coordinates must be finite numbers.")

    tol_x, tol_y = width * tolerance, height * tolerance
    if (arr[:, 0] < -tol_x).any() or (arr[:, 0] > width - 1 + tol_x).any() or (arr[:, 1] < -tol_y).any() or (arr[:, 1] > height - 1 + tol_y).any():
        raise InvalidCornersError("One or more corners lie outside the image.")
    arr[:, 0] = np.clip(arr[:, 0], 0, width - 1)
    arr[:, 1] = np.clip(arr[:, 1], 0, height - 1)

    ordered = order_corners(arr)
    sides = [np.linalg.norm(ordered[(i + 1) % 4] - ordered[i]) for i in range(4)]
    if min(sides) < MIN_SIDE_PX:
        raise InvalidCornersError("Two corners are (almost) identical; the selected region is too small.")
    if not cv2.isContourConvex(ordered.reshape(-1, 1, 2)):
        raise InvalidCornersError("The corners do not form a convex quadrilateral. Re-order or move the handles.")
    area = cv2.contourArea(ordered)
    if area < 0.01 * width * height:
        raise InvalidCornersError("The selected region covers less than 1% of the image.")
    return ordered


def estimate_aspect_ratio(ordered: np.ndarray, image_size: tuple[int, int]) -> float | None:
    """Estimate the TRUE width/height ratio of the photographed rectangle (Zhang & Zhang, 2007).

    Under a pinhole camera with square pixels and the principal point at the image centre, the four image
    corners of a planar rectangle determine both the focal length and the rectangle's aspect ratio - even under
    strong perspective, where the measured edge lengths alone would stretch the page. Returns None when the
    quadrilateral is (nearly) an affine image of a rectangle, where the model is degenerate."""
    w_img, h_img = image_size
    u0, v0 = (w_img - 1) / 2.0, (h_img - 1) / 2.0
    tl, tr, br, bl = (np.asarray(p, dtype=np.float64) for p in ordered)
    m1, m2, m3, m4 = (np.array([p[0], p[1], 1.0]) for p in (tl, tr, bl, br))
    try:
        k2 = np.dot(np.cross(m1, m4), m3) / np.dot(np.cross(m2, m4), m3)
        k3 = np.dot(np.cross(m1, m4), m2) / np.dot(np.cross(m3, m4), m2)
        n2, n3 = k2 * m2 - m1, k3 * m3 - m1
        n21, n22, n23 = n2
        n31, n32, n33 = n3
        if abs(n23) < 1e-9 or abs(n33) < 1e-9:
            return None
        f2 = -1.0 / (n23 * n33) * (
            (n21 * n31 - (n21 * n33 + n23 * n31) * u0 + n23 * n33 * u0 ** 2)
            + (n22 * n32 - (n22 * n33 + n23 * n32) * v0 + n23 * n33 * v0 ** 2)
        )
        if not np.isfinite(f2) or f2 <= 0:
            return None
        f = math.sqrt(f2)
        a_inv = np.linalg.inv(np.array([[f, 0, u0], [0, f, v0], [0, 0, 1.0]]))
        v2, v3 = a_inv @ n2, a_inv @ n3
        ratio2 = float(v2 @ v2) / float(v3 @ v3)
        if not np.isfinite(ratio2) or ratio2 <= 0:
            return None
        return math.sqrt(ratio2)
    except (FloatingPointError, ZeroDivisionError, np.linalg.LinAlgError):
        return None


def plan_output(ordered: np.ndarray, image_size: tuple[int, int] | None = None, max_side: int = MAX_OUTPUT_SIDE) -> dict:
    """Choose the output rectangle size.

    The measured longest opposite edges give a baseline (no side of the page is ever shrunk). When the camera
    model yields a plausible true aspect ratio the page is un-stretched to that ratio while still keeping the
    larger linear resolution on both axes."""
    tl, tr, br, bl = ordered
    base_w = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    base_h = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    width, height, method, ratio = base_w, base_h, "edge_lengths", None
    if image_size is not None:
        ratio = estimate_aspect_ratio(ordered, image_size)
        naive = base_w / base_h
        if ratio is not None and 0.2 < ratio < 5 and abs(math.log(ratio / naive)) < math.log(1.45):
            width = max(base_w, ratio * base_h)
            height = width / ratio
            method = "camera_model"
        else:
            ratio = None
    scale = min(1.0, max_side / max(width, height))
    return {
        "width": max(2, int(round(width * scale))),
        "height": max(2, int(round(height * scale))),
        "method": method,
        "aspect_ratio": round(float(ratio), 4) if ratio else round(float(base_w / base_h), 4),
    }


def output_size(ordered: np.ndarray, max_side: int = MAX_OUTPUT_SIDE, image_size: tuple[int, int] | None = None) -> tuple[int, int]:
    plan = plan_output(ordered, image_size, max_side)
    return plan["width"], plan["height"]


def four_point_transform(img: np.ndarray, pts, max_side: int = MAX_OUTPUT_SIDE) -> tuple[np.ndarray, np.ndarray]:
    """Warp the quadrilateral ``pts`` of ``img`` to an upright rectangle.

    Returns (warped_image, 3x3 homography). Uses cv2.getPerspectiveTransform / cv2.warpPerspective.
    """
    h, w = img.shape[:2]
    ordered = validate_corners(pts, w, h)
    out_w, out_h = output_size(ordered, max_side, image_size=(w, h))
    dst = np.array([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(ordered, dst)
    warped = cv2.warpPerspective(img, matrix, (out_w, out_h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return warped, matrix
