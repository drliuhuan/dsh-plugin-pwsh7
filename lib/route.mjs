// Routing mode, system-default executable resolution, and read-only install description.
//
// Three routes exist for the `pwsh` tool:
//
//   * "plugin" (default) — the explicit Settings selection, then the installation this plugin (or
//     an installer) recorded, then well-known locations and PATH; DSH_PWSH_PATH outranks all of
//     them (see lib/state.mjs / lib/paths.mjs);
//   * "system" — the machine's own PowerShell 7 (or Windows PowerShell 5.1 as a last resort),
//     resolved WITHOUT consulting DSH_PWSH_PATH, the selected installation, config.pwshPath, or any
//     plugin-managed copy;
//   * "pwsh5" — force Windows PowerShell 5.1 (`%SystemRoot%\System32\WindowsPowerShell\v1.0\
//     powershell.exe`). The plugin's PowerShell 7 prompt guidance and dialect hints are disabled in
//     this mode; the user selects it from the composer chip (and the Settings page).
//
// `resolveSystemPwsh` / `resolvePowerShell5` are deliberately synchronous and dependency-free at
// call time: the executor's `pwshPath` getter is synchronous, and a missing PowerShell must never
// throw during import.

import fs from 'node:fs';
import path from 'node:path';

import {
  discoveredPortablePwshPaths,
  fileOrSymlinkExists,
  isPathInside,
  isStoreAliasPath,
  localAppData,
  pathEntries,
  readRouterConfig,
  routerRoot,
  writeRouterConfig,
} from './paths.mjs';
import { installDirectory, systemVersionedDirectories } from './install-scope.mjs';

const W = path.win32;

/** Route values accepted by the config and the HTTP API. Missing/unknown means "plugin". */
export const ROUTE_MODES = Object.freeze(['plugin', 'system', 'pwsh5']);

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
  if (config === undefined || config === null || typeof config !== 'object' || Array.isArray(config)) {
    return 'plugin';
  }
  if (config.route === 'system') return 'system';
  if (config.route === 'pwsh5') return 'pwsh5';
  return 'plugin';
}

/**
 * Read the configured route. `configured` is false when config.json has no `route` key (old v1
 * configs, or no config at all); the effective mode is still the default "plugin". `previous` is
 * the route the user had before forcing `pwsh5`, so the chip can restore it when leaving that mode.
 */
export function routeInfo(env = process.env) {
  const config = readRouterConfig(env);
  const configured = config !== undefined
    && config !== null
    && typeof config === 'object'
    && Object.prototype.hasOwnProperty.call(config, 'route');
  const mode = effectiveRoute(config);
  const previous = mode === 'pwsh5' && (config?.routeBeforePwsh5 === 'system')
    ? 'system'
    : 'plugin';
  return { mode, configured, previous, config };
}

/**
 * Persist `route` additively: other keys (pwshPath, installed, legacy keys) are preserved, the
 * atomic write behavior of writeRouterConfig is reused. Entering `pwsh5` remembers the previous
 * route so leaving it restores what the user had before; the key is removed on every other mode.
 * Callers refresh the router state cache.
 */
export function writeRouteConfig(mode, env = process.env) {
  if (!ROUTE_MODES.includes(mode)) {
    throw new TypeError(`unsupported route ${JSON.stringify(mode)}`);
  }
  const current = readRouterConfig(env) ?? {};
  const previous = effectiveRoute(current);
  const next = { ...current, route: mode, version: current.version ?? 1 };
  if (mode === 'pwsh5') {
    if (previous !== 'pwsh5') next.routeBeforePwsh5 = previous;
  } else {
    delete next.routeBeforePwsh5;
  }
  writeRouterConfig(next, env);
  return next;
}

// ---------------------------------------------------------------------------
// Explicit installation selection (the Settings dropdown)
// ---------------------------------------------------------------------------
//
// When a machine exposes several PowerShell 7 installations, the user can pin the one the plugin
// route runs. The selection is a plain executable path recorded additively in config.json, so an
// older config without the key keeps working and clearing the key restores automatic order.

/** The explicitly selected PowerShell 7 executable recorded in a router config, or null. */
export function selectedPwshPath(config) {
  const value = config !== null && typeof config === 'object' ? config.selectedPwshPath : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Display metadata for the selected installation: the probed version, scope and method recorded
 * when the user picked it. Purely additive and optional — a config with only `selectedPwshPath`
 * (or a hand-edited one) is valid, and the description then falls back to the usual inference.
 */
export function selectedPwshMeta(config) {
  const raw = config !== null && typeof config === 'object' ? config.selectedPwshMeta : undefined;
  if (raw === null || typeof raw !== 'object') return null;
  const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : null;
  const method = typeof raw.method === 'string' && raw.method.trim() ? raw.method.trim() : null;
  const scope = raw.scope === 'system' || raw.scope === 'user' ? raw.scope : null;
  if (version === null && method === null && scope === null) return null;
  return { version, method, scope };
}

/**
 * Persist (or clear, with null) the explicit installation selection. The selection only drives the
 * plugin route, so every non-pwsh5 route is switched to `plugin` so the pick takes effect; a forced
 * pwsh5 route is left alone (the user must leave pwsh5 first). Other config keys are preserved.
 */
export function writeSelectedPwshPath(value, env = process.env, meta = null) {
  const current = readRouterConfig(env) ?? {};
  const next = { ...current, version: current.version ?? 1 };
  const pathValue = typeof value === 'string' && value.trim() ? value.trim() : null;
  if (pathValue === null) {
    delete next.selectedPwshPath;
    delete next.selectedPwshMeta;
  } else {
    next.selectedPwshPath = pathValue;
    const info = meta !== null && typeof meta === 'object' ? meta : {};
    const record = {};
    if (typeof info.version === 'string' && info.version.trim()) record.version = info.version.trim();
    if (typeof info.method === 'string' && info.method.trim()) record.method = info.method.trim();
    if (info.scope === 'system' || info.scope === 'user') record.scope = info.scope;
    if (Object.keys(record).length > 0) next.selectedPwshMeta = record;
    else delete next.selectedPwshMeta;
  }
  // Choosing an installation is what needs the plugin route; clearing it back to automatic must
  // not silently switch a user off the system route they selected.
  if (pathValue !== null && effectiveRoute(current) !== 'pwsh5') {
    next.route = 'plugin';
    delete next.routeBeforePwsh5;
  }
  writeRouterConfig(next, env);
  return { selected: pathValue, route: effectiveRoute(next) };
}

/**
 * Remove the explicit installation selection without touching the route. Installers and maintenance
 * actions call this so the copy they just installed or recorded becomes the active one instead of
 * an older user pick.
 */
export function clearSelectedPwshPath(env = process.env) {
  const current = readRouterConfig(env);
  if (current === undefined || current === null || typeof current !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(current, 'selectedPwshPath')
    && !Object.prototype.hasOwnProperty.call(current, 'selectedPwshMeta')) {
    return null;
  }
  const next = { ...current };
  delete next.selectedPwshPath;
  delete next.selectedPwshMeta;
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

/** Absolute Windows PowerShell 5.1 executable for an environment. */
export function powerShell5Path(env = process.env) {
  return W.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Resolve the forced `pwsh5` route. Windows PowerShell 5.1 always ships with Windows; if the
 * absolute path is missing (an injected test environment, or a broken System32) fall back to the
 * bare `powershell` name so the caller still gets an actionable spawn error instead of a crash.
 */
export function resolvePowerShell5(env = process.env) {
  const absolute = powerShell5Path(env);
  try {
    if (fileOrSymlinkExists(absolute)) return absolute;
  } catch {
    // fall through to PATH lookup
  }
  return 'powershell';
}

/**
 * Executor getter branch, extracted so tests can exercise every route without loading the shipped
 * sandbox package: explicit row config wins; otherwise "system" resolves the system executable,
 * "pwsh5" resolves Windows PowerShell 5.1, and "plugin" delegates to the shared router state
 * (which raises the setup hint when missing).
 */
export function resolveExecutorPwshPath(declared, options = {}) {
  if (typeof declared === 'string' && declared.trim().length > 0) return declared;
  const env = options.env ?? process.env;
  let state;
  let route = 'plugin';
  try {
    state = typeof options.getState === 'function' ? options.getState() : undefined;
    // RouterState carries the effective mode in `route`; a bare config object carries `route` too.
    route = effectiveRoute(state);
  } catch {
    route = 'plugin';
  }
  if (route === 'system') {
    return (options.resolveSystem ?? resolveSystemPwsh)(env);
  }
  if (route === 'pwsh5') {
    return (options.resolvePowerShell5 ?? resolvePowerShell5)(env);
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
  const selectionMeta = selectedPwshMeta(config);
  const configuredPath = typeof configured?.path === 'string' && configured.path.trim()
    ? configured.path
    : undefined;
  // An explicit pick in the Settings dropdown outranks whatever the last install recorded: it is
  // the executable the plugin route actually runs.
  const selectedPath = selectedPwshPath(config);

  const userCopies = discoveredPortablePwshPaths(env).filter((candidate) => fileOrSymlinkExists(candidate));
  const userCopy = userCopies.length > 0;
  const systemDir = installDirectory(env, 'system', root);
  const systemExe = W.join(systemDir, 'pwsh.exe');
  const systemCopy = fileOrSymlinkExists(systemExe);
  // Side-by-side copies the plugin used to extract into the system directory
  // (`…\PowerShell\7\<version>`). They are not the official installation; expose them so the UI can
  // upgrade the canonical executable and remove the leftovers.
  const legacyCopies = systemVersionedDirectories(env, root);
  const legacySystemPaths = legacyCopies.map((entry) => entry.path);
  const resolvedStatePath = state?.pwsh?.found === true && typeof state.pwsh.path === 'string'
    ? state.pwsh.path
    : undefined;

  let executablePath;
  if (selectedPath !== null && fileOrSymlinkExists(selectedPath)) executablePath = selectedPath;
  else if (configuredPath !== undefined && fileOrSymlinkExists(configuredPath)) executablePath = configuredPath;
  else if (resolvedStatePath !== undefined && fileOrSymlinkExists(resolvedStatePath)) executablePath = resolvedStatePath;
  else if (userCopy) [executablePath] = userCopies;
  else if (systemCopy) executablePath = systemExe;

  const directory = executablePath ? W.dirname(W.normalize(executablePath)) : null;
  const managed = Boolean(
    executablePath !== undefined
    && isPathInside(executablePath, W.join(root, 'powershell7')),
  );
  const legacySystem = executablePath !== undefined && legacySystemPaths.some((candidate) => {
    const left = W.normalize(candidate).toLowerCase();
    return left === W.normalize(executablePath).toLowerCase();
  });

  const selectionActive = selectedPath !== null && executablePath === selectedPath;
  let scope = null;
  if (managed) scope = 'user';
  else if (executablePath !== undefined && isPathInside(executablePath, systemDir)) scope = 'system';
  else if (configured?.scope === 'user' || configured?.scope === 'system') scope = configured.scope;
  if (selectionActive && selectionMeta?.scope !== null && selectionMeta?.scope !== undefined) {
    scope = selectionMeta.scope;
  }

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
  if (legacySystem && method === 'portable') method = 'legacy-portable';
  if (selectionActive && selectionMeta?.method !== null && selectionMeta?.method !== undefined) {
    method = selectionMeta.method;
  }

  // A picked installation outranks the recorded install's version: the MSI canonical directory has
  // no version in its name, so `configured.version` can belong to a different installation.
  const version = (selectionActive && selectionMeta?.version !== null && selectionMeta?.version !== undefined
    ? selectionMeta.version
    : null)
    ?? versionFromExecutable(executablePath)
    ?? (selectionActive ? null : (typeof configured?.version === 'string' ? configured.version : null));

  // An MSIX app package's own directory under `%ProgramFiles%\WindowsApps` never appears on PATH:
  // the command is exposed through the `%LOCALAPPDATA%\Microsoft\WindowsApps` execution alias. Check
  // that alias directory so a healthy app-package install is not reported as missing from PATH.
  let pathEntry = directory === null ? false : directoryOnPath(directory, env);
  if (!pathEntry && executablePath !== undefined) {
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
    const aliasExe = W.join(localAppData(env), 'Microsoft', 'WindowsApps', 'pwsh.exe');
    if (isPathInside(executablePath, W.join(programFiles, 'WindowsApps'))
      && fileOrSymlinkExists(aliasExe)) {
      pathEntry = directoryOnPath(W.dirname(aliasExe), env);
    }
  }

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
    /** Canonical machine-wide target of the official installer (`…\PowerShell\7\pwsh.exe`). */
    systemExe,
    systemVersionedPaths: legacyCopies.map((entry) => entry.path),
    legacySystemPaths,
    legacySystem,
    pathEntry,
    /** Explicit Settings pick, when one is recorded (the plugin route is pinned to it). */
    selectedPath,
    selectionMissing: selectedPath !== null && !fileOrSymlinkExists(selectedPath),
  };
}
