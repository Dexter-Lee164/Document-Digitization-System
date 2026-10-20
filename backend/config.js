'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

function intEnv(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: "${raw}" (expected an integer between ${min} and ${max})`);
  }
  return n;
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

/**
 * Build the configuration object. `overrides` is used by the automated tests (temp database/storage, fake CV URL).
 */
function loadConfig(overrides = {}) {
  const env = { ...process.env, ...(overrides.env || {}) };
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';

  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProd) throw new Error('SESSION_SECRET is required in production. Run `npm run setup:env`.');
    sessionSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[config] SESSION_SECRET is not set - using a temporary random secret (sessions reset on restart). Run `npm run setup:env`.');
  }
  const cvToken = env.CV_SERVICE_TOKEN;
  if (!cvToken) {
    throw new Error('CV_SERVICE_TOKEN is not set. Run `npm run setup:env` (or scripts\\setup.ps1) to create .env with a generated token.');
  }

  const cfg = {
    root: ROOT,
    nodeEnv,
    isProd,
    port: intEnv(env, 'PORT', 3000, { min: 0, max: 65535 }),
    host: env.HOST || '127.0.0.1',
    sessionSecret,
    cookieSecure: String(env.COOKIE_SECURE).toLowerCase() === 'true',
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    bcryptRounds: intEnv(env, 'BCRYPT_ROUNDS', 12, { min: 4, max: 15 }),
    databasePath: env.DATABASE_PATH === ':memory:' ? ':memory:' : resolvePath(env.DATABASE_PATH || './data/docuvision.sqlite'),
    storagePath: resolvePath(env.STORAGE_PATH || './storage'),
    maxUploadSize: intEnv(env, 'MAX_UPLOAD_SIZE', 10 * 1024 * 1024, { min: 1024, max: 100 * 1024 * 1024 }),
    maxImagePixels: intEnv(env, 'MAX_IMAGE_PIXELS', 40_000_000, { min: 100_000 }),
    cvServiceUrl: (env.CV_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/+$/, ''),
    cvServiceToken: cvToken,
    cvTimeoutMs: intEnv(env, 'CV_TIMEOUT_MS', 180_000, { min: 1000 }),
    experimentTimeoutMs: intEnv(env, 'CV_EXPERIMENT_TIMEOUT_MS', 600_000, { min: 1000 }),
    loginMaxAttempts: intEnv(env, 'LOGIN_MAX_ATTEMPTS', 8, { min: 1 }),
    frontendDir: path.join(ROOT, 'frontend'),
    schemaPath: path.join(ROOT, 'shared', 'processing_schema.json'),
  };
  return Object.freeze({ ...cfg, ...(overrides.config || {}) });
}

module.exports = { loadConfig, ROOT };
