// test/install.test.mjs — PowerShell 7 asset parsing, archive layout, download/abort behavior,
// install flows and the ensurePwsh orchestrator.
// Run with: node --test test/install.test.mjs
// Network tests are skipped unless DSH_PWSH7_NETWORK_TESTS=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  PWSH_API_LATEST,
  PWSH_RELEASES_PAGE,
  WINGET_PWSH_ID,
  selectPwsh7Asset,
  parsePwsh7ZipName,
  detectSingleTopLevelDirectory,
  verifyArchiveMagic,
  downloadFile,
  resolveTarPath,
  extractArchiveWithLayout,
  wingetAvailable,
  resolveWingetPath,
  wingetInstallArgs,
  wingetInstallManualCommand,
  looksLikeElevationRequired,
  manualInstallInstructions,
  resolvePwsh7Release,
  ensurePwsh,
  installPowerShell7,
  throwIfAborted,
} from '../lib/install.mjs';

import { readRouterConfig } from '../lib/paths.mjs';

const W = path.win32;
const NETWORK = process.env.DSH_PWSH7_NETWORK_TESTS === '1';
const REAL_TAR = 'C:\\Windows\\System32\\tar.exe';

function makeTemp(t, prefix = 'dsh-install') {
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
    PATH: W.join(base, 'bin'),
  };
}

function streamedResponse(buffer, total = buffer.length) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    },
  });
  const headers = new Headers({ 'content-length': String(total) });
  return new Response(stream, { status: 200, headers });
}

/**
 * A Response whose body emits one chunk and then stays open forever, plus a `fail()` helper that
 * errors the stream (mimicking what Node's fetch does to the body when its AbortSignal aborts).
 */
function hangingResponse() {
  let streamController;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(Buffer.from('x'.repeat(1024)));
      },
    }),
    { status: 200 },
  );
  return {
    response,
    fail(error) {
      try {
        streamController?.error(error);
      } catch {
        // already errored/closed
      }
    },
  };
}

function abortErrorForTest() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PWSH_RELEASE_FIXTURE = {
  tag_name: 'v7.6.7',
  assets: [
    {
      name: 'PowerShell-7.6.7-win-x64.msi',
      browser_download_url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.7/PowerShell-7.6.7-win-x64.msi',
      size: 1,
    },
    {
      name: 'PowerShell-7.6.7-win-x86.zip',
      browser_download_url: 'https://example.invalid/x86.zip',
      size: 2,
    },
    {
      name: 'PowerShell-7.6.7-win-arm64.zip',
      browser_download_url: 'https://example.invalid/arm64.zip',
      size: 3,
    },
    {
      name: 'PowerShell-7.6.7-win-fxdependent.zip',
      browser_download_url: 'https://example.invalid/fxdependent.zip',
      size: 4,
    },
    {
      name: 'PowerShell-7.6.7-win-x64.zip',
      browser_download_url: 'https://example.invalid/PowerShell-7.6.7-win-x64.zip',
      size: 106364316,
    },
  ],
};

const PWSH7_ZIP_URL = 'https://example.invalid/PowerShell-7.6.7-win-x64.zip';
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const FIVE_MB = 5 * 1024 * 1024;

function fakeArchive(magic) {
  const buffer = Buffer.alloc(FIVE_MB + magic.length);
  magic.copy(buffer, 0);
  return buffer;
}

// ---------------------------------------------------------------------------
// Asset name parsing
// ---------------------------------------------------------------------------

test('parsePwsh7ZipName parses portable zip names', () => {
  assert.deepEqual(parsePwsh7ZipName('PowerShell-7.6.7-win-x64.zip'), { version: '7.6.7' });
  assert.deepEqual(parsePwsh7ZipName('powershell-7.6.7-win-x64.zip'), { version: '7.6.7' });
  assert.equal(parsePwsh7ZipName('PowerShell-7.6.7-win-x64.msi'), undefined);
  assert.equal(parsePwsh7ZipName('PowerShell-7.6.7-win-arm64.zip'), undefined);
  assert.equal(parsePwsh7ZipName(''), undefined);
});

test('selectPwsh7Asset picks the win-x64 portable zip from a release', () => {
  const asset = selectPwsh7Asset(PWSH_RELEASE_FIXTURE);
  assert.ok(asset);
  assert.equal(asset.tag, 'v7.6.7');
  assert.equal(asset.version, '7.6.7');
  assert.equal(asset.name, 'PowerShell-7.6.7-win-x64.zip');
  assert.equal(asset.url, PWSH7_ZIP_URL);
  assert.equal(asset.size, 106364316);
  assert.equal(selectPwsh7Asset({ tag_name: 'v7.6.7', assets: [] }), undefined);
  assert.equal(selectPwsh7Asset(null), undefined);
  assert.equal(selectPwsh7Asset({ assets: [{ name: 'PowerShell-7.6.7-win-x64.msi' }] }), undefined);
});

// ---------------------------------------------------------------------------
// Archive layout detection / magic
// ---------------------------------------------------------------------------

test('detectSingleTopLevelDirectory detects wrapper dirs and flat layouts', () => {
  assert.equal(detectSingleTopLevelDirectory(['wrapper/', 'wrapper/usr/bin/tool.exe']), 'wrapper');
  assert.equal(detectSingleTopLevelDirectory(['wrapper/usr/bin/tool.exe']), 'wrapper');
  assert.equal(detectSingleTopLevelDirectory(['./wrapper/']), 'wrapper');
  assert.equal(detectSingleTopLevelDirectory(['wrapper\\usr\\bin\\tool.exe']), 'wrapper');
  // flat archive (PowerShell portable zip) — files at the archive root
  assert.equal(detectSingleTopLevelDirectory(['pwsh.exe', 'pwsh.dll', 'ref/']), undefined);
  // multiple top-level entries — no wrapper to strip
  assert.equal(detectSingleTopLevelDirectory(['a/x', 'b/y']), undefined);
  assert.equal(detectSingleTopLevelDirectory([]), undefined);
  assert.equal(detectSingleTopLevelDirectory(['']), undefined);
});

test('verifyArchiveMagic accepts a valid zip header and rejects garbage', (t) => {
  const base = makeTemp(t);
  const zip = W.join(base, 'a.zip');
  const bad = W.join(base, 'c.bin');
  fs.writeFileSync(zip, Buffer.concat([ZIP_MAGIC, Buffer.from('payload')]));
  fs.writeFileSync(bad, Buffer.from('GIF89a'));

  assert.equal(verifyArchiveMagic(zip, 'zip'), undefined);
  assert.throws(() => verifyArchiveMagic(bad, 'zip'), /unexpected signature/);
  assert.throws(() => verifyArchiveMagic(zip, 'rar'), /unknown archive kind/);
  assert.throws(() => verifyArchiveMagic(W.join(base, 'missing.zip'), 'zip'));
});

// ---------------------------------------------------------------------------
// Download behavior
// ---------------------------------------------------------------------------

test('downloadFile streams to disk and reports (bytes, totalBytes) progress', async (t) => {
  const base = makeTemp(t);
  const destination = W.join(base, 'nested', 'file.bin');
  const chunks = [Buffer.from('aaaa'), Buffer.from('bbbb'), Buffer.from('cccc')];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-length': String(total) } },
    );
  const progress = [];
  const result = await downloadFile('https://example.invalid/file.bin', destination, {
    fetchImpl,
    onProgress: (bytes, totalBytes) => progress.push([bytes, totalBytes]),
  });
  assert.equal(result.bytes, 12);
  assert.equal(result.totalBytes, 12);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'aaaabbbbcccc');
  assert.deepEqual(progress, [
    [4, 12],
    [8, 12],
    [12, 12],
  ]);
});

test('downloadFile rejects non-OK responses and removes partial files', async (t) => {
  const base = makeTemp(t);
  const destination = W.join(base, 'file.bin');
  const fetchImpl = async () => new Response('nope', { status: 404 });
  await assert.rejects(
    downloadFile('https://example.invalid/missing', destination, { fetchImpl }),
    /HTTP 404/,
  );
  assert.equal(fs.existsSync(destination), false);
});

test('downloadFile honors a pre-aborted signal', async (t) => {
  const base = makeTemp(t);
  const destination = W.join(base, 'file.bin');
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    downloadFile('https://example.invalid/file.bin', destination, {
      fetchImpl: async () => {
        called = true;
        return new Response('x', { status: 200 });
      },
      signal: controller.signal,
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(called, false, 'fetch must not be called once aborted');
  assert.equal(fs.existsSync(destination), false);
});

test('downloadFile aborts mid-stream and cleans up', async (t) => {
  const base = makeTemp(t);
  const destination = W.join(base, 'file.bin');
  const controller = new AbortController();
  const hanging = hangingResponse();
  const fetchImpl = async () => hanging.response;
  await assert.rejects(
    downloadFile('https://example.invalid/file.bin', destination, {
      fetchImpl,
      signal: controller.signal,
      onProgress: () => {
        controller.abort();
        hanging.fail(abortErrorForTest());
      },
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(fs.existsSync(destination), false);
});

test('downloadFile rejects downloads smaller than the sanity threshold', async (t) => {
  const base = makeTemp(t);
  const destination = W.join(base, 'tiny.bin');
  await assert.rejects(
    downloadFile('https://example.invalid/tiny', destination, {
      fetchImpl: async () => new Response('tiny', { status: 200 }),
      minBytes: 1024,
    }),
    /download too small/,
  );
  assert.equal(fs.existsSync(destination), false);
});

test('a throwing progress callback does not fail the download', async (t) => {
  const base = makeTemp(t);
  const destination = W.join(base, 'file.bin');
  const fetchImpl = async () => new Response('payload', { status: 200 });
  await downloadFile('https://example.invalid/file.bin', destination, {
    fetchImpl,
    onProgress: () => {
      throw new Error('progress explode');
    },
  });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'payload');
});

test('throwIfAborted throws an AbortError only when aborted', () => {
  assert.equal(throwIfAborted(undefined), undefined);
  assert.equal(throwIfAborted(new AbortController().signal), undefined);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => throwIfAborted(controller.signal), (error) => error.name === 'AbortError');
});

// ---------------------------------------------------------------------------
// tar resolution + real extraction (hermetic: archives created with bsdtar)
// ---------------------------------------------------------------------------

test('resolveTarPath prefers the system32 bsdtar and honors an override', (t) => {
  const base = makeTemp(t);
  const systemRoot = W.join(base, 'Windows');
  const systemTar = W.join(systemRoot, 'System32', 'tar.exe');
  writeFile(systemTar, 'fake tar');
  const env = { SystemRoot: systemRoot, PATH: '' };
  assert.equal(resolveTarPath(env), W.normalize(systemTar));

  const override = W.join(base, 'custom-tar.exe');
  writeFile(override, 'custom');
  assert.equal(resolveTarPath({ ...env, DSH_PWSH7_TAR: override }), W.normalize(override));
  assert.equal(resolveTarPath({ SystemRoot: W.join(base, 'nope'), PATH: '' }), 'tar.exe');
});

test(
  'extractArchiveWithLayout strips a real wrapper directory',
  { skip: !fs.existsSync(REAL_TAR) },
  async (t) => {
    const base = makeTemp(t);
    const source = W.join(base, 'src');
    writeFile(W.join(source, 'wrapper', 'usr', 'bin', 'tool.exe'), 'fake tool');
    const archive = W.join(base, 'wrapper.tar');
    const created = spawnSync(REAL_TAR, ['-cf', archive, '-C', source, 'wrapper']);
    assert.equal(created.status, 0, String(created.stderr));

    const destination = W.join(base, 'dest');
    const layout = await extractArchiveWithLayout(REAL_TAR, archive, destination, {});
    assert.equal(layout.topLevelDirectory, 'wrapper');
    assert.ok(fs.existsSync(W.join(destination, 'usr', 'bin', 'tool.exe')));
    // no nested wrapper left behind
    assert.equal(fs.existsSync(W.join(destination, 'wrapper')), false);
  },
);

test(
  'extractArchiveWithLayout keeps flat archives flat (portable zip layout)',
  { skip: !fs.existsSync(REAL_TAR) },
  async (t) => {
    const base = makeTemp(t);
    const source = W.join(base, 'src');
    writeFile(W.join(source, 'pwsh.exe'), 'fake pwsh');
    writeFile(W.join(source, 'pwsh.dll'), 'fake dll');
    const archive = W.join(base, 'flat.tar');
    const created = spawnSync(REAL_TAR, ['-cf', archive, '-C', source, 'pwsh.exe', 'pwsh.dll']);
    assert.equal(created.status, 0, String(created.stderr));

    const destination = W.join(base, 'dest');
    const layout = await extractArchiveWithLayout(REAL_TAR, archive, destination, {});
    assert.equal(layout.topLevelDirectory, undefined);
    assert.ok(fs.existsSync(W.join(destination, 'pwsh.exe')));
    assert.ok(fs.existsSync(W.join(destination, 'pwsh.dll')));
  },
);

// ---------------------------------------------------------------------------
// winget helpers
// ---------------------------------------------------------------------------

test('wingetAvailable / resolveWingetPath scan PATH and the WindowsApps alias', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  assert.equal(wingetAvailable(env), false);
  assert.equal(resolveWingetPath(env), undefined);

  const bin = W.join(base, 'winget-bin');
  const winget = W.join(bin, 'winget.exe');
  writeFile(winget, 'fake winget');
  assert.equal(wingetAvailable({ ...env, PATH: bin }), true);
  assert.equal(resolveWingetPath({ ...env, PATH: bin }), W.normalize(winget));

  const appsAlias = W.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe');
  writeFile(appsAlias, 'alias');
  assert.equal(wingetAvailable({ ...env, PATH: '' }), true);
});

test('winget install args and manual commands match the documentation', () => {
  const args = wingetInstallArgs();
  assert.deepEqual(args.slice(0, 6), [
    'install',
    '--id',
    WINGET_PWSH_ID,
    '-e',
    '--silent',
    '--accept-package-agreements',
  ]);
  assert.ok(args.includes('--accept-source-agreements'));
  assert.equal(wingetInstallManualCommand(), `winget install --id ${WINGET_PWSH_ID} -e --silent --accept-package-agreements --accept-source-agreements`);
  assert.match(manualInstallInstructions(), /PowerShell\/PowerShell\/releases/);
  // the pwsh-only installer rejects other component names instead of silently guessing
  assert.throws(() => wingetInstallArgs('other'), TypeError);
});

test('looksLikeElevationRequired detects common winget/UAC output', () => {
  assert.equal(
    looksLikeElevationRequired('This package requires administrator privileges.'),
    true,
  );
  assert.equal(looksLikeElevationRequired('Requested operation requires elevation'), true);
  assert.equal(looksLikeElevationRequired('error 0x800704c7'), true);
  assert.equal(looksLikeElevationRequired('需要管理员权限'), true);
  assert.equal(looksLikeElevationRequired('Successfully installed'), false);
  assert.equal(looksLikeElevationRequired(''), false);
});

// ---------------------------------------------------------------------------
// Release resolution with injected fetch (no network)
// ---------------------------------------------------------------------------

test('resolvePwsh7Release uses the GitHub API asset URL', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, headers: options?.headers });
    return jsonResponse(PWSH_RELEASE_FIXTURE);
  };
  const asset = await resolvePwsh7Release({ fetchImpl });
  assert.equal(asset.url, PWSH7_ZIP_URL);
  assert.equal(asset.version, '7.6.7');
  assert.equal(seen[0].url, PWSH_API_LATEST);
  assert.equal(seen[0].headers['User-Agent'], 'dsh-plugin-pwsh7');
});

test('resolvePwsh7Release falls back to the release page redirect when the API fails', async () => {
  const fetchImpl = async (url) => {
    if (url === PWSH_API_LATEST) throw new Error('rate limited');
    if (url === PWSH_RELEASES_PAGE) {
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://github.com/PowerShell/PowerShell/releases/tag/v7.6.7',
        },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const asset = await resolvePwsh7Release({ fetchImpl });
  assert.equal(asset.version, '7.6.7');
  assert.equal(
    asset.url,
    'https://github.com/PowerShell/PowerShell/releases/download/v7.6.7/PowerShell-7.6.7-win-x64.zip',
  );
});

test('resolvePwsh7Release aborts cleanly', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    resolvePwsh7Release({
      signal: controller.signal,
      fetchImpl: async () => jsonResponse(PWSH_RELEASE_FIXTURE),
    }),
    (error) => error.name === 'AbortError',
  );
});

// ---------------------------------------------------------------------------
// Install flows with injected download/extract/probe (hermetic)
// ---------------------------------------------------------------------------

function fakeExtractForPowerShell(targets) {
  return async (_tarPath, archivePath, destination) => {
    assert.ok(fs.existsSync(archivePath), 'archive should exist while extracting');
    targets.push(destination);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(W.join(destination, 'pwsh.exe'), 'fake pwsh', 'utf8');
  };
}

test('installPowerShell7 portable flow downloads, extracts, verifies, writes config', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = W.join(base, 'router');
  const extracted = [];
  const progress = [];
  const fetchImpl = async (url) => {
    if (url === PWSH_API_LATEST) return jsonResponse(PWSH_RELEASE_FIXTURE);
    if (url === PWSH7_ZIP_URL) return streamedResponse(fakeArchive(ZIP_MAGIC));
    throw new Error(`unexpected URL ${url}`);
  };
  const probePwshImpl = async (pwshPath) => {
    assert.ok(pwshPath.endsWith('pwsh.exe'));
    return { ok: true, version: '7.6.7', output: '7.6.7' };
  };

  const result = await installPowerShell7({
    updatePath: async () => {},
    env,
    root,
    force: true,
    fetchImpl,
    tarPath: REAL_TAR,
    extractImpl: fakeExtractForPowerShell(extracted),
    probePwsh: probePwshImpl,
    onProgress: (bytes) => progress.push(bytes),
  });

  assert.equal(result.ok, true);
  assert.equal(result.component, 'pwsh');
  assert.equal(result.method, 'portable');
  assert.equal(result.version, '7.6.7');
  assert.equal(result.path, W.join(root, 'powershell7', '7.6.7', 'pwsh.exe'));
  assert.ok(fs.existsSync(result.path));
  assert.equal(result.url, PWSH7_ZIP_URL);
  assert.ok(result.bytes >= FIVE_MB);
  assert.equal(typeof result.durationMs, 'number');
  assert.equal(extracted[0], W.join(root, 'powershell7', '7.6.7'));
  assert.ok(progress.length > 0);
  assert.ok(progress[progress.length - 1] >= FIVE_MB);

  const config = readRouterConfig(env);
  assert.equal(config.pwshPath, result.path);
  assert.equal(config.installed.pwsh.method, 'portable');
  assert.equal(config.installed.pwsh.version, '7.6.7');

  // downloaded archive removed from <root>\tmp
  const tmpDir = W.join(root, 'tmp');
  const leftovers = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
  assert.deepEqual(leftovers, []);
});

test('installPowerShell7 rejects an archive with a bad signature', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = W.join(base, 'router');
  const fetchImpl = async (url) => {
    if (url === PWSH_API_LATEST) return jsonResponse(PWSH_RELEASE_FIXTURE);
    if (url === PWSH7_ZIP_URL) return streamedResponse(fakeArchive(Buffer.from('GIF8')));
    throw new Error(`unexpected URL ${url}`);
  };
  const result = await installPowerShell7({
    updatePath: async () => {},
    env,
    root,
    method: 'portable',
    force: true,
    fetchImpl,
    tarPath: REAL_TAR,
    extractImpl: async () => {
      throw new Error('extract must not run');
    },
    probePwsh: async () => ({ ok: true, version: '7.6.7' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /unexpected signature/);
  assert.equal(readRouterConfig(env), undefined);
});

test('installPowerShell7 auto fallback reports unavailable winget without hanging', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = W.join(base, 'router');
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const result = await installPowerShell7({
    updatePath: async () => {},
    env,
    root,
    method: 'auto',
    force: true,
    fetchImpl,
    tarPath: REAL_TAR,
    probePwsh: async () => ({ ok: false }),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /winget is not available/i);
  assert.match(result.message, /github\.com\/PowerShell\/PowerShell/i);
});

test('installPowerShell7 aborts during download', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = W.join(base, 'router');
  const controller = new AbortController();
  const hanging = hangingResponse();
  const fetchImpl = async (url) => {
    if (url === PWSH_API_LATEST) return jsonResponse(PWSH_RELEASE_FIXTURE);
    return hanging.response;
  };
  await assert.rejects(
    installPowerShell7({
      env,
      root,
      force: true,
      fetchImpl,
      signal: controller.signal,
      onProgress: () => {
        controller.abort();
        hanging.fail(abortErrorForTest());
      },
      tarPath: REAL_TAR,
      probePwsh: async () => ({ ok: true, version: '7.6.7' }),
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(readRouterConfig(env), undefined);
});

test('installPowerShell7 reuses an existing PowerShell 7 install (method existing)', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = W.join(base, 'router');
  const existing = W.join(env.LOCALAPPDATA, 'Programs', 'PowerShell', '7', 'pwsh.exe');
  writeFile(existing, 'fake');
  const result = await installPowerShell7({
    updatePath: async () => {},
    env,
    root,
    probePwsh: async () => ({ ok: true, version: '7.6.7', output: '7.6.7' }),
    fetchImpl: async () => {
      throw new Error('must not download when an existing install works');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'existing');
  assert.equal(result.path, W.normalize(existing));
  assert.equal(readRouterConfig(env).pwshPath, W.normalize(existing));
});

// ---------------------------------------------------------------------------
// ensurePwsh orchestrator
// ---------------------------------------------------------------------------

test('ensurePwsh returns { ok, result, notes, aborted } on a portable install', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = W.join(base, 'router');
  const fetchImpl = async (url) => {
    if (url === PWSH_API_LATEST) return jsonResponse(PWSH_RELEASE_FIXTURE);
    if (url === PWSH7_ZIP_URL) return streamedResponse(fakeArchive(ZIP_MAGIC));
    throw new Error(`unexpected URL ${url}`);
  };
  const outcome = await ensurePwsh({
    updatePath: async () => {},
    env,
    root,
    method: 'auto',
    force: true,
    fetchImpl,
    tarPath: REAL_TAR,
    extractImpl: fakeExtractForPowerShell([]),
    probePwsh: async () => ({ ok: true, version: '7.6.7', output: '7.6.7' }),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.result.component, 'pwsh');
  assert.equal(outcome.result.method, 'portable');
  assert.equal(outcome.result.version, '7.6.7');
  assert.ok(Array.isArray(outcome.notes));
  assert.ok(outcome.notes.some((note) => note.includes('pwsh: installing')));
  assert.ok(outcome.notes.some((note) => note.includes('pwsh: ok')));
});

test('ensurePwsh reports an aborted signal without installing', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = W.join(base, 'router');
  const controller = new AbortController();
  controller.abort();
  const outcome = await ensurePwsh({
    updatePath: async () => {},
    env,
    root,
    signal: controller.signal,
    fetchImpl: async () => {
      throw new Error('fetch must not run');
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, true);
  assert.equal(outcome.result.ok, false);
  assert.match(outcome.result.message, /aborted/);
  assert.deepEqual(outcome.notes, ['pwsh: aborted']);
});

test('ensurePwsh surfaces a failed install result and notes', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = W.join(base, 'router');
  const outcome = await ensurePwsh({
    updatePath: async () => {},
    env,
    root,
    method: 'auto',
    force: true,
    fetchImpl: async () => {
      throw new Error('network down');
    },
    tarPath: REAL_TAR,
    probePwsh: async () => ({ ok: false }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.result.ok, false);
  assert.ok(outcome.notes.some((note) => note.includes('pwsh: failed')));
});

test('ensurePwsh validates the method', async (t) => {
  const base = makeTemp(t);
  await assert.rejects(
    ensurePwsh({ env: makeEnv(base), root: W.join(base, 'router'), method: 'bogus' }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// Network tests (opt-in: DSH_PWSH7_NETWORK_TESTS=1)
// ---------------------------------------------------------------------------

test(
  'network: latest PowerShell 7 release resolves to a downloadable win-x64 zip',
  { skip: !NETWORK, timeout: 120_000 },
  async () => {
    const asset = await resolvePwsh7Release({});
    assert.match(asset.name, /^PowerShell-.+-win-x64\.zip$/);
    assert.match(
      asset.url,
      /^https:\/\/github\.com\/PowerShell\/PowerShell\/releases\/download\/v\d/,
    );
    assert.equal(asset.version, asset.tag.replace(/^v/i, ''));
    const response = await fetch(asset.url, { method: 'HEAD', redirect: 'follow' });
    assert.equal(response.status, 200);
    const length = Number(response.headers.get('content-length'));
    assert.ok(Number.isFinite(length) && length > 1024 * 1024, 'asset should be >1 MiB');
  },
);

for (const scope of ['user', 'system']) {
  test(`${scope} portable install writes the matching PATH before recording success`, async (t) => {
    const base = makeTemp(t);
    const env = makeEnv(base);
    const root = W.join(base, 'router');
    let updated;
    const result = await installPowerShell7({
      env, root, scope, force: true, method: 'portable',
      requireAdministrator: async () => {},
      updatePath: async (executable, options) => { updated = { executable, scope: options.scope }; },
      fetchImpl: async (url) => url === PWSH_API_LATEST
        ? jsonResponse(PWSH_RELEASE_FIXTURE) : streamedResponse(fakeArchive(ZIP_MAGIC)),
      tarPath: REAL_TAR,
      extractImpl: fakeExtractForPowerShell([]),
      probePwsh: async () => ({ ok: true, version: '7.6.7' }),
    });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.scope, scope);
    assert.deepEqual(updated, { executable: result.path, scope });
    assert.equal(readRouterConfig(env).installed.pwsh.scope, scope);
    if (scope === 'system') assert.equal(result.path, W.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'));
  });
}

test('PATH failure does not report success or trigger a winget fallback', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const result = await installPowerShell7({
    env, root: W.join(base, 'router'), force: true,
    updatePath: async () => { throw new Error('PATH access denied'); },
    fetchImpl: async (url) => url === PWSH_API_LATEST
      ? jsonResponse(PWSH_RELEASE_FIXTURE) : streamedResponse(fakeArchive(ZIP_MAGIC)),
    tarPath: REAL_TAR,
    extractImpl: fakeExtractForPowerShell([]),
    probePwsh: async () => ({ ok: true, version: '7.6.7' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.message, 'PATH access denied');
  assert.equal(readRouterConfig(env), undefined);
});
