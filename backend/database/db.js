'use strict';
const fs = require('node:fs');
const path = require('node:path');

// node:sqlite ships with Node.js (22.5+). It may print a one-time "experimental" notice on some versions.
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

/** Thin wrapper: plain-object rows, positional parameters only (always parameterised), tiny transaction helper. */
class Db {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    this._depth = 0;
  }

  /** Create / upgrade tables. Safe to call on every start. */
  init() {
    this.raw.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    return this;
  }

  one(sql, ...params) {
    const row = this.raw.prepare(sql).get(...params);
    return row ? { ...row } : null;
  }

  all(sql, ...params) {
    return this.raw.prepare(sql).all(...params).map((r) => ({ ...r }));
  }

  run(sql, ...params) {
    const info = this.raw.prepare(sql).run(...params);
    return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
  }

  /** Run `fn` inside a transaction (re-entrant: nested calls join the outer one). */
  tx(fn) {
    if (this._depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this._depth = 1;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      this._depth = 0;
    }
  }

  close() {
    try { this.raw.close(); } catch { /* already closed */ }
  }
}

function openDatabase(file) {
  return new Db(file).init();
}

function isUniqueViolation(err) {
  return Boolean(err && /UNIQUE constraint failed/i.test(String(err.message)));
}

module.exports = { Db, openDatabase, isUniqueViolation };
