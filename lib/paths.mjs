// lib/paths.mjs — synchronous PowerShell 7 detection and router config IO.
//
// Windows-only semantics: paths are handled with path.win32 so an injected fake environment
// behaves the same regardless of the host OS the tests run on. Only Node builtins are used.
//
// Public contract:
//   ROUTER_DIR_NAME, DSH_DIR_NAME, CONFIG_FILE_NAME
//   routerRoot, configFile
//   candidatePwshPaths, discoveredPortablePwshPaths
//   findPwsh, isPowerShell7, probePwsh
//   readRouterConfig, writeRouterConfig
//
// Extra exports are lower-level helpers used by install.mjs and the node:test suites.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const W = path.win32;

export const ROUTER_DIR_NAME = 'pwsh7';
export const DSH_DIR_NAME = 'dsh';
export const CONFIG_FILE_NAME = 'config.json';

const DEFAULT_PROBE_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Paths and config file location
// ---------------------------------------------------------------------------

/** Per-user AppData\Local directory, from an injected environment (testable). */
export function localAppData(env) {
  const fromEnv = env.LOCALAPPDATA ?? env.LocalAppData ?? env.localappdata;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  const home = env.USERPROFILE ?? env.UserProfile ?? env.HOME ?? os.homedir();
  return W.join(home, 'AppData', 'Local');
}

export function routerRoot(env = process.env) {
  return W.join(localAppData(env), DSH_DIR_NAME, ROUTER_DIR_NAME);
}

export function configFile(env = process.env) {
  return W.join(routerRoot(env), CONFIG_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Candidate list (first existing wins)
// ---------------------------------------------------------------------------

function pushUnique(list, value, seen) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim().replace(/^"(.*)"$/, '$1');
  if (!trimmed) return;
  const normalised = W.normalize(trimmed);
  const key = normalised.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  list.push(normalised);
}

/** PATH entries of an injected environment, trimmed and unquoted. */
export function pathEntries(env) {
  const raw = env.PATH ?? env.Path ?? env.path;
  if (typeof raw !== 'string' || !raw) return [];
  return raw
    .split(W.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

/**
 * True when `target` is `base` or lives below it (case-insensitive, quote/trailing-slash tolerant).
 * Used to decide whether an executable or PATH entry belongs to the plugin-managed router root.
 */
export function isPathInside(target, base) {
  if (typeof target !== 'string' || typeof base !== 'string') return false;
  const normalise = (value) => {
    const trimmed = value.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed) return '';
    return W.normalize(trimmed).replace(/[\\/]+$/, '').toLowerCase();
  };
  const targetValue = normalise(target);
  const baseValue = normalise(base);
  if (!targetValue || !baseValue) return false;
  return targetValue === baseValue || targetValue.startsWith(baseValue + W.sep);
}

function readInstalledConfig(env) {
  const config = readRouterConfig(env);
  return config && typeof config === 'object' ? config : undefined;
}

function compareVersionDesc(a, b) {
  const pa = String(a).split(/[.-]/).map((part) => Number(part) || 0);
  const pb = String(b).split(/[.-]/).map((part) => Number(part) || 0);
  const length = Math.max(pa.length, pb.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (pb[index] ?? 0) - (pa[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** <routerRoot>\powershell7\<version>\pwsh.exe for each versioned portable install, newest first. */
export function discoveredPortablePwshPaths(env = process.env) {
  const base = W.join(routerRoot(env), 'powershell7');
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersionDesc);
  return versions.map((version) => W.join(base, version, 'pwsh.exe'));
}

/**
 * Candidate pwsh.exe paths, in contract order: DSH_PWSH_PATH, config pwshPath,
 * %ProgramFiles%\PowerShell\7, <routerRoot>\powershell7, %LOCALAPPDATA%\Programs\PowerShell\7,
 * every PATH entry, the Store alias, %ProgramFiles(x86)%\PowerShell\7, then versioned portable
 * installs discovered on disk.
 */
export function candidatePwshPaths(env = process.env) {
  const list = [];
  const seen = new Set();
  const config = readInstalledConfig(env);
  const appData = localAppData(env);
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
  const programFilesX86 =
    env['ProgramFiles(x86)'] ??
    env['PROGRAMFILES(X86)'] ??
    env['ProgramFiles(X86)'] ??
    'C:\\Program Files (x86)';

  pushUnique(list, env.DSH_PWSH_PATH, seen);
  if (config) pushUnique(list, config.pwshPath, seen);
  pushUnique(list, W.join(programFiles, 'PowerShell', '7', 'pwsh.exe'), seen);
  pushUnique(list, W.join(routerRoot(env), 'powershell7', 'pwsh.exe'), seen);
  pushUnique(list, W.join(appData, 'Programs', 'PowerShell', '7', 'pwsh.exe'), seen);
  for (const entry of pathEntries(env)) pushUnique(list, W.join(entry, 'pwsh.exe'), seen);
  pushUnique(list, W.join(appData, 'Microsoft', 'WindowsApps', 'pwsh.exe'), seen);
  pushUnique(list, W.join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'), seen);
  for (const discovered of discoveredPortablePwshPaths(env)) pushUnique(list, discovered, seen);

  return list;
}

// ---------------------------------------------------------------------------
// Existence checks
// ---------------------------------------------------------------------------

/** True when `target` is a regular file, or a symlink/reparse alias that may not stat as a file. */
export function fileOrSymlinkExists(target) {
  if (typeof target !== 'string' || !target.trim()) return false;
  try {
    return fs.statSync(target).isFile();
  } catch {
    // fall through to lstat (e.g. a Store app-execution alias)
  }
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** First candidate that exists as a file/symlink. */
export function findPwsh(options = {}) {
  const env = options.env ?? process.env;
  for (const candidate of candidatePwshPaths(env)) {
    if (fileOrSymlinkExists(candidate)) return { path: candidate };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Router config JSON
// ---------------------------------------------------------------------------

/**
 * Read %LOCALAPPDATA%\dsh\pwsh7\config.json; undefined when missing or invalid.
 * Only `pwshPath` / `installed.pwsh` are meaningful to this module; unknown keys are left
 * untouched by writeRouterConfig callers and never required here.
 */
export function readRouterConfig(env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(configFile(env), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic-ish JSON write (temp file + rename, direct-write fallback). Sets `version`/`updatedAt`. */
export function writeRouterConfig(config, env = process.env) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('writeRouterConfig(config): config must be a plain object');
  }
  const root = routerRoot(env);
  fs.mkdirSync(root, { recursive: true });
  const file = configFile(env);
  const payload = { ...config };
  if (payload.version === undefined) payload.version = 1;
  payload.updatedAt = new Date().toISOString();
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, json, 'utf8');
    try {
      fs.renameSync(temp, file);
    } catch {
      fs.writeFileSync(file, json, 'utf8');
      try {
        fs.unlinkSync(temp);
      } catch {
        // best effort cleanup
      }
    }
  } finally {
    if (fs.existsSync(temp)) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // best effort cleanup
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Async version probes (child_process only, no shell interpolation)
// ---------------------------------------------------------------------------

/** Default runner: execFile with timeout, no shell, injectable `run` in tests. */
export function execFileProbe(file, args, options = {}) {
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
          timeout: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
          env: options.env ?? process.env,
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

/** Parse `$PSVersionTable.PSVersion.Major` output (tolerant of extra lines). */
export function parsePwshMajor(output) {
  const text = String(output ?? '');
  const standalone = /^\s*(\d+)\s*$/m.exec(text);
  if (standalone) return Number(standalone[1]);
  const version = parsePwshVersion(text);
  return version ? Number(version.split('.')[0]) : undefined;
}

/** Parse the first x.y[.z] version token from command output. */
export function parsePwshVersion(output) {
  const match = /(\d+\.\d+(?:\.\d+){0,2})/.exec(String(output ?? ''));
  return match ? match[1] : undefined;
}

const PWSH_MAJOR_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '$PSVersionTable.PSVersion.Major',
];
const PWSH_VERSION_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '$PSVersionTable.PSVersion.ToString()',
];

/** True when `pwshPath` runs and reports a PowerShell major version >= 7. Never throws. */
export async function isPowerShell7(pwshPath, options = {}) {
  if (typeof pwshPath !== 'string' || !pwshPath.trim()) return false;
  const run = options.run ?? execFileProbe;
  try {
    const result = await run(pwshPath, PWSH_MAJOR_ARGS, {
      env: options.env,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    if (!result?.ok) return false;
    const major = parsePwshMajor(result.stdout);
    return typeof major === 'number' && Number.isFinite(major) && major >= 7;
  } catch {
    return false;
  }
}

/** Probe a pwsh.exe: { ok, version, output }. Never throws. */
export async function probePwsh(pwshPath, options = {}) {
  if (typeof pwshPath !== 'string' || !pwshPath.trim()) {
    return { ok: false, version: undefined, output: '' };
  }
  const run = options.run ?? execFileProbe;
  try {
    const result = await run(pwshPath, PWSH_VERSION_ARGS, {
      env: options.env,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    const output = [result?.stdout, result?.stderr]
      .filter((part) => typeof part === 'string' && part.trim())
      .join('\n')
      .trim();
    const version = parsePwshVersion(result?.stdout) ?? parsePwshVersion(output);
    const major = version ? Number(version.split('.')[0]) : undefined;
    return { ok: Boolean(result?.ok) && major >= 7, version, output };
  } catch (error) {
    return { ok: false, version: undefined, output: String(error?.message ?? error) };
  }
}
