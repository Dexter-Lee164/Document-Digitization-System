"""Template based structured form digitization.

Design rules (see README "Known limitations"):

* Only forms that ship with a template are understood. ``identify_form`` OCRs the template's title region and
  fuzzy-matches the expected keywords; if the page does not match, the caller falls back to general text OCR.
* Fields are located by RELATIVE regions (fractions of the flattened, upright page), so the same template works
  at any scan resolution. The page is first resampled to the template's canonical size.
* Each region is cleaned (ruling-line removal), upscaled and OCR'd with its own page-segmentation mode and optional
  character whitelist.
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

import config as service_config
from processing.common import ParameterError, to_gray

from . import recognition
from .layout import text_from_words

REVIEW_CONFIDENCE = 70.0


@lru_cache(maxsize=1)
def _template_dir() -> Path:
    return service_config.SERVICE_ROOT / "templates"


@lru_cache(maxsize=8)
def load_template(template_id: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", template_id or ""):
        raise ParameterError("Invalid template id.")
    for path in _template_dir().glob("*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("id") == template_id:
            return data
    raise ParameterError(f"Unknown form template '{template_id}'.")


def list_templates() -> list[dict]:
    out = []
    for path in sorted(_template_dir().glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        out.append({"id": data["id"], "name": data["name"], "title": data["title"], "fields": [{"key": f["key"], "label": f["label"], "type": f["type"]} for f in data["fields"]]})
    return out


def _canonical_gray(img: np.ndarray, template: dict) -> np.ndarray:
    gray = to_gray(img)
    cw, ch = template["canonical_size"]
    interp = cv2.INTER_AREA if gray.shape[1] > cw else cv2.INTER_CUBIC
    return cv2.resize(gray, (cw, ch), interpolation=interp)


def _crop(gray: np.ndarray, region: list[float], pad: int = 0) -> np.ndarray:
    h, w = gray.shape
    x, y, rw, rh = region
    x0 = max(0, int(round(x * w)) - pad)
    y0 = max(0, int(round(y * h)) - pad)
    x1 = min(w, int(round((x + rw) * w)) + pad)
    y1 = min(h, int(round((y + rh) * h)) + pad)
    return gray[y0:y1, x0:x1]


def remove_ruling_lines(gray_crop: np.ndarray) -> np.ndarray:
    """Remove long horizontal/vertical rules (underlines, box borders) so they are not read as characters or
    glued to the text. Returns dark text on white."""
    h, w = gray_crop.shape
    _, ink = cv2.threshold(gray_crop, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    horiz = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(15, int(w * 0.35)), 1)))
    vert = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(15, int(h * 0.7)))))
    lines = cv2.dilate(cv2.bitwise_or(horiz, vert), np.ones((3, 3), np.uint8))
    cleaned = cv2.bitwise_and(ink, cv2.bitwise_not(lines))
    return cv2.bitwise_not(cleaned)


def _prepare_region(gray_crop: np.ndarray) -> np.ndarray:
    cleaned = remove_ruling_lines(gray_crop)
    scale = 2.0 if cleaned.shape[0] < 120 else 1.0
    if scale > 1:
        cleaned = cv2.resize(cleaned, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return cv2.copyMakeBorder(cleaned, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=255)


def _clean_value(value: str, ftype: str) -> str:
    value = re.sub(r"[\x00-\x1f]+", " ", value or "")
    value = re.sub(r"\s+", " ", value).strip(" |_~`\\")
    if ftype == "id":
        value = re.sub(r"[^0-9\-]", "", value).strip("-")
    elif ftype == "phone":
        value = re.sub(r"[^0-9+\-() ]", "", value).strip()
    elif ftype == "date":
        value = re.sub(r"[^0-9A-Za-z/.\- ,]", "", value).strip()
    return value


_NAME_OK = re.compile(r"[^\W\d_]+(?:[ .,'\-]+[^\W\d_]+)*[ .]?", re.UNICODE)
_DATE_OK = re.compile(r"^(?:\d{1,4}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}[ \-]?[A-Za-z]{3,9}[ ,.\-]*\d{2,4}|[A-Za-z]{3,9}[ .]\d{1,2},?[ ]\d{2,4})$")


def check_plausible(value: str, ftype: str) -> str | None:
    """Return why a value does not look like its field type (or None when it is plausible).

    OCR sometimes confuses a letter with a symbol (for example J read as '|'); the engine's confidence for the whole line can still be high,
    so the content itself is checked. A failed check never changes the text, it only marks the field for the user to review."""
    if not value:
        return "Nothing was read in this box."
    if ftype == "name":
        if not _NAME_OK.fullmatch(value):
            return "A name should only contain letters, spaces and . , ' - (a symbol or digit was read)."
    elif ftype == "id":
        if not re.fullmatch(r"\d+(?:-\d+)*", value) or len(re.sub(r"\D", "", value)) < 4:
            return "An ID number should be digits (with hyphens) - fewer than 4 digits were read."
    elif ftype == "phone":
        digits = re.sub(r"\D", "", value)
        if not 7 <= len(digits) <= 15:
            return "A phone number has 7 to 15 digits."
    elif ftype == "date":
        if not _DATE_OK.match(value.strip()):
            return "This does not look like a date."
    else:
        letters = sum(ch.isalnum() for ch in value)
        if "|" in value or "_" in value or letters < 0.7 * len(value.replace(" ", "")):
            return "The text contains symbols that are probably misread characters."
    return None


def _ocr_region(gray: np.ndarray, field: dict) -> dict:
    crop = _crop(gray, field["region"], pad=2)
    prepared = _prepare_region(crop)
    extra = f"-c tessedit_char_whitelist={field['whitelist']}" if field.get("whitelist") else ""
    words = recognition.recognize_data_only(prepared, psm=int(field.get("psm", 7)), timeout=30, extra_config=extra)
    raw = text_from_words(words).replace("\n", " ")
    value = _clean_value(raw, field.get("type", "text"))
    confs = [w["conf"] for w in words]
    conf = round(sum(confs) / len(confs), 1) if confs else None
    ftype = field.get("type", "text")
    reason = check_plausible(value, ftype)
    if reason is None and (conf is None or conf < REVIEW_CONFIDENCE):
        reason = f"The text engine was not sure about this one ({'no confidence' if conf is None else f'{conf:g}%'})."
    return {
        "key": field["key"],
        "label": field["label"],
        "type": field.get("type", "text"),
        "value": value,
        "original_value": value,
        "confidence": conf,
        "needs_review": reason is not None,
        "reason": reason,
        "region": field["region"],
    }


def identify_form(img: np.ndarray, template: dict) -> dict:
    gray = _canonical_gray(img, template)
    ident = template["identification"]
    crop = _crop(gray, ident["region"], pad=6)
    prepared = _prepare_region(crop)
    words = recognition.recognize_data_only(prepared, psm=int(ident.get("psm", 7)), timeout=30)
    tokens = [re.sub(r"[^A-Z]", "", w["text"].upper()) for w in words]
    keywords = [k.upper() for k in ident["keywords"]]
    hits = 0
    for kw in keywords:
        if any(t and SequenceMatcher(None, t, kw).ratio() >= 0.8 for t in tokens):
            hits += 1
    score = hits / len(keywords) if keywords else 0.0
    return {"matched": score >= float(ident.get("min_ratio", 0.66)), "score": round(score, 3), "keywords_found": hits, "keywords_expected": len(keywords)}


def extract_fields(img: np.ndarray, template_id: str, skip_identification: bool = False) -> dict:
    """Identify the form and read every template field. ``fields`` is empty when the page does not match."""
    template = load_template(template_id)
    ident = {"matched": True, "score": 1.0, "skipped": True} if skip_identification else identify_form(img, template)
    result = {
        "template_id": template["id"],
        "template_name": template["name"],
        "title": template["title"],
        "matched": ident["matched"],
        "match_score": ident["score"],
        "fields": [],
    }
    if not ident["matched"]:
        result["message"] = (
            "This page does not look like the supported template "
            f"('{template['title']}'). Showing general text instead."
        )
        return result
    gray = _canonical_gray(img, template)
    with ThreadPoolExecutor(max_workers=2) as pool:
        result["fields"] = list(pool.map(lambda f: _ocr_region(gray, f), template["fields"]))
    result["message"] = f"{sum(1 for f in result['fields'] if f['value'])} of {len(result['fields'])} fields were read; please verify each value."
    return result
