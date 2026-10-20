'use strict';
const crypto = require('node:crypto');
const { badRequest, conflict, notFound } = require('../utils/errors');
const { inspectImage } = require('../utils/imageMeta');
const { sanitizeFilename, stripExtension, parseJson, escapeLike } = require('../utils/validators');
const { getOwned, now, serialize, serializeJob, latestJob, touch } = require('../services/documents');

const DOC_TYPES = ['general', 'form'];
const STATUSES = ['uploaded', 'processing', 'processed', 'failed'];
const REVIEWS = ['not_started', 'needs_review', 'reviewed'];

/** Multer decodes multipart file names as latin1; browsers send UTF-8. Repair, then sanitise. */
function cleanUploadName(raw, ext) {
  let name = String(raw || '');
  try { name = Buffer.from(name, 'latin1').toString('utf8'); } catch { /* keep as is */ }
  const base = sanitizeFilename(stripExtension(name), `scan-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
  return `${base}.${ext}`.slice(0, 255);
}

function createDocumentsController({ db, config, storage, cv }) {
  const stageFile = (kind) => (req, res) => {
    const doc = getOwned(db, req.user.id, req.docId);
    const key = { original: doc.original_image_path, corrected: doc.corrected_image_path, enhanced: doc.enhanced_image_path }[kind];
    if (!key) throw notFound(`The ${kind} image is not available yet.`);
    res.setHeader('Content-Type', storage.contentType(key));
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(storage.abs(key), (err) => {
      if (err && !res.headersSent) {
        res.removeHeader('Content-Type'); res.removeHeader('Content-Disposition'); // otherwise the JSON error would be labelled as an image
        res.status(404).json({ error: { code: 'file_missing', message: 'The image file is missing from storage.' } });
      }
    });
  };

  return {
    async upload(req, res) {
      if (!req.file) throw badRequest('Choose an image to upload.', undefined, 'no_file');
      const meta = inspectImage(req.file.buffer);
      if (meta.width < 16 || meta.height < 16) throw badRequest('The image is too small to contain a document.', undefined, 'image_too_small');
      if (meta.width * meta.height > config.maxImagePixels) {
        throw badRequest(`The image is too large (${meta.width}x${meta.height}). The limit is ${Math.floor(config.maxImagePixels / 1e6)} megapixels.`, undefined, 'image_too_large');
      }
      const docType = DOC_TYPES.includes(req.body.document_type) ? req.body.document_type : 'general';

      const stored = `${crypto.randomUUID()}.${meta.ext}`;
      const key = `uploads/${stored}`;
      await storage.write(key, req.file.buffer);
      let info;
      try {
        info = await cv.validate(key); // real decode in the CV service: catches corrupted/truncated images
      } catch (err) {
        await storage.remove(key);
        throw err;
      }

      const ts = now();
      let id;
      try {
        id = db.run(
          `INSERT INTO documents (user_id, original_filename, stored_filename, original_image_path, mime_type, file_size, image_width, image_height, document_type, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          req.user.id, cleanUploadName(req.file.originalname, meta.ext), stored, key, meta.mime, req.file.size, info.width, info.height, docType, ts, ts,
        ).lastInsertRowid;
      } catch (err) {
        await storage.remove(key);
        throw err;
      }
      res.status(201).json({ document: serialize(getOwned(db, req.user.id, id)) });
    },

    list(req, res) {
      const q = req.query;
      const search = typeof q.search === 'string' ? q.search.trim().slice(0, 100) : '';
      const status = STATUSES.includes(q.status) ? q.status : null;
      const review = REVIEWS.includes(q.review) ? q.review : null;
      const type = DOC_TYPES.includes(q.type) ? q.type : null;
      const sort = { oldest: 'd.created_at ASC, d.id ASC', name: 'd.original_filename COLLATE NOCASE ASC, d.id DESC' }[q.sort] || 'd.created_at DESC, d.id DESC';
      const pageSize = Math.min(Math.max(Number.parseInt(q.page_size, 10) || 15, 1), 50);
      const page = Math.max(Number.parseInt(q.page, 10) || 1, 1);

      const where = ['d.user_id = ?'];
      const params = [req.user.id];
      if (search) { where.push("d.original_filename LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(search)}%`); }
      if (status) { where.push('d.processing_status = ?'); params.push(status); }
      if (review) { where.push('d.review_status = ?'); params.push(review); }
      if (type) { where.push('d.document_type = ?'); params.push(type); }
      const clause = where.join(' AND ');

      const total = db.one(`SELECT COUNT(*) AS n FROM documents d WHERE ${clause}`, ...params).n;
      const rows = db.all(
        `SELECT d.*, o.confidence_score,
                (SELECT COUNT(*) FROM document_exports e WHERE e.document_id = d.id) AS export_count,
                (SELECT e.id FROM document_exports e WHERE e.document_id = d.id ORDER BY e.id DESC LIMIT 1) AS latest_export_id
           FROM documents d LEFT JOIN ocr_results o ON o.document_id = d.id
          WHERE ${clause} ORDER BY ${sort} LIMIT ? OFFSET ?`,
        ...params, pageSize, (page - 1) * pageSize,
      );
      res.json({
        items: rows.map((r) => serialize(r, { confidence: r.confidence_score, export_count: r.export_count, latest_export_id: r.latest_export_id })),
        total, page, page_size: pageSize, pages: Math.max(1, Math.ceil(total / pageSize)),
      });
    },

    get(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      const ocr = db.one('SELECT confidence_score, updated_at FROM ocr_results WHERE document_id = ?', doc.id);
      const exportsCount = db.one('SELECT COUNT(*) AS n FROM document_exports WHERE document_id = ?', doc.id).n;
      const geometry = parseJson(doc.geometry_json, null);
      const enhancement = parseJson(doc.enhancement_json, null);
      res.json({
        document: serialize(doc, {
          corners: parseJson(doc.corners_json, null),
          has_ocr: Boolean(ocr),
          confidence: ocr ? ocr.confidence_score : null,
          export_count: exportsCount,
        }),
        geometry,
        enhancement,
        job: serializeJob(latestJob(db, doc.id)),
      });
    },

    update(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      const body = req.body || {};
      const fields = {};
      if (body.document_type !== undefined) {
        if (!DOC_TYPES.includes(body.document_type)) throw badRequest("document_type must be 'general' or 'form'.");
        fields.document_type = body.document_type;
      }
      if (body.original_filename !== undefined) {
        const name = sanitizeFilename(stripExtension(body.original_filename), '');
        if (!name) throw badRequest('Enter a valid document name.');
        fields.original_filename = `${name}.${doc.stored_filename.split('.').pop()}`.slice(0, 255);
      }
      if (!Object.keys(fields).length) throw badRequest('Nothing to update.');
      if (doc.processing_status === 'processing') throw conflict('The document is being processed. Try again when it finishes.', 'busy');
      touch(db, doc.id, fields);
      res.json({ document: serialize(getOwned(db, req.user.id, doc.id)) });
    },

    async remove(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      const active = db.one("SELECT id FROM processing_jobs WHERE document_id = ? AND status IN ('queued','running')", doc.id);
      if (doc.processing_status === 'processing' || active) throw conflict('This document is still being processed. Wait for it to finish before deleting.', 'busy');

      const exportsRows = db.all('SELECT file_path FROM document_exports WHERE document_id = ?', doc.id);
      // Database first (cascades jobs, OCR, exports, experiments); files afterwards so a failure never leaves dangling rows.
      db.run('DELETE FROM documents WHERE id = ? AND user_id = ?', doc.id, req.user.id);
      const stem = doc.stored_filename.replace(/\.[A-Za-z0-9]+$/, '');
      const cleanup = [storage.remove(doc.original_image_path), storage.removeDir(`processed/${stem}`), ...exportsRows.map((e) => storage.remove(e.file_path))];
      const results = await Promise.allSettled(cleanup);
      const failed = results.filter((r) => r.status === 'rejected').length;
      res.json({ ok: true, files_removed: cleanup.length - failed, files_failed: failed });
    },

    original: stageFile('original'),
    corrected: stageFile('corrected'),
    enhanced: stageFile('enhanced'),

    /** Run automatic boundary detection only (cheap) and remember the corners for the manual editor. */
    async detect(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      if (doc.processing_status === 'processing') throw conflict('The document is being processed. Try again when it finishes.', 'busy');
      const result = await cv.detect(doc.original_image_path);
      touch(db, doc.id, { corners_json: JSON.stringify(result.corners) });
      res.json(result);
    },
  };
}

module.exports = { createDocumentsController };
