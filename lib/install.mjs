// lib/install.mjs — scoped installer for PowerShell 7.
//
// User installs extract the portable ZIP into the router directory. System installs do NOT extract
// a ZIP into Program Files: they run the official PowerShell MSI, which upgrades the canonical
// `…\PowerShell\7\pwsh.exe` in place. That is the executable Windows Terminal and every other
// launcher resolve, so a system upgrade is visible outside DSH. The same elevated session removes
// the versioned side-by-side copies older plugin releases left behind and their PATH entries.
//
// Public contract:
//   USER_AGENT, PWSH_API_LATEST, PWSH_RELEASES_PAGE, WINGET_PWSH_ID
//   ensurePwsh({ env, root, method, onProgress, signal }) -> { ok, result, notes, aborted }
//     result: { ok, component: 'pwsh', method, path?, version?, message, url?, bytes?,
//               cleaned?, warnings?, restartRequired?, durationMs }
//   installPowerShell7(options) -> Result (same shape as above)
//   resolvePwsh7Release(options) / resolvePwsh7MsiRelease(options) -> { tag, version, name, url, size? }
//   selectPwsh7Asset(release, kind) -> asset descriptor | undefined
//   parsePwsh7ZipName(name) / parsePwsh7MsiName(name) -> { version } | undefined
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
  candidatePwshPaths,
  comparePwshVersions,
  probePwsh,
  fileOrSymlinkExists,
} from './paths.mjs';

import {
  validateScope,
  installDirectory,
  updateInstallPath,
  isProcessElevated,
  removeProcessPathEntriesUnder,
  systemVersionedDirectories,
} from './install-scope.mjs';
import {
  runElevatedCommand,
  runElevatedSystemInstall,
  runElevatedZipReplace,
} from './elevate.mjs';
import { resolvePwshArchitecture, resolveUpgradePlan } from './install-plan.mjs';

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

function persistPwshConfig(env, { path: pwshPath, version, method, scope, at = nowIso() }) {
  const entry = { path: pwshPath, method, scope, at };
  if (version) entry.version = version;
  return updateRouterConfig(env, { pwshPath, installed: { pwsh: entry } });
}

// ---------------------------------------------------------------------------
// Asset name parsing and selection (pure — unit tested)
// ---------------------------------------------------------------------------

/** Parse a PowerShell architecture-specific portable zip name into { version } or undefined. */
export function parsePwsh7ZipName(name, architecture = 'win-x64') {
  const match = new RegExp(`^PowerShell-(.+)-${architecture}\\.zip$`, 'i').exec(String(name ?? '').trim());
  return match ? { version: match[1] } : undefined;
}

/** Parse a PowerShell architecture-specific MSI name into { version } or undefined. */
export function parsePwsh7MsiName(name, architecture = 'win-x64') {
  const match = new RegExp(`^PowerShell-(.+)-${architecture}\\.msi$`, 'i').exec(String(name ?? '').trim());
  return match ? { version: match[1] } : undefined;
}

/**
 * Pick an asset out of a GitHub release JSON document.
 * `kind` is `zip` (portable, user scope) or `msi` (official installer, system scope).
 * `architecture` is `win-x64` (default), `win-arm64`, or `win-x86`.
 */
export function selectPwsh7Asset(release, kind = 'zip', architecture = 'win-x64') {
  if (kind !== 'zip' && kind !== 'msi') {
    throw new TypeError(`selectPwsh7Asset: unknown asset kind ${JSON.stringify(kind)}`);
  }
  if (!['win-x64', 'win-arm64', 'win-x86'].includes(architecture)) {
    throw new TypeError(`selectPwsh7Asset: unknown architecture ${JSON.stringify(architecture)}`);
  }
  if (!release || typeof release !== 'object' || !Array.isArray(release.assets)) return undefined;
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  const version = tag.replace(/^v/i, '');
  const pattern = new RegExp(`^PowerShell-.+-${architecture}\\.${kind}$`, 'i');
  const parse = kind === 'msi' ? parsePwsh7MsiName : parsePwsh7ZipName;
  const matches = release.assets.filter((asset) => {
    if (!asset || typeof asset.name !== 'string') return false;
    return pattern.test(asset.name);
  });
  if (!matches.length) return undefined;
  const expectedName = version ? `PowerShell-${version}-${architecture}.${kind}` : '';
  const asset =
    (expectedName && matches.find((item) => item.name.toLowerCase() === expectedName.toLowerCase())) ||
    matches[0];
  const parsed = parse(asset.name, architecture);
  return {
    tag,
    version: parsed?.version ?? version,
    name: asset.name,
    url:
      asset.browser_download_url ??
      `https://github.com/PowerShell/PowerShell/releases/download/${tag}/${asset.name}`,
    size: typeof asset.size === 'number' ? asset.size : undefined,
    asset,
    kind,
    architecture,
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
  // OLE compound document header, used by every Windows Installer package.
  msi: [0xd0, 0xcf, 0x11, 0xe0],
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

function buildPwsh7AssetFromTag(tag, kind = 'zip', architecture = 'win-x64') {
  const version = tag.replace(/^v/i, '');
  const name = `PowerShell-${version}-${architecture}.${kind}`;
  return {
    tag,
    version,
    name,
    url: `https://github.com/PowerShell/PowerShell/releases/download/${tag}/${name}`,
    synthetic: true,
    kind,
    architecture,
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
 * Resolve the latest PowerShell 7 win-x64 asset:
 * GitHub REST API first, release-page redirect as a rate-limit fallback.
 * `kind: 'msi'` selects the official installer used for system scope; the default `zip` is the
 * portable archive used for user scope.
 */
export async function resolvePwsh7Release(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const signal = options.signal;
  const kind = options.kind === 'msi' ? 'msi' : 'zip';
  const architecture = options.architecture ?? resolvePwshArchitecture(env);
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
    const asset = selectPwsh7Asset(release, kind, architecture);
    if (!asset) {
      throw new Error(
        `latest PowerShell release ${release?.tag_name ?? '?'} has no PowerShell-*-${architecture}.${kind} asset`,
      );
    }
    return asset;
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw ensureAbortError(error, signal);
    try {
      const tag = await resolveLatestPwsh7TagViaRedirect({ fetchImpl, env, signal });
      return buildPwsh7AssetFromTag(tag, kind, architecture);
    } catch (fallbackError) {
      if (fallbackError?.name === 'AbortError') throw fallbackError;
      const manual = kind === 'msi'
        ? `Download the win-x64 MSI from ${PWSH_RELEASES_PAGE} and run it (it upgrades the existing installation), `
        : `Download the win-x64 zip manually from ${PWSH_RELEASES_PAGE} and extract it, `;
      throw new Error(
        `could not resolve the latest PowerShell 7 release (${error?.message ?? error}). `
          + `${manual}or install with winget: ${wingetInstallManualCommand()}`,
      );
    }
  }
}

/** Resolve the latest official PowerShell 7 MSI (system scope). */
export function resolvePwsh7MsiRelease(options = {}) {
  return resolvePwsh7Release({ ...options, kind: 'msi' });
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
export function wingetInstallArgs(component = 'pwsh', scope = 'user') {
  pwshOnly(component);
  validateScope(scope);
  return [
    'install',
    '--id',
    WINGET_PWSH_ID,
    '-e',
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
    '--scope',
    scope === 'system' ? 'machine' : 'user',
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

/** Exact recovery path for a system-scope failure: the official MSI upgrades the main install. */
export function manualSystemInstallInstructions(component = 'pwsh') {
  pwshOnly(component);
  return (
    `Upgrade PowerShell 7 system-wide: download the official win-x64 MSI from ${PWSH_RELEASES_PAGE} `
    + 'and run it as administrator (it upgrades the existing installation in place), or run from an '
    + `elevated terminal: ${wingetInstallManualCommand().replace('winget install', 'winget upgrade')}`
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
  const args = wingetInstallArgs('pwsh', options.scope);
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
 * Install or upgrade PowerShell 7 for the selected user/system scope.
 *
 * User scope extracts the portable ZIP under the router root. System scope runs the official MSI
 * in place, so the canonical `…\PowerShell\7\pwsh.exe` (the one Windows Terminal launches) becomes
 * the new version; it never extracts a ZIP next to it.
 *
 * opts: { env, root, scope = 'user'|'system', method = 'auto'|'portable'|'msi'|'winget',
 *         onProgress, onPhase, signal, fetchImpl, tarPath, extractImpl, timeouts,
 *         wingetTimeoutMs, force, version, url, probePwsh, isElevated, runSystemInstall, updatePath }
 * -> Result { ok, component: 'pwsh', method, path, version, message, url?, bytes?,
 *             cleaned?, warnings?, restartRequired?, durationMs }
 */
export async function installPowerShell7(options = {}) {
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const root = options.root ?? routerRoot(env);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : () => {};
  const signal = options.signal;
  const requestedMethod = options.method ?? 'auto';
  const method = requestedMethod === 'msi' && options.scope !== 'system' ? 'portable' : requestedMethod;
  const scope = validateScope(options.scope ?? 'user');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const probeImpl = options.probePwsh ?? probePwsh;
  const extractImpl = options.extractImpl ?? extractArchiveWithLayout;
  const tarPath = options.tarPath ?? resolveTarPath(env);
  const updatePath = options.updatePath ?? updateInstallPath;

  const fail = (message, extra = {}) => ({
    ...baseResult(scope === 'system' ? 'msi' : method, startedAt),
    scope,
    message,
    ...extra,
  });

  const localPrograms = W.join(
    env.LOCALAPPDATA ?? W.join(env.USERPROFILE ?? os.homedir(), 'AppData', 'Local'),
    'Programs',
    'PowerShell',
  );
  const localWinget = W.join(
    env.LOCALAPPDATA ?? W.join(env.USERPROFILE ?? os.homedir(), 'AppData', 'Local'),
    'Microsoft',
    'WinGet',
  );
  const scopeRoot = installDirectory(env, scope, root);
  const locate = () => {
    const roots = scope === 'system' ? [scopeRoot] : [scopeRoot, localPrograms, localWinget];
    const candidate = candidatePwshPaths(env).find((value) =>
      roots.some((base) => W.normalize(value).toLowerCase().startsWith(W.normalize(base).toLowerCase() + W.sep))
      && fileOrSymlinkExists(value));
    return candidate ? { path: candidate } : undefined;
  };
  const persist = async (entry, persistOptions = {}) => {
    if (persistOptions.skipPath !== true) {
      try {
        await updatePath(entry.path, { env, scope, signal });
      } catch (error) {
        error.pathUpdateFailed = true;
        throw error;
      }
    }
    persistPwshConfig(env, { ...entry, scope });
  };

  /** winget strategy, shared by both scopes. */
  const runWinget = async () => {
    onPhase('winget');
    const winget = await installViaWinget({
      env,
      signal,
      timeoutMs: options.wingetTimeoutMs,
      scope,
    });
    if (!winget.ok) {
      return fail(winget.message, { method: 'winget', output: winget.output });
    }
    const located = locate();
    onPhase('verify');
    const probe = located ? await probeImpl(located.path, { env, signal }) : { ok: false };
    if (located && probe.ok) {
      await persist({ path: located.path, version: probe.version, method: 'winget' });
      return {
        ok: true,
        component: 'pwsh',
        scope,
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
  };

  throwIfAborted(signal);

  try {
    // System scope: the official MSI upgrades the canonical installation in place. winget stays
    // available as an explicit alternative, but there is deliberately no ZIP side-by-side path.
    if (scope === 'system') {
      if (method === 'winget') return await runWinget();
      return await installPowerShell7System({
        env,
        root,
        method,
        onProgress,
        onPhase,
        signal,
        fetchImpl,
        probeImpl,
        startedAt,
        force: options.force,
        version: options.version,
        url: options.url,
        isElevated: options.isElevated,
        requireAdministrator: options.requireAdministrator,
        runSystemInstall: options.runSystemInstall ?? runElevatedSystemInstall,
        runZipReplace: options.runZipReplace ?? runElevatedZipReplace,
        runPackageCommand: options.runPackageCommand,
        resolvePlan: options.resolvePlan,
        msiProducts: options.msiProducts,
        pathEntries: options.pathEntries,
        declaredPath: options.declaredPath,
        extractImpl,
        tarPath,
      });
    }

    // User scope: reuse a working copy, but only when it is already at the latest release. The
    // client's Update action calls install without `force`, so this comparison is what makes an
    // in-place update actually download the newer portable ZIP.
    let resolvedRelease;
    if (!options.force) {
      const existing = locate();
      if (existing) {
        const probe = await probeImpl(existing.path, { env, signal });
        if (probe.ok) {
          try {
            resolvedRelease = await resolvePwsh7Release({
              env,
              fetchImpl,
              signal,
              architecture: resolvePwshArchitecture(env),
            });
          } catch (error) {
            if (error?.name === 'AbortError' || signal?.aborted) throw ensureAbortError(error, signal);
            resolvedRelease = undefined;
          }
          const upgradeNeeded = resolvedRelease !== undefined
            && typeof resolvedRelease.version === 'string'
            && comparePwshVersions(probe.version, resolvedRelease.version) < 0;
          if (!upgradeNeeded) {
            await persist({ path: existing.path, version: probe.version, method: 'existing' });
            return {
              ok: true,
              component: 'pwsh',
              scope,
              method: 'existing',
              path: existing.path,
              version: probe.version,
              message: `using existing PowerShell ${probe.version ?? '(version unknown)'} at ${existing.path}`,
              durationMs: Date.now() - startedAt,
            };
          }
        }
      }
    }

    let portableError;
    let portableUrl = options.url;
    try {
      return await installPowerShell7Portable({
        env,
        root,
        scope,
        persist,
        method,
        onProgress,
        onPhase,
        signal,
        fetchImpl,
        tarPath,
        probeImpl,
        extractImpl,
        startedAt,
        force: options.force || resolvedRelease !== undefined,
        version: options.version,
        url: options.url,
        release: options.url ? undefined : resolvedRelease,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw ensureAbortError(error, signal);
      if (error?.pathUpdateFailed) throw error;
      portableError = error;
      if (error?.url) portableUrl = error.url;
    }

    if (method === 'portable') {
      return fail(`portable PowerShell 7 install failed: ${portableError?.message ?? portableError}`, {
        url: portableUrl ?? PWSH_RELEASES_PAGE,
        hint: manualInstallInstructions(),
      });
    }

    // 'auto' falls back to winget.
    const wingetOutcome = await runWinget();
    if (wingetOutcome.ok) {
      return {
        ...wingetOutcome,
        message:
          `portable install failed (${portableError?.message ?? portableError}); `
          + wingetOutcome.message,
      };
    }
    return fail(
      `portable install failed (${portableError?.message ?? portableError}); ` +
        `winget fallback also failed: ${wingetOutcome.message}`,
      { method: wingetOutcome.method === 'winget' ? 'winget' : 'portable', output: wingetOutcome.output },
    );
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw ensureAbortError(error, signal);
    return fail(error?.message ?? String(error), {
      ...(error?.elevationFailed === true ? { requiresElevation: true } : {}),
      ...(error?.pendingRestart === true ? { restartRequired: true } : {}),
      hint: error?.hint
        ?? (scope === 'system' ? manualSystemInstallInstructions() : manualInstallInstructions()),
    });
  }
}

/**
 * System-scope install/upgrade through the official MSI. Always targets the canonical
 * `…\PowerShell\7\pwsh.exe`; when that executable already reports the target version no download
 * or UAC prompt is needed. A successful MSI run also removes the versioned side-by-side copies and
 * their machine PATH entries in the same elevated session.
 */
async function installPowerShell7System(context) {
  const {
    env,
    root,
    onPhase,
    startedAt,
    msiProducts,
    pathEntries,
    declaredPath,
    resolvePlan,
  } = context;
  const phase = typeof onPhase === 'function' ? onPhase : () => {};
  const canonicalDir = installDirectory(env, 'system', root);
  const legacyCopies = systemVersionedDirectories(env, root);
  const legacyDirectories = legacyCopies.map((entry) => entry.directory);
  const legacyPaths = legacyCopies.map((entry) => entry.path);
  const architecture = resolvePwshArchitecture(env);

  const planInfo = await (resolvePlan ?? resolveUpgradePlan)({
    env,
    root,
    scope: 'system',
    msiProducts,
    pathEntries,
    declaredPath,
  });
  const plan = planInfo?.plan ?? {
    strategy: 'msi-install',
    targetDirectory: canonicalDir,
    allUsers: true,
  };
  const main = planInfo?.main;

  if (plan.strategy === 'refuse') {
    const error = new Error(plan.reason ?? 'the main PowerShell 7 installation is managed externally');
    error.hint = plan.reason;
    throw error;
  }
  if (plan.strategy === 'zip-in-place') {
    return installPowerShell7PortableInPlace({
      ...context,
      phase,
      plan,
      main,
      canonicalDir,
      legacyDirectories,
      legacyPaths,
      architecture,
    });
  }
  if (plan.strategy === 'chocolatey' || plan.strategy === 'scoop' || plan.strategy === 'store') {
    return upgradePowerShell7WithPackageManager({
      ...context,
      phase,
      plan,
      main,
      canonicalDir,
      legacyDirectories,
      legacyPaths,
      architecture,
    });
  }
  return installPowerShell7SystemMsi({
    ...context,
    phase,
    plan,
    main,
    canonicalDir,
    legacyDirectories,
    legacyPaths,
    architecture,
  });
}

/** MSI branch: upgrade the product (or install it) and verify its executable. */
async function installPowerShell7SystemMsi(context) {
  const {
    env,
    root,
    phase,
    plan,
    canonicalDir,
    legacyDirectories,
    legacyPaths,
    architecture,
    onProgress,
    signal,
    fetchImpl,
    probeImpl,
    startedAt,
    force,
    version,
    url,
    isElevated,
    requireAdministrator,
    runSystemInstall,
  } = context;
  const targetDir = plan.targetDirectory ?? canonicalDir;
  const targetExe = W.join(targetDir, 'pwsh.exe');
  const allUsers = plan.allUsers !== false;
  const scope = allUsers ? 'system' : 'user';

  let release;
  if (url) {
    const name = W.basename(new URL(url).pathname);
    const parsed = parsePwsh7MsiName(name, architecture);
    release = { url, name, version: version ?? parsed?.version ?? 'custom', kind: 'msi', architecture };
  } else {
    release = await resolvePwsh7MsiRelease({ env, fetchImpl, signal, architecture });
  }
  if (!release?.version || release.version === 'custom') {
    throw new Error(`could not determine the PowerShell 7 version to install from ${release?.url}`);
  }
  throwIfAborted(signal);

  let existing;
  if (fileOrSymlinkExists(targetExe)) {
    existing = await probeImpl(targetExe, { env, signal });
  }
  if (!force && existing?.ok && comparePwshVersions(existing.version, release.version) >= 0) {
    persistPwshConfig(env, {
      path: targetExe,
      version: existing.version,
      method: 'existing',
      scope,
    });
    return {
      ok: true,
      component: 'pwsh',
      scope,
      method: 'existing',
      path: targetExe,
      version: existing.version,
      legacyPaths,
      message: `using existing ${scope === 'system' ? 'system' : 'per-user'} PowerShell `
        + `${existing.version ?? '(version unknown)'} at ${targetExe}`
        + (legacyPaths.length > 0
          ? `; ${legacyPaths.length} legacy copy(ies) remain (the next upgrade removes them)`
          : ''),
      durationMs: Date.now() - startedAt,
    };
  }

  const tmpDir = W.join(root, 'tmp');
  const msiName = release.name ?? `PowerShell-${release.version}-${architecture}.msi`;
  const msiPath = W.join(tmpDir, msiName);
  const logPath = W.join(tmpDir, `PowerShell-${release.version}-install.log`);
  let bytes;
  let cleaned = [];
  let warnings = [];
  let restartRequired = false;

  try {
    phase('download');
    const download = await downloadFile(release.url, msiPath, {
      onProgress,
      signal,
      fetchImpl,
      headers: headersFor(env),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      minBytes: PWSH7_MIN_DOWNLOAD_BYTES,
    });
    bytes = download.bytes;
    verifyArchiveMagic(msiPath, 'msi');
    throwIfAborted(signal);

    let elevated = false;
    if (typeof requireAdministrator === 'function') {
      await requireAdministrator({ env, signal });
      elevated = true;
    } else if (typeof isElevated === 'function') {
      elevated = (await isElevated({ env, signal })) === true;
    } else {
      elevated = (await isProcessElevated({ env, signal })) === true;
    }

    phase(allUsers && !elevated ? 'elevate' : 'installing');
    const outcome = await runSystemInstall({
      env,
      msiPath,
      logPath,
      systemDir: targetDir,
      legacyDirectories,
      expectedVersion: release.version,
      allUsers,
      signal,
      isElevated: elevated,
    });
    if (!outcome?.ok) {
      const failure = new Error(
        outcome?.cancelled
          ? 'administrator approval was cancelled; approve the Windows UAC prompt and retry'
          : (outcome?.error ?? 'the system-level installation did not complete'),
      );
      failure.elevationFailed = true;
      failure.cancelled = outcome?.cancelled === true;
      throw failure;
    }
    cleaned = Array.isArray(outcome.cleaned) ? outcome.cleaned : [];
    warnings = Array.isArray(outcome.warnings) ? outcome.warnings : [];
    restartRequired = outcome.restartRequired === true;
  } finally {
    removeQuietly(msiPath);
  }

  phase('verify');
  const probe = await probeImpl(targetExe, { env, signal });
  if (!probe.ok) {
    throw new Error(
      `the MSI installer completed, but ${targetExe} failed verification: ${
        tail(probe.output) || 'no version output'
      }`,
    );
  }
  if (comparePwshVersions(probe.version, release.version) < 0) {
    const failure = new Error(
      `the MSI installer completed, but ${targetExe} still reports `
      + `${probe.version ?? 'an unknown version'} instead of ${release.version}. `
      + 'Close every PowerShell window (or restart Windows) and run the update again.',
    );
    failure.pendingRestart = true;
    throw failure;
  }

  for (const directory of legacyDirectories) removeProcessPathEntriesUnder(directory, env);
  persistPwshConfig(env, {
    path: targetExe,
    version: probe.version,
    method: 'msi',
    scope,
  });

  const cleanupNote = legacyDirectories.length === 0
    ? ''
    : cleaned.length > 0
      ? `; removed ${cleaned.length} legacy copy(ies)`
      : '; the legacy copy(ies) could not be removed yet (close any process using them)';
  return {
    ok: true,
    component: 'pwsh',
    scope,
    method: 'msi',
    path: targetExe,
    version: probe.version,
    url: release.url,
    bytes,
    cleaned,
    warnings,
    restartRequired,
    legacyPaths,
    message: `upgraded the ${scope === 'system' ? 'system' : 'per-user'} PowerShell installation `
      + `to ${probe.version} at ${targetExe}${cleanupNote}`,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Portable branch: the main install is a manual ZIP extraction (no MSI product). Replace the
 * directory contents in place, keeping the exact PATH entry a terminal resolves.
 */
async function installPowerShell7PortableInPlace(context) {
  const {
    env,
    root,
    phase,
    plan,
    canonicalDir,
    legacyDirectories,
    legacyPaths,
    architecture,
    onProgress,
    signal,
    fetchImpl,
    probeImpl,
    extractImpl,
    tarPath,
    startedAt,
    version,
    url,
    isElevated,
    runZipReplace,
  } = context;

  let release;
  if (url) {
    const name = W.basename(new URL(url).pathname);
    const parsed = parsePwsh7ZipName(name, architecture);
    release = { url, name, version: version ?? parsed?.version ?? 'custom', kind: 'zip', architecture };
  } else {
    release = await resolvePwsh7Release({ env, fetchImpl, signal, kind: 'zip', architecture });
  }
  if (!release?.version || release.version === 'custom') {
    throw new Error(`could not determine the PowerShell 7 version to install from ${release?.url}`);
  }
  throwIfAborted(signal);

  let targetDir = plan.targetDirectory;
  if (typeof targetDir !== 'string' || !targetDir.trim()) targetDir = canonicalDir;
  try {
    // Follow a junction/symlink so the real installation directory is replaced, not the link.
    const real = fs.realpathSync.native(targetDir);
    if (typeof real === 'string' && real.trim()) targetDir = real;
  } catch {
    // The directory may not exist yet; keep the planned path.
  }
  targetDir = directoryOf(targetDir);
  const targetExe = W.join(targetDir, 'pwsh.exe');

  const tmpDir = W.join(root, 'tmp');
  const archiveName = release.name ?? `PowerShell-${release.version}-${architecture}.zip`;
  const archivePath = W.join(tmpDir, archiveName);
  const staging = W.join(tmpDir, `staging-${process.pid}-${Date.now()}`);
  let bytes;
  let cleaned = [];
  let warnings = [];
  let elevated = false;

  try {
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
    verifyArchiveMagic(archivePath, 'zip');
    fs.mkdirSync(staging, { recursive: true });
    phase('extract');
    await extractImpl(tarPath, archivePath, staging, {
      env,
      signal,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });

    if (typeof isElevated === 'function') {
      elevated = (await isElevated({ env, signal })) === true;
    } else {
      elevated = (await isProcessElevated({ env, signal })) === true;
    }
    const writable = canWriteDirectory(targetDir) || canWriteDirectory(W.dirname(targetDir));
    const direct = writable || elevated;
    const pathScope = plan.pathSource === 'path' ? '' : (plan.scope === 'system' ? 'Machine' : 'User');

    if (direct) {
      const backup = `${targetDir}.old-${Date.now()}`;
      const hadTarget = fs.existsSync(targetDir);
      let savedConfig;
      try {
        savedConfig = fs.readFileSync(W.join(targetDir, 'powershell.config.json'));
      } catch {
        savedConfig = undefined;
      }
      let movedOld = false;
      let createdTarget = false;
      try {
        if (hadTarget) {
          fs.renameSync(targetDir, backup);
          movedOld = true;
        }
        fs.mkdirSync(targetDir, { recursive: true });
        createdTarget = true;
        fs.cpSync(staging, targetDir, { recursive: true, force: true });
        // Keep the user's PowerShell configuration across a ZIP upgrade.
        if (savedConfig !== undefined) {
          fs.writeFileSync(W.join(targetDir, 'powershell.config.json'), savedConfig);
        }
        const probe = await probeImpl(targetExe, { env, signal });
        if (!probe.ok || comparePwshVersions(probe.version, release.version) < 0) {
          throw new Error(
            `the replaced ${targetExe} reports ${probe.version ?? 'no version'} instead of ${release.version}`,
          );
        }
        if (hadTarget) {
          try {
            fs.rmSync(backup, { recursive: true, force: true });
          } catch (caught) {
            warnings.push(`the previous copy is still at ${backup}: ${caught.message}`);
          }
        }
      } catch (caught) {
        try {
          // Only remove a directory this attempt created: a failed rename must leave the original
          // installation untouched.
          if (createdTarget) fs.rmSync(targetDir, { recursive: true, force: true });
          if (movedOld && fs.existsSync(backup)) fs.renameSync(backup, targetDir);
        } catch (rollbackError) {
          warnings.push(`rollback failed: ${rollbackError.message}`);
        }
        throw caught;
      }
    } else {
      phase('elevate');
      const outcome = await (runZipReplace ?? runElevatedZipReplace)({
        env,
        from: staging,
        targetDir,
        expectedVersion: release.version,
        legacyDirectories,
        pathScope,
        signal,
        isElevated: elevated,
      });
      if (!outcome?.ok) {
        const failure = new Error(
          outcome?.cancelled
            ? 'administrator approval was cancelled; approve the Windows UAC prompt and retry'
            : (outcome?.error ?? 'the portable PowerShell 7 upgrade did not complete'),
        );
        failure.elevationFailed = true;
        failure.cancelled = outcome?.cancelled === true;
        throw failure;
      }
      cleaned = outcome.cleaned ?? [];
      warnings = outcome.warnings ?? [];
    }

    phase('verify');
    const probe = await probeImpl(targetExe, { env, signal });
    if (!probe.ok) {
      throw new Error(
        `the upgraded ${targetExe} failed verification: ${tail(probe.output) || 'no version output'}`,
      );
    }
    if (comparePwshVersions(probe.version, release.version) < 0) {
      throw new Error(
        `${targetExe} still reports ${probe.version ?? 'an unknown version'} instead of ${release.version}`,
      );
    }

    if (direct && pathScope) {
      try {
        await updateInstallPath(targetExe, {
          env,
          scope: pathScope === 'Machine' ? 'system' : 'user',
          signal,
        });
      } catch (caught) {
        warnings.push(`could not update the ${pathScope} PATH: ${caught.message}`);
      }
    }
    for (const directory of legacyDirectories) removeProcessPathEntriesUnder(directory, env);
    persistPwshConfig(env, {
      path: targetExe,
      version: probe.version,
      method: 'portable',
      scope: plan.scope === 'system' ? 'system' : 'user',
    });
    return {
      ok: true,
      component: 'pwsh',
      scope: plan.scope === 'system' ? 'system' : 'user',
      method: 'portable',
      path: targetExe,
      version: probe.version,
      url: release.url,
      bytes,
      cleaned,
      warnings,
      legacyPaths,
      message: `replaced the portable PowerShell installation in place with ${probe.version} at ${targetExe}`,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    removeQuietly(archivePath);
    removeQuietly(staging);
  }
}

/** Store / Chocolatey / Scoop branch: let the owning package manager perform the upgrade. */
async function upgradePowerShell7WithPackageManager(context) {
  const {
    env,
    phase,
    plan,
    main,
    canonicalDir,
    legacyDirectories,
    legacyPaths,
    architecture,
    signal,
    fetchImpl,
    probeImpl,
    startedAt,
    isElevated,
    runPackageCommand,
  } = context;
  const targetExe = main?.path ?? W.join(canonicalDir, 'pwsh.exe');
  const release = await resolvePwsh7Release({ env, fetchImpl, signal, kind: 'zip', architecture });
  const latest = release?.version;

  let command;
  let args;
  let scope = plan.scope === 'system' ? 'system' : 'user';
  let method = plan.strategy;
  let elevated = false;
  if (plan.strategy === 'store') {
    command = resolveWingetPath(env);
    if (!command) {
      throw new Error(`winget is not available, so the Microsoft Store copy at ${targetExe} cannot be updated automatically. Update it from Microsoft Store.`);
    }
    args = [
      'upgrade', '--id', WINGET_PWSH_ID, '-e', '--source', 'msstore', '--silent',
      '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
    ];
    scope = 'user';
    elevated = true; // run winget directly; Store updates run in the user session
  } else if (plan.strategy === 'chocolatey') {
    command = resolveChocolateyPath(env);
    if (!command) {
      throw new Error('Chocolatey was detected but choco.exe could not be found; run "choco upgrade powershell-core -y" from an elevated terminal.');
    }
    args = ['upgrade', 'powershell-core', '-y', '--no-progress', '--limit-output'];
    scope = 'system';
    elevated = typeof isElevated === 'function'
      ? (await isElevated({ env, signal })) === true
      : (await isProcessElevated({ env, signal })) === true;
  } else {
    const scoop = resolveScoopPath(env);
    if (!scoop) {
      throw new Error('Scoop was detected but the scoop command could not be found; run "scoop update pwsh" yourself.');
    }
    const global = plan.global === true;
    const systemRootValue = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
    if (/\.ps1$/i.test(scoop)) {
      command = W.join(systemRootValue, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      args = [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scoop,
        'update', 'pwsh', ...(global ? ['-g'] : []),
      ];
    } else {
      command = W.join(systemRootValue, 'System32', 'cmd.exe');
      args = ['/d', '/s', '/c', `"${scoop}" update pwsh${global ? ' -g' : ''}`];
    }
    scope = global ? 'system' : 'user';
    if (global) {
      elevated = typeof isElevated === 'function'
        ? (await isElevated({ env, signal })) === true
        : (await isProcessElevated({ env, signal })) === true;
    } else {
      elevated = true; // user scoop runs unelevated
    }
  }

  phase(elevated ? 'installing' : 'elevate');
  const runner = runPackageCommand ?? runElevatedCommand;
  const outcome = await runner({
    env,
    file: command,
    args,
    isElevated: elevated,
    signal,
  });
  if (!outcome?.ok) {
    const failure = new Error(
      `${method} upgrade failed${outcome?.code !== undefined ? ` (exit ${outcome.code})` : ''}: `
      + `${tail(outcome?.output) || outcome?.error || 'no output'}`,
    );
    if (outcome?.cancelled) failure.elevationFailed = true;
    failure.hint = method === 'store'
      ? 'Update the Microsoft Store app manually from Microsoft Store, or run winget upgrade --id Microsoft.PowerShell --source msstore.'
      : `Run the ${method} upgrade manually from an elevated terminal.`;
    throw failure;
  }

  phase('verify');
  const probe = await probeImpl(targetExe, { env, signal });
  if (!probe.ok) {
    throw new Error(
      `${method} reported success, but ${targetExe} failed verification: `
      + `${tail(probe.output) || 'no version output'}`,
    );
  }
  if (latest && comparePwshVersions(probe.version, latest) < 0) {
    throw new Error(
      `${method} completed, but ${targetExe} still reports ${probe.version ?? 'an unknown version'} `
      + `instead of ${latest}. Close PowerShell windows and retry if the package manager scheduled the update.`,
    );
  }
  persistPwshConfig(env, {
    path: targetExe,
    version: probe.version,
    method,
    scope,
  });
  for (const directory of legacyDirectories) removeProcessPathEntriesUnder(directory, env);
  return {
    ok: true,
    component: 'pwsh',
    scope,
    method,
    path: targetExe,
    version: probe.version,
    url: release?.url,
    legacyPaths,
    message: `upgraded ${method} PowerShell to ${probe.version} at ${targetExe}`,
    durationMs: Date.now() - startedAt,
  };
}

function canWriteDirectory(directory) {
  try {
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function directoryOf(value) {
  return W.normalize(String(value ?? '')).replace(/[\\/]+$/, '');
}

/** Locate choco.exe for the Chocolatey strategy. */
export function resolveChocolateyPath(env = process.env) {
  const candidates = [
    env.DSH_CHOCO_PATH,
    W.join(env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin', 'choco.exe'),
  ];
  for (const entry of String(env.PATH ?? env.Path ?? '').split(W.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (directory) candidates.push(W.join(directory, 'choco.exe'));
  }
  return candidates.find((candidate) => typeof candidate === 'string' && fileOrSymlinkExists(candidate));
}

/** Locate the Scoop shim (cmd preferred) for the Scoop strategy. */
export function resolveScoopPath(env = process.env) {
  const userProfile = env.USERPROFILE ?? env.UserProfile ?? '';
  const candidates = [
    env.DSH_SCOOP_PATH,
    W.join(userProfile, 'scoop', 'shims', 'scoop.cmd'),
    W.join(env.ProgramData ?? 'C:\\ProgramData', 'scoop', 'shims', 'scoop.cmd'),
    W.join(userProfile, 'scoop', 'shims', 'scoop.ps1'),
    W.join(env.ProgramData ?? 'C:\\ProgramData', 'scoop', 'shims', 'scoop.ps1'),
  ];
  for (const entry of String(env.PATH ?? env.Path ?? '').split(W.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (directory) {
      candidates.push(W.join(directory, 'scoop.cmd'));
      candidates.push(W.join(directory, 'scoop.ps1'));
    }
  }
  return candidates.find((candidate) => typeof candidate === 'string' && fileOrSymlinkExists(candidate));
}

/** Per-user portable install. System scope never reaches this function (it uses the MSI path). */
async function installPowerShell7Portable(context) {
  const {
    env,
    root,
    scope,
    persist,
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
    release: providedRelease,
  } = context;
  const phase = typeof onPhase === 'function' ? onPhase : () => {};

  let release;
  if (url) {
    const name = W.basename(new URL(url).pathname);
    const parsed = parsePwsh7ZipName(name);
    release = { url, name, version: version ?? parsed?.version ?? 'custom' };
  } else if (providedRelease !== undefined) {
    release = providedRelease;
  } else {
    release = await resolvePwsh7Release({
      env,
      fetchImpl,
      signal,
      architecture: resolvePwshArchitecture(env),
    });
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
  await persist({ path: pwshExe, version: installedVersion, method: 'portable' });
  return {
    ok: true,
    component: 'pwsh',
    scope,
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
 * Ensure PowerShell 7 is available in the selected scope.
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
  if (!['auto', 'portable', 'msi', 'winget'].includes(method)) {
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
