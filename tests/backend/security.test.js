'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, makePng } = require('./helpers');

describe('HTTP security', () => {
  let t; let c;
  before(async () => { t = await startApp(); c = t.client(); await c.register(); });
  after(async () => { await t.close(); });

  test('security headers are set on pages, API responses and errors', async () => {
    for (const url of ['/login', '/api/documents', '/nothing-here', '/healthz']) {
      const res = await c.get(url, { accept: url === '/api/documents' ? 'application/json' : 'text/html' });
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'self'/, url);
      assert.match(csp, /script-src 'self'(;|$)/, `${url}: scripts only from our own files`);
      assert.doesNotMatch(csp.split('script-src')[1].split(';')[0], /unsafe-inline|unsafe-eval/, url);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /object-src 'none'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', url);
      assert.equal(res.headers.get('x-powered-by'), null, url);
      assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/);
    }
  });

  test('authenticated pages and API responses are never cached', async () => {
    assert.match((await c.get('/api/documents')).headers.get('cache-control'), /no-store/);
    assert.match((await c.get('/dashboard', { accept: 'text/html' })).headers.get('cache-control'), /no-store/);
  });

  test('every state-changing route refuses a request without the CSRF token', async () => {
    const up = await c.upload(makePng());
    const id = up.data.document.id;
    const routes = [
      ['POST', '/api/documents'], ['PATCH', `/api/documents/${id}`], ['DELETE', `/api/documents/${id}`], ['POST', `/api/documents/${id}/detect`],
      ['POST', `/api/documents/${id}/process`], ['PATCH', `/api/documents/${id}/ocr`], ['POST', `/api/documents/${id}/reprocess-ocr`],
      ['POST', `/api/documents/${id}/export`], ['POST', `/api/documents/${id}/experiments`], ['DELETE', '/api/exports/1'], ['DELETE', '/api/experiments/1'],
      ['PUT', '/api/settings'], ['POST', '/api/settings/password'], ['POST', '/auth/logout'], ['POST', '/auth/login'], ['POST', '/auth/register'],
    ];
    for (const [method, url] of routes) {
      const res = await c.request(method, url, { json: method === 'DELETE' ? undefined : {}, csrf: false });
      assert.equal(res.status, 403, `${method} ${url} without a token`);
      assert.equal(res.data.error.code, 'csrf_failed');
    }
    assert.equal((await c.get(`/api/documents/${id}`)).status, 200, 'nothing was changed or deleted by those attempts');
  });

  test('a CSRF token from another session does not work', async () => {
    const a = t.client(); await a.register('csrf-a@example.com');
    const b = t.client(); await b.register('csrf-b@example.com');
    const res = await b.request('PUT', '/api/settings', { json: { default_preset: 'grayscale' }, headers: { 'X-CSRF-Token': a.csrf }, csrf: false });
    assert.equal(res.status, 403);
  });

  test('GET requests never change state (so a link or <img> cannot be used to attack)', async () => {
    const before = t.db.one('SELECT COUNT(*) AS n FROM documents').n;
    await c.get('/auth/logout');
    await c.get('/api/documents/1/delete');
    assert.equal(t.db.one('SELECT COUNT(*) AS n FROM documents').n, before);
    assert.equal((await c.get('/api/documents')).status, 200, 'still signed in');
  });

  test('errors are JSON for the API and a normal page for browsers, without stack traces', async () => {
    const api = await c.get('/api/does-not-exist');
    assert.equal(api.status, 404);
    assert.equal(api.data.error.code, 'not_found');
    const page = await c.get('/does-not-exist', { accept: 'text/html' });
    assert.equal(page.status, 404);
    assert.match(page.data, /<html/);
    assert.doesNotMatch(page.data, /at Object\.|node_modules|\.js:\d+/);
  });

  test('malformed JSON is a 400 with a clear message', async () => {
    const res = await fetch(`${t.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf, Cookie: c.cookie }, body: '{"email": ' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_json');
  });

  test('oversized JSON bodies are refused', async () => {
    const res = await c.post('/api/settings', { default_preset: 'x'.repeat(3 * 1024 * 1024) });
    assert.ok([413, 404].includes(res.status));
    const big = await c.put('/api/settings', { export_filename_suffix: 'x'.repeat(3 * 1024 * 1024) });
    assert.equal(big.status, 413);
  });

  test('the user-supplied parts of error pages are escaped', async () => {
    const anon = t.client();
    await anon.refreshCsrf();
    const body = new URLSearchParams({ email: '"><script>alert(1)</script>', password: 'x', _csrf: anon.csrf });
    const res = await anon.request('POST', '/auth/login', { form: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, accept: 'text/html', csrf: false });
    assert.doesNotMatch(res.data, /<script>alert\(1\)<\/script>/);
  });

  test('static files cannot be used to read the project or storage folders', async () => {
    for (const url of ['/static/../../.env', '/static/%2e%2e/%2e%2e/package.json', '/static/..%2f..%2fbackend/config.js', '/vendor/bootstrap/../../package.json', '/static/.env', '/storage/uploads/', '/uploads/x.png']) {
      const res = await c.get(url, { accept: 'text/html' });
      assert.ok([301, 400, 403, 404].includes(res.status) && !String(res.data).includes('SESSION_SECRET') && !String(res.data).includes('"scripts"'), `${url} -> ${res.status}`);
    }
    assert.equal((await c.get('/static/js/main.js', { accept: '*/*' })).status, 200);
    assert.equal((await c.get('/vendor/bootstrap/css/bootstrap.min.css', { accept: '*/*' })).status, 200);
  });

  test('uploaded files are only reachable through the authenticated API, never as static files', async () => {
    const up = await c.upload(makePng());
    const row = t.db.one('SELECT original_image_path FROM documents WHERE id = ?', up.data.document.id);
    for (const url of [`/${row.original_image_path}`, `/static/${row.original_image_path}`, `/storage/${row.original_image_path}`]) {
      assert.equal((await t.client().get(url, { accept: '*/*' })).status, 404, url);
    }
    assert.equal((await t.client().get(`/api/documents/${up.data.document.id}/original`)).status, 401);
  });

  test('responses never contain the CV service token or the session secret', async () => {
    const pages = ['/login', '/dashboard', '/settings', '/api/health', '/api/settings'];
    for (const url of pages) {
      const res = await c.get(url, { accept: url.startsWith('/api') ? 'application/json' : 'text/html' });
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      assert.ok(!text.includes('test-token') && !text.includes('test-secret'), url);
    }
  });

  test('the health endpoint reports real service state and does not leak file-system paths', async () => {
    const res = await c.get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.cv_service.status, 'ok');
    assert.equal(res.data.ocr.available, true);
    assert.equal(res.data.database.status, 'ok');
    assert.doesNotMatch(JSON.stringify(res.data), /\/usr\/|\/home\/|[A-Za-z]:\\/);
    assert.equal((await t.client().get('/api/health')).status, 401, 'details are for signed-in users; /healthz is the public liveness probe');
    assert.deepEqual((await t.client().get('/healthz')).data, { status: 'ok' });
  });
});

describe('sessions', () => {
  test('expired sessions are rejected', async () => {
    const t = await startApp();
    try {
      const c = t.client(); await c.register();
      assert.equal((await c.get('/api/documents')).status, 200);
      t.db.run('UPDATE sessions SET expires = ?', Date.now() - 1000);
      assert.equal((await c.get('/api/documents')).status, 401);
    } finally { await t.close(); }
  });

  test('a forged or garbage session cookie is just an anonymous visitor', async () => {
    const t = await startApp();
    try {
      for (const cookie of ['dv.sid=s%3Aforged.signature', 'dv.sid=' + 'A'.repeat(500), 'dv.sid=', 'dv.sid=%00']) {
        const c = t.client(); c.cookie = cookie;
        assert.equal((await c.get('/api/documents')).status, 401, cookie.slice(0, 30));
      }
    } finally { await t.close(); }
  });

  test('deleting the user row invalidates their session on the next request', async () => {
    const t = await startApp();
    try {
      const c = t.client(); await c.register();
      t.db.run('DELETE FROM users');
      assert.equal((await c.get('/api/documents')).status, 401);
    } finally { await t.close(); }
  });
});
