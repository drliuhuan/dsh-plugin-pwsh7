// PowerShell 7 executor row for Windows.
//
// The shipped SandboxPwshExecutor keeps every sandbox behavior (escalation fields, denial
// facts, jobs, output caps) but resolves its executable once from config/well-known locations.
// This subclass replaces only that resolution: an explicit row `config.pwshPath` still wins;
// otherwise the configured route decides between the shared router state (per-user/plugin copy,
// raising a setup hint when absent) and the system-default resolver (which never sees the
// plugin-managed copy, DSH_PWSH_PATH, or config.pwshPath).
//
// It also enforces two model-behavior layers before delegating to the stock executor:
//   * the always-on basic rule: a command that mentions a removal command carries a prelude that
//     shadows `Remove-Item`, so every FileSystem target goes to the Recycle Bin through the host
//     recycle bridge (see ../rules.mjs and ../recycle-service.mjs);
//   * afterwards, a failed command gets one dialect-correction line appended to stderr (a parse
//     error, or a POSIX command that does not exist in PowerShell 7), so the model rewrites the
//     syntax instead of retrying it verbatim. See ../dialect.mjs for the contract and the tests.
//
// NOTE ON MEMBERS: everything here is a public class member. DSH's service seam can hand an
// executor's methods a Proxy receiver, and ES `#private` members fail the brand check on a proxy
// ("Receiver must be an instance of class …") — which took the whole `pwsh` tool down. The `_`
// prefix marks them internal without that failure mode.
//
// NOTE ON THE BRIDGE CHANNEL: the bridge URL and token reach the child through the host's
// `shellEnv` registry (the trusted managed-variable snapshot the tool merges last), NOT through a
// hand-built `spec.env`/`dshEnv` overlay — measured, those overlays did not reach the child, while
// the registry is the path DSH_HOME itself travels. `shellEnv` is a static dependency because the
// pwsh tool depends on the same service, so it is always composed where this row is.

import {
  createRecycleService,
  getActiveRecycleService,
  RECYCLE_TOKEN_ENV,
  RECYCLE_URL_ENV,
  setActiveRecycleService,
} from '../recycle-service.mjs';
import { shipped } from '../shipped.mjs';
import { effectiveRoute, resolveExecutorPwshPath } from '../route.mjs';
import { getRouterState, requirePwshPath } from '../state.mjs';
import { attachDialectHint } from '../dialect.mjs';
import { destructiveCommandReason, guardRemoval, RECYCLE_GUARD_MARKER } from '../rules.mjs';

const { SandboxPwshExecutor } = shipped('@deepseek-ai/dsh-pwsh-sandbox');

export default class WindowsRouterPwshExecutor extends SandboxPwshExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy', 'shellEnv'];

  constructor(ctx, config) {
    super(ctx, config);
    this._recycle = createRecycleService({ pwshPath: () => this.pwshPath });
    this._grants = new WeakMap();
    // Listen at boot, not on first use: the first guarded command must already have an origin,
    // otherwise grant() answers null and that command fails closed.
    this._recycle.start();
    // The `shell_router` row lives in another plugin instance of the same process; publishing the
    // bridge here is what lets its `restore` action reach it.
    setActiveRecycleService(this._recycle);
    this._registerShellEnv();
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        if (getActiveRecycleService() === this._recycle) setActiveRecycleService(null);
        void this._recycle.close();
      }, 'pwsh7: recycle bridge');
    } else if (typeof ctx?.on === 'function') {
      ctx.on('dispose', () => {
        if (getActiveRecycleService() === this._recycle) setActiveRecycleService(null);
        void this._recycle.close();
      });
    }
  }

  /** @returns {string} resolved PowerShell executable for the configured route. */
  get pwshPath() {
    const declared = this.config?.pwshPath?.get?.();
    return resolveExecutorPwshPath(declared, {
      getState: () => getRouterState(),
      requirePath: () => requirePwshPath(),
    });
  }

  /** The bridge, exposed for the self-check/diagnose surfaces and tests. */
  get recycleService() {
    return this._recycle;
  }

  /**
   * Publish the bridge through the host's managed-variable snapshot (`shellEnv`).
   *
   * The tool builds its trusted snapshot from this registry and the host merges it last — the same
   * path that carries DSH_HOME — so a contributor is what actually reaches every pwsh child. The
   * grant is bound to the execution's session workspace and expires (the registry has no
   * per-command revoke hook).
   */
  _registerShellEnv() {
    const shellEnv = this.ctx?.shellEnv;
    if (shellEnv === undefined || typeof shellEnv.register !== 'function') {
      // Without the registry the prelude fails closed; nothing is ever deleted in-process.
      return;
    }
    try {
      shellEnv.register({
        name: 'pwsh7-recycle-bridge',
        variables: {
          [RECYCLE_URL_ENV]: { description: 'Loopback URL of the pwsh7 Recycle-Bin bridge for this execution.' },
          [RECYCLE_TOKEN_ENV]: { description: 'Per-execution token for the pwsh7 Recycle-Bin bridge.' },
        },
        resolve: (exec) => {
          const root = exec?.agent?.session?.header?.cwd;
          if (typeof root !== 'string' || root.length === 0) return {};
          const grant = this._recycle.grant(root);
          return grant === null ? {} : { [RECYCLE_URL_ENV]: grant.url, [RECYCLE_TOKEN_ENV]: grant.token };
        },
      });
    } catch {
      // A rejected contributor registration leaves the prelude failing closed.
    }
  }

  /**
   * Apply the removal guard and, when the managed snapshot did not already carry the bridge
   * variables, attach them directly. The direct overlay is a fallback only: on this host it did
   * not reach the child, which is why the shellEnv contributor is the primary channel.
   * @param {object} spec resolved execution spec.
   * @returns {object} the prepared spec (same object when nothing applies).
   */
  _prepare(spec) {
    // Mode-independent on purpose: this runs before any sandbox-mode branching, so
    // danger-full-access cannot turn a refused command into an allowed one.
    // Commands that would empty the Recycle Bin or delete permanently never reach the shell.
    const refusal = destructiveCommandReason(spec?.command);
    if (refusal !== null) throw new Error(`[pwsh7] refused: ${refusal}`);
    const guarded = guardRemoval(spec);
    if (guarded === null || typeof guarded !== 'object' || typeof guarded.command !== 'string') return guarded;
    if (!guarded.command.startsWith(RECYCLE_GUARD_MARKER)) return guarded;
    if (guarded.env?.[RECYCLE_URL_ENV] !== undefined || guarded.dshEnv?.[RECYCLE_URL_ENV] !== undefined) {
      return guarded;
    }
    let workspaceRoot = guarded.sandboxPolicy?.workspaceRoot ?? guarded.workdir;
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
      try {
        workspaceRoot = this.ctx?.sandboxPolicy?.resolve?.()?.workspaceRoot;
      } catch {
        workspaceRoot = undefined;
      }
    }
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) return guarded;
    const grant = this._recycle.grant(workspaceRoot);
    if (grant === null) return guarded;
    this._grants.set(guarded, grant.token);
    const overlay = { [RECYCLE_URL_ENV]: grant.url, [RECYCLE_TOKEN_ENV]: grant.token };
    return { ...guarded, env: { ...guarded.env, ...overlay }, dshEnv: { ...guarded.dshEnv, ...overlay } };
  }

  /** Retire the token a prepared spec was issued. */
  _release(spec) {
    const token = this._grants.get(spec);
    if (token === undefined) return;
    this._grants.delete(spec);
    this._recycle.revoke(token);
  }

  /** Foreground run: prepare, delegate, and retire the token once the command settles. */
  async run(spec) {
    const prepared = this._prepare(spec);
    try {
      return await super.run(prepared);
    } finally {
      this._release(prepared);
    }
  }

  /**
   * Background start: prepare, delegate, and retire the token when the job settles. A handle with
   * no observable `done` keeps its grant (bounded by the service's token cap) rather than revoking
   * it while the command may still run.
   */
  start(spec) {
    const prepared = this._prepare(spec);
    const handle = super.start(prepared);
    const token = this._grants.get(prepared);
    if (token !== undefined) {
      const release = () => {
        this._grants.delete(prepared);
        this._recycle.revoke(token);
      };
      if (handle?.done !== undefined && typeof handle.done.finally === 'function') handle.done.finally(release);
      else release();
    }
    return handle;
  }

  /**
   * Enforce the deletion rule, spawn the command through the shipped executor, then let a settled
   * failure carry the dialect hint. The handle keeps its identity: the sandbox facts and job
   * bookkeeping key on the exact instance, so this only replaces `result`.
   */
  async execute(spec) {
    const prepared = this._prepare(spec);
    let handle;
    try {
      handle = await super.execute(prepared);
    } finally {
      this._release(prepared);
    }
    if (effectiveRoute(getRouterState()) === 'pwsh5') return handle;
    return attachDialectHint(handle, spec?.command);
  }
}
