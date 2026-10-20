'use strict';
const { badRequest, conflict, notFound } = require('../utils/errors');
const { parseJson } = require('../utils/validators');
const { getOwned, serialize, serializeJob, latestJob, touch } = require('../services/documents');

const MAX_TEXT = 1_000_000;
const MAX_FIELD_VALUE = 2000;

function readRow(db, docId) {
  return db.one('SELECT * FROM ocr_results WHERE document_id = ?', docId);
}

function serializeOcr(row, doc) {
  const meta = parseJson(row.ocr_meta_json, {});
  const form = parseJson(row.structured_fields_json, null);
  return {
    document_id: doc.id,
    document_type: doc.document_type,
    review_status: doc.review_status,
    original_text: row.original_extracted_text,
    corrected_text: row.corrected_text,
    edited: row.original_extracted_text !== row.corrected_text,
    confidence: meta.confidence || { mean: row.confidence_score },
    words: parseJson(row.bounding_boxes_json, []),
    form,
    meta: { psm: meta.psm, lang: meta.lang, image_width: meta.image_width, image_height: meta.image_height, warnings: meta.warnings || [], empty: Boolean(meta.empty), duration_ms: meta.duration_ms, mode: meta.mode },
    updated_at: row.updated_at,
  };
}

function createOcrController({ db, schema, processing }) {
  return {
    get(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      const row = readRow(db, doc.id);
      if (!row) throw notFound('No OCR result exists for this document yet. Process it first.');
      res.json({ ocr: serializeOcr(row, doc) });
    },

    /**
     * Save the user's corrections. Body (all optional):
     *   corrected_text: string
     *   fields: [{key, value}]       (structured form fields)
     *   review_status: 'reviewed' | 'needs_review'
     *   reset: true                  (restore the original OCR text and original field values)
     */
    update(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      const row = readRow(db, doc.id);
      if (!row) throw notFound('No OCR result exists for this document yet. Process it first.');
      if (doc.processing_status === 'processing') throw conflict('The document is being processed. Wait for it to finish before saving changes.', 'busy');
      const body = req.body && typeof req.body === 'object' ? req.body : {};

      let text = row.corrected_text;
      let form = parseJson(row.structured_fields_json, null);

      if (body.reset === true) {
        text = row.original_extracted_text;
        if (form && Array.isArray(form.fields)) form.fields = form.fields.map((f) => ({ ...f, value: f.original_value }));
      } else {
        if (body.corrected_text !== undefined) {
          if (typeof body.corrected_text !== 'string') throw badRequest('corrected_text must be text.', { field: 'corrected_text' });
          if (body.corrected_text.length > MAX_TEXT) throw badRequest('The text is too long to save.', { field: 'corrected_text' });
          text = body.corrected_text.replace(/\r\n?/g, '\n');
        }
        if (body.fields !== undefined) {
          if (!Array.isArray(body.fields) || body.fields.length > 100) throw badRequest('fields must be a list of {key, value}.', { field: 'fields' });
          if (!form || !Array.isArray(form.fields) || !form.fields.length) throw badRequest('This document has no structured form fields.', { field: 'fields' });
          const byKey = new Map(form.fields.map((f) => [f.key, f]));
          for (const item of body.fields) {
            if (!item || typeof item.key !== 'string' || typeof item.value !== 'string') throw badRequest('Each field needs a text key and value.', { field: 'fields' });
            if (item.value.length > MAX_FIELD_VALUE) throw badRequest(`A field value is longer than ${MAX_FIELD_VALUE} characters.`, { field: item.key });
            const target = byKey.get(item.key);
            if (!target) throw badRequest(`Unknown form field '${item.key}'.`, { field: 'fields' });
            target.value = item.value.replace(/[\r\n]+/g, ' ').trim();
          }
        }
      }

      let review = doc.review_status;
      if (body.review_status !== undefined) {
        if (!['reviewed', 'needs_review'].includes(body.review_status)) throw badRequest("review_status must be 'reviewed' or 'needs_review'.", { field: 'review_status' });
        review = body.review_status;
      } else if (body.reset === true) {
        review = 'needs_review';
      }

      db.tx(() => {
        db.run('UPDATE ocr_results SET corrected_text = ?, structured_fields_json = ?, updated_at = ? WHERE document_id = ?',
          text, form ? JSON.stringify(form) : null, new Date().toISOString(), doc.id);
        touch(db, doc.id, { review_status: review });
      });
      const fresh = getOwned(db, req.user.id, doc.id);
      res.json({ ocr: serializeOcr(readRow(db, doc.id), fresh), document: serialize(fresh) });
    },

    /** Re-run OCR on the existing enhanced image (e.g. a different page-segmentation mode). Replaces earlier edits. */
    reprocess(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      if (!doc.enhanced_image_path) throw conflict('Process the document first - there is no enhanced image to read yet.', 'not_processed');
      if (doc.processing_status === 'processing') throw conflict('This document is already being processed.', 'already_processing');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const psm = schema.validatePsm(body.psm, doc.document_type);
      const hadEdits = (() => {
        const row = readRow(db, doc.id);
        return Boolean(row) && row.original_extracted_text !== row.corrected_text;
      })();
      const jobId = processing.startOcr(doc, { psm });
      res.status(202).json({
        job: serializeJob(db.one('SELECT * FROM processing_jobs WHERE id = ?', jobId)),
        replaces_edits: hadEdits,
        latest: serializeJob(latestJob(db, doc.id)),
      });
    },
  };
}

module.exports = { createOcrController };
