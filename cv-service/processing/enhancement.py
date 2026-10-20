"""Digital-signal-processing enhancement pipeline for OCR preparation.

Every stage is a real 2-D filtering / point-operation on the image signal:

 1. grayscale conversion        Y = 0.299 R + 0.587 G + 0.114 B             (cv2.cvtColor)
 2. resampling                  bicubic interpolation up, area averaging down (cv2.resize)
 3. illumination correction     background = large low-pass of the morphologically closed page; page / background
                                (homomorphic-style division removes shadows and vignetting)
 4. noise reduction             Gaussian (linear low-pass), median (non-linear, edge preserving), bilateral
 5. contrast enhancement        global histogram equalisation and/or CLAHE (tile based, clip limited)
 6. sharpening                  unsharp mask (I + a (I - G*I)) or a 3x3 Laplacian-based convolution kernel
 7. thresholding                Otsu (global, histogram based) or adaptive Gaussian (local mean)
 8. morphology                  erosion / dilation / opening / closing applied to the INK (text) so that
                                "erode" always thins strokes and "dilate" thickens them

Interpolation (stage 2) only resamples; it does not recover detail that the camera never captured.
"""
from __future__ import annotations

import time
from typing import Any

import cv2
import numpy as np

from .common import odd, to_gray
from .schema import defaults, load_schema, preset_params, validate_params

MAX_WORKING_SIDE = 4500


# ----------------------------------------------------------------------------- analysis (for the "automatic" preset)
def _white_noise_sigma(gray: np.ndarray) -> float:
    """Immerkaer's 3x3 Laplacian-difference estimate in median/MAD form, so text edges (a small share of a page) do not dominate.
    It is accurate for white noise but nearly blind to spatially correlated noise (camera demosaicing, JPEG, sensor grain)."""
    kernel = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], dtype=np.float32)
    response = cv2.filter2D(gray.astype(np.float32), -1, kernel)[1:-1, 1:-1]
    mad = float(np.median(np.abs(response)))
    return mad / (0.6745 * 6.0)


def _flat_block_sigma(gray: np.ndarray, block: int = 8, percentile: float = 10.0) -> float:
    """Noise level read from the flattest parts of the page: the standard deviation inside each 8x8 block, then a low percentile
    across blocks. Blank paper makes up most of a document, so the quiet blocks show the noise floor, while blocks that contain
    ink (high deviation) are ignored. Unlike the Laplacian estimate this also sees noise that is correlated over a few pixels."""
    h, w = gray.shape
    h2, w2 = (h // block) * block, (w // block) * block
    if h2 < block or w2 < block:
        return 0.0
    tiles = gray[:h2, :w2].astype(np.float32).reshape(h2 // block, block, w2 // block, block).transpose(0, 2, 1, 3).reshape(-1, block * block)
    return float(np.percentile(tiles.std(axis=1, ddof=1), percentile))


def estimate_noise_sigma(gray: np.ndarray) -> float:
    """Noise standard deviation in grey levels: the larger of the white-noise (Laplacian) and flat-block estimates.
    Using both means neither independent grain nor blotchy, correlated noise goes unnoticed."""
    return max(_white_noise_sigma(gray), _flat_block_sigma(gray))


def estimate_background(gray: np.ndarray) -> np.ndarray:
    """Smooth estimate of the page illumination (computed on a down-scaled copy for speed)."""
    h, w = gray.shape
    factor = max(1, int(round(max(h, w) / 700)))
    small = cv2.resize(gray, (max(1, w // factor), max(1, h // factor)), interpolation=cv2.INTER_AREA) if factor > 1 else gray
    k = odd(max(7, min(small.shape) // 25))
    closed = cv2.morphologyEx(small, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    smooth = cv2.GaussianBlur(closed, (0, 0), sigmaX=max(3.0, min(small.shape) / 30.0))
    return cv2.resize(smooth, (w, h), interpolation=cv2.INTER_LINEAR) if factor > 1 else smooth


def analyze(gray: np.ndarray) -> dict[str, float]:
    h, w = gray.shape
    bg = estimate_background(gray).astype(np.float32)
    lap = cv2.Laplacian(cv2.resize(gray, (1200, int(1200 * h / w))) if w > 1200 else gray, cv2.CV_64F)
    return {
        "long_side": float(max(h, w)),
        "noise_sigma": round(estimate_noise_sigma(gray), 2),
        "contrast_std": round(float(np.std(gray)), 2),
        "illumination_variation": round(float(np.std(bg) / max(float(np.mean(bg)), 1.0)), 4),
        "sharpness_laplacian_var": round(float(lap.var()), 1),
        "mean_intensity": round(float(np.mean(gray)), 1),
    }


def auto_params(analysis: dict[str, float], schema: dict | None = None) -> dict[str, Any]:
    """Heuristic choice of parameters from measured image characteristics (the "Automatic" preset)."""
    p = defaults(schema)
    p.update({"threshold_method": "none", "morph_op": "none", "equalize": False})
    # lighting
    p["shadow_removal"] = analysis["illumination_variation"] > 0.06
    # noise: stronger smoothing as the measured noise grows (thresholds calibrated on synthetic white and correlated noise)
    sigma = analysis["noise_sigma"]
    if sigma >= 8:
        p.update(denoise_method="median", denoise_kernel=7)
    elif sigma >= 3.5:
        p.update(denoise_method="median", denoise_kernel=5)
    elif sigma >= 2:
        p.update(denoise_method="gaussian", denoise_kernel=3)
    else:
        p["denoise_method"] = "none"
    # contrast; CLAHE stretches noise as much as ink, which can make a noisy page unreadable, so its strength is capped by the noise
    std = analysis["contrast_std"]
    p["clahe_clip"] = 3.0 if std < 35 else 2.0 if std < 55 else 1.2
    if sigma >= 8:
        p["clahe_clip"] = min(p["clahe_clip"], 1.2)
    elif sigma >= 3.5:
        p["clahe_clip"] = min(p["clahe_clip"], 1.5)
    # sharpness
    lap = analysis["sharpness_laplacian_var"]
    if lap < 40:
        p.update(sharpen_method="unsharp", sharpen_amount=1.2)
    elif lap < 150:
        p.update(sharpen_method="unsharp", sharpen_amount=0.6)
    else:
        p["sharpen_method"] = "none"
    p["resize_mode"] = "auto" if analysis["long_side"] < 1800 else "none"
    return validate_params(p, schema)


def resolve_params(preset: str, params: dict | None, gray: np.ndarray, schema: dict | None = None) -> tuple[dict[str, Any], dict]:
    """Return (fully resolved parameters, analysis). ``params`` is only honoured for the custom preset."""
    schema = schema or load_schema()
    if preset not in schema["presets"]:
        preset_params(preset, schema)  # raises a helpful ParameterError
    analysis = analyze(gray)
    if preset == "automatic":
        return auto_params(analysis, schema), analysis
    if preset == "custom":
        merged = preset_params("custom", schema)
        merged.update(validate_params(params or {}, schema))
        return merged, analysis
    return preset_params(preset, schema), analysis


# ----------------------------------------------------------------------------- individual operations
def resample(gray: np.ndarray, mode: str, target_long_side: int) -> tuple[np.ndarray, float]:
    h, w = gray.shape
    long_side = max(h, w)
    scale = 1.0
    if mode == "auto" and long_side < target_long_side:
        scale = min(3.0, target_long_side / float(long_side))
    elif long_side > MAX_WORKING_SIDE:
        scale = MAX_WORKING_SIDE / float(long_side)
    if abs(scale - 1.0) < 0.05:
        return gray, 1.0
    interp = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
    return cv2.resize(gray, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=interp), scale


def remove_shadows(gray: np.ndarray) -> np.ndarray:
    bg = estimate_background(gray)
    return cv2.divide(gray, np.maximum(bg, 1), scale=255)


def denoise(gray: np.ndarray, method: str, kernel: int) -> np.ndarray:
    k = odd(kernel)
    if method == "gaussian":
        return cv2.GaussianBlur(gray, (k, k), 0)
    if method == "median":
        return cv2.medianBlur(gray, k)
    if method == "bilateral":
        return cv2.bilateralFilter(gray, d=k, sigmaColor=35, sigmaSpace=k * 2)
    return gray


def sharpen(gray: np.ndarray, method: str, amount: float) -> np.ndarray:
    if method == "unsharp" and amount > 0:
        blurred = cv2.GaussianBlur(gray, (0, 0), sigmaX=1.2)
        return cv2.addWeighted(gray, 1.0 + amount, blurred, -amount, 0)
    if method == "kernel" and amount > 0:
        kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
        sharp = cv2.filter2D(gray, -1, kernel)
        blend = min(1.0, amount)
        return cv2.addWeighted(gray, 1.0 - blend, sharp, blend, 0)
    return gray


def threshold(gray: np.ndarray, method: str, block: int, c: int) -> np.ndarray:
    if method == "otsu":
        _, out = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return out
    if method == "adaptive_gaussian":
        return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, odd(block), c)
    return gray


def morphology(img: np.ndarray, op: str, kernel_size: int, iterations: int) -> np.ndarray:
    """Morphology on the INK: the image is inverted (ink -> bright), processed, and inverted back."""
    if op == "none" or kernel_size < 1:
        return img
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    ink = cv2.bitwise_not(img)
    if op == "erode":
        res = cv2.erode(ink, kernel, iterations=iterations)
    elif op == "dilate":
        res = cv2.dilate(ink, kernel, iterations=iterations)
    elif op == "open":
        res = cv2.morphologyEx(ink, cv2.MORPH_OPEN, kernel, iterations=iterations)
    elif op == "close":
        res = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, kernel, iterations=iterations)
    else:
        return img
    return cv2.bitwise_not(res)


# ----------------------------------------------------------------------------- pipeline
def enhance(img: np.ndarray, params: dict[str, Any]) -> tuple[np.ndarray, dict]:
    """Apply the full DSP chain to ``img`` using fully-resolved ``params``.

    Returns (single-channel uint8 image, report). The report lists every applied stage with its parameters and
    duration so the UI can show real processing results.
    """
    steps: list[dict] = []

    def run(name: str, func, detail: dict | None = None):
        t0 = time.perf_counter()
        out = func()
        steps.append({"stage": name, "ms": round((time.perf_counter() - t0) * 1000, 1), **(detail or {})})
        return out

    gray = run("grayscale", lambda: to_gray(img), {"input_channels": 1 if img.ndim == 2 else 3})
    in_h, in_w = gray.shape

    gray_rs, scale = run("resample", lambda: resample(gray, params["resize_mode"], params["target_long_side"]))
    steps[-1].update(scale=round(scale, 3), size=[gray_rs.shape[1], gray_rs.shape[0]], note="interpolation only; no new detail is created" if scale > 1 else "")
    gray = gray_rs

    if params["shadow_removal"]:
        gray = run("illumination_correction", lambda: remove_shadows(gray))
    if params["denoise_method"] != "none":
        gray = run("denoise", lambda: denoise(gray, params["denoise_method"], params["denoise_kernel"]), {"method": params["denoise_method"], "kernel": params["denoise_kernel"]})
    if params["equalize"]:
        gray = run("histogram_equalization", lambda: cv2.equalizeHist(gray))
    if params["clahe_clip"] > 0:
        clahe = cv2.createCLAHE(clipLimit=float(params["clahe_clip"]), tileGridSize=(params["clahe_grid"], params["clahe_grid"]))
        gray = run("clahe", lambda: clahe.apply(gray), {"clip_limit": params["clahe_clip"], "grid": params["clahe_grid"]})
    if params["sharpen_method"] != "none" and params["sharpen_amount"] > 0:
        gray = run("sharpen", lambda: sharpen(gray, params["sharpen_method"], params["sharpen_amount"]), {"method": params["sharpen_method"], "amount": params["sharpen_amount"]})
    if params["threshold_method"] != "none":
        gray = run("threshold", lambda: threshold(gray, params["threshold_method"], params["adaptive_block"], params["adaptive_c"]), {"method": params["threshold_method"]})
    if params["morph_op"] != "none":
        gray = run("morphology", lambda: morphology(gray, params["morph_op"], params["morph_kernel"], params["morph_iterations"]), {"op": params["morph_op"], "kernel": params["morph_kernel"], "iterations": params["morph_iterations"]})

    ink_ratio = float(np.count_nonzero(gray < 128)) / gray.size
    report = {
        "input_size": [in_w, in_h],
        "output_size": [gray.shape[1], gray.shape[0]],
        "output_mode": "binary" if params["threshold_method"] != "none" else "grayscale",
        "steps": steps,
        "output_stats": {"contrast_std": round(float(np.std(gray)), 2), "dark_pixel_ratio": round(ink_ratio, 4)},
    }
    return gray, report
