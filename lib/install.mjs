// lib/install.mjs — per-user portable installer for PowerShell 7.
//
// Everything is user-scoped: files land under <routerRoot> (default
// %LOCALAPPDATA%\dsh\pwsh7), downloads under <routerRoot>\tmp, archives are extracted with
// the Windows bsdtar (tar.exe). No administrator rights are ever requested. When a portable
// install is impossible the result carries the exact manual command instead of hanging on UAC.
//
// Public contract:
//   USER_AGENT, PWSH_API_LATEST, PWSH_RELEASES_PAGE, WINGET_PWSH_ID
//   ensurePwsh({ env, root, method, onProgress, signal }) -> { ok, result, notes, aborted }
//     result: { ok, component: 'pwsh', method, path?, version?, message, url?, bytes?,
//               durationMs }
//   installPowerShell7(options) -> Result (same shape as above)
//   resolvePwsh7Release(options) -> { tag, version, name, url, size? }
//   selectPwsh7Asset(release) -> asset descriptor | undefined
//   parsePwsh7ZipName(name) -> { version } | undefined
//   downloadFile(url, destination, options) -> { url, bytes, totalBytes? }
//   listArchiveEntries / extractArchive / extractArchiveWithLayout /
//     detectSingleTopLevelDirectory / verifyArchiveMagic / resolveTarPath
//   resolveWingetPath / wingetAvailable / wingetInstallArgs / wingetInstallManualCommand /
//     manualInstallInstructions / looksLikeElevationRequired / throwIfAborted
//
// Extra pure helpers are internal but exported so test/install.test.mjs can exercise them.
// Only Node builtins and global fetch are used; there are no @deepseek-ai imports.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  routerRoot,
  readRouterConfig,
  writeRouterConfig,
  findPwsh,
  probePwsh,
  fileOrSymlinkExists,
} from './paths.mjs';

const W = path.win32;

export const USER_AGENT = 'dsh-plugin-pwsh7';
export const PWSH_API_LATEST = 'https://api.github.com/repos/PowerShell/PowerShell/releases/latest';
export const PWSH_RELEASES_PAGE = 'https://github.com/PowerShell/PowerShell/releases/latest';
export const WINGET_PWSH_ID = 'Microsoft.PowerShell';

const PWSH7_MIN_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 15 * 60 * 1000;
const WINGET_TIMEOUT_MS = 20 * 60 * 1000;
const LISTING_TIMEOUT_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function abortError(signal) {
  const reason = signal?.reason;
  const error = new Error(
    reason instanceof Error && reason.message ? reason.message : 'operation aborted',
  );
  error.name = 'AbortError';
  return error;
}

function ensureAbortError(error, signal) {
  if (error?.name === 'AbortError') return error;
  if (signal?.aborted) return abortError(signal);
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function tail(text, limit = 600) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  return value.length <= limit ? value : `…${value.slice(-limit)}`;
}

function removeQuietly(target) {
  if (typeof target !== 'string' || !target.trim()) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; never fail an install because of leftover temp files
  }
}

function linkedSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const forward = () => controller.abort(abortError(signal));
  if (signal) {
    if (signal.aborted) controller.abort(abortError(signal));
    else signal.addEventListener('abort', forward, { once: true });
  }
  let timer;
  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(
      () => controller.abort(new Error(`operation timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forward);
    },
  };
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const linked = linkedSignal(options.signal, options.timeoutMs ?? LISTING_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: options.headers ?? {},
      redirect: options.redirect ?? 'follow',
      signal: linked.signal,
    });
    return response;
  } catch (error) {
    throw ensureAbortError(error, options.signal);
  } finally {
    linked.cleanup();
  }
}

function runCommand(file, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      execFile(
        file,
        args,
        {
          timeout: options.timeoutMs ?? EXTRACT_TIMEOUT_MS,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          env: options.env ?? process.env,
          cwd: options.cwd,
          signal: options.signal,
        },
        (error, stdout, stderr) => {
          finish({
            ok: !error,
            code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            error,
          });
        },
      );
    } catch (error) {
      finish({ ok: false, code: 1, stdout: '', stderr: String(error?.message ?? error), error });
    }
  });
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchWithTimeout(fetchImpl, url, options);
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? '?'} for ${url}`);
  return response.json();
}

function headersFor(env, extra = {}) {
  return { 'User-Agent': USER_AGENT, ...extra };
}

// ---------------------------------------------------------------------------
// Config persistence (inside the router root only)
// ---------------------------------------------------------------------------

function updateRouterConfig(env, patch) {
  const current = readRouterConfig(env) ?? {};
  const installed =
    current.installed && typeof current.installed === 'object' ? { ...current.installed } : {};
  if (patch.installed) {
    for (const [component, value] of Object.entries(patch.installed)) {
      installed[component] = { ...(installed[component] ?? {}), ...value };
    }
  }
  const next = { ...current, ...patch, version: current.version ?? 1 };
  next.installed = installed;
  writeRouterConfig(next, env);
  return next;
}

function persistPwshConfig(env, { path: pwshPath, version, method, at = nowIso() }) {
  const entry = { path: pwshPath, method, at };
  if (version) entry.version = version;
  return updateRouterConfig(env, { pwshPath, installed: { pwsh: entry } });
}

// ---------------------------------------------------------------------------
// Asset name parsing and selection (pure — unit tested)
// ---------------------------------------------------------------------------

/** Parse a PowerShell win-x64 portable zip name into { version } or undefined. */
export function parsePwsh7ZipName(name) {
  const match = /^PowerShell-(.+)-win-x64\.zip$/i.exec(String(name ?? '').trim());
  return match ? { version: match[1] } : undefined;
}

/** Pick the win-x64 portable zip asset out of a GitHub release JSON document. */
export function selectPwsh7Asset(release) {
  if (!release || typeof release !== 'object' || !Array.isArray(release.assets)) return undefined;
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  const version = tag.replace(/^v/i, '');
  const matches = release.assets.filter((asset) => {
    if (!asset || typeof asset.name !== 'string') return false;
    return /^PowerShell-.+-win-x64\.zip$/i.test(asset.name);
  });
  if (!matches.length) return undefined;
  const expectedName = version ? `PowerShell-${version}-win-x64.zip` : '';
  const asset =
    (expectedName && matches.find((item) => item.name.toLowerCase() === expectedName.toLowerCase())) ||
    matches[0];
  const parsed = parsePwsh7ZipName(asset.name);
  return {
    tag,
    version: parsed?.version ?? version,
    name: asset.name,
    url:
      asset.browser_download_url ??
      `https://github.com/PowerShell/PowerShell/releases/download/${tag}/${asset.name}`,
    size: typeof asset.size === 'number' ? asset.size : undefined,
    asset,
  };
}

/**
 * Detect a single wrapper directory in archive entries (e.g. an archive rooted at "pwsh-root/").
 * Returns the directory name when every entry lives under exactly one directory, otherwise
 * undefined (files at the archive root, or several top-level entries). PowerShell portable zips
 * are flat, so they normally return undefined and are extracted without stripping.
 */
export function detectSingleTopLevelDirectory(entries) {
  const segments = new Set();
  let sawEntry = false;
  for (const entry of entries ?? []) {
    if (typeof entry !== 'string') continue;
    const cleaned = entry.replace(/^\.\//, '').replace(/\r$/, '');
    if (!cleaned) continue;
    sawEntry = true;
    const isDirectoryEntry = /[\\/]$/.test(cleaned);
    const withoutTrailing = cleaned.replace(/[\\/]+$/, '');
    if (!withoutTrailing) continue;
    const slash = withoutTrailing.search(/[\\/]/);
    if (slash === -1) {
      if (isDirectoryEntry) {
        segments.add(withoutTrailing);
        if (segments.size > 1) return undefined;
        continue;
      }
      // A plain file at the archive root: the archive has no wrapper directory.
      return undefined;
    }
    segments.add(withoutTrailing.slice(0, slash));
    if (segments.size > 1) return undefined;
  }
  return sawEntry && segments.size === 1 ? [...segments][0] : undefined;
}

// ---------------------------------------------------------------------------
// Downloading / extracting
// ---------------------------------------------------------------------------

const ARCHIVE_MAGIC = {
  zip: [0x50, 0x4b, 0x03, 0x04],
};

/** Check the leading magic bytes of a downloaded archive before extraction. */
export function verifyArchiveMagic(file, kind) {
  const expected = ARCHIVE_MAGIC[kind];
  if (!expected) throw new Error(`verifyArchiveMagic: unknown archive kind ${kind}`);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(expected.length);
    const bytesRead = fs.readSync(fd, buffer, 0, expected.length, 0);
    if (bytesRead !== expected.length) {
      throw new Error(`${kind} archive ${file} is truncated (${bytesRead} header bytes)`);
    }
    const actual = [...buffer];
    const matchesMagic = expected.every((byte, index) => actual[index] === byte);
    if (!matchesMagic) {
      throw new Error(
        `${kind} archive ${file} has an unexpected signature [${actual.join(', ')}]`,
      );
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Stream an HTTPS URL to `destination`, following redirects, calling onProgress(bytes, totalBytes)
 * and honoring an AbortSignal. Throws AbortError when cancelled and removes the partial file.
 */
export async function downloadFile(url, destination, options = {}) {
  const {
    onProgress = () => {},
    signal,
    fetchImpl = globalThis.fetch,
    headers = {},
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    minBytes = 1,
  } = options;
  throwIfAborted(signal);
  if (typeof fetchImpl !== 'function') {
    throw new Error('this runtime has no fetch implementation; cannot download the archive');
  }
  if (typeof destination !== 'string' || !destination.trim()) {
    throw new TypeError('downloadFile(url, destination): destination is required');
  }
  fs.mkdirSync(W.dirname(destination), { recursive: true });
  const linked = linkedSignal(signal, timeoutMs);
  let received = 0;
  try {
    const response = await fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: linked.signal,
    });
    if (!response || !response.ok) {
      throw new Error(`download failed: HTTP ${response?.status ?? '?'} for ${url}`);
    }
    const contentLength = Number(response.headers?.get?.('content-length'));
    const totalBytes =
      Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
    if (!response.body) throw new Error(`download failed: empty response body for ${url}`);
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        try {
          onProgress(received, totalBytes);
        } catch {
          // a faulty progress callback must never fail the download
        }
        callback(null, chunk);
      },
    });
    const source = Readable.fromWeb(response.body);
    await pipeline(source, counter, fs.createWriteStream(destination));
    if (received < minBytes) {
      throw new Error(
        `download too small: ${received} bytes from ${url} (expected at least ${minBytes})`,
      );
    }
    return { url, bytes: received, totalBytes };
  } catch (error) {
    removeQuietly(destination);
    throw ensureAbortError(error, signal);
  } finally {
    linked.cleanup();
  }
}

/** Resolve the bsdtar to use; prefers the Windows system bsdtar over any tar on PATH. */
export function resolveTarPath(env = process.env) {
  const override = env.DSH_PWSH7_TAR ?? env.DSH_TAR_PATH;
  if (typeof override === 'string' && override.trim() && fileOrSymlinkExists(override.trim())) {
    return override.trim();
  }
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? 'C:\\Windows';
  const systemTar = W.join(systemRoot, 'System32', 'tar.exe');
  if (fileOrSymlinkExists(systemTar)) return systemTar;
  const entries = String(env.PATH ?? env.Path ?? '').split(W.delimiter);
  for (const entry of entries) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    const candidate = W.join(directory, 'tar.exe');
    if (fileOrSymlinkExists(candidate)) return candidate;
  }
  return 'tar.exe';
}

/** List archive entries with `tar -tf`. Throws when tar fails. */
export async function listArchiveEntries(tarPath, archivePath, options = {}) {
  const result = await runCommand(tarPath, ['-tf', archivePath], {
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? LISTING_TIMEOUT_MS,
  });
  if (!result.ok) {
    throw new Error(
      `could not list archive ${archivePath} with ${tarPath} (exit ${result.code}): ${
        tail(result.stderr) || tail(result.stdout) || 'no output'
      }`,
    );
  }
  return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

/** Extract an archive with `tar.exe -xf`, optionally stripping a wrapper directory. */
export async function extractArchive(tarPath, archivePath, destination, options = {}) {
  const stripComponents = Number.isInteger(options.stripComponents) ? options.stripComponents : 0;
  throwIfAborted(options.signal);
  fs.mkdirSync(destination, { recursive: true });
  const args = [];
  if (stripComponents > 0) args.push(`--strip-components=${stripComponents}`);
  args.push('-xf', archivePath, '-C', destination);
  const result = await runCommand(tarPath, args, {
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? EXTRACT_TIMEOUT_MS,
  });
  if (!result.ok) {
    throw ensureAbortError(
      new Error(
        `archive extraction failed with ${tarPath} (exit ${result.code}): ${
          tail(result.stderr) || tail(result.stdout) || 'no output'
        }`,
      ),
      options.signal,
    );
  }
  return { stripComponents };
}

/**
 * Extract an archive, automatically stripping a single wrapper directory if the archive has one.
 * The PowerShell portable zip is flat (files at the root), so it is extracted as-is.
 */
export async function extractArchiveWithLayout(tarPath, archivePath, destination, options = {}) {
  const entries = await listArchiveEntries(tarPath, archivePath, options);
  const topLevelDirectory = detectSingleTopLevelDirectory(entries);
  await extractArchive(tarPath, archivePath, destination, {
    ...options,
    stripComponents: topLevelDirectory ? 1 : 0,
  });
  return { topLevelDirectory, entryCount: entries.length };
}

// ---------------------------------------------------------------------------
// PowerShell 7 release resolution
// ---------------------------------------------------------------------------

function buildPwsh7AssetFromTag(tag) {
  const version = tag.replace(/^v/i, '');
  const name = `PowerShell-${version}-win-x64.zip`;
  return {
    tag,
    version,
    name,
    url: `https://github.com/PowerShell/PowerShell/releases/download/${tag}/${name}`,
    synthetic: true,
  };
}

async function resolveLatestPwsh7TagViaRedirect(options = {}) {
  const response = await fetchWithTimeout(options.fetchImpl, PWSH_RELEASES_PAGE, {
    headers: headersFor(options.env),
    signal: options.signal,
    timeoutMs: 30_000,
    redirect: 'manual',
  });
  const location = response?.headers?.get?.('location') ?? '';
  const match = /\/releases\/tag\/(v\d[\w.-]*)/.exec(location);
  if (!match) throw new Error('could not read the latest release tag from the GitHub redirect');
  return match[1];
}

/**
 * Resolve the latest PowerShell 7 win-x64 portable zip:
 * GitHub REST API first, release-page redirect as a rate-limit fallback.
 */
export async function resolvePwsh7Release(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const signal = options.signal;
  throwIfAborted(signal);
  if (typeof fetchImpl !== 'function') throw new Error('this runtime has no fetch implementation');

  const headers = headersFor(env, { Accept: 'application/vnd.github+json' });
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const release = await fetchJson(fetchImpl, PWSH_API_LATEST, {
      headers,
      signal,
      timeoutMs: 60_000,
    });
    const asset = selectPwsh7Asset(release);
    if (!asset) {
      throw new Error(
        `latest PowerShell release ${release?.tag_name ?? '?'} has no PowerShell-*-win-x64.zip asset`,
      );
    }
    return asset;
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw ensureAbortError(error, signal);
    try {
      const tag = await resolveLatestPwsh7TagViaRedirect({ fetchImpl, env, signal });
      return buildPwsh7AssetFromTag(tag);
    } catch (fallbackError) {
      if (fallbackError?.name === 'AbortError') throw fallbackError;
      throw new Error(
        `could not resolve the latest PowerShell 7 release (${error?.message ?? error}). ` +
          `Download the win-x64 zip manually from ${PWSH_RELEASES_PAGE} and extract it, ` +
          `or install with winget: ${wingetInstallManualCommand()}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// winget fallback
// ---------------------------------------------------------------------------

function pwshOnly(component) {
  if (component === undefined || component === null || component === 'pwsh') return 'pwsh';
  throw new TypeError(
    `this installer only supports the pwsh component (got ${JSON.stringify(component)})`,
  );
}

/** Locate winget.exe without spawning anything. */
export function resolveWingetPath(env = process.env) {
  const seen = new Set();
  const candidates = [];
  const push = (candidate) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    const key = candidate.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };
  push(env.DSH_WINGET_PATH);
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  for (const entry of String(pathValue).split(W.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (directory) push(W.join(directory, 'winget.exe'));
  }
  const appData =
    env.LOCALAPPDATA ?? W.join(env.USERPROFILE ?? os.homedir(), 'AppData', 'Local');
  push(W.join(appData, 'Microsoft', 'WindowsApps', 'winget.exe'));
  return candidates.find((candidate) => fileOrSymlinkExists(candidate));
}

/** True when winget.exe can be found for this environment. */
export function wingetAvailable(env = process.env) {
  return Boolean(resolveWingetPath(env));
}

/** winget install argument vector (PowerShell 7 only). */
export function wingetInstallArgs(component = 'pwsh') {
  pwshOnly(component);
  return [
    'install',
    '--id',
    WINGET_PWSH_ID,
    '-e',
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
  ];
}

/** Exact command a user can run manually (elevated) when per-user installation is impossible. */
export function wingetInstallManualCommand(component = 'pwsh') {
  pwshOnly(component);
  return `winget install --id ${WINGET_PWSH_ID} -e --silent --accept-package-agreements --accept-source-agreements`;
}

/** Heuristic: winget output that means the install needs administrator elevation. */
export function looksLikeElevationRequired(text) {
  const value = String(text ?? '');
  if (!value) return false;
  return (
    /requires?\s+(administrator|elevation|admin)/i.test(value) ||
    /requested\s+operation\s+requires\s+elevation/i.test(value) ||
    /0x800704c7/i.test(value) ||
    /需要提升|需要管理员|管理员权限/.test(value) ||
    /uac|user account control/i.test(value)
  );
}

export function manualInstallInstructions(component = 'pwsh') {
  pwshOnly(component);
  return (
    `Install PowerShell 7 manually: download the win-x64 zip from ${PWSH_RELEASES_PAGE}, ` +
    `or run from an elevated terminal: ${wingetInstallManualCommand()}`
  );
}

async function installViaWinget(options = {}) {
  const env = options.env ?? process.env;
  const signal = options.signal;
  throwIfAborted(signal);
  const wingetPath = resolveWingetPath(env);
  if (!wingetPath) {
    return {
      ok: false,
      kind: 'unavailable',
      message: `winget is not available on this system. ${manualInstallInstructions()}`,
    };
  }
  const args = wingetInstallArgs();
  const result = await runCommand(wingetPath, args, {
    env,
    signal,
    timeoutMs: options.timeoutMs ?? WINGET_TIMEOUT_MS,
  });
  if (signal?.aborted || result.error?.name === 'AbortError') {
    throw abortError(signal);
  }
  const combined = [result.stdout, result.stderr, result.error?.message]
    .filter((part) => typeof part === 'string' && part.trim())
    .join('\n')
    .trim();
  if (result.ok) return { ok: true, kind: 'installed', output: combined, command: wingetPath };
  if (looksLikeElevationRequired(combined)) {
    return {
      ok: false,
      kind: 'elevation',
      message:
        `automatic installation would require administrator elevation, so nothing was changed. ` +
        `Open an elevated terminal (PowerShell 7 or cmd) and run:\n  ${wingetInstallManualCommand()}\n` +
        `Then reopen the app or rerun the install.`,
      output: combined,
      command: wingetPath,
    };
  }
  return {
    ok: false,
    kind: 'failed',
    message:
      `winget install failed (exit ${result.code}): ${tail(combined) || 'no output'}. ` +
      manualInstallInstructions(),
    output: combined,
    command: wingetPath,
  };
}

// ---------------------------------------------------------------------------
// PowerShell 7 installer
// ---------------------------------------------------------------------------

function baseResult(method, startedAt) {
  return { ok: false, component: 'pwsh', method, durationMs: Date.now() - startedAt };
}

/**
 * Install PowerShell 7 per-user.
 * opts: { env, root, method = 'auto'|'portable'|'winget', onProgress, signal, fetchImpl,
 *         tarPath, extractImpl, timeouts, wingetTimeoutMs, force, version, url, probePwsh }
 * -> Result { ok, component: 'pwsh', method, path, version, message, url?, bytes?, durationMs }
 */
export async function installPowerShell7(options = {}) {
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const root = options.root ?? routerRoot(env);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : () => {};
  const signal = options.signal;
  const method = options.method ?? 'auto';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const probeImpl = options.probePwsh ?? probePwsh;
  const extractImpl = options.extractImpl ?? extractArchiveWithLayout;
  const tarPath = options.tarPath ?? resolveTarPath(env);

  const fail = (message, extra = {}) => ({
    ...baseResult(method, startedAt),
    message,
    ...extra,
  });

  throwIfAborted(signal);

  try {
    // 1. Reuse a working installation and only write config.
    if (!options.force) {
      const existing = findPwsh({ env });
      if (existing) {
        const probe = await probeImpl(existing.path, { env, signal });
        if (probe.ok) {
          persistPwshConfig(env, { path: existing.path, version: probe.version, method: 'existing' });
          return {
            ok: true,
            component: 'pwsh',
            method: 'existing',
            path: existing.path,
            version: probe.version,
            message: `using existing PowerShell ${probe.version ?? '(version unknown)'} at ${existing.path}`,
            durationMs: Date.now() - startedAt,
          };
        }
      }
    }

    // 2. winget-only strategy.
    if (method === 'winget') {
      onPhase('winget');
      const winget = await installViaWinget({
        env,
        signal,
        timeoutMs: options.wingetTimeoutMs,
      });
      if (!winget.ok) {
        return fail(winget.message, { method: 'winget', output: winget.output });
      }
      const located = findPwsh({ env });
      onPhase('verify');
      const probe = located ? await probeImpl(located.path, { env, signal }) : { ok: false };
      if (located && probe.ok) {
        persistPwshConfig(env, { path: located.path, version: probe.version, method: 'winget' });
        return {
          ok: true,
          component: 'pwsh',
          method: 'winget',
          path: located.path,
          version: probe.version,
          message: `installed PowerShell ${probe.version} via winget at ${located.path}`,
          durationMs: Date.now() - startedAt,
        };
      }
      return fail(
        `winget reported success but no PowerShell 7 executable could be verified. ` +
          `Open a new terminal so PATH refreshes, then rerun the install or status. ${
            winget.output ? `winget output: ${tail(winget.output)}` : ''
          }`,
        { method: 'winget', output: winget.output },
      );
    }

    // 3. Portable zip first for 'portable' and 'auto'.
    let portableError;
    let portableUrl = options.url;
    try {
      const installed = await installPowerShell7Portable({
        env,
        root,
        method,
        onProgress,
        onPhase,
        signal,
        fetchImpl,
        tarPath,
        probeImpl,
        extractImpl,
        startedAt,
        force: options.force,
        version: options.version,
        url: options.url,
      });
      return installed;
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw ensureAbortError(error, signal);
      portableError = error;
      if (error?.url) portableUrl = error.url;
    }

    if (method === 'portable') {
      return fail(`portable PowerShell 7 install failed: ${portableError?.message ?? portableError}`, {
        url: portableUrl ?? PWSH_RELEASES_PAGE,
        hint: manualInstallInstructions(),
      });
    }

    // 4. 'auto' falls back to winget.
    onPhase('winget');
    const winget = await installViaWinget({
      env,
      signal,
      timeoutMs: options.wingetTimeoutMs,
    });
    if (!winget.ok) {
      return fail(
        `portable install failed (${portableError?.message ?? portableError}); ` +
          `winget fallback also failed: ${winget.message}`,
        { method: winget.kind === 'unavailable' ? 'portable' : 'winget', output: winget.output },
      );
    }
    const located = findPwsh({ env });
    onPhase('verify');
    const probe = located ? await probeImpl(located.path, { env, signal }) : { ok: false };
    if (located && probe.ok) {
      persistPwshConfig(env, { path: located.path, version: probe.version, method: 'winget' });
      return {
        ok: true,
        component: 'pwsh',
        method: 'winget',
        path: located.path,
        version: probe.version,
        message:
          `portable install failed (${portableError?.message ?? portableError}); ` +
          `installed PowerShell ${probe.version} via winget at ${located.path}`,
        durationMs: Date.now() - startedAt,
      };
    }
    return fail(
      `portable install failed (${portableError?.message ?? portableError}) and the winget fallback ` +
        `could not verify a PowerShell 7 executable. Open a new terminal and rerun, or install manually. ` +
        manualInstallInstructions(),
      { method: 'winget', output: winget.output },
    );
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw ensureAbortError(error, signal);
    return fail(error?.message ?? String(error), { hint: manualInstallInstructions() });
  }
}

async function installPowerShell7Portable(context) {
  const {
    env,
    root,
    onProgress,
    onPhase,
    signal,
    fetchImpl,
    tarPath,
    probeImpl,
    extractImpl,
    startedAt,
    force,
    version,
    url,
  } = context;
  const phase = typeof onPhase === 'function' ? onPhase : () => {};

  let release;
  if (url) {
    const name = W.basename(new URL(url).pathname);
    const parsed = parsePwsh7ZipName(name);
    release = { url, name, version: version ?? parsed?.version ?? 'custom' };
  } else {
    release = await resolvePwsh7Release({ env, fetchImpl, signal });
  }
  if (!release?.version || release.version === 'custom') {
    throw new Error(`could not determine the PowerShell 7 version to install from ${release?.url}`);
  }
  throwIfAborted(signal);

  const targetRoot = W.join(root, 'powershell7', release.version);
  const pwshExe = W.join(targetRoot, 'pwsh.exe');
  const tmpDir = W.join(root, 'tmp');
  const archiveName = release.name ?? `PowerShell-${release.version}-win-x64.zip`;
  const archivePath = W.join(tmpDir, archiveName);
  let bytes;
  let downloaded = false;

  try {
    if (force || !fileOrSymlinkExists(pwshExe)) {
      phase('download');
      const download = await downloadFile(release.url, archivePath, {
        onProgress,
        signal,
        fetchImpl,
        headers: headersFor(env),
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        minBytes: PWSH7_MIN_DOWNLOAD_BYTES,
      });
      bytes = download.bytes;
      downloaded = true;
      verifyArchiveMagic(archivePath, 'zip');
      fs.mkdirSync(targetRoot, { recursive: true });
      phase('extract');
      await extractImpl(tarPath, archivePath, targetRoot, {
        env,
        signal,
        timeoutMs: EXTRACT_TIMEOUT_MS,
      });
    }
  } catch (error) {
    const wrapped = ensureAbortError(error, signal);
    if (wrapped?.name !== 'AbortError') wrapped.url = release.url;
    throw wrapped;
  } finally {
    if (downloaded) removeQuietly(archivePath);
  }

  if (!fileOrSymlinkExists(pwshExe)) {
    throw new Error(
      `pwsh.exe was not found after extracting ${archiveName} into ${targetRoot}; ` +
        `the archive layout may have changed`,
    );
  }
  phase('verify');
  const probe = await probeImpl(pwshExe, { env, signal });
  if (!probe.ok) {
    throw new Error(
      `extracted pwsh.exe at ${pwshExe} failed verification: ${
        tail(probe.output) || 'no version output'
      }`,
    );
  }
  const installedVersion = probe.version ?? release.version;
  persistPwshConfig(env, { path: pwshExe, version: installedVersion, method: 'portable' });
  return {
    ok: true,
    component: 'pwsh',
    method: 'portable',
    path: pwshExe,
    version: installedVersion,
    url: release.url,
    bytes,
    message: `installed PowerShell ${installedVersion} at ${pwshExe}`,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Ensure PowerShell 7 is available, per-user.
 * -> { ok, result, notes, aborted }
 *    result is always present: a Result { ok, component: 'pwsh', method, path?, version?,
 *    message, url?, bytes?, durationMs }. `aborted` is true when the signal cancelled the work.
 */
export async function ensurePwsh(options = {}) {
  const {
    env = process.env,
    root = routerRoot(env),
    method = 'auto',
    onProgress = () => {},
    signal,
    ...rest
  } = options;
  if (!['auto', 'portable', 'winget'].includes(method)) {
    throw new TypeError(`ensurePwsh: unsupported method ${JSON.stringify(method)}`);
  }
  const notes = [];
  if (signal?.aborted) {
    const result = {
      ok: false,
      component: 'pwsh',
      method,
      message: 'aborted before installation started',
      durationMs: 0,
    };
    return { ok: false, aborted: true, result, notes: ['pwsh: aborted'] };
  }
  notes.push(`pwsh: installing (method: ${method})`);
  let result;
  try {
    // `...rest` forwards test seams (fetchImpl, extractImpl, probePwsh, ...) to the installer.
    result = await installPowerShell7({ env, root, method, onProgress, signal, ...rest });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) {
      result = {
        ok: false,
        component: 'pwsh',
        method,
        message: 'aborted',
        durationMs: 0,
      };
      notes.push('pwsh: aborted');
      return { ok: false, aborted: true, result, notes };
    }
    result = {
      ok: false,
      component: 'pwsh',
      method,
      message: error?.message ?? String(error),
      durationMs: 0,
    };
  }
  notes.push(
    result.ok
      ? `pwsh: ok (${result.method}${result.version ? `, ${result.version}` : ''})`
      : `pwsh: failed — ${result.message}`,
  );
  return { ok: result.ok === true, result, notes, aborted: false };
}
