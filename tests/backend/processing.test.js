'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, makePng } = require('./helpers');
const { AppError } = require('../../backend/utils/errors');

describe('processing jobs', () => {
  let t; let c;
  before(async () => { t = await startApp(); c = t.client(); await c.register(); });
  after(async () => { await t.close(); });
  beforeEach(() => { t.cv.calls.length = 0; t.cv.failStage = null; t.cv.failWith = null; t.cv.gate = null; t.cv.delayMs = 0; });

  async function newDoc(opts) {
    const up = await c.upload(makePng(200, 300), opts);
    assert.equal(up.status, 201);
    return up.data.document.id;
  }

  test('runs geometry, enhancement and OCR in order and records the real stage timings', async () => {
    const id = await newDoc();
    t.cv.delayMs = 5;
    const res = await c.post(`/api/documents/${id}/process`, { preset: 'document_scan' });
    assert.equal(res.status, 202);
    assert.ok(['queued', 'running'].includes(res.data.job.status));
    assert.equal(res.data.document.processing_status, 'processing');

    const done = await c.waitForJob(id);
    assert.equal(done.job.status, 'completed');
    assert.equal(done.job.stage, 'done');
    assert.equal(done.document.processing_status, 'processed');
    assert.equal(done.document.has_ocr, true);
    assert.deepEqual(Object.keys(done.job.stage_timings), ['geometry_ms', 'enhancement_ms', 'ocr_ms']);
    assert.ok(Object.values(done.job.stage_timings).every((ms) => ms >= 5), 'timings are measured, not made up');
    assert.deepEqual(t.cv.calls.filter((x) => x.stage !== 'validate').map((x) => x.stage), ['geometry', 'enhance', 'ocr']);
  });

  test('the job row shows the current stage while it is running', async () => {
    const id = await newDoc();
    let release; t.cv.gate = new Promise((r) => { release = r; });
    await c.post(`/api/documents/${id}/process`, {});
    await new Promise((r) => setTimeout(r, 40));
    const mid = (await c.get(`/api/documents/${id}/status`)).data;
    assert.equal(mid.active, true);
    assert.equal(mid.job.status, 'running');
    assert.equal(mid.job.stage, 'geometry');
    release();
    assert.equal((await c.waitForJob(id)).job.status, 'completed');
  });

  test('a second process request while one is running is a 409, and only one job exists', async () => {
    const id = await newDoc();
    let release; t.cv.gate = new Promise((r) => { release = r; });
    assert.equal((await c.post(`/api/documents/${id}/process`, {})).status, 202);
    const dup = await c.post(`/api/documents/${id}/process`, {});
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error.code, 'already_processing');
    assert.equal((await c.post(`/api/documents/${id}/reprocess-ocr`, {})).status, 409);
    assert.equal((await c.patch(`/api/documents/${id}`, { original_filename: 'x' })).status, 409);
    release();
    await c.waitForJob(id);
    assert.equal(t.db.one('SELECT COUNT(*) AS n FROM processing_jobs WHERE document_id = ?', id).n, 1);
  });

  test('the database itself refuses two active jobs for one document', async () => {
    const id = await newDoc();
    t.db.run("INSERT INTO processing_jobs (document_id, kind, processing_settings, status, stage, created_at) VALUES (?, 'process', '{}', 'running', 'geometry', ?)", id, new Date().toISOString());
    assert.throws(() => t.db.run("INSERT INTO processing_jobs (document_id, kind, processing_settings, status, stage, created_at) VALUES (?, 'process', '{}', 'queued', 'geometry', ?)", id, new Date().toISOString()), /UNIQUE|constraint/i);
    t.db.run("UPDATE processing_jobs SET status = 'failed' WHERE document_id = ?", id);
  });

  test('manual corners and manual rotation are forwarded to the CV service exactly', async () => {
    const id = await newDoc();
    const corners = [[20, 30], [180, 25], [185, 280], [15, 285]];
    await c.post(`/api/documents/${id}/process`, { corners, manual_rotation: 90, manual_angle: -2.5, auto_orient: false, auto_deskew: false });
    await c.waitForJob(id);
    const call = t.cv.calls.find((x) => x.stage === 'geometry').body;
    assert.deepEqual(call.corners, corners);
    assert.equal(call.manual_rotation, 90);
    assert.equal(call.manual_angle, -2.5);
    assert.equal(call.auto_orient, false);
    assert.equal(call.auto_deskew, false);
    assert.match(call.storage_key, /^uploads\//);
    assert.match(call.output_prefix, /^processed\/[0-9a-f-]{36}$/);
    const doc = (await c.get(`/api/documents/${id}`)).data;
    assert.deepEqual(doc.document.corners, corners, 'corners are remembered for the next visit');
    assert.equal(doc.geometry.options.corners, 'manual');
  });

  test('custom preset parameters reach the enhancement stage and are stored with the result', async () => {
    const id = await newDoc();
    await c.post(`/api/documents/${id}/process`, { preset: 'custom', params: { clahe_clip: 3.5, threshold_method: 'otsu', denoise_kernel: 5 } });
    await c.waitForJob(id);
    const enh = t.cv.calls.find((x) => x.stage === 'enhance').body;
    assert.equal(enh.settings.preset, 'custom');
    assert.equal(enh.settings.params.clahe_clip, 3.5);
    assert.equal(enh.settings.params.threshold_method, 'otsu');
    assert.equal((await c.get(`/api/documents/${id}`)).data.enhancement.resolved_params.clahe_clip, 3.5);
  });

  test('invalid settings are rejected with a 400 before any job is created', async () => {
    const id = await newDoc();
    const bad = [
      { preset: 'sepia' }, { preset: 'custom', params: { clahe_clip: 99 } }, { preset: 'custom', params: { denoise_method: 'laser' } },
      { preset: 'custom', params: { unknown_param: 1 } }, { corners: [[0, 0], [1, 1]] }, { corners: [[0, 0], [100, 0], [100, 100], ['x', 5]] },
      { corners: [[-500, 0], [100, 0], [100, 100], [0, 100]] }, { corners: [[0, 0], [9999, 0], [9999, 9999], [0, 9999]] },
      { manual_rotation: 45 }, { manual_angle: 400 }, { manual_angle: 'a lot' }, { auto_detect: 'yes' }, { scope: 'everything' },
      { document_type: 'spreadsheet' }, { psm: 99 },
    ];
    for (const body of bad) {
      const res = await c.post(`/api/documents/${id}/process`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.ok(res.data.error.message.length > 5);
    }
    assert.equal(t.db.one('SELECT COUNT(*) AS n FROM processing_jobs WHERE document_id = ?', id).n, 0);
    assert.equal(t.cv.calls.filter((x) => x.stage === 'geometry').length, 0);
  });

  test('run_ocr:false stops after enhancement; scope:enhance reuses the corrected page', async () => {
    const id = await newDoc();
    await c.post(`/api/documents/${id}/process`, { run_ocr: false });
    const first = await c.waitForJob(id);
    assert.equal(first.document.has_ocr, false);
    assert.deepEqual(Object.keys(first.job.stage_timings), ['geometry_ms', 'enhancement_ms']);

    t.cv.calls.length = 0;
    await c.post(`/api/documents/${id}/process`, { scope: 'enhance', preset: 'black_white' });
    const second = await c.waitForJob(id);
    assert.deepEqual(t.cv.calls.map((x) => x.stage), ['enhance', 'ocr'], 'geometry is not repeated');
    assert.equal(second.document.has_ocr, true);
    assert.equal(t.cv.calls[0].body.storage_key.endsWith('corrected.png'), true);
  });

  test('changing the document type on process updates the document and the OCR mode', async () => {
    const id = await newDoc();
    await c.post(`/api/documents/${id}/process`, { document_type: 'form' });
    await c.waitForJob(id);
    assert.equal((await c.get(`/api/documents/${id}`)).data.document.document_type, 'form');
    assert.equal(t.cv.calls.find((x) => x.stage === 'ocr').body.mode, 'form');
    assert.equal(t.cv.calls.find((x) => x.stage === 'ocr').body.psm, 4, 'forms default to PSM 4');
  });

  test('a CV failure marks the job and the document failed with a readable message (no internals)', async () => {
    const id = await newDoc();
    t.cv.failStage = 'enhance';
    t.cv.failWith = new AppError(502, 'cv_error', 'The processing service could not complete the request.');
    await c.post(`/api/documents/${id}/process`, {});
    const st = await c.waitForJob(id);
    assert.equal(st.job.status, 'failed');
    assert.equal(st.document.processing_status, 'failed');
    assert.equal(st.job.error_message, 'The processing service could not complete the request.');
    assert.deepEqual(Object.keys(st.job.stage_timings), ['geometry_ms'], 'timings of the stages that did finish are kept');

    t.cv.failStage = null;
    await c.post(`/api/documents/${id}/process`, {});
    assert.equal((await c.waitForJob(id)).job.status, 'completed', 'a failed document can be processed again');
  });

  test('an unexpected error becomes a generic message, never a stack trace or file path', async () => {
    const id = await newDoc();
    t.cv.failStage = 'geometry';
    t.cv.failWith = new Error('ENOENT: no such file or directory, open \'C:\\Users\\secret\\file.png\'');
    await c.post(`/api/documents/${id}/process`, {});
    const st = await c.waitForJob(id);
    assert.equal(st.job.status, 'failed');
    assert.doesNotMatch(st.job.error_message, /ENOENT|secret|C:\\/);
  });

  test('a CV service that is down is reported as such', async () => {
    const id = await newDoc();
    t.cv.failStage = 'geometry';
    t.cv.failWith = new AppError(503, 'cv_unavailable', 'The image-processing service is not reachable. Start it and try again.');
    await c.post(`/api/documents/${id}/process`, {});
    const st = await c.waitForJob(id);
    assert.match(st.job.error_message, /not reachable/);
  });

  test('re-reading the text reuses the enhanced image, reports that it replaces edits, and keeps the page processed on failure', async () => {
    const id = await newDoc();
    assert.equal((await c.post(`/api/documents/${id}/reprocess-ocr`, {})).status, 409, 'nothing to read before processing');
    await c.post(`/api/documents/${id}/process`, {});
    await c.waitForJob(id);
    await c.patch(`/api/documents/${id}/ocr`, { corrected_text: 'my own edit' });

    t.cv.calls.length = 0;
    const res = await c.post(`/api/documents/${id}/reprocess-ocr`, { psm: 6 });
    assert.equal(res.status, 202);
    assert.equal(res.data.replaces_edits, true);
    const st = await c.waitForJob(id);
    assert.equal(st.job.kind, 'ocr');
    assert.deepEqual(t.cv.calls.map((x) => x.stage), ['ocr']);
    assert.equal(t.cv.calls[0].body.psm, 6);
    assert.notEqual((await c.get(`/api/documents/${id}/ocr`)).data.ocr.corrected_text, 'my own edit');

    t.cv.failStage = 'ocr';
    await c.post(`/api/documents/${id}/reprocess-ocr`, {});
    const failed = await c.waitForJob(id);
    assert.equal(failed.job.status, 'failed');
    assert.equal(failed.document.processing_status, 'processed', 'the earlier good result is still usable');
  });

  test('jobs left running by a crash are failed on the next start', async () => {
    const id = await newDoc();
    t.db.run("INSERT INTO processing_jobs (document_id, kind, processing_settings, status, stage, created_at) VALUES (?, 'process', '{}', 'running', 'enhancement', ?)", id, new Date().toISOString());
    t.db.run("UPDATE documents SET processing_status = 'processing' WHERE id = ?", id);
    t.ctx.processing.recoverInterrupted();
    const st = (await c.get(`/api/documents/${id}/status`)).data;
    assert.equal(st.active, false);
    assert.equal(st.job.status, 'failed');
    assert.match(st.job.error_message, /interrupted/i);
    assert.equal(st.document.processing_status, 'failed');
  });

  test('the history lists real runs with their preset and timings, newest first, only for this user', async () => {
    const other = t.client(); await other.register('hist@example.com');
    const res = await c.get('/api/jobs');
    assert.equal(res.status, 200);
    assert.ok(res.data.total >= 5);
    assert.ok(res.data.items.every((j) => typeof j.original_filename === 'string'));
    const ids = res.data.items.map((j) => j.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    assert.equal((await other.get('/api/jobs')).data.total, 0);
  });

  test('the parameter schema endpoint is served from the shared contract', async () => {
    const res = await c.get('/api/processing/schema');
    assert.equal(res.status, 200);
    assert.ok(res.data.presets.automatic && res.data.presets.custom);
    assert.ok(res.data.parameters.clahe_clip);
  });
});
