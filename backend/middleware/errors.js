'use strict';
const { AppError } = require('../utils/errors');

function wantsJson(req) {
  return req.path.startsWith('/api/') || Boolean(req.is('json')) || (req.get('accept') || '').includes('application/json');
}

/** 404 for unmatched routes. */
function notFoundHandler(req, res, next) {
  next(new AppError(404, 'not_found', 'The page or resource you requested does not exist.'));
}

/**
 * Central error handler: user-safe AppErrors keep their message, everything else becomes a generic 500.
 * Stack traces, SQL and file-system paths are never sent to the client.
 */
function errorHandler(config, logger = console) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'Something went wrong on our side. Please try again.';
    let details;

    if (err instanceof AppError) {
      ({ status, code, message, details } = err);
    } else if (err && err.type === 'entity.too.large') {
      status = 413; code = 'payload_too_large'; message = 'The request is too large.';
    } else if (err && err.type === 'entity.parse.failed') {
      status = 400; code = 'invalid_json'; message = 'The request body is not valid JSON.';
    } else if (err && err.status && err.status >= 400 && err.status < 500) {
      status = err.status; code = 'bad_request'; message = 'The request could not be processed.';
    } else {
      logger.error(`[error] ${req.method} ${req.originalUrl}`, err);
    }

    if (res.headersSent) return req.socket.destroy();
    res.status(status);
    if (wantsJson(req)) {
      return res.json({ error: { code, message, ...(details ? { details } : {}) } });
    }
    return res.render('error', { title: status === 404 ? 'Page not found' : 'Something went wrong', status, message, nav: '', crumbs: [], user: res.locals.user || null, csrfToken: res.locals.csrfToken || '' });
  };
}

module.exports = { notFoundHandler, errorHandler, wantsJson };
