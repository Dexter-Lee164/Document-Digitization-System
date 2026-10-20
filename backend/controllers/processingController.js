'use strict';
const { badRequest, conflict, notFound } = require('../utils/errors');
const { asBool } = require('../utils/validators');
const { getOwned, serialize, serializeJob, latestJob, touch } = require('../services/documents');

const DOC_TYPES = ['general', 'form'];

function createProcessingController({ db, schema, processing }) {
  return {
    /** POST /api/documents/:id/process  -> 202 + job (poll /status) */
    process(req, res) {
      let doc = getOwned(db, req.user.id, req.docId);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (doc.processing_status === 'processing') throw conflict('This document is already being processed. Wait for it to finish.', 'already_processing');

      if (body.document_type !== undefined && body.document_type !== doc.document_type) {
        if (!DOC_TYPES.includes(body.document_type)) throw badRequest("document_type must be 'general' or 'form'.");
        touch(db, doc.id, { document_type: body.document_type });
        doc = getOwned(db, req.user.id, doc.id);
      }
      const settings = schema.validateSettings({ preset: body.preset, params: body.params });
      const geometry = schema.validateGeometry(body, { width: doc.image_width, height: doc.image_height });
      const scope = body.scope === undefined ? 'full' : body.scope;
      if (!['full', 'enhance'].includes(scope)) throw badRequest("scope must be 'full' or 'enhance'.", { field: 'scope' });
      const runOcr = asBool(body.run_ocr, true);
      const psm = schema.validatePsm(body.psm, doc.document_type);

      const jobId = processing.startProcess(doc, { settings, geometry, scope, run_ocr: runOcr, psm });
      const job = db.one('SELECT * FROM processing_jobs WHERE id = ?', jobId);
      res.status(202).json({ job: serializeJob(job), document: serialize(getOwned(db, req.user.id, doc.id)) });
    },

    /** GET /api/documents/:id/status - what the workspace polls for real progress. */
    status(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      const job = latestJob(db, doc.id);
      const hasOcr = Boolean(db.one('SELECT 1 AS x FROM ocr_results WHERE document_id = ?', doc.id));
      res.json({
        document: serialize(doc, { has_ocr: hasOcr }),
        job: serializeJob(job),
        active: Boolean(job && (job.status === 'queued' || job.status === 'running')),
      });
    },

    /** GET /api/jobs - processing history for the signed-in user. */
    history(req, res) {
      const pageSize = Math.min(Math.max(Number.parseInt(req.query.page_size, 10) || 20, 1), 100);
      const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
      const total = db.one('SELECT COUNT(*) AS n FROM processing_jobs j JOIN documents d ON d.id = j.document_id WHERE d.user_id = ?', req.user.id).n;
      const rows = db.all(
        `SELECT j.*, d.original_filename, d.document_type
           FROM processing_jobs j JOIN documents d ON d.id = j.document_id
          WHERE d.user_id = ? ORDER BY j.id DESC LIMIT ? OFFSET ?`,
        req.user.id, pageSize, (page - 1) * pageSize,
      );
      res.json({
        items: rows.map((r) => {
          let preset = null;
          try { preset = JSON.parse(r.processing_settings).settings.preset; } catch { /* ocr-only jobs have no preset */ }
          return { ...serializeJob(r), original_filename: r.original_filename, document_type: r.document_type, preset };
        }),
        total, page, page_size: pageSize, pages: Math.max(1, Math.ceil(total / pageSize)),
      });
    },

    schema(req, res) {
      res.json(schema.describe());
    },

    notFoundJob() { throw notFound('Job not found.'); },
  };
}

module.exports = { createProcessingController };
