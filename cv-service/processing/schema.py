"""Loads ``shared/processing_schema.json`` - the contract shared with the Node.js backend - and validates
enhancement parameters against it."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .common import ParameterError

DEFAULT_SCHEMA_PATH = Path(__file__).resolve().parents[2] / "shared" / "processing_schema.json"


@lru_cache(maxsize=4)
def load_schema(path: str | None = None) -> dict:
    p = Path(path) if path else DEFAULT_SCHEMA_PATH
    with p.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def defaults(schema: dict | None = None) -> dict[str, Any]:
    schema = schema or load_schema()
    return {name: spec["default"] for name, spec in schema["parameters"].items()}


def _validate_one(name: str, spec: dict, value: Any) -> Any:
    kind = spec["type"]
    if kind == "bool":
        if not isinstance(value, bool):
            raise ParameterError(f"'{name}' must be true or false.")
        return value
    if kind == "enum":
        if value not in spec["values"]:
            raise ParameterError(f"'{name}' must be one of: {', '.join(spec['values'])}.")
        return value
    if kind in ("int", "float"):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ParameterError(f"'{name}' must be a number.")
        if value != value or value in (float("inf"), float("-inf")):
            raise ParameterError(f"'{name}' must be a finite number.")
        if kind == "int":
            if int(value) != value:
                raise ParameterError(f"'{name}' must be a whole number.")
            value = int(value)
        else:
            value = float(value)
        if value < spec["min"] or value > spec["max"]:
            raise ParameterError(f"'{name}' must be between {spec['min']} and {spec['max']}.")
        if kind == "int" and spec.get("odd") and value % 2 == 0:
            value = value + 1 if value + 1 <= spec["max"] else value - 1
        return value
    raise ParameterError(f"Unsupported parameter type for '{name}'.")


def validate_params(params: dict | None, schema: dict | None = None) -> dict[str, Any]:
    """Validate a (possibly partial) parameter dict. Unknown keys are rejected."""
    schema = schema or load_schema()
    specs = schema["parameters"]
    out: dict[str, Any] = {}
    for key, value in (params or {}).items():
        if key not in specs:
            raise ParameterError(f"Unknown processing parameter '{key}'.")
        out[key] = _validate_one(key, specs[key], value)
    return out


def preset_names(schema: dict | None = None) -> list[str]:
    return list((schema or load_schema())["presets"].keys())


def preset_params(name: str, schema: dict | None = None) -> dict[str, Any]:
    schema = schema or load_schema()
    if name not in schema["presets"]:
        raise ParameterError(f"Unknown preset '{name}'. Valid presets: {', '.join(schema['presets'])}.")
    merged = defaults(schema)
    base = schema["presets"]["document_scan"]["params"] if name == "custom" else {}
    merged.update(base)
    merged.update(schema["presets"][name]["params"])
    return validate_params(merged, schema)


def validate_geometry(manual_rotation: Any, manual_angle: Any, schema: dict | None = None) -> tuple[int, float]:
    schema = schema or load_schema()
    geo = schema["geometry"]
    if manual_rotation not in geo["manual_rotation"]["values"]:
        raise ParameterError("manual_rotation must be 0, 90, 180 or 270.")
    spec = geo["manual_angle"]
    if isinstance(manual_angle, bool) or not isinstance(manual_angle, (int, float)) or not (spec["min"] <= manual_angle <= spec["max"]):
        raise ParameterError(f"manual_angle must be a number between {spec['min']} and {spec['max']}.")
    return int(manual_rotation), float(manual_angle)
