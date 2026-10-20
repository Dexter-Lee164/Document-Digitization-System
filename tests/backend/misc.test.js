'use strict';
/** Settings, dashboard statistics, experiments (DSP lab) and the small pure helpers. */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, makePng } = require('./helpers');
const { toCsv } = require('../../backend/controllers/experimentsController');
const { sanitizeFilename, stripExtension, parseId, validateEmail, validatePassword, asBool } = require('../../backend/utils/validators');
const { RateLimiter } = require('../../backend/utils/rateLimit');
const { inspectImage } = require('../../backend/utils/imageMeta');
const { ProcessingSchema } = require('../../backend/utils/processingSchema');
const path = require('node:path');

describe('settings', () => {
  let t; let c;
  before(async () => { t = await startApp(); c = t.client(); await c.register(); });
  after(async () => { await t.close(); });

  test('start with sensible defaults', async () => {
    const { settings, user } = (await c.get('/api/settings')).data;
    assert.equal(settings.default_preset, 'automatic');
    assert.equal(settings.default_document_type, 'general');
    assert.equal(settings.export_reflow, true);
    assert.equal(user.email, 'student@example.com');
    assert.equal(user.password_hash, undefined);
  });

  test('can be changed and are remembered; each user has their own', async () => {
    const res = await c.put('/api/settings', { default_preset: 'black_white', default_document_type: 'form', export_reflow: false, export_filename_suffix: '_clean' });
    assert.equal(res.status, 200);
    assert.equal(res.data.settings.default_preset, 'black_white');
    assert.equal((await c.get('/api/settings')).data.settings.export_filename_suffix, '_clean');
    const other = t.client(); await other.register('other@example.com');
    assert.equal((await other.get('/api/settings')).data.settings.default_preset, 'automatic');
  });

  test('the suffix is used for new export file names', async () => {
    const id = (await c.upload(makePng(), { name: 'notes.png' })).data.document.id;
    await c.post(`/api/documents/${id}/process`, {});
    await c.waitForJob(id);
    assert.equal((await c.post(`/api/documents/${id}/export`, { type: 'text' })).data.export.filename, 'notes_clean.docx');
  });

  test('invalid values are rejected', async () => {
    for (const body of [{ default_preset: 'neon' }, { default_document_type: 'poster' }, { export_filename_suffix: 'a/b' }, { export_filename_suffix: 'x'.repeat(41) }, { export_filename_suffix: 'q?' }]) {
      assert.equal((await c.put('/api/settings', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await c.get('/api/settings')).data.settings.default_preset, 'black_white', 'a rejected update changes nothing');
  });
});

describe('dashboard statistics are computed from the real tables', () => {
  test('counts, average confidence and per-day uploads', async () => {
    const t = await startApp();
    try {
      const c = t.client(); await c.register();
      const empty = (await c.get('/api/dashboard')).data;
      assert.equal(empty.documents.total, 0);
      assert.equal(empty.ocr.average_confidence, null);
      assert.equal(empty.week.length, 7);

      const a = (await c.upload(makePng())).data.document.id;
      const b = (await c.upload(makePng())).data.document.id;
      await c.upload(makePng());
      await c.post(`/api/documents/${a}/process`, {}); await c.waitForJob(a);
      t.cv.failStage = 'enhance';
      await c.post(`/api/documents/${b}/process`, {}); await c.waitForJob(b);
      t.cv.failStage = null;
      await c.patch(`/api/documents/${a}/ocr`, { review_status: 'reviewed' });
      await c.post(`/api/documents/${a}/export`, { type: 'text' });

      const d = (await c.get('/api/dashboard')).data;
      assert.equal(d.documents.total, 3);
      assert.equal(d.documents.processed, 1);
      assert.equal(d.documents.failed, 1);
      assert.equal(d.documents.awaiting, 1);
      assert.equal(d.documents.reviewed, 1);
      assert.equal(d.exports.total, 1);
      assert.equal(d.ocr.average_confidence, 88.5, 'the mean of the engine confidences stored with the results');
      assert.equal(d.jobs.total, 2);
      assert.equal(d.jobs.completed, 1);
      assert.equal(d.jobs.failed, 1);
      assert.equal(d.week.reduce((n, x) => n + x.count, 0), 3);
      assert.equal(d.week[6].count, 3, 'today is the last bucket');
      assert.equal(d.recent.length, 3);

      const other = t.client(); await other.register('other@example.com');
      assert.equal((await other.get('/api/dashboard')).data.documents.total, 0, "another account's numbers are separate");
    } finally { await t.close(); }
  });
});

describe('DSP lab experiments', () => {
  let t; let c; let id;
  before(async () => {
    t = await startApp(); c = t.client(); await c.register();
    id = (await c.upload(makePng(200, 300), { name: 'lab.png' })).data.document.id;
  });
  after(async () => { await t.close(); });

  test('runs the chosen configurations, stores the run, and passes the reference text through', async () => {
    const res = await c.post(`/api/documents/${id}/experiments`, { configs: ['A', 'D', 'A'], preset: 'document_scan', reference_text: 'Dear Students,\r\nHello' });
    assert.equal(res.status, 201);
    const sent = t.cv.calls.find((x) => x.stage === 'experiments').body;
    assert.deepEqual(sent.configs, ['A', 'D'], 'duplicates removed');
    assert.equal(sent.reference_text, 'Dear Students,\nHello');
    assert.equal(sent.storage_key.startsWith('uploads/'), true);
    assert.equal(res.data.run.results.results.length, 2);
    assert.equal(res.data.run.has_reference, true);
    assert.equal(res.data.run.results.results[0].cer, 0.1);
  });

  test('without a reference, CER and WER stay empty (never invented)', async () => {
    const res = await c.post(`/api/documents/${id}/experiments`, { configs: ['B'] });
    assert.equal(res.data.run.has_reference, false);
    assert.equal(res.data.run.results.results[0].cer, null);
    assert.equal(res.data.run.results.results[0].wer, null);
  });

  test('uses the corners the user confirmed in the workspace', async () => {
    const corners = [[20, 30], [180, 25], [185, 280], [15, 285]];
    await c.post(`/api/documents/${id}/process`, { corners });
    await c.waitForJob(id);
    await c.post(`/api/documents/${id}/experiments`, { configs: ['C'] });
    const sent = t.cv.calls.filter((x) => x.stage === 'experiments').pop().body;
    assert.deepEqual(sent.corners, corners);
  });

  test('validates the request', async () => {
    for (const body of [{ configs: [] }, { configs: ['Z'] }, { configs: 'A' }, { preset: 'neon' }, { reference_text: 5 }, { reference_text: 'x'.repeat(500_001) }]) {
      assert.equal((await c.post(`/api/documents/${id}/experiments`, body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
  });

  test('only one experiment per document runs at a time', async () => {
    t.cv.delayMs = 120;
    const [a, b] = await Promise.all([
      c.post(`/api/documents/${id}/experiments`, { configs: ['A'] }),
      new Promise((r) => setTimeout(r, 30)).then(() => c.post(`/api/documents/${id}/experiments`, { configs: ['A'] })),
    ]);
    t.cv.delayMs = 0;
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal((a.status === 409 ? a : b).data.error.code, 'already_running');
  });

  test('history, details, CSV download and delete; other users see nothing', async () => {
    const list = (await c.get(`/api/documents/${id}/experiments`)).data.items;
    assert.ok(list.length >= 3);
    assert.equal(list[0].results.results[0].text, undefined, 'list view leaves out the long recognised text');
    const run = list[0];
    assert.ok((await c.get(`/api/experiments/${run.id}`)).data.run.results.results[0].text !== undefined);

    const csv = await c.get(`/api/experiments/${run.id}/csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment/);
    const bytes = (await c.get(`/api/experiments/${run.id}/csv`, { raw: true })).data; // fetch's text decoder would hide the BOM
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel on Windows reads it correctly');
    assert.ok(csv.data.startsWith('document,run_id,'), 'header row');
    assert.ok(csv.data.includes('\r\n'), 'CRLF line endings');

    const other = t.client(); await other.register('other@example.com');
    assert.equal((await other.get(`/api/experiments/${run.id}`)).status, 404);
    assert.equal((await other.get(`/api/experiments/${run.id}/csv`)).status, 404);
    assert.equal((await other.delete(`/api/experiments/${run.id}`)).status, 404);
    assert.equal((await c.delete(`/api/experiments/${run.id}`)).status, 200);
    assert.equal((await c.get(`/api/experiments/${run.id}`)).status, 404);
  });

  test('CSV cells that could be run as spreadsheet formulas are neutralised', () => {
    const csv = toCsv({ id: 1, created_at: '2026-01-01', results: { reference_provided: false, results: [{ config: 'A', label: '=HYPERLINK("http://evil")', error: '+cmd|calc', word_count: 3, total_ms: 10, confidence: null }] } }, '@SUM(A1)');
    assert.match(csv, /'@SUM\(A1\)/);
    assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
    assert.match(csv, /'\+cmd\|calc/);
    assert.doesNotMatch(csv, /(^|,)=HYPERLINK/m);
  });
});

describe('validators and small helpers', () => {
  test('sanitizeFilename removes path parts, control and Windows-reserved characters', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'etc passwd');
    assert.equal(sanitizeFilename('C:\\Windows\\system32\\evil.dll'), 'C Windows system32 evil.dll');
    assert.equal(sanitizeFilename('a<b>c:d"e|f?g*h'), 'abcdefgh');
    assert.equal(sanitizeFilename('   .hidden   '), 'hidden');
    assert.equal(sanitizeFilename('trailing dots...'), 'trailing dots');
    assert.equal(sanitizeFilename('nul'), 'document');
    assert.equal(sanitizeFilename('COM1', 'x'), 'x');
    assert.equal(sanitizeFilename('', 'fallback'), 'fallback');
    assert.equal(sanitizeFilename('tab\there\nnewline'), 'tabherenewline');
    assert.equal(sanitizeFilename('é日本語.png'), 'é日本語.png');
    assert.ok(sanitizeFilename('x'.repeat(300)).length <= 100);
    assert.equal(stripExtension('report.final.docx'), 'report.final');
    assert.equal(stripExtension('noext'), 'noext');
  });

  test('parseId accepts only plain positive integers', () => {
    assert.equal(parseId('42'), 42);
    for (const bad of ['0', '-3', '4.5', '1e2', ' 7', '7 ', '07', '', 'x', '9'.repeat(20), undefined, 5]) assert.equal(parseId(bad), null, String(bad));
  });

  test('email and password validation', () => {
    assert.equal(validateEmail('  USER@Example.COM '), 'user@example.com');
    for (const bad of ['', 'plain', 'a@b', 'a b@c.com', '@c.com', 'a@.com', 'a'.repeat(250) + '@x.com']) assert.throws(() => validateEmail(bad), /email/i, bad);
    assert.equal(validatePassword('abcdefg1'), 'abcdefg1');
    for (const bad of ['', 'short1', 'noDigitsHere', '1234567890', undefined, 12345678]) assert.throws(() => validatePassword(bad), /Password/, String(bad));
  });

  test('asBool is strict about what counts as true/false', () => {
    assert.equal(asBool(true), true);
    assert.equal(asBool(false), false);
    assert.equal(asBool(undefined, true), true);
  });

  test('RateLimiter blocks after the limit, forgets after the window, and can be reset', () => {
    const rl = new RateLimiter({ windowMs: 1000, max: 3 });
    for (let i = 0; i < 3; i += 1) { assert.equal(rl.blocked('k', 100 + i), false); rl.hit('k', 100 + i); }
    assert.equal(rl.blocked('k', 500), true);
    assert.equal(rl.blocked('other', 500), false);
    assert.equal(rl.blocked('k', 1200), false, 'old hits expire');
    rl.hit('k', 1200); rl.hit('k', 1201); rl.hit('k', 1202);
    assert.equal(rl.blocked('k', 1203), true);
    rl.reset('k');
    assert.equal(rl.blocked('k', 1203), false);
  });

  test('inspectImage reads real dimensions and rejects everything that is not PNG/JPEG', () => {
    assert.deepEqual(inspectImage(makePng(33, 44)), { type: 'png', mime: 'image/png', ext: 'png', width: 33, height: 44 });
    for (const bad of [Buffer.alloc(0), Buffer.from('GIF89a....'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('%PDF-1.4'), Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('MZ')]) {
      assert.throws(() => inspectImage(bad), (err) => err.status === 400, bad.subarray(0, 8).toString('latin1'));
    }
  });

  test('the shared parameter schema validates corners against the image size', () => {
    const schema = new ProcessingSchema(path.join(__dirname, '..', '..', 'shared', 'processing_schema.json'));
    const size = { width: 1000, height: 1000 };
    assert.deepEqual(schema.validateCorners([[0, 0], [1000, 0], [1000, 1000], [0, 1000]], size).length, 4);
    assert.throws(() => schema.validateCorners([[0, 0], [1, 1], [2, 2]], size), /four/i);
    assert.throws(() => schema.validateCorners([[0, 0], [1000, 0], [1000, 1000], [NaN, 0]], size));
    assert.throws(() => schema.validateCorners([[0, 0], [5000, 0], [1000, 1000], [0, 1000]], size), /outside|image/i);
    assert.equal(schema.validatePsm(undefined, 'general'), 3);
    assert.equal(schema.validatePsm(undefined, 'form'), 4);
    assert.throws(() => schema.validatePsm(2, 'general'));
  });
});
