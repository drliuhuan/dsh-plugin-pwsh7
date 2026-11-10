// The deletion-protection switch (Settings → PowerShell 7 → Deletion protection).
//
// Default ON: every removal is redirected to the Recycle Bin, destructive command forms and
// protected locations are refused, and scripts are inspected before they run. The user may turn it
// off from the settings page (behind two consecutive warnings); the switch then makes deletions
// behave exactly like stock PowerShell — permanent — with no prelude, no bridge and no refusals.
//
// Stored additively in the router config so an older config file keeps working (absent => on).

import { readRouterConfig, writeRouterConfig } from './paths.mjs';

/** The documented default: protection on. */
export const DEFAULT_DELETION_GUARD = true;

/**
 * Whether deletion protection is on for this deployment.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function readDeletionGuard(env = process.env) {
  try {
    const config = readRouterConfig(env);
    const value = config?.deletionGuard;
    return value === undefined ? DEFAULT_DELETION_GUARD : value === true;
  } catch {
    // A broken config must fail safe: keep the protection on.
    return DEFAULT_DELETION_GUARD;
  }
}

/**
 * Persist the switch additively (other config keys are preserved) and return the stored value.
 * @param {boolean} enabled
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function writeDeletionGuard(enabled, env = process.env) {
  const next = enabled === true;
  let current = {};
  try {
    current = readRouterConfig(env) ?? {};
  } catch {
    current = {};
  }
  writeRouterConfig({ ...current, deletionGuard: next }, env);
  return next;
}

/**
 * The snapshot shape the settings page renders.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ enabled: boolean }}
 */
export function describeDeletionGuard(env = process.env) {
  return { enabled: readDeletionGuard(env) };
}
