"""Layout helpers: turn Tesseract word boxes into text/paragraphs and summarise recognition confidence."""
from __future__ import annotations

import re
from statistics import mean, median
from typing import Iterable

LOW_CONFIDENCE_DEFAULT = 60.0


def normalize_text(text: str) -> str:
    """Clean raw Tesseract output: unify newlines, strip form feeds/trailing spaces, collapse 3+ blank lines."""
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x0c", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def text_from_words(words: Iterable[dict]) -> str:
    """Rebuild text from word boxes grouped by Tesseract's block / paragraph / line numbers.

    Used as a fallback when ``image_to_string`` returns nothing, and by the form extractor.
    Paragraphs are separated by a blank line, lines by a newline."""
    lines: dict[tuple, list[dict]] = {}
    order: list[tuple] = []
    for w in words:
        key = (w["block"], w["par"], w["line"])
        if key not in lines:
            lines[key] = []
            order.append(key)
        lines[key].append(w)

    out: list[str] = []
    prev_par: tuple | None = None
    for key in order:
        par_key = key[:2]
        line = " ".join(w["text"] for w in sorted(lines[key], key=lambda x: x["x"]))
        if prev_par is not None and par_key != prev_par:
            out.append("")
        out.append(line)
        prev_par = par_key
    return normalize_text("\n".join(out))


def valid_words(words: Iterable[dict]) -> list[dict]:
    return [w for w in words if w.get("text", "").strip() and w.get("conf", -1) >= 0]


def confidence_summary(words: Iterable[dict], threshold: float = LOW_CONFIDENCE_DEFAULT) -> dict:
    """Document-level summary of Tesseract's *self-reported* word confidences.

    These numbers describe how sure the OCR engine is; they are NOT a verified accuracy percentage.
    """
    valid = valid_words(words)
    if not valid:
        return {"mean": None, "median": None, "min": None, "word_count": 0, "low_confidence_count": 0, "low_confidence_ratio": None, "threshold": threshold}
    confs = [float(w["conf"]) for w in valid]
    low = [c for c in confs if c < threshold]
    return {
        "mean": round(mean(confs), 2),
        "median": round(median(confs), 2),
        "min": round(min(confs), 2),
        "word_count": len(valid),
        "low_confidence_count": len(low),
        "low_confidence_ratio": round(len(low) / len(valid), 4),
        "threshold": threshold,
    }


def mark_low_confidence(words: list[dict], threshold: float = LOW_CONFIDENCE_DEFAULT) -> list[dict]:
    for w in words:
        w["low"] = bool(w.get("conf", -1) >= 0 and w["conf"] < threshold)
    return words
