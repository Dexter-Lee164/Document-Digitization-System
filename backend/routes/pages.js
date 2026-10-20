'use strict';
const express = require('express');
const { notFound } = require('../utils/errors');
const { parseId } = require('../utils/validators');
const { requireAuthPage } = require('../middleware/auth');
const { noStore } = require('../middleware/security');

function pageRoutes({ db, pages }) {
  const router = express.Router();
  const auth = requireAuthPage(db);

  router.param('id', (req, res, next, value) => {
    const id = parseId(value);
    if (!id) return next(notFound('Document not found.'));
    req.docId = id;
    return next();
  });

  router.use(noStore);
  router.get('/', pages.root);
  router.get('/login', pages.login);
  router.get('/register', pages.register);

  router.get('/dashboard', auth, pages.dashboard);
  router.get('/scan/new', auth, pages.upload);
  router.get('/documents', auth, pages.documents);
  router.get('/documents/:id/workspace', auth, pages.workspace);
  router.get('/documents/:id/review', auth, pages.review);
  router.get('/documents/:id/export', auth, pages.exportPage);
  router.get('/history', auth, pages.history);
  router.get('/lab', auth, pages.lab);
  router.get('/settings', auth, pages.settings);
  return router;
}

module.exports = { pageRoutes };
