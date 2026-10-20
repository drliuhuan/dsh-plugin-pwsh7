// PowerShell 7 executor row for Windows.
//
// The shipped SandboxPwshExecutor keeps every sandbox behavior (escalation fields, denial
// facts, jobs, output caps) but resolves its executable once from config/well-known locations.
// This subclass replaces only that resolution: an explicit row `config.pwshPath` still wins;
// otherwise the configured route decides between the shared router state (per-user/plugin copy,
// raising a setup hint when absent) and the system-default resolver (which never sees the
// plugin-managed copy, DSH_PWSH_PATH, or config.pwshPath).
//
// It also appends one dialect-correction line to a failed command's stderr (a parse error, or a
// POSIX command that does not exist in PowerShell 7), so the model rewrites the syntax instead of
// retrying it verbatim. See ../dialect.mjs for the contract and the tests.
//
// The routing features (`shell_router`, setup routes, settings surface) ride the separate
// `dsh-plugin-pwsh7` row, not this one: DSH's client-module scanner only accepts a bare package
// specifier as a client-bundle source, and this row is mounted through the `./pwsh-executor`
// subpath. Keeping the bare row is what lets `client.js` compose.

import { shipped } from '../shipped.mjs';
import { resolveExecutorPwshPath } from '../route.mjs';
import { getRouterState, requirePwshPath } from '../state.mjs';
import { attachDialectHint } from '../dialect.mjs';

const { SandboxPwshExecutor } = shipped('@deepseek-ai/dsh-pwsh-sandbox');

export default class WindowsRouterPwshExecutor extends SandboxPwshExecutor {
  /** @returns {string} resolved PowerShell executable for the configured route. */
  get pwshPath() {
    const declared = this.config?.pwshPath?.get?.();
    return resolveExecutorPwshPath(declared, {
      getState: () => getRouterState(),
      requirePath: () => requirePwshPath(),
    });
  }

  /**
   * Spawn the command through the shipped executor, then let a settled failure carry the
   * dialect hint. The handle keeps its identity: the sandbox facts and job bookkeeping key
   * on the exact instance, so this only replaces `result`.
   * @param {object} spec resolved execution spec (includes `command`).
   * @returns {Promise<object>} the live execution handle.
   */
  async execute(spec) {
    const handle = await super.execute(spec);
    return attachDialectHint(handle, spec?.command);
  }
}
