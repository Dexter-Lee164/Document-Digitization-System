"""Runtime configuration for the DocuVision CV service (read from environment variables).

The service shares the repository-level ``.env`` file with the Node.js backend. When started through
``scripts/start-cv.js`` (or ``scripts/start.ps1``) the variables are already present in the process
environment; when started by hand the optional ``python-dotenv``-free loader below reads ``../.env``.
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = SERVICE_ROOT.parent


def _load_dotenv_file(path: Path) -> None:
    """Minimal .env loader (KEY=VALUE per line). Existing environment variables win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    storage_path: Path
    service_token: str
    tesseract_cmd: str | None
    host: str
    port: int
    max_image_pixels: int
    ocr_timeout_s: int
    max_concurrency: int
    schema_path: Path
    template_dir: Path


def load_settings() -> Settings:
    _load_dotenv_file(PROJECT_ROOT / ".env")
    storage = os.environ.get("STORAGE_PATH", "./storage")
    storage_path = Path(storage)
    if not storage_path.is_absolute():
        storage_path = (PROJECT_ROOT / storage_path).resolve()
    storage_path.mkdir(parents=True, exist_ok=True)
    for sub in ("uploads", "processed", "exports"):
        (storage_path / sub).mkdir(parents=True, exist_ok=True)

    return Settings(
        storage_path=storage_path,
        service_token=os.environ.get("CV_SERVICE_TOKEN", ""),
        tesseract_cmd=os.environ.get("TESSERACT_CMD") or None,
        host=os.environ.get("CV_HOST", "127.0.0.1"),
        port=_int_env("CV_PORT", 8001),
        max_image_pixels=_int_env("MAX_IMAGE_PIXELS", 40_000_000),
        ocr_timeout_s=_int_env("OCR_TIMEOUT_SECONDS", 90),
        max_concurrency=max(1, _int_env("CV_MAX_CONCURRENCY", 2)),
        schema_path=PROJECT_ROOT / "shared" / "processing_schema.json",
        template_dir=SERVICE_ROOT / "templates",
    )


def find_tesseract(explicit: str | None) -> str | None:
    """Locate the Tesseract executable: explicit setting, PATH, then common Windows install folders."""
    if explicit:
        if Path(explicit).is_file():
            return explicit
        found = shutil.which(explicit)
        if found:
            return found
        return None
    found = shutil.which("tesseract")
    if found:
        return found
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        str(Path.home() / "AppData" / "Local" / "Programs" / "Tesseract-OCR" / "tesseract.exe"),
    ]
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    return None
