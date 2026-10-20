'use strict';
const { badRequest, conflict, notFound } = require('../utils/errors');
const { parseJson, sanitizeFilename, stripExtension } = require('../utils/validators');
const { getOwned, now } = require('../services/documents');
const { contentDisposition } = require('./exportsController');

const CONFIGS = ['A', 'B', 'C', 'D'];
const MAX_REFERENCE = 500_000;

/** CSV cell with quoting + spreadsheet formula-injection protection. */
function cell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? String(value) : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(run, docName) {
  const header = ['document', 'run_id', 'run_at', 'config', 'description', 'geometry_ms', 'enhancement_ms', 'ocr_ms', 'total_ms',
    'mean_confidence', 'low_confidence_words', 'word_count', 'cer', 'wer', 'reference_provided', 'error'];
  const rows = (run.results.results || []).map((r) => [
    docName, run.id, run.created_at, r.config, r.label, r.geometry_ms, r.enhancement_ms, r.ocr_ms, r.total_ms,
    r.confidence ? r.confidence.mean : '', r.confidence ? r.confidence.low_confidence_count : '', r.word_count,
    r.cer ?? '', r.wer ?? '', run.results.reference_provided ? 'yes' : 'no', r.error || '',
  ]);
  // CRLF + BOM so Excel on Windows opens the file with the right encoding.
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

function serializeRun(row, { full = true } = {}) {
  const results = parseJson(row.results_json, {});
  return {
    id: row.id,
    document_id: row.document_id,
    document_name: row.original_filename,
    created_at: row.created_at,
    settings: parseJson(row.settings_json, {}),
    has_reference: Boolean(row.reference_text && row.reference_text.trim()),
    results: full ? results : { ...results, results: (results.results || []).map(({ text, ...rest }) => rest) },
  };
}

function createExperimentsController({ db, schema, cv }) {
  const running = new Set(); // document ids with an experiment in flight (they are CPU heavy)

  const ownedRun = (userId, id) => {
    const row = db.one(
      `SELECT r.*, d.original_filename FROM experiment_runs r JOIN documents d ON d.id = r.document_id
        WHERE r.id = ? AND d.user_id = ?`, id, userId,
    );
    if (!row) throw notFound('Experiment run not found.');
    return row;
  };

  return {
    async run(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (doc.processing_status === 'processing') throw conflict('The document is being processed. Try again when it finishes.', 'busy');

      let configs = CONFIGS;
      if (body.configs !== undefined) {
        if (!Array.isArray(body.configs) || !body.configs.length || !body.configs.every((c) => CONFIGS.includes(c))) throw badRequest('configs must be a non-empty list of A, B, C, D.', { field: 'configs' });
        configs = [...new Set(body.configs)];
      }
      const settings = schema.validateSettings({ preset: body.preset ?? 'document_scan', params: body.params });
      const psm = schema.validatePsm(body.psm ?? undefined, 'general');
      let reference = null;
      if (body.reference_text !== undefined && body.reference_text !== null && body.reference_text !== '') {
        if (typeof body.reference_text !== 'string') throw badRequest('reference_text must be text.', { field: 'reference_text' });
        if (body.reference_text.length > MAX_REFERENCE) throw badRequest('The reference text is too long.', { field: 'reference_text' });
        reference = body.reference_text.replace(/\r\n?/g, '\n');
      }
      // Re-use the page corners the user confirmed in the workspace (if any); otherwise the service detects them itself.
      let corners = null;
      try { corners = schema.validateCorners(parseJson(doc.corners_json, null), { width: doc.image_width, height: doc.image_height }); } catch { corners = null; }

      if (running.has(doc.id)) throw conflict('An experiment for this document is already running.', 'already_running');
      running.add(doc.id);
      try {
        const results = await cv.experiments({
          storage_key: doc.original_image_path,
          configs,
          settings,
          corners,
          auto_orient: true,
          auto_deskew: true,
          reference_text: reference,
          psm,
        });
        const id = db.run(
          'INSERT INTO experiment_runs (document_id, reference_text, settings_json, results_json, created_at) VALUES (?, ?, ?, ?, ?)',
          doc.id, reference, JSON.stringify({ ...settings, psm, configs, used_corners: Boolean(corners) }), JSON.stringify(results), now(),
        ).lastInsertRowid;
        res.status(201).json({ run: serializeRun(ownedRun(req.user.id, id)) });
      } finally {
        running.delete(doc.id);
      }
    },

    listForDocument(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      const rows = db.all(
        `SELECT r.*, d.original_filename FROM experiment_runs r JOIN documents d ON d.id = r.document_id
          WHERE r.document_id = ? ORDER BY r.id DESC LIMIT 50`, doc.id,
      );
      res.json({ items: rows.map((r) => serializeRun(r, { full: false })) });
    },

    get(req, res) {
      res.json({ run: serializeRun(ownedRun(req.user.id, req.runId)) });
    },

    list(req, res) {
      const rows = db.all(
        `SELECT r.*, d.original_filename FROM experiment_runs r JOIN documents d ON d.id = r.document_id
          WHERE d.user_id = ? ORDER BY r.id DESC LIMIT 50`, req.user.id,
      );
      res.json({ items: rows.map((r) => serializeRun(r, { full: false })) });
    },

    csv(req, res) {
      const row = ownedRun(req.user.id, req.runId);
      const run = serializeRun(row);
      const name = sanitizeFilename(`${stripExtension(row.original_filename)}_experiment_${row.id}`, 'experiment');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', contentDisposition(`${name}.csv`));
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(toCsv(run, row.original_filename));
    },

    async remove(req, res) {
      const row = ownedRun(req.user.id, req.runId);
      db.run('DELETE FROM experiment_runs WHERE id = ?', row.id);
      res.json({ ok: true });
    },
  };
}

module.exports = { createExperimentsController, toCsv };
