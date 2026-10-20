#!/usr/bin/env node
'use strict';
/**
 * npm run start:cv   - starts the Python computer-vision / OCR service on CV_HOST:CV_PORT (default 127.0.0.1:8001).
 * npm run check      - same script with --check: reports Python, the Python packages and Tesseract, then exits.
 * Stop the service with Ctrl+C.
 */
const common = require('./common');

async function main() {
  common.assertNodeVersion();
  common.loadEnv();

  if (process.argv.includes('--check')) {
    const py = common.findPython();
    if (!py) common.fail('Python 3.11 or 3.12 was not found. Install it from https://www.python.org/downloads/ and run scripts\\setup.ps1.');
    console.log(py.label === py.cmd ? `Using ${py.cmd}` : `Using ${py.label} (${py.cmd})`);
    const result = common.checkPython(py);
    console.log(result.output);
    process.exit(result.status);
  }

  const py = common.requirePython();
  const { host, port } = common.cvSettings();
  if (await common.isPortInUse(port, host)) {
    common.fail(
      `Port ${port} is already in use - a DocuVision CV service may still be running from an earlier session.\n`
      + `Close that window, or free the port (PowerShell):\n  Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`,
    );
  }

  console.log(`Starting the CV service with ${py.label} on http://${host}:${port} ...`);
  const child = common.spawnCv(py);
  const stop = () => common.killTree(child);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', stop);
  child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 0 : 1) : code));
  child.on('error', (err) => common.fail(`Could not start Python: ${err.message}`));
}

main();
