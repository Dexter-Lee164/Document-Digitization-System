'use strict';
const { notFound } = require('../utils/errors');
const { parseJson } = require('../utils/validators');

const now = () => new Date().toISOString();

/** Fetch a document that belongs to `userId`. Other users' documents look exactly like missing ones (404). */
function getOwned(db, userId, id) {
  const doc = db.one('SELECT * FROM documents WHERE id = ? AND user_id = ?', id, userId);
  if (!doc) throw notFound('Document not found.');
  return doc;
}

function stem(doc) {
  return doc.stored_filename.replace(/\.[A-Za-z0-9]+$/, '');
}

function outputPrefix(doc) {
  return `processed/${stem(doc)}`;
}

/** Public shape of a document (never exposes storage paths). */
function serialize(doc, extra = {}) {
  return {
    id: doc.id,
    original_filename: doc.original_filename,
    document_type: doc.document_type,
    processing_status: doc.processing_status,
    review_status: doc.review_status,
    mime_type: doc.mime_type,
    file_size: doc.file_size,
    image_width: doc.image_width,
    image_height: doc.image_height,
    has_corrected: Boolean(doc.corrected_image_path),
    has_enhanced: Boolean(doc.enhanced_image_path),
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    ...extra,
  };
}

function serializeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    document_id: job.document_id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    stage_timings: parseJson(job.stage_timings, {}),
    processing_time_ms: job.processing_time_ms,
    error_message: job.error_message,
    created_at: job.created_at,
    completed_at: job.completed_at,
  };
}

function latestJob(db, documentId) {
  return db.one('SELECT * FROM processing_jobs WHERE document_id = ? ORDER BY id DESC LIMIT 1', documentId);
}

function touch(db, docId, fields = {}) {
  const cols = Object.keys(fields);
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  db.run(`UPDATE documents SET ${sets}${cols.length ? ', ' : ''}updated_at = ? WHERE id = ?`, ...cols.map((c) => fields[c]), now(), docId);
}

module.exports = { now, getOwned, stem, outputPrefix, serialize, serializeJob, latestJob, touch };
