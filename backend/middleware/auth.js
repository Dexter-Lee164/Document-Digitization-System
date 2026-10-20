'use strict';
const { unauthorized } = require('../utils/errors');

/** Only same-site relative redirect targets are allowed (prevents open redirects through ?next=). */
function safeNext(value, fallback = '/dashboard') {
  if (typeof value === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(value) && !value.startsWith('/auth') && !value.startsWith('/login')) return value;
  return fallback;
}

function loadUser(db, req) {
  const id = req.session && req.session.userId;
  if (!id) return null;
  return db.one('SELECT id, email, created_at FROM users WHERE id = ?', id);
}

/** Attach the signed-in user (if any) without ever failing - used for the login pages and error pages. */
function optionalUser(db) {
  return (req, res, next) => {
    try {
      const user = loadUser(db, req);
      if (user) { req.user = user; res.locals.user = user; }
    } catch { /* treat as anonymous */ }
    next();
  };
}

/** JSON API guard -> 401. */
function requireAuthApi(db) {
  return (req, res, next) => {
    const user = loadUser(db, req);
    if (!user) return next(unauthorized());
    req.user = user;
    res.locals.user = user;
    return next();
  };
}

/** HTML page guard -> redirect to the login page. */
function requireAuthPage(db) {
  return (req, res, next) => {
    const user = loadUser(db, req);
    if (!user) {
      const target = req.originalUrl && req.originalUrl.length < 200 ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
      return res.redirect(`/login${target}`);
    }
    req.user = user;
    res.locals.user = user;
    return next();
  };
}

module.exports = { requireAuthApi, requireAuthPage, optionalUser, safeNext };
