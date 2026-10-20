'use strict';
const { AppError } = require('../utils/errors');

const PASS_THROUGH_400 = new Set(['invalid_image', 'invalid_corners', 'invalid_parameters', 'invalid_request']);

/**
 * HTTP client for the internal Python/FastAPI CV service. Every call carries the shared secret in X-Service-Token,
 * has a timeout, and failures are converted into user-safe AppErrors.
 */
class CvClient {
  constructor({ baseUrl, token, timeoutMs, experimentTimeoutMs }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.experimentTimeoutMs = experimentTimeoutMs || timeoutMs;
  }

  async _call(method, path, body, timeoutMs = this.timeoutMs, { auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (auth) headers['X-Service-Token'] = this.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AppError(504, 'cv_timeout', `Processing took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped. Try a smaller image or a simpler preset.`);
      }
      throw new AppError(503, 'cv_unavailable', 'The image-processing service is not reachable. Start it (npm run dev, or scripts\\start.ps1) and try again.');
    }

    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON error page */ }
    if (res.ok) return payload;

    const err = payload && payload.error ? payload.error : {};
    const code = err.code || 'cv_error';
    const message = typeof err.message === 'string' && err.message ? err.message : 'The processing service could not complete the request.';
    if (res.status === 401) {
      throw new AppError(502, 'cv_auth_failed', 'The processing service rejected the shared token. Make sure CV_SERVICE_TOKEN in .env is the same for both services and restart them.');
    }
    if (res.status === 400 && PASS_THROUGH_400.has(code)) throw new AppError(400, code, message, err.details);
    if (res.status === 503) throw new AppError(503, code, message);
    if (res.status === 504) throw new AppError(504, code, message);
    throw new AppError(502, code, message);
  }

  async health() {
    try {
      return await this._call('GET', '/health', undefined, 3000, { auth: false });
    } catch (err) {
      return { status: 'offline', ocr: { available: false, error: err.message } };
    }
  }

  schema() { return this._call('GET', '/v1/schema'); }
  templates() { return this._call('GET', '/v1/templates', undefined, 5000); }
  validate(storageKey) { return this._call('POST', '/v1/validate', { storage_key: storageKey }, 60_000); }
  detect(storageKey) { return this._call('POST', '/v1/detect', { storage_key: storageKey }, 60_000); }
  geometry(body) { return this._call('POST', '/v1/geometry', body); }
  enhance(body) { return this._call('POST', '/v1/enhance', body); }
  ocr(body) { return this._call('POST', '/v1/ocr', body); }
  docx(body) { return this._call('POST', '/v1/docx', body, 60_000); }
  experiments(body) { return this._call('POST', '/v1/experiments', body, this.experimentTimeoutMs); }
}

module.exports = { CvClient };
