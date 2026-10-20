"""Tesseract OCR wrapper (pytesseract).

* ``image_to_string``  -> the editable text (Tesseract's own paragraph handling)
* ``image_to_data``    -> word bounding boxes + self-reported confidences

Both calls run concurrently on the same image. Failures are translated into actionable, typed errors.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import cv2
import numpy as np
import pytesseract
from PIL import Image
from pytesseract import Output

import config as service_config
from processing.common import ProcessingError

from .layout import LOW_CONFIDENCE_DEFAULT, confidence_summary, mark_low_confidence, normalize_text, text_from_words


class OcrError(ProcessingError):
    code = "ocr_failed"
    status = 500


class OcrUnavailableError(OcrError):
    code = "ocr_unavailable"
    status = 503


class OcrTimeoutError(OcrError):
    code = "ocr_timeout"
    status = 504


_lock = threading.Lock()
_state: dict = {"ready": False, "cmd": None, "version": None, "langs": []}

INSTALL_HINT = (
    "Install Tesseract OCR (Windows: https://github.com/UB-Mannheim/tesseract/wiki) and set TESSERACT_CMD in .env "
    "to the full path of tesseract.exe, e.g. C:\\Program Files\\Tesseract-OCR\\tesseract.exe."
)


def configure(explicit_cmd: str | None = None, force: bool = False) -> dict:
    """Locate Tesseract and verify it runs. Raises OcrUnavailableError with a fix-it message."""
    with _lock:
        if _state["ready"] and not force:
            return dict(_state)
        cmd = service_config.find_tesseract(explicit_cmd)
        if not cmd:
            where = f" (TESSERACT_CMD='{explicit_cmd}' does not exist)" if explicit_cmd else " (not found on PATH or in standard install folders)"
            raise OcrUnavailableError("Tesseract executable not found" + where + ". " + INSTALL_HINT)
        pytesseract.pytesseract.tesseract_cmd = cmd
        try:
            version = str(pytesseract.get_tesseract_version())
            langs = pytesseract.get_languages(config="")
        except pytesseract.TesseractNotFoundError as exc:
            raise OcrUnavailableError(f"Tesseract could not be started from '{cmd}'. " + INSTALL_HINT) from exc
        except Exception as exc:  # noqa: BLE001
            raise OcrUnavailableError(f"Tesseract was found at '{cmd}' but failed to report its version: {exc}") from exc
        _state.update(ready=True, cmd=cmd, version=version, langs=langs)
        return dict(_state)


def status() -> dict:
    """Non-raising availability report for /health."""
    try:
        info = configure(service_config_settings().tesseract_cmd)
        return {"available": True, "version": info["version"], "path": info["cmd"], "languages": info["langs"]}
    except OcrError as exc:
        return {"available": False, "error": str(exc)}


_settings_cache = None


def service_config_settings():
    global _settings_cache
    if _settings_cache is None:
        _settings_cache = service_config.load_settings()
    return _settings_cache


def ensure_ready() -> None:
    configure(service_config_settings().tesseract_cmd)


def _to_pil(img: np.ndarray) -> Image.Image:
    if img.ndim == 2:
        return Image.fromarray(img)
    return Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))


@dataclass
class OcrResult:
    text: str
    words: list[dict]
    confidence: dict
    image_width: int
    image_height: int
    psm: int
    lang: str
    duration_ms: int
    empty: bool = False
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "words": self.words,
            "confidence": self.confidence,
            "image_width": self.image_width,
            "image_height": self.image_height,
            "psm": self.psm,
            "lang": self.lang,
            "duration_ms": self.duration_ms,
            "empty": self.empty,
            "warnings": self.warnings,
        }


def _tess_config(psm: int, extra: str = "") -> str:
    return f"--oem 3 --psm {int(psm)} --dpi 300 {extra}".strip()


def _wrap_errors(exc: Exception, timeout: int) -> OcrError:
    if isinstance(exc, pytesseract.TesseractNotFoundError):
        return OcrUnavailableError("Tesseract executable could not be launched. " + INSTALL_HINT)
    if isinstance(exc, RuntimeError) and "timeout" in str(exc).lower():
        return OcrTimeoutError(f"OCR timed out after {timeout} seconds. Try a smaller image or a simpler preset.")
    if isinstance(exc, pytesseract.TesseractError):
        msg = str(exc)
        if "Failed loading language" in msg or "Error opening data file" in msg:
            return OcrUnavailableError("The Tesseract language data ('eng') is missing. Reinstall Tesseract with English data or set TESSDATA_PREFIX.")
        return OcrError(f"Tesseract failed: {msg[:300]}")
    return OcrError(f"OCR failed: {exc}")


def _rows_to_words(data: dict, threshold: float) -> list[dict]:
    words: list[dict] = []
    n = len(data.get("text", []))
    for i in range(n):
        text = str(data["text"][i]).strip()
        try:
            conf = float(data["conf"][i])
        except (TypeError, ValueError):
            conf = -1.0
        if not text or conf < 0:
            continue
        words.append(
            {
                "text": text,
                "conf": round(conf, 1),
                "x": int(data["left"][i]),
                "y": int(data["top"][i]),
                "w": int(data["width"][i]),
                "h": int(data["height"][i]),
                "block": int(data["block_num"][i]),
                "par": int(data["par_num"][i]),
                "line": int(data["line_num"][i]),
            }
        )
    return mark_low_confidence(words, threshold)


def recognize(
    img: np.ndarray,
    psm: int = 3,
    lang: str = "eng",
    timeout: int | None = None,
    threshold: float = LOW_CONFIDENCE_DEFAULT,
    extra_config: str = "",
    with_data: bool = True,
) -> OcrResult:
    """Run Tesseract on ``img`` (BGR or gray uint8)."""
    ensure_ready()
    timeout = timeout or service_config_settings().ocr_timeout_s
    pil = _to_pil(img)
    h, w = img.shape[:2]
    cfg = _tess_config(psm, extra_config)
    started = time.perf_counter()

    def run_string() -> str:
        return pytesseract.image_to_string(pil, lang=lang, config=cfg, timeout=timeout)

    def run_data() -> dict:
        return pytesseract.image_to_data(pil, lang=lang, config=cfg, output_type=Output.DICT, timeout=timeout)

    try:
        if with_data:
            with ThreadPoolExecutor(max_workers=2) as pool:
                f_text, f_data = pool.submit(run_string), pool.submit(run_data)
                raw_text, data = f_text.result(), f_data.result()
        else:
            raw_text, data = run_string(), {"text": []}
    except Exception as exc:  # noqa: BLE001
        raise _wrap_errors(exc, timeout) from exc

    words = _rows_to_words(data, threshold)
    text = normalize_text(raw_text)
    warnings: list[str] = []
    if not text and words:
        text = text_from_words(words)
        warnings.append("Text was rebuilt from word boxes because Tesseract returned no string output.")
    empty = not text.strip()
    if empty:
        warnings.append("No text was recognised. Check the corner selection, orientation and enhancement settings.")
    return OcrResult(
        text=text,
        words=words,
        confidence=confidence_summary(words, threshold),
        image_width=w,
        image_height=h,
        psm=psm,
        lang=lang,
        duration_ms=int((time.perf_counter() - started) * 1000),
        empty=empty,
        warnings=warnings,
    )


def recognize_data_only(img: np.ndarray, psm: int = 6, lang: str = "eng", timeout: int | None = None, extra_config: str = "") -> list[dict]:
    """Word boxes only (used by orientation fallback scoring and field extraction)."""
    ensure_ready()
    timeout = timeout or service_config_settings().ocr_timeout_s
    try:
        data = pytesseract.image_to_data(_to_pil(img), lang=lang, config=_tess_config(psm, extra_config), output_type=Output.DICT, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        raise _wrap_errors(exc, timeout) from exc
    return _rows_to_words(data, LOW_CONFIDENCE_DEFAULT)


def osd(img: np.ndarray, timeout: int = 30) -> dict:
    """Tesseract Orientation and Script Detection. Raises OcrError when OSD data is missing or text is too sparse."""
    ensure_ready()
    try:
        return pytesseract.image_to_osd(_to_pil(img), config="--psm 0 --dpi 300", output_type=Output.DICT, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        raise _wrap_errors(exc, timeout) from exc
