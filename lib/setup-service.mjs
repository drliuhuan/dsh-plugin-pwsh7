// The PowerShell 7 setup/maintenance coordinator.
//
// One operation runs at a time per DSH process and every surface observes the same state:
//
//   * the Web setup dialog and the Settings section (`client.js`) poll `/pwsh7/state` and stream
//     `/pwsh7/events`;
//   * the model-facing `shell_router` tool's actions start the same jobs and wait for them.
//
// That single-owner rule matters: two concurrent `auto` installs would download into the same
// `%LOCALAPPDATA%\dsh\pwsh7\tmp` archive and race on extraction. The coordinator also owns the
// v0.3.0 maintenance actions — route persistence, user-scope uninstall, relocate-to-system, and the
// read-only self-check — because they must respect the same busy rule.
//
// Only Node builtins and the sibling modules are imported here; the service is testable with
// injected `install`/`detect`/`refresh`/`run`/`probe` seams and never touches the network by itself.

import { probePwsh, readRouterConfig, writeRouterConfig } from './paths.mjs';
import { PWSH_RELEASES_PAGE, ensurePwsh, resolvePwsh7Release } from './install.mjs';
import {
  isProcessElevated,
  requireSystemAdministrator,
  validateScope,
  installDirectory,
} from './install-scope.mjs';
import { routerRoot } from './paths.mjs';
import { getRouterState, onPwshMissing, refreshRouterState } from './state.mjs';
import {
  describeInstall,
  effectiveRoute,
  pluginVersion,
  resolveSystemPwsh,
  writeRouteConfig,
} from './route.mjs';
import { removeManagedUserInstall } from './maintenance.mjs';
import { runSelfcheck } from './selfcheck.mjs';
import { describeShippedResolution } from './shipped.mjs';
import { describeDialect, writeDialect } from './dialect-config.mjs';
import { readOnboarding, writeOnboarding } from './onboarding.mjs';

/** HTTP routes owned by the setup/settings surface. Also used by the client half. */
export const SETUP_ROUTES = Object.freeze({
  state: '/pwsh7/state',
  events: '/pwsh7/events',
  install: '/pwsh7/install',
  cancel: '/pwsh7/cancel',
  route: '/pwsh7/route',
  dialect: '/pwsh7/dialect',
  onboarding: '/pwsh7/onboarding',
  latest: '/pwsh7/latest',
  uninstall: '/pwsh7/uninstall',
  relocate: '/pwsh7/relocate',
  selfcheck: '/pwsh7/selfcheck',
});

/** Installation strategies accepted by `start()`; mirrors `ensurePwsh`. */
export const SETUP_METHODS = Object.freeze(['auto', 'portable', 'winget']);

/** Progress frames are coalesced to this rate; phase changes are always sent immediately. */
const PROGRESS_EMIT_INTERVAL_MS = 150;

const ELEVATION_HINT =
  'Relocation writes to %ProgramFiles% and the machine PATH, so the DSH host must run elevated. '
  + 'Close DSH, start it as administrator (or run the winget install in an elevated terminal), then '
  + 'retry. The per-user installation was left untouched.';

/** Trim the installer result down to JSON the browser can render. */
function publicResult(result) {
  if (result === null || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    scope: result.scope,
    method: typeof result.method === 'string' ? result.method : undefined,
    path: typeof result.path === 'string' ? result.path : undefined,
    version: typeof result.version === 'string' ? result.version : undefined,
    url: typeof result.url === 'string' ? result.url : undefined,
    bytes: Number.isFinite(result.bytes) ? result.bytes : undefined,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : undefined,
    message: typeof result.message === 'string' ? result.message : undefined,
  };
}

function errorText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Compare `major.minor.patch` prefixes; unparsable sides compare equal. */
function compareVersions(a, b) {
  const parse = (value) => {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function emptyInstall() {
  return {
    exists: false,
    managed: false,
    removable: false,
    scope: null,
    method: null,
    version: null,
    path: null,
    directory: null,
    userCopy: false,
    systemCopy: false,
    pathEntry: false,
  };
}

/**
 * @typedef {object} SetupSnapshot
 * @property {boolean} found          PowerShell 7 currently resolves through the plugin route
 * @property {string} [path]          resolved or just-installed executor path
 * @property {string} [version]       version from the router config or the finished install
 * @property {string} installRoot     per-user directory the portable install uses
 * @property {string} phase           idle | downloading | extracting | verifying | installing | cancelling | done | error | cancelled
 * @property {number} received        bytes downloaded so far
 * @property {number|null} total      expected bytes, when the server sent content-length
 * @property {number|null} percent    whole percent, when total is known
 * @property {string|null} message
 * @property {string|null} error
 * @property {number} missingSeq      failed pwsh resolutions since this process started
 * @property {boolean} canInstall
 * @property {boolean} canCancel
 * @property {string} releasesUrl
 * @property {object|null} result     trimmed installer result after a finished run
 * @property {string} pluginVersion
 * @property {'plugin'|'system'} route
 * @property {boolean} routeConfigured
 * @property {string} systemPath      executable route=system would spawn, resolved now
 * @property {object} install         describeInstall() result
 * @property {{available:boolean,requiredForSystem:boolean}} elevation
 * @property {boolean} busy           an install/relocate/uninstall job is running
 * @property {object|null} relocate   relocate result after a finished relocation
 */

/**
 * Create the process-wide setup/maintenance coordinator.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {{ warn?: Function, info?: Function }} [options.logger]
 * @param {string} [options.root]              override the per-user router root (tests)
 * @param {Function} [options.install]         override `ensurePwsh` (tests)
 * @param {Function} [options.detect]          override the synchronous router state read (tests)
 * @param {Function} [options.refresh]         override the post-action refresh (tests)
 * @param {Function} [options.requireAdministrator] elevation preflight seam (tests)
 * @param {Function} [options.probeElevation]  elevation probe seam (tests)
 * @param {Function} [options.removePathEntries] PATH cleanup seam (tests; no registry write)
 * @param {Function} [options.removeDir]       file cleanup seam (tests)
 * @param {Function} [options.probe]           version probe seam for the self-check
 * @param {Function} [options.describeShipped] shipped-package probe seam for the self-check
 */
export function createSetupService(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger;
  const install = options.install ?? ensurePwsh;
  const detect = options.detect ?? (() => getRouterState());
  const refresh = options.refresh ?? (() => refreshRouterState());
  const root = options.root ?? routerRoot(env);
  const raiseAdministrator = options.requireAdministrator ?? requireSystemAdministrator;
  const probeElevation = options.probeElevation ?? isProcessElevated;
  const removePathEntries = options.removePathEntries;
  const removeDir = options.removeDir;
  const probe = options.probe ?? probePwsh;
  const describeShipped = options.describeShipped ?? describeShippedResolution;
  const resolveLatest = options.resolveLatest ?? resolvePwsh7Release;

  /** @type {Set<(snapshot: SetupSnapshot) => void>} */
  const listeners = new Set();

  /** @type {AbortController|null} */
  let controller = null;
  /** @type {Promise<SetupSnapshot>|null} */
  let running = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let pendingEmit = null;
  let lastEmitAt = 0;

  let missingSeq = 0;
  /** @type {SetupSnapshot['phase']} */
  let phase = 'idle';
  let method = 'auto';
  let scope = 'user';
  let received = 0;
  /** @type {number|null} */
  let total = null;
  /** @type {string|null} */
  let message = null;
  /** @type {string|null} */
  let error = null;
  /** @type {number|null} */
  let startedAt = null;
  /** @type {number|null} */
  let finishedAt = null;
  /** @type {object|null} */
  let result = null;
  /** @type {number} non-install maintenance operations (uninstall, relocate cleanup) in flight */
  let maintenanceDepth = 0;
  /** @type {object|null} */
  let relocateResult = null;
  /** Latest release check: `{version, current, updateAvailable, checkedAt, error}`. */
  let latest = null;
  /** @type {Promise<object>|null} */
  let latestPromise = null;
  let elevated = false;
  let elevationStarted = false;
  /** @type {Promise<boolean>|null} */
  let elevationPromise = null;

  /**
   * One failed `pwsh` run. The dialog compares `missingSeq` with the value it was dismissed at.
   * A run that fails while an install is already downloading keeps its phase.
   */
  const stopMissing = onPwshMissing(() => {
    missingSeq += 1;
    // A finished or cancelled run is no longer the current truth: this run just proved the
    // executable is still missing, so the dialog must offer the download again.
    if (phase === 'done' || phase === 'cancelled') {
      phase = 'idle';
      result = null;
      error = null;
      message = null;
      finishedAt = null;
    }
    emit(true);
  });

  function readRouterState() {
    try {
      return detect();
    } catch (caught) {
      logger?.warn?.(`pwsh7-router: setup state detection failed: ${errorText(caught)}`);
      return undefined;
    }
  }

  function installInfo(state) {
    try {
      return describeInstall({ env, root, state });
    } catch (caught) {
      logger?.warn?.(`pwsh7-router: install description failed: ${errorText(caught)}`);
      return emptyInstall();
    }
  }

  function isBusy() {
    return running !== null || maintenanceDepth > 0;
  }

  function configRoute(state) {
    const config = state?.config;
    return {
      mode: effectiveRoute(config),
      configured: Boolean(
        config !== undefined
        && config !== null
        && typeof config === 'object'
        && Object.prototype.hasOwnProperty.call(config, 'route'),
      ),
    };
  }

  function ensureElevation() {
    if (elevationStarted) return;
    elevationStarted = true;
    void refreshElevation();
  }

  /** Re-run the elevation probe; the method is public so tests and the relocate preflight can await it. */
  function refreshElevation() {
    elevationStarted = true;
    elevationPromise = (async () => {
      try {
        elevated = (await probeElevation({ env })) === true;
      } catch (caught) {
        logger?.warn?.(`pwsh7-router: elevation probe failed: ${errorText(caught)}`);
        elevated = false;
      }
      emit(true);
      return elevated;
    })();
    return elevationPromise;
  }

  /** @returns {SetupSnapshot} */
  function snapshot() {
    ensureElevation();
    const state = readRouterState();
    const found = state?.pwsh?.found === true;
    const installed = state?.config?.installed?.pwsh;
    const configuredVersion = typeof installed?.version === 'string' ? installed.version : undefined;
    const percent = total !== null && total > 0
      ? Math.max(0, Math.min(100, Math.round((received / total) * 100)))
      : null;
    const installState = installInfo(state);
    const route = configRoute(state);
    let systemPath = 'pwsh';
    try {
      systemPath = resolveSystemPwsh(env);
    } catch {
      systemPath = 'pwsh';
    }
    return {
      platform: state?.platform ?? process.platform,
      found,
      path: found ? state.pwsh.path : (result?.path ?? undefined),
      source: found ? state.pwsh.source : undefined,
      version: configuredVersion ?? result?.version ?? undefined,
      installRoot: scope === 'system' ? installDirectory(env, scope, root) : root,
      installRoots: { user: root, system: installDirectory(env, 'system', root) },
      scope,
      configPath: state?.configPath ?? null,
      phase,
      method,
      received,
      total,
      percent,
      message,
      error,
      startedAt,
      finishedAt,
      updatedAt: Date.now(),
      missingSeq,
      canInstall: !found && running === null,
      canCancel: running !== null && controller !== null && !controller.signal.aborted,
      releasesUrl: PWSH_RELEASES_PAGE,
      result,
      // v0.3.0 settings surface (additive fields)
      pluginVersion: pluginVersion(),
      route: route.mode,
      routeConfigured: route.configured,
      systemPath,
      install: installState,
      elevation: { available: elevated === true, requiredForSystem: true },
      busy: isBusy(),
      relocate: relocateResult,
      // Both are generation-memoized, so a steady snapshot does not touch the filesystem; the
      // config read happens once per write (dialect/onboarding/install/route).
      dialect: describeDialect(env),
      onboarding: readOnboarding(env),
      latest: latest ?? { version: null, current: null, updateAvailable: null, checkedAt: null, error: null },
    };
  }

  function notify() {
    const current = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(current);
      } catch (caught) {
        logger?.warn?.(`pwsh7-router: setup listener failed: ${errorText(caught)}`);
      }
    }
  }

  /**
   * Publish a state change. `force` is for phase transitions and every request/response path;
   * ordinary download progress is coalesced so a 100 MB archive does not flood the SSE stream.
   */
  function emit(force = false) {
    const now = Date.now();
    if (force) {
      if (pendingEmit !== null) {
        clearTimeout(pendingEmit);
        pendingEmit = null;
      }
      lastEmitAt = now;
      notify();
      return;
    }
    if (now - lastEmitAt >= PROGRESS_EMIT_INTERVAL_MS) {
      if (pendingEmit !== null) {
        clearTimeout(pendingEmit);
        pendingEmit = null;
      }
      lastEmitAt = now;
      notify();
      return;
    }
    // Keep the one trailing frame already scheduled. Resetting it on every chunk would let a fast
    // download postpone it forever, freezing the progress bar until completion.
    if (pendingEmit === null) {
      pendingEmit = setTimeout(() => {
        pendingEmit = null;
        lastEmitAt = Date.now();
        notify();
      }, PROGRESS_EMIT_INTERVAL_MS - (now - lastEmitAt));
      pendingEmit.unref?.();
    }
  }

  /**
   * Start one installation, or join the one already running.
   *
   * A maintenance operation (uninstall/relocate cleanup) holds the same single-owner slot: starting
   * an install while one is in flight would race a download against recursive deletion under the
   * router root, so it is refused with `busy: true` instead.
   *
   * @param {string} [requested] `auto` | `portable` | `winget`
   * @returns {{ started: boolean, busy?: boolean, snapshot: SetupSnapshot }}
   */
  function start(requested = 'auto', requestedScope = 'user') {
    validateScope(requestedScope);
    const chosen = requested ?? 'auto';
    if (!SETUP_METHODS.includes(chosen)) {
      throw new TypeError(`pwsh7-router: unsupported install method ${JSON.stringify(chosen)}`);
    }
    if (running !== null) return { started: false, snapshot: snapshot() };
    if (maintenanceDepth > 0) return { started: false, busy: true, snapshot: snapshot() };

    scope = requestedScope;
    method = chosen;
    phase = chosen === 'winget' ? 'installing' : 'downloading';
    received = 0;
    total = null;
    message = null;
    error = null;
    result = null;
    relocateResult = null;
    startedAt = Date.now();
    finishedAt = null;
    controller = new AbortController();
    const signal = controller.signal;

    /** @type {(snapshot: SetupSnapshot) => void} */
    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    running = done;

    emit(true);

    void (async () => {
      try {
        const outcome = await install({
          env,
          method: chosen,
          scope,
          root,
          signal,
          onPhase(label) {
            if (label === 'winget') phase = 'installing';
            else if (label === 'extract') phase = 'extracting';
            else if (label === 'verify') phase = 'verifying';
            else if (label === 'download') phase = 'downloading';
            emit(false);
          },
          onProgress(bytes, totalBytes) {
            if (Number.isFinite(bytes) && bytes >= 0) received = bytes;
            if (Number.isFinite(totalBytes) && totalBytes > 0) total = totalBytes;
            if (phase !== 'cancelling' && phase !== 'installing' && phase !== 'verifying') {
              phase = total !== null && received >= total ? 'extracting' : 'downloading';
            }
            emit(false);
          },
        });

        if (outcome?.aborted || signal.aborted) {
          phase = 'cancelled';
          message = 'The download was cancelled.';
          result = publicResult(outcome?.result);
        } else if (outcome?.ok === true) {
          result = publicResult(outcome.result);
          phase = 'done';
          message = null;
          error = null;
        } else {
          result = publicResult(outcome?.result);
          phase = 'error';
          error = result?.message
            ?? (typeof outcome?.error === 'string' ? outcome.error : 'PowerShell 7 could not be installed.');
          message = null;
        }
      } catch (caught) {
        if (signal.aborted) {
          phase = 'cancelled';
          message = 'The download was cancelled.';
        } else {
          phase = 'error';
          error = errorText(caught);
          message = null;
          logger?.warn?.(`pwsh7-router: setup install failed: ${error}`);
        }
      } finally {
        finishedAt = Date.now();
        controller = null;
        running = null;
        try {
          await refresh();
        } catch (caught) {
          logger?.warn?.(`pwsh7-router: setup state refresh failed: ${errorText(caught)}`);
        }
        emit(true);
        settle(snapshot());
      }
    })();

    return { started: true, snapshot: snapshot() };
  }

  /** Resolve when the current install settles; immediately when none is running. */
  async function wait() {
    if (running !== null) return running;
    return snapshot();
  }

  /** Poll until no install/maintenance operation is running (tests and tool diagnostics). */
  async function waitForIdle(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (isBusy() && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    return snapshot();
  }

  /** Abort the active download. The waiters settle through the normal cancelled path. */
  function cancel() {
    if (controller === null || controller.signal.aborted) return snapshot();
    phase = 'cancelling';
    message = 'Cancelling the download…';
    emit(true);
    try {
      controller.abort(new Error('cancelled from the PowerShell 7 setup dialog'));
    } catch {
      controller.abort();
    }
    return snapshot();
  }

  /**
   * Persist the routing mode additively and refresh detection before returning the new snapshot.
   * @param {'plugin'|'system'} mode
   */
  async function setRoute(mode) {
    writeRouteConfig(mode, env);
    try {
      await refresh();
    } catch (caught) {
      logger?.warn?.(`pwsh7-router: route refresh failed: ${errorText(caught)}`);
    }
    emit(true);
    return { mode, state: snapshot() };
  }

  /**
   * Persist the prompt-injection level (`force` implies `common`) and publish a fresh snapshot.
   * The prompt section reads the config on every assembly, so the next model step sees the change
   * without a restart or a prompt re-registration.
   * @param {{ common?: boolean, force?: boolean }} value
   */
  async function setDialect(value) {
    writeDialect(value, env);
    try {
      // Detection is cached for ten seconds; a config write must not leave the snapshot stale.
      await refresh();
    } catch (caught) {
      logger?.warn?.(`pwsh7-router: dialect refresh failed: ${errorText(caught)}`);
    }
    emit(true);
    return { dialect: describeDialect(env), state: snapshot() };
  }

  /**
   * Persist "the initial setup dialog was confirmed", so it does not reopen on the next launch.
   * @param {boolean} completed
   */
  async function setOnboarding(completed) {
    writeOnboarding(completed, env);
    try {
      await refresh();
    } catch (caught) {
      logger?.warn?.(`pwsh7-router: onboarding refresh failed: ${errorText(caught)}`);
    }
    emit(true);
    return { onboarding: readOnboarding(env), state: snapshot() };
  }

  /**
   * Check the latest PowerShell 7 release against the installed executable.
   *
   * The result is cached for five minutes unless `force` is set. It never throws for a network
   * failure: the error travels in `latest.error` so the dialog can still show the installed state.
   * @param {{ force?: boolean }} [optionsArg]
   * @returns {Promise<{version: string|null, current: string|null, updateAvailable: boolean|null, checkedAt: number, error: string|null}>}
   */
  async function checkLatest(optionsArg = {}) {
    const force = optionsArg.force === true;
    if (!force && latest !== null && Date.now() - latest.checkedAt < 5 * 60 * 1000) return latest;
    if (latestPromise !== null) return latestPromise;
    latestPromise = (async () => {
      const info = { version: null, current: null, updateAvailable: null, checkedAt: Date.now(), error: null };
      try {
        const asset = await resolveLatest({ env });
        if (asset !== null && typeof asset === 'object' && typeof asset.version === 'string') {
          info.version = asset.version;
        }
      } catch (caught) {
        info.error = errorText(caught);
      }
      try {
        const state = readRouterState();
        if (state?.pwsh?.found && typeof state.pwsh.path === 'string') {
          const probed = await probe(state.pwsh.path);
          if (probed?.ok === true && typeof probed.version === 'string') info.current = probed.version;
        }
      } catch {
        // The installed executable stays unknown; the dialog then shows no update action.
      }
      if (info.version !== null && info.current !== null) {
        info.updateAvailable = compareVersions(info.version, info.current) > 0;
      }
      latest = info;
      emit(true);
      return info;
    })();
    try {
      return await latestPromise;
    } finally {
      latestPromise = null;
    }
  }

  /**
   * Remove the plugin-managed per-user portable installation. Refuses while another operation is
   * running or when the active installation is not such a copy.
   *
   * @returns {Promise<{ok:boolean,removed?:string[],warnings?:string[],state:SetupSnapshot,error?:string,busy?:boolean,refused?:boolean}>}
   */
  async function uninstall(optionsArg = {}) {
    if (isBusy()) {
      return { ok: false, busy: true, error: 'another PowerShell 7 operation is running', state: snapshot() };
    }
    const state = readRouterState();
    const installState = installInfo(state);
    if (!installState.removable) {
      return {
        ok: false,
        refused: true,
        error: installState.exists
          ? `the current PowerShell 7 installation is not a plugin-managed per-user copy (${installState.path ?? 'unknown path'})`
          : 'no plugin-managed per-user PowerShell 7 installation was found',
        state: snapshot(),
      };
    }

    maintenanceDepth += 1;
    emit(true);
    let outcome;
    try {
      outcome = await removeManagedUserInstall({
        env,
        root,
        run: optionsArg.run,
        removePathEntries: optionsArg.removePathEntries ?? removePathEntries,
        removeDir: optionsArg.removeDir ?? removeDir,
        signal: optionsArg.signal,
      });
    } catch (caught) {
      outcome = { ok: false, removed: [], warnings: [errorText(caught)] };
    } finally {
      try {
        await refresh();
      } catch (caught) {
        logger?.warn?.(`pwsh7-router: uninstall refresh failed: ${errorText(caught)}`);
      }
      maintenanceDepth -= 1;
      relocateResult = null;
      emit(true);
    }
    return {
      ok: outcome.ok === true,
      removed: outcome.removed ?? [],
      warnings: outcome.warnings ?? [],
      state: snapshot(),
    };
  }

  /**
   * Move the per-user installation to system scope: preflight elevation, run the system install
   * job, then (by default) clean up the per-user copy and point the config at the system executable.
   *
   * Unelevated hosts get `{requiresElevation:true}` with nothing started; a concurrent job gets
   * `{busy:true}`; otherwise the job starts and `relocate` appears in the snapshot when it settles.
   */
  async function relocate(optionsArg = {}) {
    if (isBusy()) {
      return { ok: false, busy: true, error: 'another PowerShell 7 operation is running', state: snapshot() };
    }
    const methodValue = optionsArg.method ?? 'auto';
    if (!SETUP_METHODS.includes(methodValue)) {
      throw new TypeError(`pwsh7-router: unsupported install method ${JSON.stringify(methodValue)}`);
    }
    try {
      await raiseAdministrator({ env });
    } catch (caught) {
      return {
        ok: false,
        requiresElevation: true,
        error: errorText(caught),
        hint: ELEVATION_HINT,
        state: snapshot(),
      };
    }
    const removeUser = optionsArg.removeUser !== false;
    const started = start(methodValue, 'system');
    if (!started.started) {
      return { ok: false, busy: true, error: 'a PowerShell 7 installation is already running', state: started.snapshot };
    }

    maintenanceDepth += 1;
    relocateResult = null;
    void (async () => {
      let relocation;
      try {
        const final = await wait();
        if (final.phase !== 'done') {
          relocation = {
            ok: false,
            relocated: false,
            systemPath: null,
            removedUserCopy: [],
            warnings: [],
            error: final.error ?? 'the system installation did not complete',
          };
        } else {
          const warnings = [];
          let removed = [];
          const installResult = final.result ?? {};
          let systemPath = typeof installResult.path === 'string'
            ? installResult.path
            : installInfo(readRouterState()).path ?? resolveSystemPwsh(env);
          if (removeUser) {
            try {
              const cleanup = await removeManagedUserInstall({
                env,
                root,
                run: optionsArg.run,
                removePathEntries: optionsArg.removePathEntries ?? removePathEntries,
                removeDir: optionsArg.removeDir ?? removeDir,
                signal: optionsArg.signal,
              });
              removed = cleanup.removed ?? [];
              warnings.push(...(cleanup.warnings ?? []));
            } catch (caught) {
              warnings.push(`user-scope cleanup failed: ${errorText(caught)}`);
            }
          }
          try {
            // The uninstall cleanup keeps only `route`, so re-point the config at the freshly
            // installed system executable and force the plugin route (contract step 4).
            const current = readRouterConfig(env) ?? {};
            const previousInstalled =
              current.installed && typeof current.installed === 'object' ? current.installed : {};
            writeRouterConfig({
              ...current,
              route: 'plugin',
              pwshPath: systemPath,
              installed: {
                ...previousInstalled,
                pwsh: {
                  ...(previousInstalled.pwsh ?? {}),
                  path: systemPath,
                  method: typeof installResult.method === 'string' ? installResult.method : 'portable',
                  scope: 'system',
                  ...(typeof installResult.version === 'string' ? { version: installResult.version } : {}),
                },
              },
            }, env);
          } catch (caught) {
            warnings.push(`could not persist the plugin route: ${errorText(caught)}`);
          }
          try {
            await refresh();
          } catch (caught) {
            warnings.push(`state refresh failed: ${errorText(caught)}`);
          }
          const described = installInfo(readRouterState());
          if (described.path !== null) systemPath = described.path;
          relocation = { ok: true, relocated: true, systemPath, removedUserCopy: removed, warnings };
        }
      } catch (caught) {
        relocation = {
          ok: false,
          relocated: false,
          systemPath: null,
          removedUserCopy: [],
          warnings: [errorText(caught)],
          error: errorText(caught),
        };
      } finally {
        relocateResult = relocation;
        maintenanceDepth -= 1;
        emit(true);
      }
    })();

    return { ok: true, started: true, state: snapshot() };
  }

  /**
   * Read-only self-check. Never throws for a missing PowerShell or config.
   * @param {{ ctx?: object, probe?: Function, describeShipped?: Function }} [optionsArg]
   */
  async function selfcheck(optionsArg = {}) {
    const state = readRouterState();
    return runSelfcheck({
      env,
      root,
      state,
      install: installInfo(state),
      routes: Array.isArray(optionsArg.routes) ? optionsArg.routes : undefined,
      job: { busy: isBusy(), phase, error },
      ctx: optionsArg.ctx,
      probe: optionsArg.probe ?? probe,
      describeShipped: optionsArg.describeShipped ?? describeShipped,
    });
  }

  /**
   * Subscribe to every published snapshot.
   * @param {(snapshot: SetupSnapshot) => void} listener
   * @returns {() => void}
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** Stop the listener, abort any install, and drop pending progress frames. */
  function dispose() {
    stopMissing();
    if (pendingEmit !== null) {
      clearTimeout(pendingEmit);
      pendingEmit = null;
    }
    if (controller !== null && !controller.signal.aborted) {
      try {
        controller.abort(new Error('pwsh7-router is unloading'));
      } catch {
        controller.abort();
      }
    }
    listeners.clear();
  }

  return {
    start,
    wait,
    waitForIdle,
    cancel,
    subscribe,
    snapshot,
    dispose,
    setRoute,
    setDialect,
    setOnboarding,
    checkLatest,
    uninstall,
    relocate,
    selfcheck,
    refreshElevation,
    /** Exposed for diagnostics and tests. */
    get running() {
      return running !== null;
    },
    /** Exposed for diagnostics and tests. */
    get elevation() {
      return elevation === true;
    },
  };
}
