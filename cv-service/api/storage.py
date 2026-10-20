"""Safe access to the shared storage folder.

The Node.js backend and this service share one storage root. The browser never supplies a path: Node generates
the storage keys; this module still validates every key defensively (allow-list regex, no traversal, must resolve
inside the storage root) before any file is touched.
"""
from __future__ import annotations

import re
from pathlib import Path

from processing.common import ParameterError

_SEGMENT = r"[A-Za-z0-9][A-Za-z0-9_\-]{0,63}"
KEY_RE = re.compile(rf"^(uploads|processed|exports)/{_SEGMENT}(/{_SEGMENT})*\.(png|jpg|jpeg|docx)$")
PREFIX_RE = re.compile(rf"^processed/{_SEGMENT}$")


def resolve_key(storage_root: Path, key: str) -> Path:
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        raise ParameterError("Invalid storage key.")
    root = storage_root.resolve()
    path = (root / key).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:  # symlink or traversal escape
        raise ParameterError("Invalid storage key.") from exc
    return path


def resolve_prefix(storage_root: Path, prefix: str) -> Path:
    if not isinstance(prefix, str) or not PREFIX_RE.fullmatch(prefix):
        raise ParameterError("Invalid output prefix.")
    root = storage_root.resolve()
    path = (root / prefix).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ParameterError("Invalid output prefix.") from exc
    return path
