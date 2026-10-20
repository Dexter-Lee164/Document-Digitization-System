#!/usr/bin/env node
'use strict';
/**
 * `npm run db:init` - creates the SQLite database file and all tables (also done automatically on server start).
 */
const { loadConfig } = require('../config');
const { openDatabase } = require('./db');

if (require.main === module) {
  const config = loadConfig({ env: { CV_SERVICE_TOKEN: process.env.CV_SERVICE_TOKEN || 'init-only' } });
  const db = openDatabase(config.databasePath);
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name);
  console.log(`SQLite database ready: ${config.databasePath}`);
  console.log(`Tables: ${tables.join(', ')}`);
  db.close();
}
