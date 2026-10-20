#!/usr/bin/env node
'use strict';
/**
 * npm run dev   - starts the Python CV service, waits until it answers, then starts the Express web app.
 *                 Output of both is shown in one window with [cv] / [web] prefixes.
 *                 Press Ctrl+C once to stop both. Add --open to open the browser when everything is ready.
 */
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const common = require('./common');

const prefixed = (tag, stream, out) => {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) out.write(`[${tag}] ${line}\n`);
  });
  stream.on('end', () => { if (pending) out.write(`[${tag}] ${pending}\n`); });
};

function waitForHealth(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null || child.signalCode !== null) return reject(new Error('The CV service stopped before it became ready (see the [cv] lines above).'));
      const req = http.get(url, { timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error(`The CV service did not answer on ${url} within ${Math.round(timeoutMs / 1000)} s.`));
      setTimeout(attempt, 400);
    };
    attempt();
  });
}

function openBrowser(url) {
  const [cmd, args] = common.IS_WIN ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch { /* the URL is printed anyway */ }
}

async function main() {
  common.assertNodeVersion();
  common.loadEnv();
  const py = common.requirePython();
  const { host, port } = common.cvSettings();

  if (await common.isPortInUse(port, host)) {
    common.fail(
      `Port ${port} (CV service) is already in use - a DocuVision service may still be running from an earlier session.\n`
      + `Close that window, or free the port (PowerShell):\n  Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`,
    );
  }
  const webPort = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
  const webHost = process.env.HOST || '127.0.0.1';
  if (await common.isPortInUse(webPort, webHost === '0.0.0.0' ? '127.0.0.1' : webHost)) {
    common.fail(`Port ${webPort} (web app) is already in use. Close the other program or change PORT in .env.`);
  }

  const children = [];
  let stopping = false;
  const stopAll = (code) => {
    if (stopping) return;
    stopping = true;
    for (const c of children) common.killTree(c);
    setTimeout(() => process.exit(code), 400);
  };
  process.on('SIGINT', () => { console.log('\nStopping DocuVision ...'); stopAll(0); });
  process.on('SIGTERM', () => stopAll(0));
  process.on('exit', () => { for (const c of children) common.killTree(c); });

  console.log(`Starting the CV service (${py.label}) ...`);
  const cv = common.spawnCv(py, ['ignore', 'pipe', 'pipe']);
  children.push(cv);
  prefixed('cv', cv.stdout, process.stdout);
  prefixed('cv', cv.stderr, process.stdout);
  cv.on('error', (err) => { console.error(`Could not start Python: ${err.message}`); stopAll(1); });
  cv.on('exit', (code, signal) => { if (!stopping) { console.error(`[cv] the CV service stopped (${signal || `exit code ${code}`}). Shutting down.`); stopAll(1); } });

  try {
    await waitForHealth(`http://${host}:${port}/health`, cv, 90000);
  } catch (err) {
    console.error(`\n${err.message}`);
    return stopAll(1);
  }
  console.log('CV service is ready. Starting the web app ...');

  const web = spawn(process.execPath, [path.join(common.ROOT, 'backend', 'server.js')], {
    cwd: common.ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: process.env,
  });
  children.push(web);
  prefixed('web', web.stdout, process.stdout);
  prefixed('web', web.stderr, process.stdout);
  web.on('exit', (code, signal) => { if (!stopping) { console.error(`[web] the web app stopped (${signal || `exit code ${code}`}). Shutting down.`); stopAll(code || 1); } });

  const url = `http://${webHost === '0.0.0.0' ? 'localhost' : webHost}:${webPort}`;
  await waitForHealth(`${url.replace('localhost', '127.0.0.1')}/healthz`, web, 30000).then(() => {
    console.log(`\nDocuVision is running at ${url}\nPress Ctrl+C to stop both services.\n`);
    if (process.argv.includes('--open')) openBrowser(url);
  }, (err) => { console.error(`\n${err.message}`); stopAll(1); });
}

main();
