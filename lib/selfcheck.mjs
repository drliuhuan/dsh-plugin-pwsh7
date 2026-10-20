// Read-only self-check for the PowerShell 7 router (`POST /pwsh7/selfcheck`, `shell_router` action
// `selfcheck`). Every probe is injectable and wrapped: a missing PowerShell, an invalid config, or
// an absent sandbox service is reported as a check status, never thrown.

import fs from 'node:fs';

import {
  configFile,
  fileOrSymlinkExists,
  probePwsh,
  routerRoot,
} from './paths.mjs';
import { describeShippedResolution } from './shipped.mjs';
import {
  describeInstall,
  effectiveRoute,
  pluginVersion,
  resolveSystemPwsh,
} from './route.mjs';

/** Check ids the client localizes titles for, in display order. */
export const SELFCHECK_IDS = Object.freeze([
  'plugin-version',
  'route',
  'executable',
  'version',
  'config',
  'install',
  'path-env',
  'shipped',
  'sandbox',
  'install-job',
  'routes',
]);

/** Routes the settings surface depends on; the route table check verifies they are all registered. */
const REQUIRED_ROUTES = Object.freeze([
  '/pwsh7/state',
  '/pwsh7/events',
  '/pwsh7/install',
  '/pwsh7/cancel',
  '/pwsh7/route',
  '/pwsh7/dialect',
  '/pwsh7/onboarding',
  '/pwsh7/latest',
  '/pwsh7/uninstall',
  '/pwsh7/relocate',
  '/pwsh7/selfcheck',
]);

function terse(text, limit = 400) {
  const value = String(text ?? '').replace(/\r\n/g, '\n').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function hasRouteKey(config) {
  return config !== undefined
    && config !== null
    && typeof config === 'object'
    && Object.prototype.hasOwnProperty.call(config, 'route');
}

function configExists(env) {
  try {
    return fs.existsSync(configFile(env));
  } catch {
    return false;
  }
}

function isPowerShell7Path(executable) {
  return typeof executable === 'string' && /pwsh\.exe$/i.test(executable);
}

function isWindowsPowerShellPath(executable) {
  return typeof executable === 'string' && /powershell\.exe$/i.test(executable);
}

/**
 * Run every read-only check.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.root]
 * @param {object} [options.state]            router state (lib/state.mjs), for the active route
 * @param {object} [options.install]          describeInstall() result
 * @param {string} [options.systemPath]       resolveSystemPwsh() result
 * @param {string[]} [options.routes]         registered exact route paths
 * @param {{ busy?: boolean, phase?: string, error?: string|null }} [options.job]
 * @param {object} [options.ctx]              plugin context, for the sandbox-policy check
 * @param {Function} [options.probe]          probePwsh seam
 * @param {Function} [options.describeShipped] describeShippedResolution seam
 * @returns {Promise<{ ok: boolean, checkedAt: string, checks: Array<{id:string,status:string,detail:string}>, summary: {ok:number,warn:number,fail:number} }>}
 */
export async function runSelfcheck(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? routerRoot(env);
  const state = options.state;
  const install = options.install ?? describeInstall({ env, root, state });
  const route = effectiveRoute(state?.config);
  const systemPath = options.systemPath ?? resolveSystemPwsh(env);
  const probe = options.probe ?? probePwsh;
  const describeShipped = options.describeShipped ?? describeShippedResolution;

  const checks = [];
  const add = (id, status, detail) => {
    checks.push({ id, status, detail: terse(detail) });
  };

  // 1. plugin-version
  const version = pluginVersion();
  add('plugin-version', version === null ? 'fail' : 'ok',
    version === null ? 'cannot read this package\'s version from package.json' : `dsh-plugin-pwsh7 ${version}`);

  // 2. route
  const configured = hasRouteKey(state?.config);
  add('route', 'ok', `${route}${configured ? ' (configured)' : ' (default; config has no route key)'}`);

  // 3. executable — what the active route would spawn
  let executable = null;
  if (route === 'system') {
    executable = systemPath;
    if (isPowerShell7Path(executable) && fileOrSymlinkExists(executable)) {
      add('executable', 'ok', executable);
    } else if (isWindowsPowerShellPath(executable) && fileOrSymlinkExists(executable)) {
      add('executable', 'warn',
        `${executable} — no system PowerShell 7 found; the system route falls back to Windows PowerShell 5.1`);
    } else {
      add('executable', 'fail',
        'no system PowerShell 7 and no Windows PowerShell were found; install PowerShell 7 or switch the route to plugin');
    }
  } else if (state?.pwsh?.found === true && typeof state.pwsh.path === 'string') {
    executable = state.pwsh.path;
    add('executable', 'ok', executable);
  } else {
    add('executable', 'fail',
      'PowerShell 7 (pwsh.exe) was not found; install it from the Web setup dialog or Settings → PowerShell 7, or install it manually');
  }

  // 4. version — probe the executable (5.1 is a warning, not a hard failure)
  if (executable !== null && fileOrSymlinkExists(executable)) {
    let result;
    try {
      result = await probe(executable, { env });
    } catch (caught) {
      result = { ok: false, version: undefined, output: cautionText(caught) };
    }
    const major = result?.version ? Number(String(result.version).split('.')[0]) : undefined;
    if (result?.ok === true) {
      add('version', 'ok', result.version ? `PowerShell ${result.version}` : 'PowerShell 7 (version unknown)');
    } else if (major === 5) {
      add('version', 'warn',
        `${result.version} — Windows PowerShell 5.1 fallback; the pwsh tool will not be PowerShell 7`);
    } else {
      add('version', 'fail',
        `the executable did not report PowerShell 7: ${result?.output ? terse(result.output, 300) : 'no version output'}`);
    }
  } else {
    add('version', 'fail', 'no PowerShell executable is available to probe');
  }

  // 5. config
  if (!configExists(env)) {
    add('config', 'ok', `${configFile(env)} (not created yet; defaults apply)`);
  } else if (state?.config !== undefined) {
    add('config', 'ok', configFile(env));
  } else {
    add('config', 'warn', `${configFile(env)} exists but could not be parsed as a JSON object; defaults apply`);
  }

  // 6. install
  if (!install.exists) {
    add('install', 'warn', 'no PowerShell 7 installation was detected');
  } else {
    const scope = install.scope ?? 'unknown';
    const method = install.method ?? 'unknown';
    add('install', 'ok',
      `scope=${scope} method=${method} path=${install.path}${install.removable ? ' (removable)' : ''}`);
  }

  // 7. path-env
  if (install.directory === null) {
    add('path-env', 'warn', 'no installation directory to check against PATH');
  } else if (install.pathEntry) {
    add('path-env', 'ok', `${install.directory} is on PATH`);
  } else {
    add('path-env', 'warn', `${install.directory} is not on PATH; new terminals may not find pwsh`);
  }

  // 8. shipped @deepseek-ai packages
  let shipped;
  try {
    shipped = describeShipped();
  } catch (caught) {
    shipped = { ok: false, error: cautionText(caught) };
  }
  add('shipped', shipped?.ok === true ? 'ok' : 'fail',
    shipped?.ok === true
      ? `DSH packages resolved${shipped.appRoot ? ` (${shipped.appRoot})` : ''}`
      : `cannot load the shipped @deepseek-ai packages: ${shipped?.error ?? 'unknown error'}`);

  // 9. sandbox policy service
  let policy;
  try {
    policy = options.ctx?.get?.('sandboxPolicy');
  } catch {
    policy = undefined;
  }
  if (policy === undefined) {
    add('sandbox', 'warn', 'no sandboxPolicy service in this context; policy mode unknown');
  } else if (typeof policy.resolve !== 'function') {
    add('sandbox', 'warn', 'the sandboxPolicy service has no resolve() method; policy mode unknown');
  } else {
    try {
      const resolved = policy.resolve({});
      add('sandbox', 'ok',
        `mode=${resolved?.mode ?? 'unknown'}${resolved?.workspaceRoot ? ` workspace=${resolved.workspaceRoot}` : ''}`);
    } catch (caught) {
      add('sandbox', 'warn', `the sandboxPolicy service could not resolve the current policy: ${cautionText(caught)}`);
    }
  }

  // 10. install job
  const job = options.job ?? {};
  if (job.busy === true) {
    add('install-job', 'warn', 'an install/relocate/uninstall job is currently running');
  } else if (job.phase === 'error' && job.error) {
    add('install-job', 'warn', `the last install job failed: ${job.error}`);
  } else if (job.phase === 'cancelled') {
    add('install-job', 'warn', 'the last install job was cancelled');
  } else {
    add('install-job', 'ok', 'no install job is running');
  }

  // 11. routes — compare against the routes the host actually registered, not a second copy of
  // the constant list.
  if (!Array.isArray(options.routes)) {
    add('routes', 'warn', 'the host did not report its registered routes; registration could not be verified');
  } else {
    const missing = REQUIRED_ROUTES.filter((path) => !options.routes.includes(path));
    add('routes', missing.length === 0 ? 'ok' : 'fail',
      missing.length === 0
        ? `${REQUIRED_ROUTES.length} exact routes are registered`
        : `missing routes: ${missing.join(', ')}`);
  }

  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) {
    if (check.status === 'ok') summary.ok += 1;
    else if (check.status === 'warn') summary.warn += 1;
    else summary.fail += 1;
  }

  return {
    ok: summary.fail === 0,
    checkedAt: new Date().toISOString(),
    checks,
    summary,
  };
}

function cautionText(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
