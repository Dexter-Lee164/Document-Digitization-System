'use strict';
/**
 * End-to-end test of the whole system with NOTHING faked: the real Express app talks to the real Python/FastAPI service,
 * which runs real OpenCV processing and real Tesseract OCR on the synthetic fixture photos in tests/fixtures.
 *
 *   upload -> detect page -> process (geometry, enhancement, OCR) -> review/correct -> export .docx -> download -> verify
 *
 * It starts the Python service itself on a free port with a throw-away storage folder. When Python, its packages or Tesseract are
 * not installed the tests are skipped (with the reason) instead of failing.
 *
 * Run:  npm run test:integration   (uses the .venv created by scripts/setup.ps1, or CV_PYTHON)
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { createApp } = require('../../backend/app');
const { Client } = require('../backend/helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const TOKEN = 'integration-token';

/** The same interpreter the launchers use (CV_PYTHON, the project's .venv, py -3.12/-3.11, python), if it has the packages. */
function findPython() {
  const py = require('../../scripts/common').findPython();
  if (!py) return null;
  const r = spawnSync(py.cmd, [...py.args, '-c', 'import fastapi, uvicorn, cv2, numpy, PIL, pytesseract, docx'], { encoding: 'utf8' });
  return r.status === 0 ? { cmd: py.cmd, args: py.args } : null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

/** Character error rate: Levenshtein distance over whitespace-normalised text. */
function cer(reference, hypothesis) {
  const a = reference.replace(/\s+/g, ' ').trim();
  const b = hypothesis.replace(/\s+/g, ' ').trim();
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / Math.max(a.length, 1);
}

/** Independent check of a downloaded .docx using python-docx (not the code that wrote it). */
function inspectDocx(py, file) {
  const script = `
import json, sys
from docx import Document
from docx.shared import Pt
d = Document(sys.argv[1])
runs = [r for p in d.paragraphs for r in p.runs] + [r for t in d.tables for row in t.rows for c in row.cells for p in c.paragraphs for r in p.runs]
s = d.sections[0]
print(json.dumps({
  'text': '\\n'.join(p.text for p in d.paragraphs),
  'cells': [c.text for t in d.tables for row in t.rows for c in row.cells],
  'tables': len(d.tables),
  'fonts': sorted({r.font.name for r in runs if r.text.strip()} | {d.styles['Normal'].font.name}),
  'sizes': sorted({r.font.size.pt for r in runs if r.text.strip() and r.font.size}),
  'page_cm': [round(s.page_width.cm, 1), round(s.page_height.cm, 1)],
}))`;
  const r = spawnSync(py.cmd, [...py.args, '-c', script, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

describe('full pipeline with the real Python service', () => {
  const py = findPython();
  let skipReason = py ? null : 'Python 3 with fastapi, uvicorn, opencv, numpy, Pillow, pytesseract and python-docx is not available';
  let cvProc; let cvUrl; let dir; let app; let closeApp; let server; let client; let health;
  const cvLog = [];

  before(async () => {
    if (skipReason) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docuvision-it-'));
    const storage = path.join(dir, 'storage');
    const port = await freePort();
    cvUrl = `http://127.0.0.1:${port}`;
    cvProc = spawn(py.cmd, [...py.args, 'main.py'], {
      cwd: path.join(ROOT, 'cv-service'),
      env: { ...process.env, CV_PORT: String(port), CV_HOST: '127.0.0.1', CV_SERVICE_TOKEN: TOKEN, STORAGE_PATH: storage, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cvProc.stdout.on('data', (d) => cvLog.push(String(d)));
    cvProc.stderr.on('data', (d) => cvLog.push(String(d)));

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { const res = await fetch(`${cvUrl}/health`); if (res.ok) { health = await res.json(); break; } } catch { /* not up yet */ }
      if (cvProc.exitCode !== null) throw new Error(`The CV service exited early:\n${cvLog.join('')}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!health) throw new Error(`The CV service did not start within 60 s:\n${cvLog.join('')}`);
    if (!health.ocr.available) { skipReason = `Tesseract is not installed (${health.ocr.error || 'not found'})`; return; }

    ({ app, close: closeApp } = createApp({
      env: { CV_SERVICE_URL: cvUrl, CV_SERVICE_TOKEN: TOKEN, STORAGE_PATH: storage, DATABASE_PATH: ':memory:', SESSION_SECRET: 'it-secret', BCRYPT_ROUNDS: '4' },
      logger: { log() {}, info() {}, warn() {}, error() {} },
    }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    client = new Client(`http://127.0.0.1:${server.address().port}`);
    await client.register('integration@example.com', 'passw0rd1');
  });

  after(async () => {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    if (closeApp) closeApp();
    if (cvProc && cvProc.exitCode === null && cvProc.signalCode === null) { cvProc.kill(); await new Promise((r) => cvProc.once('exit', r)); } // a process ended by a signal has exitCode null too
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const it = (name, fn) => test(name, async (t) => { if (skipReason) return t.skip(skipReason); return fn(t); });
  const upload = (file, extra) => client.upload(fs.readFileSync(path.join(FIX, file)), { name: file, type: 'image/jpeg', ...extra });

  let letterId; let formId;

  it('the Node app sees the Python service and Tesseract', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.cv_service.status, 'ok');
    assert.equal(res.data.ocr.available, true);
    console.log(`    Tesseract ${res.data.ocr.version}, OpenCV ${res.data.cv_service.opencv}`);
  });

  it('uploads a real photo; damaged files are caught by the real decoder', async () => {
    const res = await upload('letter_photo.jpg');
    assert.equal(res.status, 201);
    assert.deepEqual([res.data.document.image_width, res.data.document.image_height], [2000, 2500]);
    letterId = res.data.document.id;

    const jpg = fs.readFileSync(path.join(FIX, 'letter_photo.jpg'));
    const truncated = await client.upload(jpg.subarray(0, Math.floor(jpg.length * 0.4)), { name: 'cut.jpg', type: 'image/jpeg' });
    assert.ok(truncated.status >= 400 && truncated.status < 500, `truncated JPEG -> ${truncated.status}`);
  });

  it('finds the page corners close to where the page really is', async () => {
    const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'ground_truth_corners.json'), 'utf8'))['letter_photo.jpg'];
    const res = await client.post(`/api/documents/${letterId}/detect`);
    assert.equal(res.status, 200);
    assert.equal(res.data.detected, true);
    const diag = Math.hypot(2000, 2500);
    const errors = res.data.corners.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1]) / diag);
    console.log(`    corner error (% of image diagonal): ${errors.map((e) => (e * 100).toFixed(2)).join(', ')}`);
    assert.ok(Math.max(...errors) < 0.03, `corner errors: ${errors}`);
  });

  it('processes the photo: stages run in order and every stage reports a real duration', async () => {
    const res = await client.post(`/api/documents/${letterId}/process`, { preset: 'document_scan', run_ocr: true });
    assert.equal(res.status, 202);
    const stages = new Set();
    let st;
    for (let i = 0; i < 600; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      st = (await client.get(`/api/documents/${letterId}/status`)).data;
      if (st.job) stages.add(st.job.stage);
      if (!st.active) break;
    }
    assert.equal(st.job.status, 'completed', st.job.error_message);
    console.log(`    stages seen: ${[...stages].join(' -> ')}; timings ${JSON.stringify(st.job.stage_timings)}`);
    assert.ok(stages.has('geometry') || stages.has('enhancement'));
    for (const key of ['geometry_ms', 'enhancement_ms', 'ocr_ms']) assert.ok(st.job.stage_timings[key] > 0, key);
    assert.equal(st.document.has_ocr, true);

    const img = await client.get(`/api/documents/${letterId}/enhanced`, { raw: true });
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual([...img.data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const doc = (await client.get(`/api/documents/${letterId}`)).data;
    assert.equal(doc.geometry.report.corners_source, 'auto');
    assert.ok(doc.enhancement.report.steps.length >= 3);
  });

  it('reads the letter accurately and reports honest confidence values', async () => {
    const { ocr } = (await client.get(`/api/documents/${letterId}/ocr`)).data;
    const reference = fs.readFileSync(path.join(FIX, 'letter_reference.txt'), 'utf8');
    const error = cer(reference, ocr.original_text);
    console.log(`    CER ${(error * 100).toFixed(2)}%, mean confidence ${ocr.confidence.mean}%, words ${ocr.confidence.word_count}`);
    assert.ok(error < 0.05, `CER ${error}`);
    assert.ok(ocr.confidence.mean > 80);
    assert.ok(ocr.words.length > 80 && ocr.words.every((w) => w.w > 0 && w.h > 0));
    assert.match(ocr.original_text, /SAMPLE UNIVERSITY/);
  });

  it('a correction is saved, exported and comes back inside a valid Word document (Times New Roman 12 pt, A4)', async () => {
    await client.patch(`/api/documents/${letterId}/ocr`, { corrected_text: `${(await client.get(`/api/documents/${letterId}/ocr`)).data.ocr.original_text}\n\nReviewed by the integration test.`, review_status: 'reviewed' });
    const made = await client.post(`/api/documents/${letterId}/export`, { type: 'text', filename: 'Integration letter' });
    assert.equal(made.status, 201);
    assert.equal(made.data.verification.font_ok, true);
    const dl = await client.get(made.data.export.download_url, { raw: true });
    assert.equal(dl.status, 200);
    const file = path.join(dir, 'downloaded.docx');
    fs.writeFileSync(file, dl.data);
    const info = inspectDocx(py, file);
    assert.match(info.text, /Reviewed by the integration test\./);
    assert.match(info.text, /SAMPLE UNIVERSITY/);
    assert.deepEqual(info.fonts, ['Times New Roman']);
    assert.deepEqual(info.sizes, [12]);
    assert.deepEqual(info.page_cm, [21, 29.7]);
  });

  it('reads the registration form into fields and exports them as a table', async () => {
    const res = await upload('registration_form_photo.jpg', { documentType: 'form' });
    assert.equal(res.status, 201);
    formId = res.data.document.id;
    await client.post(`/api/documents/${formId}/process`, { preset: 'automatic' });
    const st = await client.waitForJob(formId, 120_000);
    assert.equal(st.job.status, 'completed', st.job.error_message);

    const { ocr } = (await client.get(`/api/documents/${formId}/ocr`)).data;
    assert.equal(ocr.form.matched, true);
    assert.equal(ocr.form.fields.length, 8);
    const truth = JSON.parse(fs.readFileSync(path.join(FIX, 'registration_form_reference.json'), 'utf8'));
    const exact = ocr.form.fields.filter((f) => truth[f.key] === f.value);
    const wrong = ocr.form.fields.filter((f) => truth[f.key] !== f.value).map((f) => `${f.key}: ${JSON.stringify(f.value)} (expected ${JSON.stringify(truth[f.key])}, needs_review=${f.needs_review})`);
    console.log(`    form fields exact: ${exact.length}/8${wrong.length ? `\n      ${wrong.join('\n      ')}` : ''}`);
    assert.ok(exact.length >= 6, `only ${exact.length}/8 fields matched`);
    assert.ok(wrong.length === 0 || ocr.form.fields.filter((f) => truth[f.key] !== f.value).every((f) => f.needs_review), 'every wrong field is flagged for review rather than silently trusted');

    await client.patch(`/api/documents/${formId}/ocr`, { fields: ocr.form.fields.map((f) => ({ key: f.key, value: truth[f.key] })) });
    const made = await client.post(`/api/documents/${formId}/export`, {});
    assert.equal(made.data.export.export_type, 'form');
    const file = path.join(dir, 'form.docx');
    fs.writeFileSync(file, (await client.get(made.data.export.download_url, { raw: true })).data);
    const info = inspectDocx(py, file);
    assert.equal(info.tables, 1);
    for (const value of Object.values(truth)) assert.ok(info.cells.includes(value), `table lacks ${value}`);
    assert.deepEqual(info.fonts, ['Times New Roman']);
  });

  it('re-reading with another page-segmentation mode works on the stored enhanced image', async () => {
    const res = await client.post(`/api/documents/${letterId}/reprocess-ocr`, { psm: 6 });
    assert.equal(res.status, 202);
    const st = await client.waitForJob(letterId, 120_000);
    assert.equal(st.job.status, 'completed');
    assert.equal((await client.get(`/api/documents/${letterId}/ocr`)).data.ocr.meta.psm, 6);
  });

  it('the DSP lab compares configurations A and D with a reference and exports a CSV', async () => {
    const reference = fs.readFileSync(path.join(FIX, 'letter_reference.txt'), 'utf8');
    const res = await client.post(`/api/documents/${letterId}/experiments`, { configs: ['A', 'D'], reference_text: reference });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const rows = res.data.run.results.results;
    console.log(`    ${rows.map((r) => `${r.config}: ${r.total_ms} ms, CER ${(r.cer * 100).toFixed(2)}%, conf ${r.confidence.mean}`).join(' | ')}`);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.total_ms > 0 && typeof r.cer === 'number' && typeof r.wer === 'number'));
    const csv = await client.get(`/api/experiments/${res.data.run.id}/csv`);
    assert.equal(csv.status, 200);
    assert.ok(csv.data.split('\r\n').length >= 4);
  });

  it('stopping the Python service gives a clear, recoverable error', async () => {
    const id = (await upload('letter_photo.jpg')).data.document.id;
    cvProc.kill();
    await new Promise((r) => cvProc.once('exit', r));
    await client.post(`/api/documents/${id}/process`, {});
    const st = await client.waitForJob(id, 30_000);
    assert.equal(st.job.status, 'failed');
    assert.match(st.job.error_message, /not reachable/i);
    assert.equal(st.document.processing_status, 'failed');
    const health = (await client.get('/api/health')).data;
    assert.equal(health.cv_service.status, 'offline');
  });
});
