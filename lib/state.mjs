// Shared PowerShell 7 routing state.
//
// One process-wide resolution cache used by both the pwsh executor and the model-facing tool.
// Priority, highest first:
//   1. environment override (DSH_PWSH_PATH)
//   2. %LOCALAPPDATA%\dsh\pwsh7\config.json (written by the installer tool)
//   3. well-known locations and PATH probing (lib/paths.mjs)
//
// Detection is synchronous because the pwsh executor's `pwshPath` getter is synchronous; version
// probes are async and live in lib/status.mjs.

import { existsSync } from 'node:fs';
import {
  candidatePwshPaths,
  configFile,
  findPwsh,
  readRouterConfig,
  routerConfigGeneration,
} from './paths.mjs';
import { effectiveRoute } from './route.mjs';

// Detection is cached because every executor call, state snapshot and SSE frame asks for it.
// Ten seconds keeps the synchronous filesystem probe off those hot paths; every in-process write
// (install, route, dialect, onboarding) calls refreshRouterState() explicitly, so the longer TTL
// never leaves the surfaces that matter stale.
const CACHE_TTL_MS = 10_000;

/** @type {{ at: number, generation: number, state: RouterState } | undefined} */
let cache;

/**
 * Listeners told every time the executor resolves a missing pwsh.
 *
 * The Web setup dialog needs to know that a `pwsh` tool call has just failed, not only that the
 * executable is absent: "show the download prompt on every run" means every failed run re-opens it
 * even when the user dismissed the previous prompt. The executor getter is synchronous, so the
 * notification is synchronous and must never throw into the tool-call path.
 *
 * @type {Set<() => void>}
 */
const missingListeners = new Set();

/**
 * Subscribe to "the pwsh executor asked for a missing PowerShell 7".
 * @param {() => void} listener
 * @returns {() => void} unsubscribe
 */
export function onPwshMissing(listener) {
  missingListeners.add(listener);
  return () => missingListeners.delete(listener);
}

/**
 * Record one failed pwsh resolution and notify subscribers.
 * Called by {@link requirePwshPath} before it throws; a listener failure is swallowed.
 */
export function notePwshMissing() {
  for (const listener of [...missingListeners]) {
    try {
      listener();
    } catch {
      // A UI hook must never turn a missing executable into a different error.
    }
  }
}

/**
 * @typedef {object} PwshFact
 * @property {boolean} found
 * @property {string} [path]
 * @property {string} [source] which layer resolved it
 * @property {string[]} [candidates] probed paths, for setup guidance
 */

/**
 * @typedef {object} RouterState
 * @property {number} at
 * @property {string} platform
 * @property {PwshFact} pwsh
 * @property {string} configPath
 * @property {object|undefined} config
 * @property {'plugin'|'system'} route effective routing mode
 * @property {boolean} routeConfigured whether config.json carried an explicit route key
 * @property {string[]} notes
 */

function isFile(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function configuredPwshPath(config) {
  if (config === undefined || typeof config !== 'object') return undefined;
  if (typeof config.pwshPath === 'string' && config.pwshPath.length > 0) return config.pwshPath;
  const installed = config.installed?.pwsh;
  return typeof installed?.path === 'string' && installed.path.length > 0 ? installed.path : undefined;
}

function detectPwsh(env, config, candidates) {
  const envPath = env.DSH_PWSH_PATH;
  if (typeof envPath === 'string' && envPath.length > 0 && isFile(envPath)) {
    return { found: true, path: envPath, source: 'env', candidates };
  }
  const configured = configuredPwshPath(config);
  if (configured !== undefined && isFile(configured)) {
    return { found: true, path: configured, source: 'config', candidates };
  }
  const detected = findPwsh({ env, config });
  if (detected !== undefined) {
    return { found: true, path: detected.path, source: detected.source ?? 'detected', candidates };
  }
  return { found: false, candidates };
}

/** @returns {RouterState} */
export function getRouterState() {
  const at = Date.now();
  const generation = routerConfigGeneration();
  if (cache !== undefined && at - cache.at <= CACHE_TTL_MS && cache.generation === generation) {
    return cache.state;
  }
  const state = detectState();
  cache = { at, generation, state };
  return state;
}

/** Force a fresh detection pass (after an install or config reload). */
export async function refreshRouterState() {
  cache = undefined;
  return getRouterState();
}

export function configPath() {
  return getRouterState().configPath;
}

/** The PowerShell 7 executable for the pwsh executor; throws a setup hint when missing. */
export function requirePwshPath() {
  const state = getRouterState();
  if (state.pwsh.found && typeof state.pwsh.path === 'string') return state.pwsh.path;
  notePwshMissing();
  throw new Error(
    'pwsh7-router: PowerShell 7 (pwsh.exe) was not found. '
    + 'The Web app opens a setup dialog where the user can install it (no administrator needed for the user scope); '
    + 'the same action is available in Settings → PowerShell 7, or the user can set DSH_PWSH_PATH or install PowerShell 7 manually. '
    + `Looked for: ${(state.pwsh.candidates ?? []).join(' | ')}`,
  );
}

/** True when PowerShell 7 resolved; used by status/diagnose without throwing. */
export function pwshReady(state = getRouterState()) {
  return Boolean(state.pwsh.found);
}

/** Detect PowerShell 7 once. Kept separate from the cache so tests can call it directly. */
export function detectState() {
  const env = process.env;
  const notes = [];
  let config;
  try {
    config = readRouterConfig(env);
  } catch (error) {
    notes.push(`config read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidates = candidatePwshPaths(env);
  return {
    at: Date.now(),
    platform: process.platform,
    pwsh: detectPwsh(env, config, candidates),
    configPath: configFile(env),
    config,
    route: effectiveRoute(config),
    routeConfigured: Boolean(
      config !== undefined
      && config !== null
      && typeof config === 'object'
      && Object.prototype.hasOwnProperty.call(config, 'route'),
    ),
    notes,
  };
}
