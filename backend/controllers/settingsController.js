'use strict';
const bcrypt = require('bcryptjs');
const { AppError, badRequest, tooMany } = require('../utils/errors');
const { validatePassword, asBool } = require('../utils/validators');
const { RateLimiter } = require('../utils/rateLimit');
const { newToken } = require('../middleware/csrf');
const { now } = require('../services/documents');

const PRESETS = ['automatic', 'document_scan', 'black_white', 'grayscale', 'custom'];
const TYPES = ['general', 'form'];

function serializeSettings(row) {
  return {
    default_preset: row.default_preset,
    default_document_type: row.default_document_type,
    export_reflow: Boolean(row.export_reflow),
    export_include_full_text: Boolean(row.export_include_full_text),
    export_filename_suffix: row.export_filename_suffix,
    updated_at: row.updated_at,
  };
}

function readSettings(db, userId) {
  let row = db.one('SELECT * FROM user_settings WHERE user_id = ?', userId);
  if (!row) {
    db.run('INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)', userId, now());
    row = db.one('SELECT * FROM user_settings WHERE user_id = ?', userId);
  }
  return row;
}

function createSettingsController({ db, config }) {
  const pwLimiter = new RateLimiter({ windowMs: 15 * 60 * 1000, max: config.loginMaxAttempts });

  return {
    get(req, res) {
      res.json({ settings: serializeSettings(readSettings(db, req.user.id)), user: { id: req.user.id, email: req.user.email, created_at: req.user.created_at } });
    },

    update(req, res) {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const current = readSettings(db, req.user.id);
      const next = { ...current };
      if (body.default_preset !== undefined) {
        if (!PRESETS.includes(body.default_preset)) throw badRequest('Choose one of the available presets.', { field: 'default_preset' });
        next.default_preset = body.default_preset;
      }
      if (body.default_document_type !== undefined) {
        if (!TYPES.includes(body.default_document_type)) throw badRequest("Document type must be 'general' or 'form'.", { field: 'default_document_type' });
        next.default_document_type = body.default_document_type;
      }
      if (body.export_reflow !== undefined) next.export_reflow = asBool(body.export_reflow) ? 1 : 0;
      if (body.export_include_full_text !== undefined) next.export_include_full_text = asBool(body.export_include_full_text) ? 1 : 0;
      if (body.export_filename_suffix !== undefined) {
        const suffix = String(body.export_filename_suffix);
        // eslint-disable-next-line no-control-regex
        if (suffix.length > 40 || /[\\/:*?"<>|\u0000-\u001f]/.test(suffix)) throw badRequest('The file name suffix may be up to 40 characters and cannot contain \\ / : * ? " < > |.', { field: 'export_filename_suffix' });
        next.export_filename_suffix = suffix;
      }
      db.run(
        `UPDATE user_settings SET default_preset = ?, default_document_type = ?, export_reflow = ?, export_include_full_text = ?, export_filename_suffix = ?, updated_at = ?
          WHERE user_id = ?`,
        next.default_preset, next.default_document_type, next.export_reflow, next.export_include_full_text, next.export_filename_suffix, now(), req.user.id,
      );
      res.json({ settings: serializeSettings(readSettings(db, req.user.id)) });
    },

    /** POST /api/settings/password { current_password, new_password, confirm_password? } */
    async changePassword(req, res) {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const key = `pw:${req.user.id}`;
      if (pwLimiter.blocked(key)) throw tooMany();
      const row = db.one('SELECT password_hash FROM users WHERE id = ?', req.user.id);
      const current = typeof body.current_password === 'string' ? body.current_password : '';
      if (!current || !(await bcrypt.compare(current, row.password_hash))) {
        pwLimiter.hit(key);
        throw new AppError(400, 'wrong_password', 'Your current password is incorrect.', { field: 'current_password' });
      }
      const next = validatePassword(body.new_password, 'new_password');
      if (body.confirm_password !== undefined && body.confirm_password !== next) throw badRequest('The two new passwords do not match.', { field: 'confirm_password' });
      if (next === current) throw badRequest('Choose a password that is different from the current one.', { field: 'new_password' });
      pwLimiter.reset(key);

      const hash = await bcrypt.hash(next, config.bcryptRounds);
      db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, now(), req.user.id);

      // Invalidate every other session of this user, and rotate this one.
      const keep = req.sessionID;
      for (const s of db.all('SELECT sid, sess FROM sessions')) {
        if (s.sid === keep) continue;
        try { if (JSON.parse(s.sess).userId === req.user.id) db.run('DELETE FROM sessions WHERE sid = ?', s.sid); } catch { /* ignore malformed */ }
      }
      await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
      req.session.userId = req.user.id;
      req.session.csrfToken = newToken();
      await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
      res.json({ ok: true, csrfToken: req.session.csrfToken });
    },
  };
}

module.exports = { createSettingsController, readSettings, serializeSettings };
