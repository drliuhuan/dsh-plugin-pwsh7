// Routing mode, system-default executable resolution, and read-only install description.
//
// Two routes exist for the `pwsh` tool:
//
//   * "plugin" (default) — the per-user copy this plugin installs, then DSH_PWSH_PATH/config, then
//     well-known locations and PATH (see lib/state.mjs / lib/paths.mjs);
//   * "system" — the machine's own PowerShell 7 (or Windows PowerShell 5.1 as a last resort),
//     resolved WITHOUT consulting DSH_PWSH_PATH, config.pwshPath, or any plugin-managed copy.
//
// `resolveSystemPwsh` is deliberately synchronous and dependency-free at call time: the executor's
// `pwshPath` getter is synchronous, and a missing PowerShell must never throw during import.

import fs from 'node:fs';
import path from 'node:path';

import {
  discoveredPortablePwshPaths,
  fileOrSymlinkExists,
  isPathInside,
  localAppData,
  pathEntries,
  readRouterConfig,
  routerRoot,
  writeRouterConfig,
} from './paths.mjs';
import { installDirectory } from './install-scope.mjs';

const W = path.win32;

/** Route values accepted by the config and the HTTP API. Missing/unknown means "plugin". */
export const ROUTE_MODES = Object.freeze(['plugin', 'system']);

const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);
let cachedPluginVersion;

/** This package's version, read once from its own package.json; null when unreadable. */
export function pluginVersion() {
  if (cachedPluginVersion !== undefined) return cachedPluginVersion;
  try {
    const manifest = JSON.parse(fs.readFileSync(PACKAGE_JSON_URL, 'utf8'));
    cachedPluginVersion = typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    cachedPluginVersion = null;
  }
  return cachedPluginVersion;
}

// ---------------------------------------------------------------------------
// Route config (additive key on the existing v1 router config)
// ---------------------------------------------------------------------------

/** Effective route for a router config object. Unknown/missing → "plugin". */
export function effectiveRoute(config) {
  return config !== undefined
    && config !== null
    && typeof config === 'object'
    && !Array.isArray(config)
    && config.route === 'system'
    ? 'system'
    : 'plugin';
}

/**
 * Read the configured route. `configured` is false when config.json has no `route` key (old v1
 * configs, or no config at all); the effective mode is still the default "plugin".
 */
export function routeInfo(env = process.env) {
  const config = readRouterConfig(env);
  const configured = config !== undefined
    && typeof config === 'object'
    && Object.prototype.hasOwnProperty.call(config, 'route');
  return { mode: effectiveRoute(config), configured, config };
}

/**
 * Persist `route` additively: other keys (pwshPath, installed, legacy keys) are preserved, the
 * atomic write behavior of writeRouterConfig is reused. Callers refresh the router state cache.
 */
export function writeRouteConfig(mode, env = process.env) {
  if (!ROUTE_MODES.includes(mode)) {
    throw new TypeError(`unsupported route ${JSON.stringify(mode)}`);
  }
  const current = readRouterConfig(env) ?? {};
  const next = { ...current, route: mode, version: current.version ?? 1 };
  writeRouterConfig(next, env);
  return next;
}

// ---------------------------------------------------------------------------
// System-default resolution (route = "system")
// ---------------------------------------------------------------------------

function defaultProgramFiles(env) {
  return env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
}

function defaultProgramFilesX86(env) {
  return env['ProgramFiles(x86)']
    ?? env['PROGRAMFILES(X86)']
    ?? env['ProgramFiles(X86)']
    ?? 'C:\\Program Files (x86)';
}

function systemRoot(env) {
  return env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? 'C:\\Windows';
}

/**
 * Ordered candidates for the "system default" route (contract order). PATH entries under the
 * plugin router root are skipped so an installed per-user copy can never leak into this route.
 */
export function systemPwshCandidates(env = process.env) {
  const list = [];
  const seen = new Set();
  const root = routerRoot(env);
  const push = (candidate) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    const normalised = W.normalize(candidate.trim().replace(/^"(.*)"$/, '$1'));
    const key = normalised.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(normalised);
  };

  const appData = localAppData(env);
  push(W.join(defaultProgramFiles(env), 'PowerShell', '7', 'pwsh.exe'));
  push(W.join(defaultProgramFilesX86(env), 'PowerShell', '7', 'pwsh.exe'));
  push(W.join(appData, 'Programs', 'PowerShell', '7', 'pwsh.exe'));
  push(W.join(appData, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  for (const entry of pathEntries(env)) {
    const directory = W.normalize(entry);
    if (isPathInside(directory, root)) continue;
    push(W.join(directory, 'pwsh.exe'));
  }
  push(W.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  return list;
}

/**
 * Resolve the executable the "system default" route would spawn: the first existing candidate,
 * Windows PowerShell 5.1 as the stock last resort, then the literal `"pwsh"` (PATH lookup by the
 * caller). Never consults DSH_PWSH_PATH or config.pwshPath and never throws.
 */
export function resolveSystemPwsh(env = process.env) {
  try {
    for (const candidate of systemPwshCandidates(env)) {
      if (fileOrSymlinkExists(candidate)) return candidate;
    }
  } catch {
    // A malformed injected environment must not break the executor getter.
  }
  return 'pwsh';
}

/**
 * Executor getter branch, extracted so tests can exercise both routes without loading the shipped
 * sandbox package: explicit row config wins; otherwise "system" resolves the system executable and
 * "plugin" delegates to the shared router state (which raises the setup hint when missing).
 */
export function resolveExecutorPwshPath(declared, options = {}) {
  if (typeof declared === 'string' && declared.trim().length > 0) return declared;
  const env = options.env ?? process.env;
  let route = 'plugin';
  try {
    route = effectiveRoute(typeof options.getState === 'function' ? options.getState() : undefined);
  } catch {
    route = 'plugin';
  }
  if (route === 'system') {
    return (options.resolveSystem ?? resolveSystemPwsh)(env);
  }
  if (typeof options.requirePath === 'function') return options.requirePath();
  throw new Error(
    'pwsh7-router: PowerShell 7 (pwsh.exe) was not found. '
    + 'Use the Web setup dialog or Settings → PowerShell 7 to install it, set DSH_PWSH_PATH, or install PowerShell 7 manually.',
  );
}

// ---------------------------------------------------------------------------
// Read-only installation description (state snapshot + self-check)
// ---------------------------------------------------------------------------

function versionFromExecutable(pwshPath) {
  if (typeof pwshPath !== 'string' || !pwshPath.trim()) return null;
  const directory = W.basename(W.dirname(W.normalize(pwshPath)));
  return /^\d+\.\d+(?:\.\d+)*$/.test(directory) ? directory : null;
}

/** True when `directory` is present in this environment's PATH (normalized comparison). */
export function directoryOnPath(directory, env = process.env) {
  if (typeof directory !== 'string' || !directory.trim()) return false;
  const target = W.normalize(directory).replace(/[\\/]+$/, '').toLowerCase();
  return pathEntries(env).some(
    (entry) => W.normalize(entry).replace(/[\\/]+$/, '').toLowerCase() === target,
  );
}

/**
 * Describe the current installation (independent of the active route) for `/pwsh7/state`,
 * `shell_router status`, and the self-check. Synchronous and tolerant of missing config/files.
 *
 * @param {{ env?: NodeJS.ProcessEnv, root?: string, state?: object, config?: object }} [options]
 */
export function describeInstall(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? routerRoot(env);
  const state = options.state;
  const config = options.config ?? state?.config;
  const configured = config !== undefined && config !== null && typeof config === 'object'
    ? config.installed?.pwsh
    : undefined;
  const configuredPath = typeof configured?.path === 'string' && configured.path.trim()
    ? configured.path
    : undefined;

  const userCopies = discoveredPortablePwshPaths(env).filter((candidate) => fileOrSymlinkExists(candidate));
  const userCopy = userCopies.length > 0;
  const systemDir = installDirectory(env, 'system', root);
  const systemExe = W.join(systemDir, 'pwsh.exe');
  const systemCopy = fileOrSymlinkExists(systemExe);
  const resolvedStatePath = state?.pwsh?.found === true && typeof state.pwsh.path === 'string'
    ? state.pwsh.path
    : undefined;

  let executablePath;
  if (configuredPath !== undefined && fileOrSymlinkExists(configuredPath)) executablePath = configuredPath;
  else if (resolvedStatePath !== undefined && fileOrSymlinkExists(resolvedStatePath)) executablePath = resolvedStatePath;
  else if (userCopy) [executablePath] = userCopies;
  else if (systemCopy) executablePath = systemExe;

  const directory = executablePath ? W.dirname(W.normalize(executablePath)) : null;
  const managed = Boolean(
    executablePath !== undefined
    && isPathInside(executablePath, W.join(root, 'powershell7')),
  );

  let scope = null;
  if (managed) scope = 'user';
  else if (executablePath !== undefined && isPathInside(executablePath, systemDir)) scope = 'system';
  else if (configured?.scope === 'user' || configured?.scope === 'system') scope = configured.scope;

  const removable = Boolean(
    managed
    && scope === 'user'
    && executablePath !== undefined
    && isPathInside(executablePath, root),
  );

  let method = typeof configured?.method === 'string' && configured.method ? configured.method : null;
  if (method === null) {
    if (managed) method = 'portable';
    else if (executablePath !== undefined) method = 'existing';
  }

  const version = versionFromExecutable(executablePath)
    ?? (typeof configured?.version === 'string' ? configured.version : null);

  return {
    exists: executablePath !== undefined,
    managed,
    removable,
    scope,
    method,
    version,
    path: executablePath ?? null,
    directory,
    userCopy,
    systemCopy,
    pathEntry: directory === null ? false : directoryOnPath(directory, env),
  };
}
