"""Request schemas (the internal API contract with the Node.js backend)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EnhanceSettings(_Strict):
    preset: str = "automatic"
    params: dict[str, Any] = Field(default_factory=dict)


class StorageRef(_Strict):
    storage_key: str = Field(max_length=300)


class GeometryRequest(_Strict):
    storage_key: str = Field(max_length=300)
    output_prefix: str = Field(max_length=200)
    corners: list[list[float]] | None = None
    auto_detect: bool = True
    auto_orient: bool = True
    auto_deskew: bool = True
    manual_rotation: int = 0
    manual_angle: float = 0.0


class EnhanceRequest(_Strict):
    storage_key: str = Field(max_length=300)
    output_prefix: str = Field(max_length=200)
    settings: EnhanceSettings = Field(default_factory=EnhanceSettings)


class OcrRequest(_Strict):
    storage_key: str = Field(max_length=300)
    mode: Literal["general", "form"] = "general"
    psm: int | None = None
    template_id: str | None = Field(default=None, max_length=80)
    low_confidence_threshold: float = Field(default=60.0, ge=0, le=100)


class FieldIn(_Strict):
    key: str = Field(default="", max_length=80)
    label: str = Field(default="", max_length=120)
    value: str = Field(default="", max_length=2000)


class DocxRequest(_Strict):
    mode: Literal["text", "form"] = "text"
    output_key: str = Field(max_length=300)
    title: str | None = Field(default=None, max_length=200)
    text: str = Field(default="", max_length=2_000_000)
    fields: list[FieldIn] = Field(default_factory=list, max_length=100)
    reflow: bool = True
    include_full_text: bool = True


class ExperimentRequest(_Strict):
    storage_key: str = Field(max_length=300)
    configs: list[Literal["A", "B", "C", "D"]] = Field(default_factory=lambda: ["A", "B", "C", "D"], min_length=1, max_length=4)
    settings: EnhanceSettings = Field(default_factory=lambda: EnhanceSettings(preset="document_scan"))
    corners: list[list[float]] | None = None
    auto_orient: bool = True
    auto_deskew: bool = True
    reference_text: str | None = Field(default=None, max_length=500_000)
    psm: int = 3
