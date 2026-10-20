'use strict';
const session = require('express-session');

/** express-session store persisted in the SQLite `sessions` table. */
class SqliteSessionStore extends session.Store {
  constructor(db, { ttlMs = 7 * 24 * 60 * 60 * 1000, pruneEveryMs = 15 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.timer = setInterval(() => this.prune(), pruneEveryMs);
    this.timer.unref();
    this.prune();
  }

  _expires(sess) {
    const fromCookie = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(fromCookie) ? fromCookie : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.db.one('SELECT sess, expires FROM sessions WHERE sid = ?', sid);
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) {
        this.db.run('DELETE FROM sessions WHERE sid = ?', sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.sess));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.db.run(
        'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires',
        sid, JSON.stringify(sess), this._expires(sess),
      );
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.db.run('UPDATE sessions SET expires = ? WHERE sid = ?', this._expires(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.db.run('DELETE FROM sessions WHERE sid = ?', sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  prune() {
    try { this.db.run('DELETE FROM sessions WHERE expires <= ?', Date.now()); } catch { /* database closing */ }
  }

  close() {
    clearInterval(this.timer);
  }
}

module.exports = { SqliteSessionStore };
