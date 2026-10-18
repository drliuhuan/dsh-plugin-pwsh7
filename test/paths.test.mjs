// test/paths.test.mjs — PowerShell 7 detection order, config IO, version parsing, probes.
// Run with: node --test test/paths.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ROUTER_DIR_NAME,
  DSH_DIR_NAME,
  CONFIG_FILE_NAME,
  routerRoot,
  configFile,
  candidatePwshPaths,
  discoveredPortablePwshPaths,
  fileOrSymlinkExists,
  findPwsh,
  isPowerShell7,
  probePwsh,
  readRouterConfig,
  writeRouterConfig,
  parsePwshMajor,
  parsePwshVersion,
} from '../lib/paths.mjs';

const W = path.win32;

function makeTemp(t, prefix = 'dsh-paths') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFile(file, contents = '') {
  fs.mkdirSync(W.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

function makeEnv(base) {
  return {
    LOCALAPPDATA: W.join(base, 'localappdata'),
    USERPROFILE: W.join(base, 'user'),
    ProgramFiles: W.join(base, 'Program Files'),
    'ProgramFiles(x86)': W.join(base, 'Program Files (x86)'),
    PATH: [W.join(base, 'bin'), W.join(base, 'tools')].join(';'),
  };
}

// ---------------------------------------------------------------------------
// Path and config location
// ---------------------------------------------------------------------------

test('routerRoot / configFile use %LOCALAPPDATA%\\dsh\\pwsh7', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  assert.equal(routerRoot(env), W.join(base, 'localappdata', DSH_DIR_NAME, ROUTER_DIR_NAME));
  assert.equal(
    configFile(env),
    W.join(base, 'localappdata', DSH_DIR_NAME, ROUTER_DIR_NAME, CONFIG_FILE_NAME),
  );
});

test('routerRoot falls back to USERPROFILE when LOCALAPPDATA is missing', (t) => {
  const base = makeTemp(t);
  const env = { USERPROFILE: W.join(base, 'user') };
  assert.equal(routerRoot(env), W.join(base, 'user', 'AppData', 'Local', 'dsh', ROUTER_DIR_NAME));
});

test('path constants are the contract values', () => {
  assert.equal(ROUTER_DIR_NAME, 'pwsh7');
  assert.equal(DSH_DIR_NAME, 'dsh');
  assert.equal(CONFIG_FILE_NAME, 'config.json');
});

// ---------------------------------------------------------------------------
// Candidate list order
// ---------------------------------------------------------------------------

test('candidatePwshPaths keeps the contract order', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  env.DSH_PWSH_PATH = W.join(base, 'env-pwsh.exe');
  writeRouterConfig({ version: 1, pwshPath: W.join(base, 'config-pwsh.exe') }, env);

  const paths = candidatePwshPaths(env);
  assert.equal(paths[0], W.join(base, 'env-pwsh.exe'));
  assert.equal(paths[1], W.join(base, 'config-pwsh.exe'));
  assert.equal(paths[2], W.join(base, 'Program Files', 'PowerShell', '7', 'pwsh.exe'));
  assert.equal(paths[3], W.join(routerRoot(env), 'powershell7', 'pwsh.exe'));
  assert.equal(
    paths[4],
    W.join(base, 'localappdata', 'Programs', 'PowerShell', '7', 'pwsh.exe'),
  );
  assert.ok(paths.includes(W.join(base, 'bin', 'pwsh.exe')));
  assert.ok(paths.includes(W.join(base, 'tools', 'pwsh.exe')));
  assert.ok(
    paths.indexOf(W.join(base, 'localappdata', 'Microsoft', 'WindowsApps', 'pwsh.exe')) >
      paths.indexOf(W.join(base, 'tools', 'pwsh.exe')),
  );
  assert.ok(
    paths.includes(W.join(base, 'Program Files (x86)', 'PowerShell', '7', 'pwsh.exe')),
  );
  // de-duplicated case-insensitively
  assert.equal(
    new Set(paths.map((entry) => entry.toLowerCase())).size,
    paths.length,
  );
});

// ---------------------------------------------------------------------------
// Detection order (first existing wins)
// ---------------------------------------------------------------------------

test('findPwsh resolves DSH_PWSH_PATH > config > ProgramFiles > PATH', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const envPwsh = W.join(base, 'env', 'pwsh.exe');
  const configPwsh = W.join(base, 'config', 'pwsh.exe');
  const programFilesPwsh = W.join(base, 'Program Files', 'PowerShell', '7', 'pwsh.exe');
  const pathPwsh = W.join(base, 'bin', 'pwsh.exe');
  env.DSH_PWSH_PATH = envPwsh;
  writeRouterConfig({ version: 1, pwshPath: configPwsh }, env);
  for (const file of [envPwsh, configPwsh, programFilesPwsh, pathPwsh]) writeFile(file, 'fake');

  assert.equal(findPwsh({ env }).path, envPwsh);
  fs.rmSync(envPwsh);
  assert.equal(findPwsh({ env }).path, configPwsh);
  fs.rmSync(configPwsh);
  assert.equal(findPwsh({ env }).path, W.normalize(programFilesPwsh));
  fs.rmSync(programFilesPwsh);
  assert.equal(findPwsh({ env }).path, W.normalize(pathPwsh));
});

test('findPwsh returns undefined for an environment with no pwsh', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  assert.equal(findPwsh({ env }), undefined);
});

test('findPwsh accepts a symlink/alias-like entry and rejects a directory', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const directoryCandidate = W.join(base, 'Program Files', 'PowerShell', '7', 'pwsh.exe');
  fs.mkdirSync(directoryCandidate, { recursive: true });
  assert.equal(fileOrSymlinkExists(directoryCandidate), false);
  assert.equal(fileOrSymlinkExists(W.join(base, 'missing.exe')), false);
  assert.equal(fileOrSymlinkExists(''), false);

  const realFile = W.join(base, 'real.exe');
  writeFile(realFile, 'x');
  assert.equal(fileOrSymlinkExists(realFile), true);
});

test('versioned portable pwsh installs are discovered newest first', { skip: process.platform !== 'win32' && 'Requires Windows filesystem separators' }, (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const baseDir = W.join(routerRoot(env), 'powershell7');
  for (const version of ['7.6.7', '7.6.10', '7.5.4']) {
    writeFile(W.join(baseDir, version, 'pwsh.exe'), 'fake');
  }
  const discovered = discoveredPortablePwshPaths(env);
  assert.equal(discovered[0], W.join(baseDir, '7.6.10', 'pwsh.exe'));
  assert.equal(discovered[1], W.join(baseDir, '7.6.7', 'pwsh.exe'));
  assert.equal(discovered[2], W.join(baseDir, '7.5.4', 'pwsh.exe'));
  assert.ok(candidatePwshPaths(env).includes(discovered[0]));
});

// ---------------------------------------------------------------------------
// Config read/write
// ---------------------------------------------------------------------------

test('writeRouterConfig/readRouterConfig round-trip inside the router root', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const config = {
    version: 1,
    pwshPath: 'D:\\tools\\pwsh.exe',
    installed: {
      pwsh: {
        path: 'D:\\tools\\pwsh.exe',
        version: '7.6.7',
        method: 'portable',
        at: '2026-01-01T00:00:00.000Z',
      },
    },
  };
  writeRouterConfig(config, env);

  const stored = readRouterConfig(env);
  assert.equal(stored.version, 1);
  assert.equal(stored.pwshPath, config.pwshPath);
  assert.deepEqual(stored.installed, config.installed);
  assert.match(stored.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const raw = fs.readFileSync(configFile(env), 'utf8');
  assert.match(raw, /"version": 1/);
  // no temp files left behind
  const leftovers = fs
    .readdirSync(W.join(env.LOCALAPPDATA, DSH_DIR_NAME, ROUTER_DIR_NAME))
    .filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeRouterConfig adds version 1 when missing and updatedAt always', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  writeRouterConfig({ pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }, env);
  const stored = readRouterConfig(env);
  assert.equal(stored.version, 1);
  assert.ok(stored.updatedAt);
});

test('readRouterConfig returns undefined for missing or invalid config', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  assert.equal(readRouterConfig(env), undefined);

  fs.mkdirSync(W.dirname(configFile(env)), { recursive: true });
  fs.writeFileSync(configFile(env), '{ not json', 'utf8');
  assert.equal(readRouterConfig(env), undefined);

  fs.writeFileSync(configFile(env), '[]', 'utf8');
  assert.equal(readRouterConfig(env), undefined);
});

test('readRouterConfig tolerates unknown keys from older configs', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const config = {
    version: 1,
    pwshPath: 'D:\\tools\\pwsh.exe',
    legacyNote: 'ignored',
    installed: { pwsh: { path: 'D:\\tools\\pwsh.exe', method: 'existing' } },
  };
  writeRouterConfig(config, env);
  const stored = readRouterConfig(env);
  assert.equal(stored.pwshPath, config.pwshPath);
  assert.equal(stored.legacyNote, 'ignored');
  assert.equal(candidatePwshPaths(env)[0], 'D:\\tools\\pwsh.exe');
});

test('writeRouterConfig rejects non-object configs', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  assert.throws(() => writeRouterConfig(null, env), TypeError);
  assert.throws(() => writeRouterConfig([], env), TypeError);
  assert.throws(() => writeRouterConfig('nope', env), TypeError);
});

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

test('parsePwshMajor parses probe output shapes', () => {
  assert.equal(parsePwshMajor('7'), 7);
  assert.equal(parsePwshMajor('7\r\n'), 7);
  assert.equal(parsePwshMajor(' 7 \n'), 7);
  assert.equal(parsePwshMajor('7.6.7'), 7);
  assert.equal(parsePwshMajor('PowerShell 7.6.7\n'), 7);
  assert.equal(parsePwshMajor('5'), 5);
  assert.equal(parsePwshMajor(''), undefined);
  assert.equal(parsePwshMajor('no version here'), undefined);
});

test('parsePwshVersion parses first version token', () => {
  assert.equal(parsePwshVersion('7.6.7'), '7.6.7');
  assert.equal(parsePwshVersion('7.6.7\r\n'), '7.6.7');
  assert.equal(parsePwshVersion('PowerShell 7.4.0-preview.3'), '7.4.0');
  assert.equal(parsePwshVersion(''), undefined);
});

// ---------------------------------------------------------------------------
// Async probes (injected runner — no real executable needed)
// ---------------------------------------------------------------------------

test('isPowerShell7 accepts major >= 7 and rejects 5.x', async () => {
  const run = async () => ({ ok: true, code: 0, stdout: '7\r\n', stderr: '' });
  assert.equal(await isPowerShell7('C:\\fake\\pwsh.exe', { run }), true);

  const runFive = async () => ({ ok: true, code: 0, stdout: '5\r\n', stderr: '' });
  assert.equal(await isPowerShell7('C:\\fake\\pwsh.exe', { run: runFive }), false);

  const runFail = async () => ({ ok: false, code: 1, stdout: '', stderr: 'boom' });
  assert.equal(await isPowerShell7('C:\\fake\\pwsh.exe', { run: runFail }), false);

  const runThrow = async () => {
    throw new Error('cannot spawn');
  };
  assert.equal(await isPowerShell7('C:\\fake\\pwsh.exe', { run: runThrow }), false);

  assert.equal(await isPowerShell7('', { run }), false);
});

test('probePwsh returns ok/version/output from injected runner', async () => {
  const run = async () => ({ ok: true, code: 0, stdout: '7.6.7\r\n', stderr: '' });
  const probe = await probePwsh('C:\\fake\\pwsh.exe', { run });
  assert.equal(probe.ok, true);
  assert.equal(probe.version, '7.6.7');
  assert.equal(probe.output, '7.6.7');

  const runFive = async () => ({ ok: true, code: 0, stdout: '5.1.22621.1', stderr: '' });
  const probeFive = await probePwsh('C:\\fake\\powershell.exe', { run: runFive });
  assert.equal(probeFive.ok, false);
  assert.equal(probeFive.version, '5.1.22621.1');

  const runFail = async () => ({ ok: false, code: 1, stdout: '', stderr: 'access denied' });
  const probeFail = await probePwsh('C:\\fake\\pwsh.exe', { run: runFail });
  assert.equal(probeFail.ok, false);
  assert.match(probeFail.output, /access denied/);
});

// ---------------------------------------------------------------------------
// Real-machine probe (read-only; skipped when PowerShell 7 is absent)
// ---------------------------------------------------------------------------

const REAL_PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

test('real PowerShell 7 probe reports major >= 7', { skip: !fs.existsSync(REAL_PWSH) }, async () => {
  const probe = await probePwsh(REAL_PWSH);
  assert.equal(probe.ok, true);
  assert.ok(Number(probe.version.split('.')[0]) >= 7);
  assert.equal(await isPowerShell7(REAL_PWSH), true);
});

test('real findPwsh detects the installed PowerShell 7', { skip: !fs.existsSync(REAL_PWSH) }, () => {
  const found = findPwsh({});
  assert.ok(found, 'expected findPwsh to find the installed PowerShell 7');
  assert.ok(fs.existsSync(found.path));
});
