'use strict';
/**
 * Shared test harness for the Node backend tests.
 *  - startApp(): a real Express app (real SQLite in memory, real storage in a temp folder, real sessions) listening on a random port.
 *  - StubCv: stands in for the Python service so these tests exercise the Node logic alone (the CV service has its own pytest suite and
 *    tests/integration runs both together). It writes real files into storage so serving and deleting them is tested for real.
 *  - Client: a tiny cookie-jar HTTP client that handles the CSRF token like the browser code does.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { createApp } = require('../../backend/app');
const { AppError } = require('../../backend/utils/errors');
const { inspectImage } = require('../../backend/utils/imageMeta');

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

/* ------------------------------------------------------------------ images */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A genuinely valid greyscale PNG (so the file really is an image, not just a magic number). */
function makePng(width = 120, height = 160, shade = 235) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height, shade);
  for (let y = 0; y < height; y += 1) raw[y * (width + 1)] = 0; // filter type 0 on every row
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** Smallest byte string the backend accepts as a JPEG (SOI + SOF0 with dimensions). The stub CV does not decode it. */
function makeJpeg(width = 200, height = 300) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.from([0xff, 0xd9])]);
}

/* ------------------------------------------------------------------ stub CV service */
class StubCv {
  constructor() {
    this.calls = [];
    this.delayMs = 0;
    this.failStage = null; // 'geometry' | 'enhance' | 'ocr' | 'docx' | 'experiments' | 'validate'
    this.failWith = null;
    this.gate = null; // a promise the geometry stage waits for (to hold a job in the "running" state)
    this.ocrText = 'SAMPLE UNIVERSITY\n\nDear Students,\nThe examinations begin on Monday.\n\nSincerely,\nThe Registrar';
    this.storage = null;
  }

  attach(storagePath) { this.storage = storagePath; }

  _abs(key) { return path.join(this.storage, ...key.split('/')); }

  async _step(stage, body) {
    this.calls.push({ stage, body });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failStage === stage) throw this.failWith || new AppError(502, 'cv_error', 'The processing service could not complete the request.');
  }

  async health() { return { status: 'ok', service: 'stub', ocr: { available: true, version: 'stub', languages: ['eng'] }, opencv: 'stub' }; }
  async templates() { return { templates: [{ id: 'university_registration', name: 'University registration form' }] }; }
  async schema() { return {}; }

  async validate(key) {
    await this._step('validate', key);
    const buf = fs.readFileSync(this._abs(key));
    if (buf.includes(Buffer.from('CORRUPT-MARKER'))) throw new AppError(400, 'invalid_image', 'The image could not be decoded. It may be damaged.');
    const meta = inspectImage(buf);
    return { width: meta.width, height: meta.height, format: meta.type.toUpperCase() };
  }

  async detect(key) {
    await this._step('detect', key);
    const { width: w, height: h } = inspectImage(fs.readFileSync(this._abs(key)));
    return {
      detected: true, method: 'stub', score: 0.9, message: 'Document boundary detected.',
      corners: [[w * 0.1, h * 0.1], [w * 0.9, h * 0.1], [w * 0.9, h * 0.9], [w * 0.1, h * 0.9]], image_size: [w, h],
    };
  }

  async geometry(body) {
    await this._step('geometry', body);
    if (this.gate) await this.gate;
    const key = `${body.output_prefix}/corrected.png`;
    fs.mkdirSync(path.dirname(this._abs(key)), { recursive: true });
    fs.writeFileSync(this._abs(key), makePng(100, 140, 230));
    const corners = body.corners || [[10, 10], [190, 10], [190, 290], [10, 290]];
    return { corrected_key: key, report: { corners, corners_source: body.corners ? 'manual' : 'auto', orientation: { rotation: 0 }, deskew: { angle: 0 } } };
  }

  async enhance(body) {
    await this._step('enhance', body);
    const key = `${body.output_prefix}/enhanced.png`;
    fs.mkdirSync(path.dirname(this._abs(key)), { recursive: true });
    fs.writeFileSync(this._abs(key), makePng(100, 140, 250));
    const preset = body.settings.preset;
    return { enhanced_key: key, preset, resolved_params: { ...(body.settings.params || {}), preset }, analysis: { noise_sigma: 1 }, report: { steps: [{ stage: 'grayscale', ms: 1 }] } };
  }

  async ocr(body) {
    await this._step('ocr', body);
    const words = this.ocrText.split(/\s+/).filter(Boolean).map((text, i) => ({ text, conf: i === 1 ? 41 : 93, x: 10 + i * 20, y: 10, w: 18, h: 10, block: 1, par: 1, line: 1, low: i === 1 }));
    const form = body.mode === 'form' ? {
      template_id: 'university_registration', template_name: 'University registration form', title: 'Student registration form', matched: true, match_score: 0.9, message: null,
      fields: [
        { key: 'student_name', label: 'Student name', type: 'name', value: 'DELA CRUZ, JUAN M.', original_value: 'DELA CRUZ, JUAN M.', confidence: 91, needs_review: false, region: [0.1, 0.2, 0.5, 0.05] },
        { key: 'student_id', label: 'Student number', type: 'id', value: '2022-01457', original_value: '2022-01457', confidence: 88, needs_review: false, region: [0.1, 0.3, 0.3, 0.05] },
      ],
    } : null;
    return {
      text: this.ocrText, words, psm: body.psm || 3, lang: 'eng', image_width: 100, image_height: 140, duration_ms: 5, empty: false, warnings: [],
      confidence: { mean: 88.5, median: 93, min: 41, word_count: words.length, low_confidence_count: 1, low_confidence_ratio: 1 / words.length, threshold: 60 }, form,
    };
  }

  async docx(payload) {
    await this._step('docx', payload);
    fs.mkdirSync(path.dirname(this._abs(payload.output_key)), { recursive: true });
    const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(JSON.stringify({ mode: payload.mode, title: payload.title, text: payload.text, fields: payload.fields }))]);
    fs.writeFileSync(this._abs(payload.output_key), bytes);
    return { export_key: payload.output_key, bytes: bytes.length, verification: { font_ok: true, a4: true } };
  }

  async experiments(body) {
    await this._step('experiments', body);
    return {
      reference_provided: Boolean(body.reference_text), preset: body.settings.preset, note: 'stub',
      results: body.configs.map((c, i) => ({
        config: c, label: `${c}. Stub configuration`, geometry_ms: 10, enhancement_ms: 5, ocr_ms: 20 + i, total_ms: 35 + i, word_count: 12, text: i === 0 ? '=cmd|calc' : 'text',
        confidence: { mean: 80 + i, low_confidence_count: 1, word_count: 12 }, cer: body.reference_text ? 0.1 * (i + 1) : null, wer: body.reference_text ? 0.2 * (i + 1) : null, notes: [], error: null,
      })),
    };
  }
}

/* ------------------------------------------------------------------ HTTP client with cookie jar + CSRF */
class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }

  async request(method, url, { json, form, headers = {}, csrf = true, accept = 'application/json', raw = false } = {}) {
    const h = { Accept: accept, ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (csrf && this.csrf && method !== 'GET' && method !== 'HEAD') h['X-CSRF-Token'] = this.csrf;
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies.length) this.cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    const type = res.headers.get('content-type') || '';
    let data;
    if (raw) data = Buffer.from(await res.arrayBuffer());
    else if (type.includes('json')) data = await res.json();
    else if (type.startsWith('text/')) data = await res.text();
    else data = Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers, setCookies };
  }

  get(url, opts) { return this.request('GET', url, opts); }
  post(url, json, opts) { return this.request('POST', url, { json, ...opts }); }
  patch(url, json, opts) { return this.request('PATCH', url, { json, ...opts }); }
  put(url, json, opts) { return this.request('PUT', url, { json, ...opts }); }
  delete(url, opts) { return this.request('DELETE', url, opts); }

  async refreshCsrf() { this.csrf = (await this.get('/auth/csrf')).data.csrfToken; return this.csrf; }

  async register(email = 'student@example.com', password = 'passw0rd1') {
    await this.refreshCsrf();
    const res = await this.post('/auth/register', { email, password });
    if (res.status !== 200) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.data)}`);
    await this.refreshCsrf();
    return res;
  }

  async login(email, password) {
    await this.refreshCsrf();
    const res = await this.post('/auth/login', { email, password });
    if (res.status === 200) await this.refreshCsrf();
    return res;
  }

  async upload(buffer = makePng(), { name = 'page.png', type = 'image/png', documentType } = {}) {
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type }), name);
    if (documentType) fd.append('document_type', documentType);
    return this.request('POST', '/api/documents', { form: fd });
  }

  /** Poll /status until the job is no longer active. */
  async waitForJob(docId, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = (await this.get(`/api/documents/${docId}/status`)).data;
      if (!last.active) return last;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`job did not finish: ${JSON.stringify(last)}`);
  }
}

/* ------------------------------------------------------------------ app lifecycle */
async function startApp({ cv = new StubCv(), env = {}, config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docuvision-test-'));
  const storagePath = path.join(dir, 'storage');
  const { app, ctx, close } = createApp({
    env: { CV_SERVICE_TOKEN: 'test-token', DATABASE_PATH: ':memory:', STORAGE_PATH: storagePath, SESSION_SECRET: 'test-secret', BCRYPT_ROUNDS: '4', ...env },
    config, cv, logger: silent,
  });
  if (typeof cv.attach === 'function') cv.attach(storagePath);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, ctx, cv, storagePath, db: ctx.db,
    client: () => new Client(base),
    files: (sub) => { const p = path.join(storagePath, sub); return fs.existsSync(p) ? fs.readdirSync(p, { recursive: true }).filter((f) => fs.statSync(path.join(p, f)).isFile()) : []; },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startApp, StubCv, Client, makePng, makeJpeg, silent };
