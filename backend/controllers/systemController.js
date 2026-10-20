'use strict';
const { dashboardData } = require('./pagesController');

function createSystemController({ db, config, cv, storage }) {
  return {
    /** Public liveness probe used by the start scripts - reveals nothing about the system. */
    healthz(req, res) {
      res.json({ status: 'ok' });
    },

    /** Detailed status for signed-in users (drives the status indicator in the app header). */
    async health(req, res) {
      const python = await cv.health();
      let database = 'ok';
      try { db.one('SELECT 1 AS ok'); } catch { database = 'error'; }
      res.json({
        node: { status: 'ok', version: process.version },
        database: { status: database },
        storage: { status: 'ok' },
        // status: ok | degraded (service up, Tesseract missing) | offline (not reachable)
        cv_service: { status: python.status, ...(python.status !== 'offline' ? { version: python.version, opencv: python.opencv } : {}) },
        ocr: { available: Boolean(python.ocr && python.ocr.available), version: python.ocr && python.ocr.version, languages: python.ocr && python.ocr.languages, error: python.ocr && python.ocr.error },
        limits: { max_upload_bytes: config.maxUploadSize },
      });
    },

    async templates(req, res) {
      res.json(await cv.templates());
    },

    dashboard(req, res) {
      res.json(dashboardData(db, req.user.id));
    },
  };
}

module.exports = { createSystemController };
