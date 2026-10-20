'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makePng, makeJpeg } = require('./helpers');

describe('uploading', () => {
  let t; let c;
  before(async () => { t = await startApp({ config: { maxUploadSize: 200 * 1024 } }); c = t.client(); await c.register(); });
  after(async () => { await t.close(); });

  test('accepts a PNG and a JPEG, judged by their bytes', async () => {
    const png = await c.upload(makePng(120, 160), { name: 'a.png' });
    assert.equal(png.status, 201);
    assert.equal(png.data.document.mime_type, 'image/png');
    assert.equal(png.data.document.image_width, 120);
    assert.equal(png.data.document.image_height, 160);
    const jpg = await c.upload(makeJpeg(640, 480), { name: 'b.jpg', type: 'image/jpeg' });
    assert.equal(jpg.status, 201);
    assert.equal(jpg.data.document.mime_type, 'image/jpeg');
    assert.equal(jpg.data.document.document_type, 'general');
  });

  test('the file name and MIME type claimed by the client are not trusted', async () => {
    const res = await c.upload(Buffer.from('MZ\x90\x00 this is an executable, not a picture'), { name: 'holiday.jpg', type: 'image/jpeg' });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'unsupported_type');
    const html = await c.upload(Buffer.from('<script>alert(1)</script>'), { name: 'x.png', type: 'image/png' });
    assert.equal(html.status, 400);
    const pdf = await c.upload(Buffer.from('%PDF-1.7 fake'), { name: 'x.png', type: 'image/png' });
    assert.equal(pdf.status, 400);
  });

  test('rejects empty uploads, a missing file field and tiny images', async () => {
    assert.equal((await c.upload(Buffer.alloc(0), { name: 'empty.png' })).status, 400);
    const none = await c.request('POST', '/api/documents', { form: new FormData() });
    assert.equal(none.status, 400);
    assert.equal(none.data.error.code, 'no_file');
    assert.equal((await c.upload(makePng(4, 4), { name: 'tiny.png' })).data.error.code, 'image_too_small');
  });

  test('a PNG with a corrupted header is rejected', async () => {
    const png = makePng();
    png.write('XXXX', 12, 'ascii'); // IHDR tag destroyed
    const res = await c.upload(png);
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'invalid_image');
  });

  test('files over the size limit get 413', async () => {
    const big = Buffer.concat([makePng(), Buffer.alloc(300 * 1024)]);
    const res = await c.upload(big);
    assert.equal(res.status, 413);
    assert.equal(res.data.error.code, 'file_too_large');
  });

  test('images with too many pixels are refused before anything is stored', async () => {
    const t2 = await startApp({ config: { maxImagePixels: 100_000 } });
    try {
      const c2 = t2.client(); await c2.register();
      const res = await c2.upload(makePng(600, 600));
      assert.equal(res.status, 400);
      assert.equal(res.data.error.code, 'image_too_large');
      assert.equal(t2.files('uploads').length, 0);
    } finally { await t2.close(); }
  });

  test('if the CV service finds the image undecodable, the stored file is removed and no row is created', async () => {
    const before = t.files('uploads').length;
    const rows = t.db.one('SELECT COUNT(*) AS n FROM documents').n;
    const res = await c.upload(Buffer.concat([makePng(), Buffer.from('CORRUPT-MARKER')]), { name: 'broken.png' });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'invalid_image');
    assert.equal(t.files('uploads').length, before);
    assert.equal(t.db.one('SELECT COUNT(*) AS n FROM documents').n, rows);
  });

  test('the stored file name is server-generated; hostile client names never reach the file system', async () => {
    const res = await c.upload(makePng(), { name: '../../../etc/passwd.png' });
    assert.equal(res.status, 201);
    assert.ok(!res.data.document.original_filename.includes('..') && !res.data.document.original_filename.includes('/'));
    const row = t.db.one('SELECT * FROM documents WHERE id = ?', res.data.document.id);
    assert.match(row.original_image_path, /^uploads\/[0-9a-f-]{36}\.png$/);
    assert.ok(fs.existsSync(path.join(t.storagePath, row.original_image_path)));
  });

  test('document type form is stored; anything else falls back to general', async () => {
    assert.equal((await c.upload(makePng(), { documentType: 'form' })).data.document.document_type, 'form');
    assert.equal((await c.upload(makePng(), { documentType: 'hacked' })).data.document.document_type, 'general');
  });

  test('the API never exposes storage paths', async () => {
    const res = await c.upload(makePng());
    const text = JSON.stringify(res.data);
    assert.doesNotMatch(text, /uploads\/|stored_filename|original_image_path|[A-Za-z]:\\|\/tmp\//);
  });
});

describe('listing, searching and ownership', () => {
  let t; let alice; let bob; const ids = {};
  before(async () => {
    t = await startApp();
    alice = t.client(); await alice.register('alice@example.com');
    bob = t.client(); await bob.register('bob@example.com');
    ids.a1 = (await alice.upload(makePng(), { name: 'Invoice_March.png' })).data.document.id;
    ids.a2 = (await alice.upload(makePng(), { name: 'receipt-100%_real.png', documentType: 'form' })).data.document.id;
    ids.a3 = (await alice.upload(makePng(), { name: 'letter.png' })).data.document.id;
    ids.b1 = (await bob.upload(makePng(), { name: 'bob-private.png' })).data.document.id;
  });
  after(async () => { await t.close(); });

  test('search is case-insensitive and treats % and _ literally', async () => {
    assert.equal((await alice.get('/api/documents?search=invoice')).data.total, 1);
    assert.equal((await alice.get('/api/documents?search=' + encodeURIComponent('100%'))).data.total, 1);
    assert.equal((await alice.get('/api/documents?search=' + encodeURIComponent('%'))).data.total, 1, '% matches only the file that contains a percent sign');
    assert.equal((await alice.get('/api/documents?search=' + encodeURIComponent('_'))).data.total, 2, '_ matches only file names that contain an underscore');
  });

  test('search text is not interpreted as SQL', async () => {
    const res = await alice.get('/api/documents?search=' + encodeURIComponent("'; DROP TABLE documents; --"));
    assert.equal(res.status, 200);
    assert.equal(res.data.total, 0);
    assert.equal((await alice.get('/api/documents')).data.total, 3);
  });

  test('filters, sorting and paging', async () => {
    assert.equal((await alice.get('/api/documents?type=form')).data.total, 1);
    assert.equal((await alice.get('/api/documents?status=processed')).data.total, 0);
    assert.equal((await alice.get('/api/documents?status=uploaded')).data.total, 3);
    const byName = (await alice.get('/api/documents?sort=name')).data.items.map((d) => d.original_filename);
    assert.deepEqual(byName, [...byName].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' })));
    const newest = (await alice.get('/api/documents?sort=newest')).data.items.map((d) => d.id);
    assert.deepEqual(newest, [ids.a3, ids.a2, ids.a1]);
    const page = (await alice.get('/api/documents?page_size=2&page=2')).data;
    assert.equal(page.items.length, 1);
    assert.equal(page.pages, 2);
    assert.equal((await alice.get('/api/documents?page_size=9999')).data.page_size, 50, 'page size is capped');
  });

  test("one user's list never contains another user's documents", async () => {
    const mine = (await alice.get('/api/documents')).data.items.map((d) => d.id);
    assert.ok(!mine.includes(ids.b1));
    assert.equal((await bob.get('/api/documents')).data.total, 1);
  });

  test('every document endpoint answers 404 (not 403) for someone else\'s document', async () => {
    const id = ids.a1;
    const requests = [
      ['GET', `/api/documents/${id}`], ['PATCH', `/api/documents/${id}`, { original_filename: 'x' }], ['DELETE', `/api/documents/${id}`],
      ['GET', `/api/documents/${id}/original`], ['GET', `/api/documents/${id}/corrected`], ['GET', `/api/documents/${id}/enhanced`],
      ['POST', `/api/documents/${id}/detect`, {}], ['POST', `/api/documents/${id}/process`, {}], ['GET', `/api/documents/${id}/status`],
      ['GET', `/api/documents/${id}/ocr`], ['PATCH', `/api/documents/${id}/ocr`, { corrected_text: 'x' }], ['POST', `/api/documents/${id}/reprocess-ocr`, {}],
      ['POST', `/api/documents/${id}/export`, {}], ['GET', `/api/documents/${id}/exports`],
      ['POST', `/api/documents/${id}/experiments`, {}], ['GET', `/api/documents/${id}/experiments`],
    ];
    for (const [method, url, body] of requests) {
      const res = await bob.request(method, url, { json: body });
      assert.equal(res.status, 404, `${method} ${url}`);
    }
    const doc = (await alice.get(`/api/documents/${id}`)).data.document;
    assert.equal(doc.original_filename, 'Invoice_March.png', 'untouched by Bob\'s attempts');
  });

  test('ids that are not plain positive integers are 404 and never reach the database or file system', async () => {
    for (const bad of ['0', '-1', '1.5', '1e3', 'abc', '1%2F..%2F..%2Fetc', '99999999999999999999', '%00', '1;DROP']) {
      const res = await alice.get(`/api/documents/${bad}`);
      assert.equal(res.status, 404, bad);
    }
    assert.equal((await alice.get('/api/documents/999999')).status, 404);
  });

  test('renaming validates and sanitises the name', async () => {
    const ok = await alice.patch(`/api/documents/${ids.a3}`, { original_filename: 'Final: draft?.png' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.document.original_filename, 'Final draft.png');
    assert.equal((await alice.patch(`/api/documents/${ids.a3}`, { original_filename: '   ' })).status, 400);
    assert.equal((await alice.patch(`/api/documents/${ids.a3}`, { document_type: 'spreadsheet' })).status, 400);
    assert.equal((await alice.patch(`/api/documents/${ids.a3}`, {})).status, 400);
  });
});

describe('image endpoints and deleting', () => {
  let t; let c; let other;
  before(async () => { t = await startApp(); c = t.client(); await c.register(); other = t.client(); await other.register('other@example.com'); });
  after(async () => { await t.close(); });

  test('the original comes back byte for byte, privately cached, as an image', async () => {
    const png = makePng(90, 120);
    const up = await c.upload(png);
    const res = await c.get(`/api/documents/${up.data.document.id}/original`, { raw: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, png);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control'), /no-store|private/);
  });

  test('processed images are 404 until they exist', async () => {
    const up = await c.upload(makePng());
    assert.equal((await c.get(`/api/documents/${up.data.document.id}/enhanced`)).status, 404);
    assert.equal((await c.get(`/api/documents/${up.data.document.id}/corrected`)).status, 404);
  });

  test('deleting removes the row, the original, the processed images and the exports', async () => {
    const up = await c.upload(makePng());
    const id = up.data.document.id;
    await c.post(`/api/documents/${id}/process`, { preset: 'document_scan' });
    await c.waitForJob(id);
    assert.equal((await c.post(`/api/documents/${id}/export`, { type: 'text' })).status, 201);
    const row = t.db.one('SELECT * FROM documents WHERE id = ?', id);
    const exp = t.db.one('SELECT * FROM document_exports WHERE document_id = ?', id);
    const mine = [row.original_image_path, row.corrected_image_path, row.enhanced_image_path, exp.file_path];
    assert.equal(mine.filter(Boolean).length, 4);
    for (const key of mine) assert.ok(fs.existsSync(path.join(t.storagePath, key)), `${key} exists before deleting`);

    const res = await c.delete(`/api/documents/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.files_failed, 0);
    assert.equal((await c.get(`/api/documents/${id}`)).status, 404);
    for (const table of ['processing_jobs', 'ocr_results', 'document_exports']) {
      assert.equal(t.db.one(`SELECT COUNT(*) AS n FROM ${table} WHERE document_id = ?`, id).n, 0, table);
    }
    for (const key of mine) assert.ok(!fs.existsSync(path.join(t.storagePath, key)), `${key} is gone after deleting`);
    assert.ok(!fs.existsSync(path.join(t.storagePath, path.dirname(row.enhanced_image_path))), 'the per-document processed folder is removed too');
  });

  test('deleting is refused while the document is being processed, and works afterwards', async () => {
    let release;
    t.cv.gate = new Promise((r) => { release = r; });
    const up = await c.upload(makePng());
    const id = up.data.document.id;
    await c.post(`/api/documents/${id}/process`, {});
    const res = await c.delete(`/api/documents/${id}`);
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'busy');
    assert.equal((await c.get(`/api/documents/${id}`)).status, 200, 'still there');
    release(); t.cv.gate = null;
    await c.waitForJob(id);
    assert.equal((await c.delete(`/api/documents/${id}`)).status, 200);
  });

  test('another user cannot delete it either, and a second delete is 404', async () => {
    const up = await c.upload(makePng());
    const id = up.data.document.id;
    assert.equal((await other.delete(`/api/documents/${id}`)).status, 404);
    assert.equal((await c.delete(`/api/documents/${id}`)).status, 200);
    assert.equal((await c.delete(`/api/documents/${id}`)).status, 404);
  });

  test('detect stores the corners so the workspace can reuse them', async () => {
    const up = await c.upload(makePng(200, 300));
    const id = up.data.document.id;
    const res = await c.post(`/api/documents/${id}/detect`);
    assert.equal(res.status, 200);
    assert.equal(res.data.corners.length, 4);
    assert.deepEqual((await c.get(`/api/documents/${id}`)).data.document.corners, res.data.corners);
  });
});
