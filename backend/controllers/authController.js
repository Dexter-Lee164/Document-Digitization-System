'use strict';
const bcrypt = require('bcryptjs');
const { isUniqueViolation } = require('../database/db');
const { AppError, badRequest, conflict, tooMany } = require('../utils/errors');
const { validateEmail, validatePassword } = require('../utils/validators');
const { RateLimiter } = require('../utils/rateLimit');
const { newToken } = require('../middleware/csrf');
const { safeNext } = require('../middleware/auth');
const { now } = require('../services/documents');

// A real bcrypt hash of a random value: compared against when the email is unknown so response time does not
// reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-' + Math.random(), 4);

/** JSON client (fetch with a JSON body or an explicit Accept header) vs. a plain browser form post. */
const isApiCall = (req) => Boolean(req.is('json')) || (req.get('accept') || '').includes('application/json');

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}
function save(req) {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}
function destroy(req) {
  return new Promise((resolve) => req.session.destroy(() => resolve()));
}

function createAuthController({ db, config }) {
  const loginLimiter = new RateLimiter({ windowMs: 15 * 60 * 1000, max: config.loginMaxAttempts });
  const registerLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, max: 20 });

  /** New session id (prevents fixation) + fresh CSRF token. */
  async function startSession(req, userId) {
    await regenerate(req);
    req.session.userId = userId;
    req.session.csrfToken = newToken();
    await save(req);
  }

  const respond = (req, res, body, redirect) => {
    if (isApiCall(req)) return res.json({ ...body, redirect });
    return res.redirect(303, redirect);
  };

  function renderAuthError(req, res, view, err, email) {
    const status = err instanceof AppError ? err.status : 500;
    const message = err instanceof AppError ? err.message : 'Something went wrong. Please try again.';
    return res.status(status).render(`auth/${view}`, { title: view === 'login' ? 'Sign in' : 'Create account', error: message, email: email || '', next: '', csrfToken: res.locals.csrfToken });
  }

  return {
    csrf(req, res) {
      res.json({ csrfToken: res.locals.csrfToken });
    },

    async register(req, res, next) {
      const wantsPage = !isApiCall(req);
      try {
        if (registerLimiter.blocked(req.ip)) throw tooMany();
        registerLimiter.hit(req.ip);
        const email = validateEmail(req.body.email);
        const password = validatePassword(req.body.password);
        if (req.body.confirm_password !== undefined && req.body.confirm_password !== password) {
          throw badRequest('The two passwords do not match.', { field: 'confirm_password' });
        }
        const hash = await bcrypt.hash(password, config.bcryptRounds);
        const ts = now();
        let userId;
        try {
          userId = db.tx(() => {
            const id = db.run('INSERT INTO users (email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)', email, hash, ts, ts).lastInsertRowid;
            db.run('INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)', id, ts);
            return id;
          });
        } catch (err) {
          if (isUniqueViolation(err)) throw conflict('An account with this email already exists. Try signing in instead.', 'email_taken');
          throw err;
        }
        await startSession(req, userId);
        return respond(req, res, { ok: true, user: { id: userId, email } }, '/dashboard');
      } catch (err) {
        if (wantsPage && err instanceof AppError) return renderAuthError(req, res, 'register', err, req.body && req.body.email);
        return next(err);
      }
    },

    async login(req, res, next) {
      const wantsPage = !isApiCall(req);
      try {
        const email = validateEmail(req.body.email);
        const password = typeof req.body.password === 'string' ? req.body.password : '';
        const keys = [`ip:${req.ip}`, `acct:${email}`];
        if (keys.some((k) => loginLimiter.blocked(k))) throw tooMany();

        const user = db.one('SELECT id, email, password_hash FROM users WHERE email = ?', email);
        const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
        if (!user || !ok) {
          keys.forEach((k) => loginLimiter.hit(k));
          throw new AppError(401, 'invalid_credentials', 'Incorrect email or password.');
        }
        keys.forEach((k) => loginLimiter.reset(k));
        await startSession(req, user.id);
        const target = safeNext(req.body.next || req.query.next);
        return respond(req, res, { ok: true, user: { id: user.id, email: user.email } }, target);
      } catch (err) {
        if (wantsPage && err instanceof AppError) return renderAuthError(req, res, 'login', err, req.body && req.body.email);
        return next(err);
      }
    },

    async logout(req, res, next) {
      try {
        await destroy(req);
        res.clearCookie('dv.sid');
        return respond(req, res, { ok: true }, '/login');
      } catch (err) {
        return next(err);
      }
    },
  };
}

module.exports = { createAuthController };
