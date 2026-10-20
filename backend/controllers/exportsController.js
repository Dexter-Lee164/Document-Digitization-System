'use strict';
const crypto = require('node:crypto');
const { badRequest, conflict, notFound } = require('../utils/errors');
const { asBool, parseJson, sanitizeFilename, stripExtension } = require('../utils/validators');
const { getOwned, now } = require('../services/documents');

/** Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 name (no header injection possible). */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function serializeExport(row) {
  return {
    id: row.id,
    document_id: row.document_id,
    export_type: row.export_type,
    filename: row.filename,
    created_at: row.created_at,
    document_name: row.original_filename,
    download_url: `/api/exports/${row.id}/download`,
  };
}

function createExportsController({ db, storage, cv }) {
  const ownedExport = (userId, id) => {
    const row = db.one(
      `SELECT e.*, d.original_filename FROM document_exports e JOIN documents d ON d.id = e.document_id
        WHERE e.id = ? AND d.user_id = ?`, id, userId,
    );
    if (!row) throw notFound('Export not found.');
    return row;
  };

  return {
    /** POST /api/documents/:id/export  { type:'text'|'form', filename?, reflow?, include_full_text? } */
    async create(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      const ocr = db.one('SELECT * FROM ocr_results WHERE document_id = ?', doc.id);
      if (!ocr) throw conflict('There is no recognised text to export yet. Process the document first.', 'no_ocr');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const settings = db.one('SELECT * FROM user_settings WHERE user_id = ?', req.user.id) || {};

      const form = parseJson(ocr.structured_fields_json, null);
      const hasForm = Boolean(form && form.matched && Array.isArray(form.fields) && form.fields.length);
      const type = body.type === undefined ? (hasForm ? 'form' : 'text') : body.type;
      if (!['text', 'form'].includes(type)) throw badRequest("type must be 'text' or 'form'.", { field: 'type' });
      if (type === 'form' && !hasForm) throw badRequest('This document has no structured form fields. Export it as a text document instead.', { field: 'type' }, 'no_form_fields');

      const reflow = asBool(body.reflow, settings.export_reflow === undefined ? true : Boolean(settings.export_reflow));
      const includeFullText = asBool(body.include_full_text, settings.export_include_full_text === undefined ? true : Boolean(settings.export_include_full_text));
      if (type === 'text' && !ocr.corrected_text.trim()) throw badRequest('The text is empty - there is nothing to put in a Word document.', undefined, 'empty_text');

      if (body.filename !== undefined && typeof body.filename !== 'string') throw badRequest('filename must be text.', { field: 'filename' });
      const chosen = sanitizeFilename(stripExtension(body.filename ?? ''), '');
      const suffix = settings.export_filename_suffix === undefined ? '_digitized' : settings.export_filename_suffix;
      const filename = `${chosen || sanitizeFilename(sanitizeFilename(stripExtension(doc.original_filename), 'document') + suffix, 'document')}.docx`;

      const key = `exports/${crypto.randomUUID()}.docx`;
      const payload = {
        mode: type,
        output_key: key,
        title: type === 'form' ? form.title : stripExtension(doc.original_filename),
        text: ocr.corrected_text,
        reflow,
        include_full_text: includeFullText,
        fields: type === 'form' ? form.fields.map((f) => ({ key: f.key, label: f.label, value: f.value ?? '' })) : [],
      };
      const result = await cv.docx(payload);

      let id;
      try {
        id = db.run('INSERT INTO document_exports (document_id, export_type, filename, file_path, created_at) VALUES (?, ?, ?, ?, ?)', doc.id, type, filename, result.export_key, now()).lastInsertRowid;
      } catch (err) {
        await storage.remove(result.export_key);
        throw err;
      }
      const row = ownedExport(req.user.id, id);
      res.status(201).json({ export: serializeExport(row), verification: result.verification, bytes: result.bytes });
    },

    listForDocument(req, res) {
      const doc = getOwned(db, req.user.id, req.docId);
      const rows = db.all(
        `SELECT e.*, d.original_filename FROM document_exports e JOIN documents d ON d.id = e.document_id
          WHERE e.document_id = ? ORDER BY e.id DESC`, doc.id,
      );
      res.json({ items: rows.map(serializeExport) });
    },

    /** Export history across all of the user's documents. */
    list(req, res) {
      const pageSize = Math.min(Math.max(Number.parseInt(req.query.page_size, 10) || 20, 1), 100);
      const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
      const total = db.one('SELECT COUNT(*) AS n FROM document_exports e JOIN documents d ON d.id = e.document_id WHERE d.user_id = ?', req.user.id).n;
      const rows = db.all(
        `SELECT e.*, d.original_filename FROM document_exports e JOIN documents d ON d.id = e.document_id
          WHERE d.user_id = ? ORDER BY e.id DESC LIMIT ? OFFSET ?`, req.user.id, pageSize, (page - 1) * pageSize,
      );
      res.json({ items: rows.map(serializeExport), total, page, page_size: pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) });
    },

    download(req, res) {
      const row = ownedExport(req.user.id, req.exportId);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', contentDisposition(row.filename));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(storage.abs(row.file_path), { headers: {} }, (err) => {
        if (err && !res.headersSent) {
          res.removeHeader('Content-Type'); res.removeHeader('Content-Disposition'); // otherwise the JSON error would download as a .docx
          res.status(404).json({ error: { code: 'file_missing', message: 'The exported file is no longer in storage. Export the document again.' } });
        }
      });
    },

    async remove(req, res) {
      const row = ownedExport(req.user.id, req.exportId);
      db.run('DELETE FROM document_exports WHERE id = ?', row.id);
      await storage.remove(row.file_path);
      res.json({ ok: true });
    },
  };
}

module.exports = { createExportsController, contentDisposition };
