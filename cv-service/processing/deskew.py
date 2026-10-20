"""Small-angle skew estimation and correction.

Method: **projection-profile analysis**.

The page is binarised (adaptive threshold, text = white) at reduced size and rotated through a range of
candidate angles. For each angle the horizontal projection profile (row sums) is computed. When text lines are
exactly horizontal the profile alternates between sharp peaks (text lines) and deep valleys (line gaps), so the
profile *variance* is maximal. A coarse 1 degree search is followed by a 0.1 degree refinement.

Why not Hough lines? Hough needs long straight edges and several tuned thresholds; paragraphs of text, forms with
few ruling lines and photographs with blur make it unstable. The projection profile uses every text pixel, is
deterministic, has no threshold tuning, and gives sub-degree accuracy on the +-15 degree skews typical of
hand-held photographs. Its weakness (pages dominated by large photos/graphics, almost no text) is detected via a
confidence ratio and reported instead of guessed.

Sign convention: angles follow OpenCV - positive = counter-clockwise rotation of the image.
``estimate_skew`` returns the correction angle to pass to ``rotate_image``.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .common import border_fill_value, resize_to_max, to_gray

MAX_SKEW_DEGREES = 15.0
MIN_APPLY_DEGREES = 0.15
MIN_CONFIDENCE = 1.12


@dataclass
class SkewResult:
    angle: float  # correction angle (deg, OpenCV: positive = counter-clockwise)
    confidence: float
    reliable: bool
    message: str

    def to_dict(self) -> dict:
        return {
            "angle": round(float(self.angle), 2),
            "confidence": round(float(self.confidence), 3),
            "reliable": self.reliable,
            "message": self.message,
        }


def _binarise_text(gray: np.ndarray) -> np.ndarray:
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    block = max(15, (min(gray.shape[:2]) // 20) | 1)
    return cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 15)


def _rotate_binary(binary: np.ndarray, angle: float) -> np.ndarray:
    h, w = binary.shape
    matrix = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle, 1.0)
    return cv2.warpAffine(binary, matrix, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)


def _profile_score(binary: np.ndarray, angle: float) -> float:
    rotated = _rotate_binary(binary, angle)
    rows = rotated.sum(axis=1, dtype=np.float64) / 255.0
    return float(np.var(rows))


def estimate_skew(img: np.ndarray, max_angle: float = MAX_SKEW_DEGREES) -> SkewResult:
    gray = to_gray(img)
    small, _ = resize_to_max(gray, 1100)
    binary = _binarise_text(small)

    # Ignore pages with (almost) no ink - nothing to align to.
    ink = float(np.count_nonzero(binary)) / binary.size
    if ink < 0.004:
        return SkewResult(0.0, 0.0, False, "Not enough text/ink to measure skew.")

    coarse_angles = np.arange(-max_angle, max_angle + 0.001, 1.0)
    coarse = np.array([_profile_score(binary, a) for a in coarse_angles])
    best_coarse = float(coarse_angles[int(np.argmax(coarse))])

    fine_angles = np.arange(best_coarse - 1.0, best_coarse + 1.0001, 0.1)
    fine = np.array([_profile_score(binary, a) for a in fine_angles])
    best_idx = int(np.argmax(fine))
    best_angle = float(fine_angles[best_idx])

    mean_score = float(np.mean(coarse))
    confidence = float(fine[best_idx] / mean_score) if mean_score > 0 else 0.0
    reliable = confidence >= MIN_CONFIDENCE
    if not reliable:
        return SkewResult(0.0, confidence, False, "Skew measurement was not distinct enough to trust; left unchanged.")
    # best_angle is the rotation that *made the lines horizontal* in the rotated copy, i.e. exactly the correction.
    if abs(best_angle) < MIN_APPLY_DEGREES:
        return SkewResult(0.0, confidence, True, "Page is already level.")
    return SkewResult(best_angle, confidence, True, f"Detected skew; correcting by {best_angle:+.1f} degrees.")


def rotate_image(img: np.ndarray, angle: float, expand: bool = True) -> np.ndarray:
    """Rotate by ``angle`` degrees (positive = counter-clockwise). The canvas grows so no content is cut and the
    exposed corners are filled with the image border colour (usually paper white)."""
    if abs(angle) < 1e-6:
        return img
    h, w = img.shape[:2]
    centre = (w / 2.0, h / 2.0)
    matrix = cv2.getRotationMatrix2D(centre, angle, 1.0)
    if expand:
        cos, sin = abs(matrix[0, 0]), abs(matrix[0, 1])
        new_w = int(round(h * sin + w * cos))
        new_h = int(round(h * cos + w * sin))
        matrix[0, 2] += new_w / 2.0 - centre[0]
        matrix[1, 2] += new_h / 2.0 - centre[1]
    else:
        new_w, new_h = w, h
    fill = border_fill_value(img)
    border = fill if img.ndim == 3 else int(fill[0])
    return cv2.warpAffine(img, matrix, (new_w, new_h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=border)


def deskew(img: np.ndarray, max_angle: float = MAX_SKEW_DEGREES) -> tuple[np.ndarray, SkewResult]:
    result = estimate_skew(img, max_angle)
    if result.reliable and result.angle != 0.0:
        return rotate_image(img, result.angle), result
    return img, result
