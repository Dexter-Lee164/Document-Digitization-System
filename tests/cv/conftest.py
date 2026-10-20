"""Shared pytest fixtures for the CV service tests."""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "cv-service"))
sys.path.insert(0, str(FIXTURES))

TOKEN = "test-token-123"
os.environ.setdefault("CV_SERVICE_TOKEN", TOKEN)

import generate_fixtures as gf  # noqa: E402  (fixture generator doubles as a test helper module)

from processing.common import load_image  # noqa: E402


def _tesseract_ok() -> bool:
    try:
        from ocr import recognition

        recognition.configure(None, force=True)
        return True
    except Exception:  # noqa: BLE001
        return False


HAS_TESSERACT = _tesseract_ok()
requires_tesseract = pytest.mark.skipif(not HAS_TESSERACT, reason="Tesseract OCR is not installed")


@pytest.fixture(scope="session")
def letter():
    return load_image(FIXTURES / "letter_clean.png")


@pytest.fixture(scope="session")
def letter_photo():
    return load_image(FIXTURES / "letter_photo.jpg")


@pytest.fixture(scope="session")
def form_photo():
    return load_image(FIXTURES / "registration_form_photo.jpg")


@pytest.fixture(scope="session")
def form_clean():
    return load_image(FIXTURES / "registration_form_clean.png")


@pytest.fixture(scope="session")
def ground_truth():
    return json.loads((FIXTURES / "ground_truth_corners.json").read_text())


@pytest.fixture(scope="session")
def reference_text():
    return (FIXTURES / "letter_reference.txt").read_text(encoding="utf-8")


@pytest.fixture()
def storage(tmp_path):
    root = tmp_path / "storage"
    for sub in ("uploads", "processed", "exports"):
        (root / sub).mkdir(parents=True)
    return root


@pytest.fixture()
def client(storage):
    from fastapi.testclient import TestClient

    import config
    from api.app import create_app

    settings = config.Settings(
        storage_path=storage,
        service_token=TOKEN,
        tesseract_cmd=None,
        host="127.0.0.1",
        port=8001,
        max_image_pixels=40_000_000,
        ocr_timeout_s=90,
        max_concurrency=2,
        schema_path=ROOT / "shared" / "processing_schema.json",
        template_dir=ROOT / "cv-service" / "templates",
    )
    app = create_app(settings)
    with TestClient(app, headers={"X-Service-Token": TOKEN}) as c:
        c.storage = storage
        yield c


def put_upload(storage: Path, source: Path, name: str) -> str:
    dest = storage / "uploads" / name
    shutil.copy(source, dest)
    return f"uploads/{name}"
