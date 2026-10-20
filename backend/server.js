#!/usr/bin/env node
'use strict';
{ // node:sqlite needs Node 22.13+; say so plainly instead of failing with "No such built-in module".
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`\nNode.js ${process.versions.node} is too old: DocuVision needs Node.js 22.13 or newer (v26.5.1 recommended).\n`);
    process.exit(1);
  }
}
const { createApp } = require('./app');

function main() {
  let created;
  try {
    created = createApp();
  } catch (err) {
    console.error(`\nDocuVision could not start: ${err.message}\n`);
    process.exit(1);
  }
  const { app, ctx, close } = created;
  const { config } = ctx;

  const server = app.listen(config.port, config.host, () => {
    console.log(`DocuVision web app running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`  Database : ${config.databasePath}`);
    console.log(`  Storage  : ${config.storagePath}`);
    console.log(`  CV service: ${config.cvServiceUrl}`);
    ctx.cv.health().then((h) => {
      if (h.status === 'offline') console.warn('  ! The Python CV service is not reachable yet. Start it with "npm run start:cv" (or use "npm run dev").');
      else if (h.status === 'degraded') console.warn(`  ! CV service is up but Tesseract OCR is unavailable: ${h.ocr && h.ocr.error}`);
      else console.log(`  CV service online (OpenCV ${h.opencv}, Tesseract ${h.ocr.version})`);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`\nPort ${config.port} is already in use. Change PORT in .env or stop the other program.\n`);
    else console.error(err);
    close();
    process.exit(1);
  });
  // Uploads and long-running processing must not be cut off by Node's defaults, but idle sockets should still close.
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 60 * 1000;

  const shutdown = (signal) => {
    console.log(`\n${signal} received - shutting down.`);
    server.close(() => { close(); process.exit(0); });
    setTimeout(() => { close(); process.exit(0); }, 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
