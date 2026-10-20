'use strict';
/**
 * Helpers shared by scripts/dev.js and scripts/start-cv.js: Node version guard, .env loading,
 * Python discovery (virtual environment first), and process-tree shutdown that also works on Windows.
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CV_DIR = path.join(ROOT, 'cv-service');
const IS_WIN = process.platform === 'win32';

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** node:sqlite (used for the database) ships without a flag from Node 22.13. */
function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    fail(`Node.js ${process.versions.node} is too old. DocuVision needs Node.js 22.13 or newer (v26.5.1 recommended): https://nodejs.org/`);
  }
}

/** Creates .env on first run (with generated secrets) and loads it into process.env. Existing variables win. */
function loadEnv() {
  require('./ensure-env').ensureEnv();
  try {
    require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') fail('The Node.js packages are not installed yet. Run:  npm install');
    throw err;
  }
}

function probePython(cmd, args) {
  const r = spawnSync(cmd, [...args, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec((r.stdout || '').trim());
  return m ? { cmd, args, version: m.slice(1).map(Number) } : null;
}

/**
 * Finds a usable Python 3.10+: CV_PYTHON, then the project's .venv, then (Windows) the py launcher
 * preferring 3.12 and 3.11, then python / python3 on PATH. Returns { cmd, args, version, label } or null.
 */
function findPython() {
  const venvPython = IS_WIN ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') : path.join(ROOT, '.venv', 'bin', 'python');
  const candidates = [];
  if (process.env.CV_PYTHON) candidates.push([process.env.CV_PYTHON, [], 'CV_PYTHON']);
  if (fs.existsSync(venvPython)) candidates.push([venvPython, [], '.venv']);
  if (IS_WIN) candidates.push(['py', ['-3.12'], 'py -3.12'], ['py', ['-3.11'], 'py -3.11'], ['py', ['-3'], 'py -3']);
  candidates.push(['python', [], 'python'], ['python3', [], 'python3']);
  for (const [cmd, args, label] of candidates) {
    const found = probePython(cmd, args);
    if (found && found.version[0] === 3 && found.version[1] >= 10) return { ...found, label };
    if (label === 'CV_PYTHON') console.warn(`CV_PYTHON is set to "${cmd}" but that is not a working Python 3.10+; looking elsewhere.`);
  }
  return null;
}

/** Runs cv-service/check_env.py. Returns { status, output }: 0 = ok, 1 = packages missing, 2 = Tesseract needs attention. */
function checkPython(py) {
  const r = spawnSync(py.cmd, [...py.args, path.join(CV_DIR, 'check_env.py')], { encoding: 'utf8', cwd: CV_DIR, timeout: 60000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return { status: r.status === null ? 1 : r.status, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function requirePython({ checkDeps = true } = {}) {
  const py = findPython();
  if (!py) {
    fail(
      'Python 3.11 or 3.12 was not found.\n'
      + '  1. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH").\n'
      + '  2. Run  .\\scripts\\setup.ps1  to create the virtual environment and install the packages.',
    );
  }
  if (checkDeps) {
    const check = checkPython(py);
    if (check.status === 1) {
      console.error(check.output);
      fail(`The Python packages are not installed for ${py.label}. Run  .\\scripts\\setup.ps1  (or: pip install -r cv-service/requirements.txt).`);
    }
    if (check.status === 2) console.warn(`\n${check.output.split('\n').filter((l) => /Tesseract|eng\.traineddata/.test(l)).join('\n')}\n(The service will start; text recognition reports a clear error until this is fixed.)\n`);
  }
  return py;
}

function cvSettings() {
  return {
    host: process.env.CV_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.CV_PORT || '8001', 10) || 8001,
  };
}

/** Starts cv-service/main.py with the inherited environment. `stdio` is passed through to spawn. */
function spawnCv(py, stdio = 'inherit') {
  return spawn(py.cmd, [...py.args, 'main.py'], {
    cwd: CV_DIR,
    stdio,
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });
}

function isPortInUse(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
  });
}

/** Stops a child process and everything it started (the Windows venv launcher starts a second python.exe). */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

module.exports = { ROOT, CV_DIR, IS_WIN, fail, assertNodeVersion, loadEnv, findPython, checkPython, requirePython, cvSettings, spawnCv, isPortInUse, killTree };
