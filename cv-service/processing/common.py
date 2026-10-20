"""Shared helpers: errors, image decoding/encoding and small geometry utilities."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image


class ProcessingError(Exception):
    """Base class for expected processing failures (mapped to JSON errors by the API layer)."""

    code = "processing_failed"
    status = 500


class ImageError(ProcessingError):
    code = "invalid_image"
    status = 400


class InvalidCornersError(ProcessingError):
    code = "invalid_corners"
    status = 400


class ParameterError(ProcessingError):
    code = "invalid_parameters"
    status = 400


SUPPORTED_FORMATS = {"JPEG", "PNG"}


def decode_image_bytes(data: bytes, max_pixels: int = 40_000_000) -> np.ndarray:
    """Decode JPEG/PNG bytes into a BGR uint8 image.

    * Real content is verified (Pillow reads the header, OpenCV performs the full decode),
      never the file extension.
    * Pixel count is checked from the header *before* the pixel buffer is allocated.
    * Alpha channels are composited onto white; 16-bit and grayscale inputs are normalised to BGR uint8.
    """
    if not data:
        raise ImageError("The image is empty.")
    try:
        import io

        with Image.open(io.BytesIO(data)) as probe:
            fmt = (probe.format or "").upper()
            width, height = probe.size
    except Exception as exc:  # noqa: BLE001 - any Pillow failure means "not a usable image"
        raise ImageError("The file is not a valid or readable image.") from exc
    if fmt not in SUPPORTED_FORMATS:
        raise ImageError(f"Unsupported image format '{fmt or 'unknown'}'. Use JPG or PNG.")
    if width < 16 or height < 16:
        raise ImageError("The image is too small to contain a document (minimum 16x16 pixels).")
    if width * height > max_pixels:
        raise ImageError(
            f"The image is too large ({width}x{height}). The limit is {max_pixels // 1_000_000} megapixels."
        )

    buf = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED if fmt == "PNG" else cv2.IMREAD_COLOR)
    if img is None:
        raise ImageError("The image data is corrupted and could not be decoded.")
    return _normalise_channels(img)


def _normalise_channels(img: np.ndarray) -> np.ndarray:
    if img.dtype == np.uint16:
        img = (img / 257.0).astype(np.uint8)
    elif img.dtype != np.uint8:
        img = cv2.normalize(img, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        alpha = img[:, :, 3:4].astype(np.float32) / 255.0
        bgr = img[:, :, :3].astype(np.float32)
        out = bgr * alpha + 255.0 * (1.0 - alpha)
        return out.astype(np.uint8)
    return img


def load_image(path: Path, max_pixels: int = 40_000_000) -> np.ndarray:
    try:
        data = Path(path).read_bytes()
    except FileNotFoundError as exc:
        raise ImageError("The image file was not found in storage.") from exc
    return decode_image_bytes(data, max_pixels)


def save_image(path: Path, img: np.ndarray) -> None:
    """Write PNG/JPEG using imencode so non-ASCII Windows paths work."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ext = path.suffix.lower() or ".png"
    params = [cv2.IMWRITE_JPEG_QUALITY, 95] if ext in (".jpg", ".jpeg") else [cv2.IMWRITE_PNG_COMPRESSION, 3]
    ok, encoded = cv2.imencode(ext, img, params)
    if not ok:
        raise ProcessingError("Failed to encode the processed image.")
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(encoded.tobytes())
    tmp.replace(path)


def to_gray(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return img
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def to_bgr(img: np.ndarray) -> np.ndarray:
    if img.ndim == 3:
        return img
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def resize_to_max(img: np.ndarray, max_dim: int) -> tuple[np.ndarray, float]:
    """Down-scale (never up-scale) so the longest side is <= max_dim. Returns (image, scale)."""
    h, w = img.shape[:2]
    longest = max(h, w)
    if longest <= max_dim:
        return img, 1.0
    scale = max_dim / float(longest)
    out = cv2.resize(img, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    return out, scale


def odd(value: int) -> int:
    value = int(value)
    return value if value % 2 == 1 else value + 1


def border_fill_value(img: np.ndarray) -> tuple[int, ...]:
    """Median colour of the image border - used to fill corners exposed by rotations."""
    border = np.concatenate([img[0, :], img[-1, :], img[:, 0], img[:, -1]]).reshape(-1, 1 if img.ndim == 2 else img.shape[2])
    med = np.median(border, axis=0)
    return tuple(int(v) for v in np.atleast_1d(med))
