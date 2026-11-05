// Persistence for the opt-in prompt-injection level.
//
// The choice lives in the same router config as `route`/`installed`, so one file is the source of
// truth for the settings page, the setup dialog, the prompt section, and the shell_router tool.
//
// Defaults are OFF: upgrading an existing installation never starts spending prompt tokens until
// the user turns the guidance on in the setup dialog or Settings → PowerShell 7.
//
// `readDialect` runs on the model-prompt assembly path, so it is memoized against the router
// config's in-process write generation: a steady session does no filesystem access at all, and any
// `writeRouterConfig` bump invalidates it on the next read.

import { configFile, readRouterConfig, routerConfigGeneration, writeRouterConfig } from './paths.mjs';
import { dialectPromptSizes, normalizeDialect } from './dialect.mjs';
import { effectiveRoute } from './route.mjs';

/** Both levels disabled. */
export const DEFAULT_DIALECT = Object.freeze({ common: false, force: false });

/** Prompt sizes are constant for a build; compute them once. */
const PROMPT_SIZES = dialectPromptSizes();

/** @type {{ file: string, generation: number, value: { common: boolean, force: boolean } } | undefined} */
let memo;

/**
 * Read the stored level, degrading to the defaults when the config is missing or unreadable.
 * Memoized by (config file, write generation):
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ common: boolean, force: boolean }}
 */
export function readDialect(env = process.env) {
  const file = configFile(env);
  const generation = routerConfigGeneration();
  if (memo !== undefined && memo.file === file && memo.generation === generation) return memo.value;
  let value;
  try {
    const config = readRouterConfig(env);
    // The forced `pwsh5` route disables every PowerShell 7 prompt layer, without discarding the
    // level the user stored for the plugin/system routes: leaving pwsh5 restores it.
    value = effectiveRoute(config) === 'pwsh5'
      ? { ...DEFAULT_DIALECT }
      : normalizeDialect(config?.dialect);
  } catch {
    value = { ...DEFAULT_DIALECT };
  }
  memo = { file, generation, value };
  return value;
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
  return { ...readDialect(env), sizes: PROMPT_SIZES };
}
