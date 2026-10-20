// Persistence for "the initial setup dialog has been shown and confirmed".
//
// The setup dialog is the confirmation surface for two facts: whether PowerShell 7 is present and
// where it came from, and which prompt-injection level the user wants. It opens once even when
// PowerShell 7 is already detected, and stays closed after the user confirms (or installs).
//
// Stored next to `route`/`dialect` in the router config so one file remains the source of truth.

import { configFile, readRouterConfig, routerConfigGeneration, writeRouterConfig } from './paths.mjs';

/** The dialog has not been confirmed yet. */
export const DEFAULT_ONBOARDING = Object.freeze({ completed: false });

/** Memoized like `readDialect`: one snapshot never touches the file after the last config write. */
let memo;

/**
 * Read the confirmation flag, degrading to "not completed" when the config is missing or broken.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ completed: boolean }}
 */
export function readOnboarding(env = process.env) {
  const file = configFile(env);
  const generation = routerConfigGeneration();
  if (memo !== undefined && memo.file === file && memo.generation === generation) return memo.value;
  let value;
  try {
    const config = readRouterConfig(env);
    value = { completed: config?.onboarding?.completed === true };
  } catch {
    value = { ...DEFAULT_ONBOARDING };
  }
  memo = { file, generation, value };
  return value;
}

/**
 * Persist the confirmation flag additively (other config keys are preserved).
 * @param {boolean} completed
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ completed: boolean }}
 */
export function writeOnboarding(completed, env = process.env) {
  const next = { completed: completed === true };
  let current = {};
  try {
    current = readRouterConfig(env) ?? {};
  } catch {
    current = {};
  }
  writeRouterConfig({ ...current, onboarding: next }, env);
  return next;
}
