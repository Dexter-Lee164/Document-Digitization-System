'use strict';
const { badRequest } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function validateEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email) throw badRequest('Email is required.', { field: 'email' });
  if (email.length > 254 || !EMAIL_RE.test(email)) throw badRequest('Enter a valid email address.', { field: 'email' });
  return email;
}

function validatePassword(value, field = 'password') {
  const pw = typeof value === 'string' ? value : '';
  if (pw.length < 8) throw badRequest('Password must be at least 8 characters.', { field });
  if (pw.length > 128) throw badRequest('Password must be at most 128 characters.', { field });
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw badRequest('Password must contain at least one letter and one number.', { field });
  return pw;
}

/** Positive integer id from a route parameter. */
function parseId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  return Number(value);
}

/** Safe file name for downloads / display: no path parts, control or reserved characters. Extension is NOT added here. */
function sanitizeFilename(name, fallback = 'document') {
  let base = String(name ?? '').normalize('NFC');
  base = base.replace(/[\\/]+/g, ' ');                 // path separators
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, ''); // control + Windows-reserved characters
  base = base.replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').replace(/[. ]+$/, ''); // no hidden-file dots or leading spaces left over from removed path parts
  if (base.length > 100) base = base.slice(0, 100).trim();
  if (!base || WINDOWS_RESERVED.test(base)) return fallback;
  return base;
}

function stripExtension(name) {
  return String(name ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

function asBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  throw badRequest('Expected true or false.');
}

function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function escapeLike(term) {
  return String(term).replace(/[\\%_]/g, (m) => `\\${m}`);
}

module.exports = { validateEmail, validatePassword, parseId, sanitizeFilename, stripExtension, asBool, parseJson, escapeLike, EMAIL_RE };
