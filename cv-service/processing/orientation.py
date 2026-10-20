"""Page orientation correction for 0 / 90 / 180 / 270 degree rotations.

Strategy (most to least trusted):

1. **Tesseract OSD** (``--psm 0``) on a down-scaled copy. Accepted when its orientation confidence is high enough.
2. **OCR-score fallback** when OSD fails or is unsure (sparse text, forms, small pages). A projection-profile test
   first decides whether text lines run horizontally (0/180) or vertically (90/270); the two remaining candidates
   are each OCR'd and the one that yields clearly more confident, word-like text wins. A margin is required,
   otherwise the result is flagged *unreliable* and the page is left as is.
3. If Tesseract is not available at all, orientation is skipped with an explanatory message (the user can still
   rotate manually).

Convention: ``angle_cw`` is the number of degrees the image must be rotated *clockwise* to become upright.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from ocr import recognition
from ocr.recognition import OcrError, OcrUnavailableError

from .common import resize_to_max, to_gray

OSD_MIN_CONFIDENCE = 1.5
FALLBACK_MARGIN = 1.25


@dataclass
class OrientationResult:
    angle_cw: int
    confidence: float
    method: str
    reliable: bool
    message: str

    def to_dict(self) -> dict:
        return {
            "angle_cw": int(self.angle_cw),
            "confidence": round(float(self.confidence), 3),
            "method": self.method,
            "reliable": self.reliable,
            "message": self.message,
        }


def rotate_quarter(img: np.ndarray, angle_cw: int) -> np.ndarray:
    """Rotate by a multiple of 90 degrees clockwise (lossless)."""
    angle = int(angle_cw) % 360
    if angle == 0:
        return img
    code = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}.get(angle)
    if code is None:
        raise ValueError("angle must be a multiple of 90")
    return cv2.rotate(img, code)


def _text_runs_horizontally(gray: np.ndarray) -> tuple[bool | None, float]:
    """Projection-profile test. Returns (horizontal?, ratio). ``None`` when ambiguous."""
    small, _ = resize_to_max(gray, 900)
    blur = cv2.GaussianBlur(small, (3, 3), 0)
    block = max(15, (min(small.shape[:2]) // 20) | 1)
    binary = cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 15)
    if np.count_nonzero(binary) / binary.size < 0.004:
        return None, 1.0
    row_var = float(np.var(binary.sum(axis=1, dtype=np.float64)))
    col_var = float(np.var(binary.sum(axis=0, dtype=np.float64)))
    if row_var <= 0 or col_var <= 0:
        return None, 1.0
    ratio = row_var / col_var
    if ratio > 1.3:
        return True, ratio
    if ratio < 1 / 1.3:
        return False, ratio
    return None, ratio


def _word_score(words: list[dict]) -> float:
    """Sum of confidences of plausible word tokens - larger when the page is read in the right direction."""
    score = 0.0
    for w in words:
        text = w["text"]
        letters = sum(ch.isalpha() for ch in text)
        if len(text) >= 3 and letters >= max(2, int(0.6 * len(text))) and w["conf"] >= 30:
            score += w["conf"]
    return score


def _ocr_score_fallback(gray: np.ndarray) -> OrientationResult:
    small, _ = resize_to_max(gray, 1000)
    horizontal, ratio = _text_runs_horizontally(small)
    if horizontal is True:
        candidates = [0, 180]
    elif horizontal is False:
        candidates = [90, 270]
    else:
        candidates = [0, 90, 180, 270]

    scores: dict[int, float] = {}
    for angle in candidates:
        rotated = rotate_quarter(small, angle)
        try:
            words = recognition.recognize_data_only(rotated, psm=6, timeout=40)
        except OcrUnavailableError:
            raise
        except OcrError:
            words = []
        scores[angle] = _word_score(words)

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best_angle, best = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    if best <= 0:
        return OrientationResult(0, 0.0, "ocr_score", False, "No readable text found in any orientation; left unchanged.")
    margin = best / second if second > 0 else float("inf")
    if margin < FALLBACK_MARGIN:
        return OrientationResult(0, min(margin, 99.0), "ocr_score", False, "Orientation could not be determined reliably; left unchanged.")
    msg = "Page is upright." if best_angle == 0 else f"Page rotated {best_angle} degrees; correcting."
    return OrientationResult(best_angle, min(margin, 99.0), "ocr_score", True, msg)


def detect_orientation(img: np.ndarray) -> OrientationResult:
    gray = to_gray(img)
    small, _ = resize_to_max(gray, 1600)
    osd_note = ""
    try:
        data = recognition.osd(small)
        angle = int(data.get("rotate", 0)) % 360
        conf = float(data.get("orientation_conf", 0.0))
        if conf >= OSD_MIN_CONFIDENCE and angle in (0, 90, 180, 270):
            msg = "Page is upright." if angle == 0 else f"Tesseract OSD reports the page must be rotated {angle} degrees clockwise."
            return OrientationResult(angle, conf, "tesseract_osd", True, msg)
        osd_note = f"OSD confidence too low ({conf:.1f}); "
    except OcrUnavailableError as exc:
        return OrientationResult(0, 0.0, "unavailable", False, f"Orientation detection skipped: {exc}")
    except OcrError as exc:
        osd_note = f"OSD unavailable ({str(exc)[:80]}); "

    try:
        result = _ocr_score_fallback(gray)
    except OcrUnavailableError as exc:
        return OrientationResult(0, 0.0, "unavailable", False, f"Orientation detection skipped: {exc}")
    result.message = osd_note + "used OCR scoring. " + result.message
    return result
