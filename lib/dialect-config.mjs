// Persistence for the opt-in prompt-injection level.
//
// The choice lives in the same router config as `route`/`installed`, so one file is the source of
// truth for the settings page, the setup dialog, the prompt section, and the shell_router tool.
//
// Defaults are OFF: upgrading an existing installation never starts spending prompt tokens until
// the user turns the guidance on in the setup dialog or Settings → PowerShell 7.

import { readRouterConfig, writeRouterConfig } from './paths.mjs';
import { dialectPromptSizes, normalizeDialect } from './dialect.mjs';

/** Both levels disabled. */
export const DEFAULT_DIALECT = Object.freeze({ common: false, force: false });

/**
 * Read the stored level, degrading to the defaults when the config is missing or unreadable.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ common: boolean, force: boolean }}
 */
export function readDialect(env = process.env) {
  try {
    const config = readRouterConfig(env);
    return normalizeDialect(config?.dialect);
  } catch {
    return { ...DEFAULT_DIALECT };
  }
}

/**
 * Persist a level additively (other config keys are preserved) and return the normalized value.
 * `force` implies `common`.
 * @param {{ common?: boolean, force?: boolean }} value
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ common: boolean, force: boolean }}
 */
export function writeDialect(value, env = process.env) {
  const next = normalizeDialect(value);
  let current = {};
  try {
    current = readRouterConfig(env) ?? {};
  } catch {
    current = {};
  }
  writeRouterConfig({ ...current, dialect: next }, env);
  return next;
}

/**
 * The snapshot shape both surfaces render: the stored level plus the disclosed prompt cost.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function describeDialect(env = process.env) {
  return { ...readDialect(env), sizes: dialectPromptSizes() };
}
