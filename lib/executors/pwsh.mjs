// PowerShell 7 executor row for Windows.
//
// The shipped SandboxPwshExecutor keeps every sandbox behavior (escalation fields, denial
// facts, jobs, output caps) but resolves its executable once from config/well-known locations.
// This subclass replaces only that resolution: an explicit row `config.pwshPath` still wins,
// otherwise the shared router state resolves PowerShell 7 (and raises a setup hint when absent).
//
// The routing features (`shell_router`, setup routes, system-prompt section) ride the separate
// `dsh-plugin-pwsh7` row, not this one: DSH's client-module scanner only accepts a bare package
// specifier as a client-bundle source, and this row is mounted through the `./pwsh-executor`
// subpath. Keeping the bare row is what lets `client.js` compose.

import { shipped } from '../shipped.mjs';
import { requirePwshPath } from '../state.mjs';

const { SandboxPwshExecutor } = shipped('@deepseek-ai/dsh-pwsh-sandbox');

export default class WindowsRouterPwshExecutor extends SandboxPwshExecutor {
  /** @returns {string} resolved PowerShell 7 executable. */
  get pwshPath() {
    const declared = this.config?.pwshPath?.get?.();
    if (typeof declared === 'string' && declared.trim().length > 0) return declared;
    return requirePwshPath();
  }
}
