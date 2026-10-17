// PowerShell 7 executor row for Windows.
//
// The shipped SandboxPwshExecutor keeps every sandbox behavior (escalation fields, denial
// facts, jobs, output caps) but resolves its executable once from config/well-known locations.
// This subclass replaces only that resolution: an explicit row `config.pwshPath` still wins,
// otherwise the shared router state resolves PowerShell 7 (and raises a setup hint when absent).

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
