'use strict';
const crypto = require('node:crypto');
const { forbidden } = require('../utils/errors');

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Make sure the session carries a CSRF token (this also creates the session cookie for anonymous visitors). */
function ensureToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = newToken();
  return req.session.csrfToken;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Synchronizer-token CSRF protection for every state-changing request.
 * The token is sent by the browser in the `X-CSRF-Token` header (fetch) or a hidden `_csrf` form field.
 */
function csrfProtection() {
  return (req, res, next) => {
    const token = ensureToken(req);
    res.locals.csrfToken = token;
    if (!UNSAFE.has(req.method)) return next();
    const supplied = req.get('x-csrf-token') || (req.body && req.body._csrf);
    if (!supplied || !safeEqual(supplied, token)) {
      return next(forbidden('Your session security token is missing or expired. Reload the page and try again.', 'csrf_failed'));
    }
    return next();
  };
}

module.exports = { csrfProtection, ensureToken, newToken };
