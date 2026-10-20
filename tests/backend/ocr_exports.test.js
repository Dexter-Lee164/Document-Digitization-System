'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makePng } = require('./helpers');
const { contentDisposition } = require('../../backend/controllers/exportsController');

describe('OCR results: review and correction', () => {
  let t; let c; let docId; let formId;
  before(async () => {
    t = await startApp(); c = t.client(); await c.register();
    docId = (await c.upload(makePng())).data.document.id;
    formId = (await c.upload(makePng(), { documentType: 'form' })).data.document.id;
  });
  after(async () => { await t.close(); });

  test('there is no OCR result before processing', async () => {
    const res = await c.get(`/api/documents/${docId}/ocr`);
    assert.equal(res.status, 404);
    assert.equal((await c.patch(`/api/documents/${docId}/ocr`, { corrected_text: 'x' })).status, 404);
  });

  test('after processing, the OCR result carries text, word boxes, confidence and an untouched original', async () => {
    await c.post(`/api/documents/${docId}/process`, {});
    await c.waitForJob(docId);
    const { ocr } = (await c.get(`/api/documents/${docId}/ocr`)).data;
    assert.equal(ocr.corrected_text, ocr.original_text);
    assert.equal(ocr.edited, false);
    assert.ok(ocr.words.length > 5 && ocr.words.every((w) => 'text' in w && 'conf' in w && 'x' in w && 'low' in w));
    assert.equal(ocr.confidence.mean, 88.5);
    assert.equal(ocr.confidence.low_confidence_count, 1);
    assert.equal(ocr.form, null);
    assert.equal((await c.get(`/api/documents/${docId}`)).data.document.review_status, 'needs_review');
  });

  test('saving keeps the original OCR text and marks the result edited', async () => {
    const before = (await c.get(`/api/documents/${docId}/ocr`)).data.ocr;
    const res = await c.patch(`/api/documents/${docId}/ocr`, { corrected_text: 'Corrected\r\ntext here' });
    assert.equal(res.status, 200);
    assert.equal(res.data.ocr.corrected_text, 'Corrected\ntext here', 'line endings normalised');
    assert.equal(res.data.ocr.original_text, before.original_text, 'the machine reading is never overwritten');
    assert.equal(res.data.ocr.edited, true);
  });

  test('review status can be set and is validated', async () => {
    let res = await c.patch(`/api/documents/${docId}/ocr`, { review_status: 'reviewed' });
    assert.equal(res.data.document.review_status, 'reviewed');
    assert.equal((await c.patch(`/api/documents/${docId}/ocr`, { review_status: 'approved' })).status, 400);
    res = await c.patch(`/api/documents/${docId}/ocr`, { review_status: 'needs_review' });
    assert.equal(res.data.document.review_status, 'needs_review');
  });

  test('reset restores the original text and goes back to needs-review', async () => {
    await c.patch(`/api/documents/${docId}/ocr`, { corrected_text: 'something else', review_status: 'reviewed' });
    const res = await c.patch(`/api/documents/${docId}/ocr`, { reset: true });
    assert.equal(res.data.ocr.corrected_text, res.data.ocr.original_text);
    assert.equal(res.data.ocr.edited, false);
    assert.equal(res.data.document.review_status, 'needs_review');
  });

  test('bad input is rejected', async () => {
    assert.equal((await c.patch(`/api/documents/${docId}/ocr`, { corrected_text: 123 })).status, 400);
    assert.equal((await c.patch(`/api/documents/${docId}/ocr`, { corrected_text: 'x'.repeat(1_000_001) })).status, 400);
    assert.equal((await c.patch(`/api/documents/${docId}/ocr`, { fields: [{ key: 'a', value: 'b' }] })).status, 400, 'a general document has no form fields');
  });

  test('HTML in the text is stored as plain text and returned as JSON (never rendered by the API)', async () => {
    const payload = '<img src=x onerror=alert(1)> & "quotes"';
    await c.patch(`/api/documents/${docId}/ocr`, { corrected_text: payload });
    const res = await c.get(`/api/documents/${docId}/ocr`);
    assert.equal(res.data.ocr.corrected_text, payload);
    assert.match(res.headers.get('content-type'), /application\/json/);
  });

  test('form documents expose their fields; edits keep the original value for reset', async () => {
    await c.post(`/api/documents/${formId}/process`, {});
    await c.waitForJob(formId);
    let { ocr } = (await c.get(`/api/documents/${formId}/ocr`)).data;
    assert.equal(ocr.form.matched, true);
    assert.equal(ocr.form.fields.length, 2);

    const res = await c.patch(`/api/documents/${formId}/ocr`, { fields: [{ key: 'student_name', value: '  Juan\nDela Cruz ' }] });
    assert.equal(res.status, 200);
    const field = res.data.ocr.form.fields.find((f) => f.key === 'student_name');
    assert.equal(field.value, 'Juan Dela Cruz', 'control characters removed and trimmed');
    assert.equal(field.original_value, 'DELA CRUZ, JUAN M.');

    assert.equal((await c.patch(`/api/documents/${formId}/ocr`, { fields: [{ key: 'nope', value: 'x' }] })).status, 400);
    assert.equal((await c.patch(`/api/documents/${formId}/ocr`, { fields: [{ key: 'student_id', value: 5 }] })).status, 400);
    assert.equal((await c.patch(`/api/documents/${formId}/ocr`, { fields: 'all' })).status, 400);
    assert.equal((await c.patch(`/api/documents/${formId}/ocr`, { fields: [{ key: 'student_id', value: 'x'.repeat(2001) }] })).status, 400);

    ({ ocr } = (await c.patch(`/api/documents/${formId}/ocr`, { reset: true })).data);
    assert.equal(ocr.form.fields.find((f) => f.key === 'student_name').value, 'DELA CRUZ, JUAN M.');
  });
});

describe('Word export', () => {
  let t; let c; let other; let docId; let formId;
  before(async () => {
    t = await startApp(); c = t.client(); await c.register(); other = t.client(); await other.register('other@example.com');
    docId = (await c.upload(makePng(), { name: 'Quarterly report.png' })).data.document.id;
    formId = (await c.upload(makePng(), { name: 'form.png', documentType: 'form' })).data.document.id;
  });
  after(async () => { await t.close(); });

  test('is refused with a clear message until there is text to export', async () => {
    const res = await c.post(`/api/documents/${docId}/export`, { type: 'text' });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'no_ocr');
  });

  test('creates a .docx through the CV service and records it', async () => {
    await c.post(`/api/documents/${docId}/process`, {});
    await c.waitForJob(docId);
    await c.patch(`/api/documents/${docId}/ocr`, { corrected_text: 'Edited line one.\n\nEdited line two.' });
    t.cv.calls.length = 0;
    const res = await c.post(`/api/documents/${docId}/export`, { type: 'text', reflow: false, include_full_text: false });
    assert.equal(res.status, 201);
    assert.equal(res.data.export.filename, 'Quarterly report_digitized.docx');
    assert.equal(res.data.export.export_type, 'text');
    assert.equal(res.data.verification.font_ok, true);
    const sent = t.cv.calls.find((x) => x.stage === 'docx').body;
    assert.equal(sent.text, 'Edited line one.\n\nEdited line two.', 'the user-corrected text is exported, not the raw OCR');
    assert.equal(sent.reflow, false);
    assert.match(sent.output_key, /^exports\/[0-9a-f-]{36}\.docx$/);
    assert.ok(fs.existsSync(path.join(t.storagePath, sent.output_key)));
  });

  test('the default type follows the document: form tables for matched forms, text otherwise', async () => {
    assert.equal((await c.post(`/api/documents/${docId}/export`, {})).data.export.export_type, 'text');
    await c.post(`/api/documents/${formId}/process`, {});
    await c.waitForJob(formId);
    const res = await c.post(`/api/documents/${formId}/export`, {});
    assert.equal(res.data.export.export_type, 'form');
    const sent = t.cv.calls.filter((x) => x.stage === 'docx').pop().body;
    assert.deepEqual(sent.fields.map((f) => f.key), ['student_name', 'student_id']);
    assert.equal(sent.title, 'Student registration form');
  });

  test('a form export uses the corrected field values', async () => {
    await c.patch(`/api/documents/${formId}/ocr`, { fields: [{ key: 'student_id', value: '2023-00001' }] });
    await c.post(`/api/documents/${formId}/export`, { type: 'form' });
    const sent = t.cv.calls.filter((x) => x.stage === 'docx').pop().body;
    assert.equal(sent.fields.find((f) => f.key === 'student_id').value, '2023-00001');
  });

  test('validates the requested type and refuses a form export for a general document', async () => {
    assert.equal((await c.post(`/api/documents/${docId}/export`, { type: 'pdf' })).status, 400);
    const res = await c.post(`/api/documents/${docId}/export`, { type: 'form' });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'no_form_fields');
    await c.patch(`/api/documents/${docId}/ocr`, { corrected_text: '   \n ' });
    assert.equal((await c.post(`/api/documents/${docId}/export`, { type: 'text' })).data.error.code, 'empty_text');
    await c.patch(`/api/documents/${docId}/ocr`, { corrected_text: 'text again' });
  });

  test('file names are sanitised: no path parts, no reserved characters, always .docx', async () => {
    const cases = [
      ['My: "report"/final', 'My report final.docx'],
      ['../../etc/passwd', 'etc passwd.docx'],
      ['report.docx', 'report.docx'],
      ['  spaced   out  ', 'spaced out.docx'],
      ['CON', 'Quarterly report_digitized.docx'],
      ['', 'Quarterly report_digitized.docx'],
      ['<script>alert(1)</script>', 'scriptalert(1) script.docx'],
    ];
    for (const [given, expected] of cases) {
      const res = await c.post(`/api/documents/${docId}/export`, { type: 'text', filename: given });
      assert.equal(res.status, 201, given);
      assert.equal(res.data.export.filename, expected, `filename ${JSON.stringify(given)}`);
    }
    assert.equal((await c.post(`/api/documents/${docId}/export`, { type: 'text', filename: 42 })).status, 400);
  });

  test('download streams the file with safe headers and a correct Content-Disposition', async () => {
    const made = await c.post(`/api/documents/${docId}/export`, { type: 'text', filename: 'Résumé 2026' });
    const res = await c.get(made.data.export.download_url, { raw: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control'), /no-store/);
    const disposition = res.headers.get('content-disposition');
    assert.match(disposition, /^attachment;/);
    assert.match(disposition, /filename\*=UTF-8''R%C3%A9sum%C3%A9%202026\.docx/);
    assert.equal(res.data.subarray(0, 2).toString('latin1'), 'PK');
  });

  test('another user and anonymous visitors cannot download or list it', async () => {
    const made = await c.post(`/api/documents/${docId}/export`, { type: 'text' });
    const url = made.data.export.download_url;
    assert.equal((await other.get(url)).status, 404);
    assert.equal((await t.client().get(url)).status, 401);
    assert.equal((await other.delete(`/api/exports/${made.data.export.id}`)).status, 404);
    assert.equal((await other.get('/api/exports')).data.total, 0);
    assert.equal((await c.get(url, { raw: true })).status, 200, 'the owner still can');
  });

  test('history lists exports; deleting one removes the row and the file', async () => {
    const list = (await c.get(`/api/documents/${docId}/exports`)).data.items;
    assert.ok(list.length >= 3);
    const target = list[0];
    const row = t.db.one('SELECT file_path FROM document_exports WHERE id = ?', target.id);
    assert.ok(fs.existsSync(path.join(t.storagePath, row.file_path)));
    assert.equal((await c.delete(`/api/exports/${target.id}`)).status, 200);
    assert.ok(!fs.existsSync(path.join(t.storagePath, row.file_path)));
    assert.equal((await c.get(`/api/exports/${target.id}/download`)).status, 404);
    const all = (await c.get('/api/exports?page_size=2')).data;
    assert.equal(all.items.length, 2);
    assert.ok(all.total >= 4 && all.pages >= 2);
  });

  test('if the CV service fails, no export row is left behind', async () => {
    const before = t.db.one('SELECT COUNT(*) AS n FROM document_exports').n;
    t.cv.failStage = 'docx';
    const res = await c.post(`/api/documents/${docId}/export`, { type: 'text' });
    t.cv.failStage = null;
    assert.equal(res.status, 502);
    assert.equal(t.db.one('SELECT COUNT(*) AS n FROM document_exports').n, before);
  });

  test('a missing file on disk gives a helpful 404 instead of a crash', async () => {
    const made = await c.post(`/api/documents/${docId}/export`, { type: 'text' });
    const row = t.db.one('SELECT file_path FROM document_exports WHERE id = ?', made.data.export.id);
    fs.rmSync(path.join(t.storagePath, row.file_path));
    const res = await c.get(made.data.export.download_url);
    assert.equal(res.status, 404);
    assert.equal(res.data.error.code, 'file_missing');
  });
});

describe('Content-Disposition helper', () => {
  test('ASCII names are quoted, others use RFC 5987, and header injection is impossible', () => {
    assert.equal(contentDisposition('plain.docx'), 'attachment; filename="plain.docx"; filename*=UTF-8\'\'plain.docx');
    assert.match(contentDisposition('naïve café.docx'), /filename\*=UTF-8''na%C3%AFve%20caf%C3%A9\.docx/);
    const evil = contentDisposition('a"\r\nSet-Cookie: x=1.docx');
    assert.doesNotMatch(evil, /[\r\n]/);
    assert.doesNotMatch(evil.split(';')[1], /"[^"]*"[^;]*"/, 'no stray quote breaks out of the filename parameter');
  });
});
