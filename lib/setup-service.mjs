// The PowerShell 7 setup coordinator.
//
// One install runs at a time per DSH process and every surface observes the same state:
//
//   * the Web setup dialog (`client.js`) polls `/pwsh7/state` and streams `/pwsh7/events`;
//   * the model-facing `shell_router` tool's `install` action starts the same job and waits for it.
//
// That single-owner rule matters: two concurrent `auto` installs would download into the same
// `%LOCALAPPDATA%\dsh\pwsh7\tmp` archive and race on extraction. The coordinator also remembers how
// many `pwsh` runs failed because PowerShell 7 was missing (`missingSeq`), which is what lets the
// dialog re-open on every run after a dismissal while staying shut in between.
//
// Only Node builtins and the sibling modules are imported here; the service is testable with an
// injected `install`/`detect`/`refresh` seam and never touches the network by itself.

import { PWSH_RELEASES_PAGE, ensurePwsh } from './install.mjs';
import { routerRoot } from './paths.mjs';
import { getRouterState, onPwshMissing, refreshRouterState } from './state.mjs';

/** HTTP routes owned by the setup surface. Also used by the client half. */
export const SETUP_ROUTES = Object.freeze({
  state: '/pwsh7/state',
  events: '/pwsh7/events',
  install: '/pwsh7/install',
  cancel: '/pwsh7/cancel',
});

/** Installation strategies accepted by `start()`; mirrors `ensurePwsh`. */
export const SETUP_METHODS = Object.freeze(['auto', 'portable', 'winget']);

/** Progress frames are coalesced to this rate; phase changes are always sent immediately. */
const PROGRESS_EMIT_INTERVAL_MS = 150;

/** Trim the installer result down to JSON the browser can render. */
function publicResult(result) {
  if (result === null || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
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

/**
 * @typedef {object} SetupSnapshot
 * @property {boolean} found          PowerShell 7 currently resolves
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
 */

/**
 * Create the process-wide setup coordinator.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {{ warn?: Function, info?: Function }} [options.logger]
 * @param {string} [options.root]          override the per-user router root (tests)
 * @param {Function} [options.install]     override `ensurePwsh` (tests)
 * @param {Function} [options.detect]      override the synchronous router state read (tests)
 * @param {Function} [options.refresh]     override the post-install refresh (tests)
 */
export function createSetupService(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger;
  const install = options.install ?? ensurePwsh;
  const detect = options.detect ?? (() => getRouterState());
  const refresh = options.refresh ?? (() => refreshRouterState());
  const root = options.root ?? routerRoot(env);

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

  /** @returns {SetupSnapshot} */
  function snapshot() {
    const state = readRouterState();
    const found = state?.pwsh?.found === true;
    const installed = state?.config?.installed?.pwsh;
    const configuredVersion = typeof installed?.version === 'string' ? installed.version : undefined;
    const percent = total !== null && total > 0
      ? Math.max(0, Math.min(100, Math.round((received / total) * 100)))
      : null;
    return {
      platform: state?.platform ?? process.platform,
      found,
      path: found ? state.pwsh.path : (result?.path ?? undefined),
      source: found ? state.pwsh.source : undefined,
      version: configuredVersion ?? result?.version ?? undefined,
      installRoot: root,
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
   * @param {string} [requested] `auto` | `portable` | `winget`
   * @returns {{ started: boolean, snapshot: SetupSnapshot }}
   */
  function start(requested = 'auto') {
    const chosen = requested ?? 'auto';
    if (!SETUP_METHODS.includes(chosen)) {
      throw new TypeError(`pwsh7-router: unsupported install method ${JSON.stringify(chosen)}`);
    }
    if (running !== null) return { started: false, snapshot: snapshot() };

    // A tool run may race a manual install that just finished; re-check before downloading again.
    const current = readRouterState();
    if (current?.pwsh?.found === true) {
      phase = 'done';
      method = chosen;
      result = {
        ok: true,
        method: 'existing',
        path: current.pwsh.path,
        version: typeof current.config?.installed?.pwsh?.version === 'string'
          ? current.config.installed.pwsh.version
          : undefined,
        message: 'PowerShell 7 is already available.',
      };
      message = null;
      error = null;
      finishedAt = Date.now();
      emit(true);
      return { started: false, snapshot: snapshot() };
    }

    method = chosen;
    phase = chosen === 'winget' ? 'installing' : 'downloading';
    received = 0;
    total = null;
    message = null;
    error = null;
    result = null;
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
    cancel,
    subscribe,
    snapshot,
    dispose,
    /** Exposed for diagnostics and tests. */
    get running() {
      return running !== null;
    },
  };
}
