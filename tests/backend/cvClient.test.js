'use strict';
/** The Node -> Python HTTP contract: shared-secret header, JSON bodies, timeouts and error translation. */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { CvClient } = require('../../backend/services/cvClient');

describe('CvClient', () => {
  let server; let base; let seen; let behaviour;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        seen = { method: req.method, url: req.url, token: req.headers['x-service-token'], type: req.headers['content-type'], body: body ? JSON.parse(body) : null };
        const b = behaviour(seen, res);
        if (b === 'handled') return;
        res.writeHead(b.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(b.json));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });

  const client = (opts = {}) => new CvClient({ baseUrl: base, token: 'secret-token', timeoutMs: 2000, ...opts });

  test('sends the shared secret and a JSON body, and returns the parsed response', async () => {
    behaviour = () => ({ json: { width: 10, height: 20 } });
    const res = await client().validate('uploads/a.png');
    assert.deepEqual(res, { width: 10, height: 20 });
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/v1/validate');
    assert.equal(seen.token, 'secret-token');
    assert.equal(seen.type, 'application/json');
    assert.deepEqual(seen.body, { storage_key: 'uploads/a.png' });
  });

  test('every stage calls its own endpoint', async () => {
    behaviour = () => ({ json: {} });
    const c = client();
    await c.detect('k'); assert.equal(seen.url, '/v1/detect');
    await c.geometry({ a: 1 }); assert.equal(seen.url, '/v1/geometry');
    await c.enhance({ a: 1 }); assert.equal(seen.url, '/v1/enhance');
    await c.ocr({ a: 1 }); assert.equal(seen.url, '/v1/ocr');
    await c.docx({ a: 1 }); assert.equal(seen.url, '/v1/docx');
    await c.experiments({ a: 1 }); assert.equal(seen.url, '/v1/experiments');
    await c.templates(); assert.equal(seen.method, 'GET'); assert.equal(seen.url, '/v1/templates');
  });

  test('health is called without the secret and never throws', async () => {
    behaviour = () => ({ json: { status: 'ok', ocr: { available: true } } });
    assert.equal((await client().health()).status, 'ok');
    assert.equal(seen.token, undefined, 'the public health probe carries no secret');
    const down = await new CvClient({ baseUrl: 'http://127.0.0.1:1', token: 'x', timeoutMs: 500 }).health();
    assert.equal(down.status, 'offline');
    assert.equal(down.ocr.available, false);
  });

  test('a 401 from the service means the tokens differ, and says how to fix it', async () => {
    behaviour = () => ({ status: 401, json: { error: { code: 'unauthorized', message: 'bad token' } } });
    await assert.rejects(client().ocr({}), (err) => err.status === 502 && err.code === 'cv_auth_failed' && /CV_SERVICE_TOKEN/.test(err.message));
  });

  test('validation errors from the service reach the user unchanged', async () => {
    behaviour = () => ({ status: 400, json: { error: { code: 'invalid_image', message: 'The image could not be decoded.', details: { x: 1 } } } });
    await assert.rejects(client().validate('k'), (err) => err.status === 400 && err.code === 'invalid_image' && err.message === 'The image could not be decoded.' && err.details.x === 1);
    behaviour = () => ({ status: 400, json: { error: { code: 'invalid_corners', message: 'The corners do not form a page.' } } });
    await assert.rejects(client().geometry({}), (err) => err.code === 'invalid_corners');
  });

  test('other failures become a generic 502 without leaking internals', async () => {
    behaviour = () => ({ status: 500, json: { error: { code: 'internal', message: 'Traceback: File "/srv/app/main.py", line 3' } } });
    await assert.rejects(client().ocr({}), (err) => err.status === 502 && err.code === 'internal');
    behaviour = (_, res) => { res.writeHead(500, { 'Content-Type': 'text/html' }); res.end('<h1>Server error</h1>'); return 'handled'; };
    await assert.rejects(client().ocr({}), (err) => err.status === 502 && err.code === 'cv_error' && /could not complete/.test(err.message));
  });

  test('503/504 from the service keep their meaning (e.g. Tesseract missing, OCR timeout)', async () => {
    behaviour = () => ({ status: 503, json: { error: { code: 'ocr_unavailable', message: 'Tesseract is not installed.' } } });
    await assert.rejects(client().ocr({}), (err) => err.status === 503 && err.code === 'ocr_unavailable');
    behaviour = () => ({ status: 504, json: { error: { code: 'ocr_timeout', message: 'Text recognition took too long.' } } });
    await assert.rejects(client().ocr({}), (err) => err.status === 504 && err.code === 'ocr_timeout');
  });

  test('a service that is not running is reported with instructions', async () => {
    const c = new CvClient({ baseUrl: 'http://127.0.0.1:1', token: 'x', timeoutMs: 1000 });
    await assert.rejects(c.ocr({}), (err) => err.status === 503 && err.code === 'cv_unavailable' && /Start it/.test(err.message));
  });

  test('a service that does not answer in time is cut off with a 504', async () => {
    behaviour = (_, res) => { setTimeout(() => { try { res.writeHead(200); res.end('{}'); } catch { /* client went away */ } }, 1500); return 'handled'; };
    const started = Date.now();
    await assert.rejects(client({ timeoutMs: 200 }).ocr({}), (err) => err.status === 504 && err.code === 'cv_timeout');
    assert.ok(Date.now() - started < 1200, 'gave up at the timeout, not when the server finally answered');
  });
});
