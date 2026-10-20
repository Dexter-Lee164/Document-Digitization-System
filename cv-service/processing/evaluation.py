"""DSP experiment runner: compares OCR with and without the image-processing stages and computes CER / WER
against a user supplied, manually transcribed reference text.

Configurations
    A  OCR on the unmodified image (no geometry, no enhancement)
    B  perspective + orientation + deskew correction, then OCR
    C  DSP enhancement only (on the unmodified geometry), then OCR
    D  complete pipeline (geometry + enhancement), then OCR

CER/WER are only computed when a reference transcription is provided - accuracy cannot be measured without ground truth.
Tesseract's own confidence is reported separately and is NOT an accuracy percentage.
"""
from __future__ import annotations

import re
import time
from typing import Any, Callable

import numpy as np

from ocr import recognition

from .enhancement import enhance, resolve_params
from .common import to_gray
from .pipeline import run_geometry

CONFIG_LABELS = {
    "A": "A - OCR without enhancement",
    "B": "B - Perspective + orientation + deskew, then OCR",
    "C": "C - Image enhancement only, then OCR",
    "D": "D - Complete pipeline, then OCR",
}


# ----------------------------------------------------------------------------- edit distance (Myers / Hyyro bit-parallel)
def edit_distance(a, b) -> int:
    """Levenshtein distance between two sequences (strings or lists of tokens).

    Uses the bit-parallel algorithm of Myers (1999) / Hyyro (2003) with Python big integers, so even long pages are
    processed in milliseconds instead of the seconds a quadratic dynamic program needs."""
    if len(a) == 0:
        return len(b)
    if len(b) == 0:
        return len(a)
    m = len(a)
    peq: dict[Any, int] = {}
    for i, symbol in enumerate(a):
        peq[symbol] = peq.get(symbol, 0) | (1 << i)
    mask = (1 << m) - 1
    high = 1 << (m - 1)
    pv, mv, score = mask, 0, m
    for symbol in b:
        eq = peq.get(symbol, 0)
        xv = eq | mv
        xh = (((eq & pv) + pv) ^ pv) | eq
        ph = mv | (~(xh | pv) & mask)
        mh = pv & xh
        if ph & high:
            score += 1
        elif mh & high:
            score -= 1
        ph = ((ph << 1) | 1) & mask
        mh = (mh << 1) & mask
        pv = (mh | (~(xv | ph) & mask)) & mask
        mv = ph & xv
    return score


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("\x0c", " ")).strip()


def cer(reference: str, hypothesis: str) -> float | None:
    ref, hyp = _normalise(reference), _normalise(hypothesis)
    if not ref:
        return None
    return edit_distance(ref, hyp) / len(ref)


def wer(reference: str, hypothesis: str) -> float | None:
    ref, hyp = _normalise(reference).split(), _normalise(hypothesis).split()
    if not ref:
        return None
    return edit_distance(ref, hyp) / len(ref)


# ----------------------------------------------------------------------------- runner
def _timed(fn: Callable[[], Any]) -> tuple[Any, float]:
    t0 = time.perf_counter()
    out = fn()
    return out, (time.perf_counter() - t0) * 1000.0


def run_experiments(
    img: np.ndarray,
    configs: list[str],
    enhance_preset: str = "document_scan",
    enhance_params: dict | None = None,
    geometry_kwargs: dict | None = None,
    reference_text: str | None = None,
    psm: int = 3,
) -> dict:
    """Execute the requested configurations and return one result row per configuration."""
    configs = [c for c in configs if c in CONFIG_LABELS]
    geometry_kwargs = geometry_kwargs or {}
    results: list[dict] = []

    geo_cache: dict[str, Any] = {}

    def geometry():
        if "img" not in geo_cache:
            (corrected, report), ms = _timed(lambda: run_geometry(img, **geometry_kwargs))
            geo_cache.update(img=corrected, report=report, ms=ms)
        return geo_cache["img"], geo_cache["ms"], geo_cache["report"]

    def enhance_on(source: np.ndarray) -> tuple[np.ndarray, float, dict]:
        def go():
            params, _ = resolve_params(enhance_preset, enhance_params, to_gray(source))
            return enhance(source, params)

        (out, rep), ms = _timed(go)
        return out, ms, rep

    for cfg in configs:
        geometry_ms = enhance_ms = 0.0
        notes: list[str] = []
        if cfg == "A":
            ocr_input = img
        elif cfg == "B":
            ocr_input, geometry_ms, rep = geometry()
            notes.append(f"corners: {rep['corners_source']}, orientation applied: {rep['orientation']['applied_cw']} deg, deskew applied: {rep['deskew'].get('applied')}")
        elif cfg == "C":
            ocr_input, enhance_ms, _ = enhance_on(img)
        else:  # D
            corrected, geometry_ms, rep = geometry()
            ocr_input, enhance_ms, _ = enhance_on(corrected)
            notes.append(f"corners: {rep['corners_source']}, preset: {enhance_preset}")

        try:
            result = recognition.recognize(ocr_input, psm=psm)
            ocr_ms = float(result.duration_ms)
            row = {
                "config": cfg,
                "label": CONFIG_LABELS[cfg],
                "geometry_ms": round(geometry_ms, 1),
                "enhancement_ms": round(enhance_ms, 1),
                "ocr_ms": round(ocr_ms, 1),
                "total_ms": round(geometry_ms + enhance_ms + ocr_ms, 1),
                "confidence": result.confidence,
                "word_count": result.confidence["word_count"],
                "text": result.text,
                "cer": None,
                "wer": None,
                "notes": notes,
                "error": None,
            }
            if reference_text and reference_text.strip():
                row["cer"] = round(cer(reference_text, result.text), 4)
                row["wer"] = round(wer(reference_text, result.text), 4)
        except recognition.OcrError as exc:
            row = {"config": cfg, "label": CONFIG_LABELS[cfg], "geometry_ms": round(geometry_ms, 1), "enhancement_ms": round(enhance_ms, 1), "ocr_ms": 0.0, "total_ms": round(geometry_ms + enhance_ms, 1), "confidence": None, "word_count": 0, "text": "", "cer": None, "wer": None, "notes": notes, "error": str(exc)}
        results.append(row)

    return {
        "results": results,
        "reference_provided": bool(reference_text and reference_text.strip()),
        "preset": enhance_preset,
        "note": "Tesseract confidence is the engine's self-reported certainty, not verified accuracy. CER/WER require a manual reference transcription.",
    }
