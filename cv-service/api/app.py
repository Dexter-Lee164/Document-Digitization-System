"""FastAPI application factory for the DocuVision CV / OCR / DOCX service.

Interactive documentation (Swagger UI) is available at /docs while the service is running.
All /v1 endpoints require the ``X-Service-Token`` header (shared secret with the Node.js backend).
"""
from __future__ import annotations

import logging
import secrets
import threading
import time
from pathlib import Path

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

import config as service_config
from export import docx_generator
from ocr import form_extraction, recognition
from ocr.layout import LOW_CONFIDENCE_DEFAULT
from processing import evaluation
from processing.common import ParameterError, ProcessingError, load_image, save_image, to_gray
from processing.document_detection import detect_document
from processing.enhancement import enhance, resolve_params
from processing.pipeline import run_geometry
from processing.schema import load_schema, validate_geometry

from .schemas import DocxRequest, EnhanceRequest, ExperimentRequest, GeometryRequest, OcrRequest, StorageRef
from .storage import resolve_key, resolve_prefix

log = logging.getLogger("docuvision.cv")


def create_app(settings: service_config.Settings | None = None) -> FastAPI:
    settings = settings or service_config.load_settings()
    if not settings.service_token:
        raise RuntimeError("CV_SERVICE_TOKEN is not set. Run `npm run setup:env` (or scripts/setup.ps1) to generate .env, then start the service again.")

    recognition._settings_cache = settings  # noqa: SLF001 - share the resolved settings with the OCR module
    schema = load_schema(str(settings.schema_path))
    gate = threading.BoundedSemaphore(settings.max_concurrency)

    app = FastAPI(title="DocuVision CV Service", version="1.0.0", description="Document detection, perspective/orientation/deskew correction, DSP enhancement, Tesseract OCR and DOCX generation.")

    # ------------------------------------------------------------------ errors (consistent JSON envelope)
    def envelope(status: int, code: str, message: str, details=None) -> JSONResponse:
        body = {"error": {"code": code, "message": message}}
        if details:
            body["error"]["details"] = details
        return JSONResponse(status_code=status, content=body)

    @app.exception_handler(ProcessingError)
    async def _processing_error(_: Request, exc: ProcessingError):
        return envelope(exc.status, exc.code, str(exc))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        details = [{"field": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()][:10]
        return envelope(400, "invalid_request", "The request body is invalid.", details)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException):
        return envelope(exc.status_code, "http_error", str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        log.exception("Unhandled error", exc_info=exc)
        return envelope(500, "internal_error", "Unexpected processing error.")

    def require_token(x_service_token: str | None = Header(default=None)) -> None:
        if not x_service_token or not secrets.compare_digest(x_service_token, settings.service_token):
            raise HTTPException(status_code=401, detail="Missing or invalid service token.")

    # ------------------------------------------------------------------ helpers
    def load(key: str) -> tuple[Path, np.ndarray]:
        path = resolve_key(settings.storage_path, key)
        return path, load_image(path, settings.max_image_pixels)

    def storage_key(path: Path) -> str:
        return path.resolve().relative_to(settings.storage_path.resolve()).as_posix()

    # ------------------------------------------------------------------ routes
    @app.get("/health", tags=["system"])
    def health():
        ocr = recognition.status()
        return {"status": "ok" if ocr["available"] else "degraded", "service": "docuvision-cv", "version": "1.0.0", "ocr": ocr, "opencv": cv2.__version__}

    @app.get("/v1/schema", dependencies=[Depends(require_token)], tags=["contract"])
    def get_schema():
        return schema

    @app.get("/v1/templates", dependencies=[Depends(require_token)], tags=["forms"])
    def get_templates():
        return {"templates": form_extraction.list_templates()}

    @app.post("/v1/validate", dependencies=[Depends(require_token)], tags=["images"])
    def validate_image(req: StorageRef):
        """Fully decode an uploaded image (real content check, not extension) and report its size."""
        path, img = load(req.storage_key)
        h, w = img.shape[:2]
        return {"width": w, "height": h, "megapixels": round(w * h / 1e6, 2), "bytes": path.stat().st_size}

    @app.post("/v1/detect", dependencies=[Depends(require_token)], tags=["geometry"])
    def detect(req: StorageRef):
        _, img = load(req.storage_key)
        t0 = time.perf_counter()
        result = detect_document(img)
        return {**result.to_dict(), "image_size": [img.shape[1], img.shape[0]], "duration_ms": round((time.perf_counter() - t0) * 1000, 1)}

    @app.post("/v1/geometry", dependencies=[Depends(require_token)], tags=["geometry"])
    def geometry(req: GeometryRequest):
        rotation, angle = validate_geometry(req.manual_rotation, req.manual_angle, schema)
        out_dir = resolve_prefix(settings.storage_path, req.output_prefix)
        _, img = load(req.storage_key)
        with gate:
            corrected, report = run_geometry(img, corners=req.corners, auto_detect=req.auto_detect, auto_orient=req.auto_orient, auto_deskew=req.auto_deskew, manual_rotation=rotation, manual_angle=angle)
        target = out_dir / "corrected.png"
        save_image(target, corrected)
        return {"corrected_key": storage_key(target), "report": report}

    @app.post("/v1/enhance", dependencies=[Depends(require_token)], tags=["enhancement"])
    def enhance_endpoint(req: EnhanceRequest):
        out_dir = resolve_prefix(settings.storage_path, req.output_prefix)
        _, img = load(req.storage_key)
        t0 = time.perf_counter()
        with gate:
            params, analysis = resolve_params(req.settings.preset, req.settings.params, to_gray(img), schema)
            enhanced, report = enhance(img, params)
        target = out_dir / "enhanced.png"
        save_image(target, enhanced)
        return {
            "enhanced_key": storage_key(target),
            "preset": req.settings.preset,
            "resolved_params": params,
            "analysis": analysis,
            "report": report,
            "duration_ms": round((time.perf_counter() - t0) * 1000, 1),
        }

    @app.post("/v1/ocr", dependencies=[Depends(require_token)], tags=["ocr"])
    def ocr(req: OcrRequest):
        _, img = load(req.storage_key)
        default_psm = schema["ocr"]["psm"]["default_form" if req.mode == "form" else "default_general"]
        psm = req.psm if req.psm is not None else default_psm
        if psm not in schema["ocr"]["psm"]["values"]:
            raise ParameterError("psm must be one of 3, 4, 6, 11.")
        with gate:
            result = recognition.recognize(img, psm=psm, threshold=req.low_confidence_threshold)
            payload = result.to_dict()
            payload["form"] = None
            if req.mode == "form":
                template_id = req.template_id or "university_registration_v1"
                payload["form"] = form_extraction.extract_fields(img, template_id)
        return payload

    @app.post("/v1/docx", dependencies=[Depends(require_token)], tags=["export"])
    def make_docx(req: DocxRequest):
        target = resolve_key(settings.storage_path, req.output_key)
        if target.suffix.lower() != ".docx" or target.parent.name != "exports":
            raise ParameterError("DOCX output must be an exports/<name>.docx key.")
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".docx.tmp")
        if req.mode == "form":
            if not req.fields:
                raise ParameterError("A structured form export needs at least one field.")
            info = docx_generator.build_form_document(tmp, req.title or "Form", [f.model_dump() for f in req.fields], req.text, req.include_full_text, req.reflow)
        else:
            info = docx_generator.build_text_document(tmp, req.text, req.reflow, req.title)
        check = docx_generator.verify_docx(tmp)
        if not (check["font_ok"] and check["a4"]):
            tmp.unlink(missing_ok=True)
            raise ProcessingError("The generated Word document failed its own formatting verification.")
        tmp.replace(target)
        return {"export_key": storage_key(target), "bytes": target.stat().st_size, "verification": check, **info}

    @app.post("/v1/experiments", dependencies=[Depends(require_token)], tags=["evaluation"])
    def experiments(req: ExperimentRequest):
        _, img = load(req.storage_key)
        resolve_params(req.settings.preset, req.settings.params, to_gray(img), schema)  # fail fast on bad settings
        if req.psm not in schema["ocr"]["psm"]["values"]:
            raise ParameterError("psm must be one of 3, 4, 6, 11.")
        with gate:
            return evaluation.run_experiments(
                img,
                configs=list(req.configs),
                enhance_preset=req.settings.preset,
                enhance_params=req.settings.params,
                geometry_kwargs={"corners": req.corners, "auto_orient": req.auto_orient, "auto_deskew": req.auto_deskew},
                reference_text=req.reference_text,
                psm=req.psm,
            )

    return app
