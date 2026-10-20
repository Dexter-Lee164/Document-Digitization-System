'use strict';
const express = require('express');
const { notFound } = require('../utils/errors');
const { parseId } = require('../utils/validators');
const { requireAuthApi } = require('../middleware/auth');
const { noStore } = require('../middleware/security');
const { singleImageUpload } = require('../middleware/upload');

/** Express 5 forwards rejected promises to the error handler itself, so async handlers need no wrapper. */
function apiRoutes({ db, config, c }) {
  const router = express.Router();

  const idParam = (field, message) => (req, res, next, value) => {
    const id = parseId(value);
    if (!id) return next(notFound(message));
    req[field] = id;
    return next();
  };
  router.param('id', idParam('docId', 'Document not found.'));
  router.param('exportId', idParam('exportId', 'Export not found.'));
  router.param('runId', idParam('runId', 'Experiment run not found.'));

  router.use(noStore);
  router.use(requireAuthApi(db));

  // system
  router.get('/health', c.system.health);
  router.get('/templates', c.system.templates);
  router.get('/dashboard', c.system.dashboard);
  router.get('/processing/schema', c.processing.schema);

  // documents
  router.get('/documents', c.documents.list);
  router.post('/documents', singleImageUpload(config), c.documents.upload);
  router.get('/documents/:id', c.documents.get);
  router.patch('/documents/:id', c.documents.update);
  router.delete('/documents/:id', c.documents.remove);
  router.get('/documents/:id/original', c.documents.original);
  router.get('/documents/:id/corrected', c.documents.corrected);
  router.get('/documents/:id/enhanced', c.documents.enhanced);

  // processing
  router.post('/documents/:id/detect', c.documents.detect);
  router.post('/documents/:id/process', c.processing.process);
  router.get('/documents/:id/status', c.processing.status);
  router.get('/jobs', c.processing.history);

  // OCR
  router.get('/documents/:id/ocr', c.ocr.get);
  router.patch('/documents/:id/ocr', c.ocr.update);
  router.post('/documents/:id/reprocess-ocr', c.ocr.reprocess);

  // exports
  router.post('/documents/:id/export', c.exports.create);
  router.get('/documents/:id/exports', c.exports.listForDocument);
  router.get('/exports', c.exports.list);
  router.get('/exports/:exportId/download', c.exports.download);
  router.delete('/exports/:exportId', c.exports.remove);

  // DSP experiments
  router.post('/documents/:id/experiments', c.experiments.run);
  router.get('/documents/:id/experiments', c.experiments.listForDocument);
  router.get('/experiments', c.experiments.list);
  router.get('/experiments/:runId', c.experiments.get);
  router.get('/experiments/:runId/csv', c.experiments.csv);
  router.delete('/experiments/:runId', c.experiments.remove);

  // settings
  router.get('/settings', c.settings.get);
  router.put('/settings', c.settings.update);
  router.post('/settings/password', c.settings.changePassword);

  return router;
}

module.exports = { apiRoutes };
