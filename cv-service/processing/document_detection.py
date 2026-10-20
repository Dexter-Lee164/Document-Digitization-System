"""Automatic document boundary detection (classical computer vision, no learned models).

Pipeline (run on a down-scaled copy for speed, results mapped back to full resolution):

1. Grayscale conversion                          cv2.cvtColor
2. Gaussian smoothing                            cv2.GaussianBlur
3. Candidate source A - edges:                   cv2.Canny (median-adaptive thresholds) + morphological closing
4. Candidate source B - brightness:              Otsu threshold + morphological closing (paper is usually brighter than its surroundings)
5. Contours                                      cv2.findContours
6. Polygon approximation                         cv2.convexHull + cv2.approxPolyDP (several epsilons), minAreaRect fallback
7. Candidate scoring (NOT "largest contour wins"): area, convexity/angles, rectangularity,
   aspect plausibility, edge support along the quad's sides and paper-vs-surround contrast.
8. Corner ordering (TL, TR, BR, BL). If nothing scores well we fall back to the full frame and say so.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .common import resize_to_max, to_gray
from .perspective import order_corners

DETECTION_MAX_DIM = 900
MIN_AREA_RATIO = 0.10
ACCEPT_SCORE = 0.50
FRAME_RATIO = 0.965


@dataclass
class DetectionResult:
    corners: np.ndarray  # (4, 2) float32 in ORIGINAL image pixel coordinates, order TL, TR, BR, BL
    detected: bool
    confidence: float
    method: str
    message: str
    details: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "corners": [[round(float(x), 2), round(float(y), 2)] for x, y in self.corners],
            "detected": self.detected,
            "confidence": round(float(self.confidence), 3),
            "method": self.method,
            "message": self.message,
            "details": self.details,
        }


def full_frame_corners(width: int, height: int) -> np.ndarray:
    return np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)


def _polygon_candidates(contour: np.ndarray) -> list[tuple[np.ndarray, str]]:
    """Turn one contour into zero or more 4-point candidates."""
    out: list[tuple[np.ndarray, str]] = []
    hull = cv2.convexHull(contour)
    peri = cv2.arcLength(hull, True)
    if peri <= 0:
        return out
    for eps in (0.015, 0.02, 0.03, 0.04, 0.06):
        approx = cv2.approxPolyDP(hull, eps * peri, True)
        if len(approx) == 4:
            out.append((approx.reshape(4, 2).astype(np.float32), f"approxPolyDP({eps})"))
            break
    # Contours that are not clean quadrilaterals (rounded corners, noise) fall back to the minimum-area rectangle
    # but only when the hull really is close to a rectangle.
    if not out:
        rect = cv2.minAreaRect(hull)
        box = cv2.boxPoints(rect).astype(np.float32)
        hull_area = cv2.contourArea(hull)
        rect_area = rect[1][0] * rect[1][1]
        if rect_area > 0 and hull_area / rect_area >= 0.88:
            out.append((box, "minAreaRect"))
    return out


def _edge_contours(gray_blur: np.ndarray) -> tuple[list[np.ndarray], np.ndarray]:
    median = float(np.median(gray_blur))
    lower = int(max(0, 0.66 * median))
    upper = int(min(255, max(lower + 30, 1.33 * median)))
    edges = cv2.Canny(gray_blur, lower, upper)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
    cnts = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[-2]
    return list(cnts), edges


def _threshold_contours(gray_blur: np.ndarray) -> list[np.ndarray]:
    _, binary = cv2.threshold(gray_blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    k = max(9, (min(gray_blur.shape[:2]) // 40) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    # closing fills the dark text holes inside the bright page, opening removes thin bright bridges
    cleaned = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, kernel)
    cnts = cv2.findContours(cleaned, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[-2]
    return list(cnts)


def _interior_angles(quad: np.ndarray) -> list[float]:
    angles = []
    for i in range(4):
        p0, p1, p2 = quad[i - 1], quad[i], quad[(i + 1) % 4]
        v1, v2 = p0 - p1, p2 - p1
        denom = np.linalg.norm(v1) * np.linalg.norm(v2)
        if denom == 0:
            return [0.0] * 4
        cosang = float(np.clip(np.dot(v1, v2) / denom, -1, 1))
        angles.append(float(np.degrees(np.arccos(cosang))))
    return angles


def _edge_support(quad: np.ndarray, edges: np.ndarray) -> float:
    """Fraction of points sampled along the quad outline that lie next to a Canny edge pixel."""
    dilated = cv2.dilate(edges, np.ones((7, 7), np.uint8))
    h, w = edges.shape
    hits = total = 0
    for i in range(4):
        a, b = quad[i], quad[(i + 1) % 4]
        length = int(np.linalg.norm(b - a))
        samples = max(8, length // 4)
        for t in np.linspace(0.0, 1.0, samples):
            x, y = a + (b - a) * t
            xi, yi = int(round(x)), int(round(y))
            if 0 <= xi < w and 0 <= yi < h:
                total += 1
                hits += 1 if dilated[yi, xi] else 0
            else:
                total += 1  # outside the frame counts as unsupported
    return hits / total if total else 0.0


def _contrast(quad: np.ndarray, gray: np.ndarray) -> float:
    """Mean brightness inside the quad minus mean brightness of a ring just outside it."""
    h, w = gray.shape
    inner = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(inner, quad.astype(np.int32), 255)
    k = max(5, min(h, w) // 25)
    outer = cv2.dilate(inner, cv2.getStructuringElement(cv2.MORPH_RECT, (2 * k + 1, 2 * k + 1)))
    ring = cv2.subtract(outer, inner)
    if cv2.countNonZero(ring) < 50 or cv2.countNonZero(inner) < 50:
        return 0.0
    return float(cv2.mean(gray, mask=inner)[0] - cv2.mean(gray, mask=ring)[0])


def _score_quad(quad: np.ndarray, gray: np.ndarray, edges: np.ndarray) -> tuple[float, dict]:
    h, w = gray.shape
    quad = order_corners(quad)
    area = float(cv2.contourArea(quad.astype(np.float32)))
    ratio = area / float(w * h)
    if ratio < MIN_AREA_RATIO:
        return 0.0, {"reason": "too small", "area_ratio": ratio}
    if not cv2.isContourConvex(quad.astype(np.float32).reshape(-1, 1, 2)):
        return 0.0, {"reason": "not convex", "area_ratio": ratio}

    angles = _interior_angles(quad)
    if min(angles) < 45 or max(angles) > 135:
        return 0.0, {"reason": "implausible angles", "angles": [round(a, 1) for a in angles]}

    top = np.linalg.norm(quad[1] - quad[0]); bottom = np.linalg.norm(quad[2] - quad[3])
    left = np.linalg.norm(quad[3] - quad[0]); right = np.linalg.norm(quad[2] - quad[1])
    width, height = (top + bottom) / 2, (left + right) / 2
    aspect = min(width, height) / max(width, height, 1e-6)
    if aspect < 0.2:
        return 0.0, {"reason": "implausible aspect", "aspect": aspect}

    rect = cv2.minAreaRect(quad.astype(np.float32))
    rect_area = max(rect[1][0] * rect[1][1], 1e-6)
    rectangularity = min(1.0, area / rect_area)

    support = _edge_support(quad, edges)
    contrast = _contrast(quad, gray)

    area_term = min(ratio / 0.55, 1.0)
    angle_term = 1.0 - min(1.0, max(abs(a - 90) for a in angles) / 45.0)
    contrast_term = float(np.clip(contrast / 50.0, -0.3, 1.0))
    score = (
        0.30 * area_term
        + 0.15 * rectangularity
        + 0.10 * angle_term
        + 0.30 * support
        + 0.15 * contrast_term
    )

    # A quad that hugs the image frame is the photo border, not a page boundary.
    margin = max(3, int(0.01 * min(h, w)))
    touching = int(np.sum((quad[:, 0] <= margin) | (quad[:, 0] >= w - 1 - margin) | (quad[:, 1] <= margin) | (quad[:, 1] >= h - 1 - margin)))
    if ratio > FRAME_RATIO or touching == 4 and ratio > 0.9:
        score *= 0.25

    return float(score), {
        "area_ratio": round(ratio, 3),
        "rectangularity": round(rectangularity, 3),
        "edge_support": round(support, 3),
        "contrast": round(contrast, 1),
        "angles": [round(a, 1) for a in angles],
    }


def detect_document(img: np.ndarray) -> DetectionResult:
    """Detect the four corners of the page in ``img`` (BGR uint8). Never raises for "not found"."""
    h, w = img.shape[:2]
    small, scale = resize_to_max(img, DETECTION_MAX_DIM)
    gray = to_gray(small)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)

    edge_cnts, edges = _edge_contours(blur)
    thresh_cnts = _threshold_contours(blur)

    sh, sw = gray.shape
    min_area = MIN_AREA_RATIO * sw * sh
    pool: list[tuple[np.ndarray, str]] = []
    for source, cnts in (("edges", edge_cnts), ("brightness", thresh_cnts)):
        big = sorted((c for c in cnts if cv2.contourArea(c) >= min_area), key=cv2.contourArea, reverse=True)[:8]
        for c in big:
            for quad, how in _polygon_candidates(c):
                pool.append((quad, f"{source}/{how}"))

    best: tuple[float, np.ndarray, str, dict] | None = None
    for quad, how in pool:
        score, info = _score_quad(quad, gray, edges)
        if best is None or score > best[0]:
            best = (score, order_corners(quad), how, info)

    if best is not None and best[0] >= ACCEPT_SCORE:
        corners = (best[1] / scale).astype(np.float32)
        corners[:, 0] = np.clip(corners[:, 0], 0, w - 1)
        corners[:, 1] = np.clip(corners[:, 1], 0, h - 1)
        return DetectionResult(
            corners=corners,
            detected=True,
            confidence=min(1.0, best[0]),
            method=best[2],
            message="Document boundary detected. Drag the corner handles if it is not exact.",
            details={**best[3], "candidates_evaluated": len(pool), "detection_scale": round(scale, 4)},
        )

    reason = "No clear document boundary was found; the full image is used."
    if best is not None and best[3].get("area_ratio", 0) > FRAME_RATIO:
        reason = "The page appears to fill the whole image; the full image is used."
    return DetectionResult(
        corners=full_frame_corners(w, h),
        detected=False,
        confidence=0.0,
        method="full_frame",
        message=reason + " Adjust the corners manually if needed.",
        details={"candidates_evaluated": len(pool), "best_score": round(best[0], 3) if best else None},
    )
