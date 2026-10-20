#!/usr/bin/env node
/**
 * Creates .env from .env.example on first run and fills SESSION_SECRET / CV_SERVICE_TOKEN with random values.
 * Existing values are never overwritten, so it is safe to run repeatedly (npm start / npm run dev call it).
 * Works the same on Windows, macOS and Linux.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');
const examplePath = path.join(ROOT, '.env.example');

function ensureEnv({ quiet = false } = {}) {
  let created = false;
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(examplePath, envPath);
    created = true;
  }
  let text = fs.readFileSync(envPath, 'utf8');
  const filled = [];
  for (const key of ['SESSION_SECRET', 'CV_SERVICE_TOKEN']) {
    const re = new RegExp(`^${key}=(.*)$`, 'm');
    const match = text.match(re);
    if (!match) {
      text += `${text.endsWith('\n') ? '' : '\n'}${key}=${crypto.randomBytes(32).toString('hex')}\n`;
      filled.push(key);
    } else if (!match[1].trim()) {
      text = text.replace(re, `${key}=${crypto.randomBytes(32).toString('hex')}`);
      filled.push(key);
    }
  }
  if (created || filled.length) {
    fs.writeFileSync(envPath, text, { mode: 0o600 });
    try { fs.chmodSync(envPath, 0o600); } catch { /* not supported on this file system (e.g. Windows) */ }
  }
  if (!quiet) {
    if (created) console.log('Created .env from .env.example');
    if (filled.length) console.log(`Generated random values for: ${filled.join(', ')}`);
    if (!created && !filled.length) console.log('.env already configured.');
  }
  return { created, filled };
}

if (require.main === module) ensureEnv();
module.exports = { ensureEnv };
