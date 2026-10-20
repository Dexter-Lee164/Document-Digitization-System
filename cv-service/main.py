"""Entry point:  ``uvicorn main:app --host 127.0.0.1 --port 8001``  (run from the cv-service folder).

The service binds to localhost by default and is only meant to be called by the Node.js backend.
"""
from __future__ import annotations

import logging

from api.app import create_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = create_app()

if __name__ == "__main__":  # pragma: no cover - convenience for `python main.py`
    import uvicorn

    import config

    s = config.load_settings()
    uvicorn.run(app, host=s.host, port=s.port, log_level="info")
