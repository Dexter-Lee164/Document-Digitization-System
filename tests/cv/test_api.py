"""Contract tests for the FastAPI service (auth, validation, storage safety, full chain)."""
from __future__ import annotations

import pytest
from docx import Document

from conftest import FIXTURES, TOKEN, put_upload, requires_tesseract

PREFIX = "processed/abcdef123456"


def test_health_is_public_and_reports_ocr_status(client):
    r = client.get("/health", headers={"X-Service-Token": ""})
    assert r.status_code == 200
    assert "ocr" in r.json() and "available" in r.json()["ocr"]


def test_v1_endpoints_require_token(client):
    r = client.get("/v1/templates", headers={"X-Service-Token": "wrong"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "http_error"
    r = client.post("/v1/detect", json={"storage_key": "uploads/a.png"}, headers={"X-Service-Token": ""})
    assert r.status_code == 401


def test_service_refuses_to_start_without_token(storage):
    import config
    from api.app import create_app

    s = config.Settings(storage, "", None, "127.0.0.1", 8001, 40_000_000, 90, 2, FIXTURES.parent.parent / "shared" / "processing_schema.json", FIXTURES)
    with pytest.raises(RuntimeError, match="CV_SERVICE_TOKEN"):
        create_app(s)


@pytest.mark.parametrize("key", ["../../etc/passwd", "uploads/../../secret.png", "/etc/passwd", "uploads/a b.png", "other/x.png", "uploads/x.exe", "uploads/.hidden.png", "uploads//x.png"])
def test_path_traversal_and_foreign_keys_are_rejected(client, key):
    r = client.post("/v1/validate", json={"storage_key": key})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_parameters"


def test_missing_file_is_a_clean_400(client):
    r = client.post("/v1/validate", json={"storage_key": "uploads/nothing.png"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_image"


def test_corrupt_upload_is_rejected(client):
    (client.storage / "uploads" / "bad.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"garbage" * 50)
    r = client.post("/v1/validate", json={"storage_key": "uploads/bad.png"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_image"


def test_unknown_fields_and_bad_types_are_rejected(client):
    r = client.post("/v1/detect", json={"storage_key": "uploads/a.png", "extra": 1})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request"


def test_validate_and_detect(client):
    key = put_upload(client.storage, FIXTURES / "letter_photo.jpg", "doc1.jpg")
    v = client.post("/v1/validate", json={"storage_key": key}).json()
    assert (v["width"], v["height"]) == (2000, 2500)
    d = client.post("/v1/detect", json={"storage_key": key}).json()
    assert d["detected"] and len(d["corners"]) == 4 and d["image_size"] == [2000, 2500]


def test_invalid_corners_and_params_return_400(client):
    key = put_upload(client.storage, FIXTURES / "letter_photo.jpg", "doc2.jpg")
    r = client.post("/v1/geometry", json={"storage_key": key, "output_prefix": PREFIX, "corners": [[0, 0], [1, 1], [2, 2], [3, 3]]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_corners"
    r = client.post("/v1/geometry", json={"storage_key": key, "output_prefix": PREFIX, "manual_rotation": 45})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_parameters"
    r = client.post("/v1/geometry", json={"storage_key": key, "output_prefix": "processed/../x"})
    assert r.status_code == 400
    r = client.post("/v1/enhance", json={"storage_key": key, "output_prefix": PREFIX, "settings": {"preset": "custom", "params": {"clahe_clip": 50}}})
    assert r.status_code == 400 and "clahe_clip" in r.json()["error"]["message"]


@requires_tesseract
def test_full_chain_upload_geometry_enhance_ocr_docx(client, reference_text):
    from processing.evaluation import cer

    key = put_upload(client.storage, FIXTURES / "letter_photo.jpg", "chain1.jpg")
    geo = client.post("/v1/geometry", json={"storage_key": key, "output_prefix": PREFIX}).json()
    assert geo["corrected_key"] == f"{PREFIX}/corrected.png" and (client.storage / geo["corrected_key"]).is_file()
    assert geo["report"]["corners_source"] == "auto"

    enh = client.post("/v1/enhance", json={"storage_key": geo["corrected_key"], "output_prefix": PREFIX, "settings": {"preset": "document_scan", "params": {}}}).json()
    assert (client.storage / enh["enhanced_key"]).is_file() and enh["resolved_params"]["shadow_removal"] is True

    ocr = client.post("/v1/ocr", json={"storage_key": enh["enhanced_key"], "mode": "general"}).json()
    assert cer(reference_text, ocr["text"]) < 0.06
    assert ocr["image_width"] > 0 and ocr["words"] and ocr["form"] is None

    corrected_text = ocr["text"].replace("Students", "STUDENTS", 1)
    out_key = "exports/chain-export-1.docx"
    d = client.post("/v1/docx", json={"mode": "text", "output_key": out_key, "text": corrected_text, "title": "Letter"}).json()
    assert d["verification"]["font_ok"] and d["verification"]["a4"]
    doc = Document(str(client.storage / out_key))
    assert "STUDENTS" in "\n".join(p.text for p in doc.paragraphs)


@requires_tesseract
def test_form_mode_ocr_returns_structured_fields(client):
    key = put_upload(client.storage, FIXTURES / "registration_form_clean.png", "form1.png")
    r = client.post("/v1/ocr", json={"storage_key": key, "mode": "form"}).json()
    assert r["form"]["matched"]
    assert {f["key"]: f["value"] for f in r["form"]["fields"]}["student_number"] == "2022-01457"


def test_docx_endpoint_validation(client):
    r = client.post("/v1/docx", json={"mode": "form", "output_key": "exports/f1.docx", "fields": [], "text": ""})
    assert r.status_code == 400
    r = client.post("/v1/docx", json={"mode": "text", "output_key": "uploads/evil.docx", "text": "x"})
    assert r.status_code == 400
    r = client.post("/v1/docx", json={"mode": "text", "output_key": "exports/../uploads/x.docx", "text": "x"})
    assert r.status_code == 400
    ok = client.post("/v1/docx", json={"mode": "form", "output_key": "exports/f2.docx", "title": "Form", "fields": [{"key": "a", "label": "A", "value": "1"}], "text": ""})
    assert ok.status_code == 200 and ok.json()["table_rows"] == 2


def test_schema_endpoint_serves_shared_contract(client):
    s = client.get("/v1/schema").json()
    assert set(s["presets"]) == {"automatic", "document_scan", "black_white", "grayscale", "custom"}


@requires_tesseract
def test_experiments_endpoint(client, reference_text):
    key = put_upload(client.storage, FIXTURES / "letter_photo.jpg", "exp1.jpg")
    r = client.post("/v1/experiments", json={"storage_key": key, "configs": ["A", "D"], "reference_text": reference_text}).json()
    rows = {x["config"]: x for x in r["results"]}
    assert rows["D"]["cer"] < rows["A"]["cer"] and r["reference_provided"]
