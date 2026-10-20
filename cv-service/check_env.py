"""Environment self-check for the CV service:  ``python check_env.py``  (run from the cv-service folder or anywhere).

Reports which Python packages are missing and whether Tesseract can be started. Exit code: 0 = all good,
1 = Python or a package is missing (the service cannot start), 2 = only Tesseract needs attention (the service
starts, but text recognition reports a clear error). ``scripts/setup.ps1`` and ``npm run check`` call it.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# import name -> pip package name
REQUIRED = {
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "pydantic": "pydantic",
    "cv2": "opencv-python-headless",
    "numpy": "numpy",
    "PIL": "Pillow",
    "pytesseract": "pytesseract",
    "docx": "python-docx",
}


def main() -> int:
    problems = 0
    version = ".".join(str(p) for p in sys.version_info[:3])
    note = "" if sys.version_info[:2] in ((3, 11), (3, 12)) else "  (target is 3.11 or 3.12; other 3.x versions usually work but are less tested)"
    print(f"Python {version}{note}")
    if sys.version_info < (3, 10):
        print("  [!!] Python 3.10 or newer is required.")
        return 1

    missing = []
    for module, package in REQUIRED.items():
        try:
            mod = importlib.import_module(module)
            ver = getattr(mod, "__version__", "")
            print(f"  [ok] {package} {ver}".rstrip())
        except Exception as exc:  # noqa: BLE001 - a broken install (e.g. a missing DLL) must be reported, not crash
            missing.append(package)
            print(f"  [!!] {package}: {type(exc).__name__}: {exc}")
    if missing:
        print("\nInstall the missing packages with:\n  pip install -r cv-service/requirements.txt")
        return 1

    from ocr import recognition  # imported only after pytesseract is known to be present

    ocr = recognition.status()
    if ocr["available"]:
        print(f"  [ok] Tesseract {ocr['version']} at {ocr['path']}")
        langs = ocr.get("languages", [])
        print(f"    languages: {', '.join(langs) or 'none'}")
        if "eng" not in langs:
            problems += 1
            print("  [!!] The English language data (eng.traineddata) is missing - text recognition will fail.")
        if "osd" not in langs:
            print("    note: osd.traineddata is missing, so page-orientation detection falls back to the built-in estimate.")
    else:
        problems += 1
        print(f"  [!!] {ocr['error']}")
    return 2 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
