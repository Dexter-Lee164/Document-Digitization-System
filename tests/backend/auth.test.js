'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

describe('registration and login', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  test('anonymous API calls are refused with 401 JSON', async () => {
    const c = t.client();
    const res = await c.get('/api/documents');
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'unauthorized');
  });

  test('registration without a CSRF token is refused', async () => {
    const c = t.client();
    await c.get('/auth/csrf'); // establishes the session cookie but we do not send the token back
    const res = await c.post('/auth/register', { email: 'nocsrf@example.com', password: 'abc12345' }, { csrf: false });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'csrf_failed');
    assert.equal(t.db.one('SELECT COUNT(*) AS n FROM users WHERE email = ?', 'nocsrf@example.com').n, 0);
  });

  test('a wrong CSRF token is refused', async () => {
    const c = t.client();
    await c.refreshCsrf();
    c.csrf = 'not-the-token';
    const res = await c.post('/auth/register', { email: 'bad@example.com', password: 'abc12345' });
    assert.equal(res.status, 403);
  });

  test('registers a user, stores only a bcrypt hash, and signs them in', async () => {
    const c = t.client();
    const res = await c.register('New.User@Example.com', 'passw0rd1');
    assert.equal(res.data.user.email, 'new.user@example.com', 'email is normalised to lower case');
    const row = t.db.one('SELECT * FROM users WHERE email = ?', 'new.user@example.com');
    assert.ok(row.password_hash.startsWith('$2'), 'bcrypt hash');
    assert.notEqual(row.password_hash, 'passw0rd1');
    assert.equal((await c.get('/api/documents')).status, 200);
    assert.ok(t.db.one('SELECT 1 AS x FROM user_settings WHERE user_id = ?', row.id), 'default settings row created');
  });

  test('the session cookie is HttpOnly and SameSite=Lax', async () => {
    const c = t.client();
    await c.refreshCsrf();
    const res = await c.post('/auth/register', { email: 'cookie@example.com', password: 'passw0rd1' });
    const cookie = res.setCookies.find((x) => x.startsWith('dv.sid='));
    assert.ok(cookie, 'dv.sid cookie is set');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
  });

  test('rejects bad emails and weak passwords with field-level messages', async () => {
    const c = t.client();
    await c.refreshCsrf();
    const cases = [
      [{ email: 'not-an-email', password: 'passw0rd1' }, 'email'],
      [{ email: 'a@example.com', password: 'short1' }, 'password'],
      [{ email: 'a@example.com', password: 'onlyletters' }, 'password'],
      [{ email: 'a@example.com', password: '12345678' }, 'password'],
      [{ email: 'a@example.com', password: 'x'.repeat(200) + '1' }, 'password'],
      [{ email: 'a@example.com', password: 'passw0rd1', confirm_password: 'different1' }, 'confirm_password'],
    ];
    for (const [body, field] of cases) {
      const res = await c.post('/auth/register', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.data.error.details.field, field);
    }
  });

  test('duplicate email (any letter case) is a 409', async () => {
    const c = t.client();
    await c.register('dup@example.com');
    const other = t.client();
    await other.refreshCsrf();
    const res = await other.post('/auth/register', { email: 'DUP@example.com', password: 'passw0rd1' });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'email_taken');
  });

  test('login: wrong password and unknown email give the same message', async () => {
    const c = t.client();
    await c.register('login@example.com', 'passw0rd1');
    const wrong = await t.client().login('login@example.com', 'wrongpass1');
    const unknown = await t.client().login('nobody@example.com', 'wrongpass1');
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.data.error.message, unknown.data.error.message);
  });

  test('login regenerates the session id (no session fixation) and a fresh CSRF token', async () => {
    const reg = t.client();
    await reg.register('fix@example.com', 'passw0rd1');
    const c = t.client();
    await c.refreshCsrf();
    const before = c.cookie;
    const tokenBefore = c.csrf;
    const res = await c.post('/auth/login', { email: 'fix@example.com', password: 'passw0rd1' });
    assert.equal(res.status, 200);
    assert.notEqual(c.cookie, before, 'session cookie changed');
    assert.notEqual((await c.get('/auth/csrf')).data.csrfToken, tokenBefore, 'CSRF token changed');
  });

  test('logout destroys the server-side session', async () => {
    const c = t.client();
    await c.register('out@example.com');
    const oldCookie = c.cookie;
    assert.equal((await c.post('/auth/logout', {})).status, 200);
    assert.equal((await c.get('/api/documents')).status, 401);
    const replay = t.client();
    replay.cookie = oldCookie;
    assert.equal((await replay.get('/api/documents')).status, 401, 'the old cookie no longer works');
  });

  test('form posts redirect (303) while JSON clients get JSON', async () => {
    const c = t.client();
    await c.register('form@example.com');
    await c.post('/auth/logout', {});
    await c.refreshCsrf();
    const body = new URLSearchParams({ email: 'form@example.com', password: 'passw0rd1', _csrf: c.csrf });
    const res = await c.request('POST', '/auth/login', { form: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, accept: 'text/html', csrf: false });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/dashboard');
  });

  test('a failed form login re-renders the page with the message (no JSON dump)', async () => {
    const c = t.client();
    await c.refreshCsrf();
    const body = new URLSearchParams({ email: 'form@example.com', password: 'wrong-pass1', _csrf: c.csrf });
    const res = await c.request('POST', '/auth/login', { form: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, accept: 'text/html', csrf: false });
    assert.equal(res.status, 401);
    assert.match(res.data, /Incorrect email or password/);
    assert.match(res.data, /<form/);
  });

  test('the ?next= redirect only allows same-site relative paths', async () => {
    const reg = t.client();
    await reg.register('next@example.com', 'passw0rd1');
    const attempts = [
      ['/documents', '/documents'],
      ['//evil.example.com', '/dashboard'],
      ['https://evil.example.com', '/dashboard'],
      ['/\\evil.example.com', '/dashboard'],
      ['/auth/logout', '/dashboard'],
    ];
    for (const [next, expected] of attempts) {
      const c = t.client();
      await c.refreshCsrf();
      const res = await c.post('/auth/login', { email: 'next@example.com', password: 'passw0rd1', next });
      assert.equal(res.data.redirect, expected, `next=${next}`);
    }
  });
});

describe('rate limiting', () => {
  test('repeated wrong passwords for one account lock further attempts for a while', async () => {
    const t = await startApp({ env: { LOGIN_MAX_ATTEMPTS: '3' } });
    try {
      await t.client().register('limit@example.com', 'passw0rd1');
      const c = t.client();
      for (let i = 0; i < 3; i += 1) assert.equal((await c.login('limit@example.com', 'nope-nope1')).status, 401);
      const blocked = await c.login('limit@example.com', 'passw0rd1'); // even the right password is refused while locked
      assert.equal(blocked.status, 429);
      assert.equal(blocked.data.error.code, 'rate_limited');
    } finally { await t.close(); }
  });
});

describe('protected pages', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  test('every page except login/register redirects anonymous visitors to /login with a next parameter', async () => {
    const c = t.client();
    for (const url of ['/dashboard', '/scan/new', '/documents', '/documents/1/workspace', '/documents/1/review', '/documents/1/export', '/history', '/lab', '/settings']) {
      const res = await c.get(url, { accept: 'text/html' });
      assert.equal(res.status, 302, url);
      assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(url)}`);
    }
  });

  test('login and register pages render for anonymous visitors and carry a CSRF token', async () => {
    const c = t.client();
    for (const url of ['/login', '/register']) {
      const res = await c.get(url, { accept: 'text/html' });
      assert.equal(res.status, 200);
      assert.match(res.data, /name="_csrf" value="[\w-]{20,}"/);
    }
  });

  test('a signed-in user is sent from /login to the dashboard', async () => {
    const c = t.client();
    await c.register('pages@example.com');
    const res = await c.get('/login', { accept: 'text/html' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/dashboard');
  });

  test('every page renders for a signed-in user', async () => {
    const c = t.client();
    await c.register('render@example.com');
    const up = await c.upload();
    for (const url of ['/dashboard', '/scan/new', '/documents', `/documents/${up.data.document.id}/workspace`, `/documents/${up.data.document.id}/review`, `/documents/${up.data.document.id}/export`, '/history', '/lab', '/settings']) {
      const res = await c.get(url, { accept: 'text/html' });
      assert.equal(res.status, 200, url);
      assert.match(res.data, /<title>[^<]*DocuVision/, url);
      assert.doesNotMatch(res.data, /<script>[^<]*\S/, `${url}: no inline scripts (CSP forbids them)`);
    }
  });
});

describe('changing the password', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  test('requires the current password and a valid new one', async () => {
    const c = t.client();
    await c.register('pw@example.com', 'passw0rd1');
    let res = await c.post('/api/settings/password', { current_password: 'wrong-one1', new_password: 'newpassw0rd' });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'wrong_password');
    res = await c.post('/api/settings/password', { current_password: 'passw0rd1', new_password: 'short' });
    assert.equal(res.status, 400);
    res = await c.post('/api/settings/password', { current_password: 'passw0rd1', new_password: 'newpassw0rd', confirm_password: 'other1234' });
    assert.equal(res.status, 400);
  });

  test('rotates this session, signs out every other device, and the old password stops working', async () => {
    const phone = t.client();
    await phone.register('rotate@example.com', 'passw0rd1');
    const laptop = t.client();
    await laptop.login('rotate@example.com', 'passw0rd1');
    const laptopCookie = laptop.cookie;
    const phoneCookie = phone.cookie;

    const res = await laptop.post('/api/settings/password', { current_password: 'passw0rd1', new_password: 'brandnew99', confirm_password: 'brandnew99' });
    assert.equal(res.status, 200);
    assert.ok(res.data.csrfToken, 'a fresh CSRF token is returned for the rotated session');
    assert.notEqual(laptop.cookie, laptopCookie, 'session id rotated');
    laptop.csrf = res.data.csrfToken;
    assert.equal((await laptop.get('/api/documents')).status, 200, 'this device stays signed in');
    assert.equal((await laptop.put('/api/settings', { default_preset: 'grayscale' })).status, 200, 'and can still make changes with the new token');

    const stale = t.client();
    stale.cookie = phoneCookie;
    assert.equal((await stale.get('/api/documents')).status, 401, 'the other device was signed out');
    const old = t.client();
    old.cookie = laptopCookie;
    assert.equal((await old.get('/api/documents')).status, 401, 'the pre-rotation cookie is dead');

    assert.equal((await t.client().login('rotate@example.com', 'passw0rd1')).status, 401);
    assert.equal((await t.client().login('rotate@example.com', 'brandnew99')).status, 200);
  });
});
