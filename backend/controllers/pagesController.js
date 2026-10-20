'use strict';
const { getOwned, serialize, serializeJob } = require('../services/documents');
const { readSettings, serializeSettings } = require('./settingsController');

const CRUMB_HOME = { label: 'Dashboard', href: '/dashboard' };

/** Real numbers computed from the user's own rows - nothing here is a placeholder. */
function dashboardData(db, userId) {
  const docs = db.one(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(processing_status = 'processed'), 0)  AS processed,
            COALESCE(SUM(processing_status = 'failed'), 0)     AS failed,
            COALESCE(SUM(processing_status = 'processing'), 0) AS processing,
            COALESCE(SUM(processing_status = 'uploaded'), 0)   AS awaiting,
            COALESCE(SUM(review_status = 'needs_review'), 0)   AS needs_review,
            COALESCE(SUM(review_status = 'reviewed'), 0)       AS reviewed
       FROM documents WHERE user_id = ?`, userId);
  const exportsRow = db.one(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT e.document_id) AS documents
       FROM document_exports e JOIN documents d ON d.id = e.document_id WHERE d.user_id = ?`, userId);
  const ocr = db.one(
    `SELECT AVG(o.confidence_score) AS avg_confidence, COUNT(*) AS n
       FROM ocr_results o JOIN documents d ON d.id = o.document_id WHERE d.user_id = ? AND o.confidence_score IS NOT NULL`, userId);
  const jobs = db.one(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(j.status = 'completed'), 0) AS completed,
            COALESCE(SUM(j.status = 'failed'), 0)    AS failed,
            AVG(CASE WHEN j.status = 'completed' THEN j.processing_time_ms END) AS avg_ms
       FROM processing_jobs j JOIN documents d ON d.id = j.document_id WHERE d.user_id = ?`, userId);

  // Uploads per day for the last 7 days (UTC dates, zero-filled).
  const since = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const perDay = new Map(db.all(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM documents WHERE user_id = ? AND substr(created_at, 1, 10) >= ? GROUP BY day`, userId, since,
  ).map((r) => [r.day, r.n]));
  const week = [];
  for (let i = 6; i >= 0; i -= 1) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    week.push({ day, count: perDay.get(day) || 0 });
  }

  const recent = db.all(
    `SELECT d.*, o.confidence_score FROM documents d LEFT JOIN ocr_results o ON o.document_id = d.id
      WHERE d.user_id = ? ORDER BY d.created_at DESC, d.id DESC LIMIT 6`, userId,
  ).map((r) => serialize(r, { confidence: r.confidence_score }));
  const recentJobs = db.all(
    `SELECT j.*, d.original_filename FROM processing_jobs j JOIN documents d ON d.id = j.document_id
      WHERE d.user_id = ? ORDER BY j.id DESC LIMIT 5`, userId,
  ).map((r) => ({ ...serializeJob(r), original_filename: r.original_filename }));

  return {
    documents: docs,
    exports: exportsRow,
    ocr: { average_confidence: ocr.avg_confidence === null ? null : Math.round(ocr.avg_confidence * 10) / 10, results: ocr.n },
    jobs: { total: jobs.total, completed: jobs.completed, failed: jobs.failed, average_ms: jobs.avg_ms === null ? null : Math.round(jobs.avg_ms) },
    week,
    recent,
    recent_jobs: recentJobs,
  };
}

function createPagesController({ db, config }) {
  const base = (req, res, nav, title, crumbs = []) => ({
    title, nav, crumbs, user: req.user, csrfToken: res.locals.csrfToken, maxUploadMb: Math.round(config.maxUploadSize / (1024 * 1024)),
  });

  const documentPage = (view, nav, label, suffix) => (req, res) => {
    const doc = getOwned(db, req.user.id, req.docId);
    const settings = serializeSettings(readSettings(db, req.user.id));
    res.render(view, {
      ...base(req, res, nav, `${label} - ${doc.original_filename}`, [
        CRUMB_HOME, { label: 'My Documents', href: '/documents' }, { label: doc.original_filename, href: `/documents/${doc.id}/${suffix}` }, { label },
      ]),
      doc: serialize(doc),
      settings,
    });
  };

  return {
    root(req, res) {
      res.redirect(req.user ? '/dashboard' : '/login');
    },
    login(req, res) {
      if (req.user) return res.redirect('/dashboard');
      return res.render('auth/login', { title: 'Sign in', error: '', email: '', next: typeof req.query.next === 'string' ? req.query.next.slice(0, 200) : '', csrfToken: res.locals.csrfToken });
    },
    register(req, res) {
      if (req.user) return res.redirect('/dashboard');
      return res.render('auth/register', { title: 'Create account', error: '', email: '', next: '', csrfToken: res.locals.csrfToken });
    },
    dashboard(req, res) {
      res.render('dashboard', { ...base(req, res, 'dashboard', 'Dashboard'), data: dashboardData(db, req.user.id) });
    },
    upload(req, res) {
      res.render('upload', { ...base(req, res, 'scan', 'New Scan', [CRUMB_HOME, { label: 'New Scan' }]), settings: serializeSettings(readSettings(db, req.user.id)) });
    },
    documents(req, res) {
      res.render('documents', base(req, res, 'documents', 'My Documents', [CRUMB_HOME, { label: 'My Documents' }]));
    },
    workspace: documentPage('workspace', 'documents', 'Processing workspace', 'workspace'),
    review: documentPage('review', 'documents', 'OCR review', 'review'),
    exportPage: documentPage('export', 'documents', 'Export', 'export'),
    history(req, res) {
      res.render('history', base(req, res, 'history', 'History', [CRUMB_HOME, { label: 'History' }]));
    },
    lab(req, res) {
      res.render('lab', base(req, res, 'lab', 'DSP Lab', [CRUMB_HOME, { label: 'DSP Lab' }]));
    },
    settings(req, res) {
      res.render('settings', { ...base(req, res, 'settings', 'Settings', [CRUMB_HOME, { label: 'Settings' }]), settings: serializeSettings(readSettings(db, req.user.id)) });
    },
  };
}

module.exports = { createPagesController, dashboardData };
