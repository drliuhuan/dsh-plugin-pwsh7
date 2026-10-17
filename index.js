// dsh-plugin-pwsh7 — host plugin entry.
//
// Routes the model-facing `pwsh` tool to PowerShell 7 and exposes a `shell_router` tool for
// status, diagnosis, and per-user installation. The executor class lives in
// ./lib/executors/pwsh.mjs and is mounted by ./cordis.patch.yml.

import { defineTool } from './lib/shipped.mjs';
import { configPath, getRouterState, refreshRouterState } from './lib/state.mjs';
import { ensurePwsh } from './lib/install.mjs';
import { describeStatus, runDiagnosis } from './lib/status.mjs';

export const name = 'pwsh7-router';
export const inject = ['tools', 'systemPrompt'];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/**
 * Build the `shell_router` tool definition. Exported so tests/smoke harnesses can compile and
 * inspect it without registering a second copy in the live tool registry.
 */
export function createToolDefinition(ctx) {
  return defineTool({
    name: 'shell_router',
    description: [
      'Inspect or repair how this Windows deployment routes the `pwsh` tool.',
      '`status` (default) reports the resolved PowerShell 7 executable and version, the config file, and the active sandbox policy.',
      '`diagnose` runs real PowerShell 7 commands under the current sandbox policy and reports failures with concrete hints.',
      '`install` downloads and installs PowerShell 7 per-user under %LOCALAPPDATA%\\dsh\\pwsh7 (no admin), or falls back to winget.',
      'Use it when `pwsh` reports that PowerShell 7 is missing, or when the user asks to set up PowerShell 7.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'diagnose', 'install'],
        description: 'Operation to perform; omit for `status`.',
      },
      method: {
        type: 'string',
        enum: ['auto', 'portable', 'winget'],
        description: 'For `install`: installation strategy. `auto` prefers the per-user portable zip.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the requested operation succeeded.' },
          summary: { type: 'string', required: true, description: 'Human-readable status or diagnosis.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const action = args.action ?? 'status';
      if (action === 'status') {
        const state = await refreshRouterState();
        return { ok: true, summary: await describeStatus(ctx, state, exec) };
      }
      if (action === 'diagnose') {
        const state = await refreshRouterState();
        const result = await runDiagnosis(ctx, state, exec);
        return { ok: result.ok, summary: result.summary };
      }
      const progress = [];
      let lastProgressAt = 0;
      const installed = await ensurePwsh({
        method: args.method ?? 'auto',
        onProgress: (bytes, totalBytes) => {
          const at = Date.now();
          if (at - lastProgressAt < 4000) return;
          lastProgressAt = at;
          if (Number.isFinite(totalBytes) && totalBytes > 0) {
            progress.push(`download progress: ${formatBytes(bytes)} / ${formatBytes(totalBytes)} (${Math.round((bytes / totalBytes) * 100)}%)`);
          } else if (Number.isFinite(bytes) && bytes > 0) {
            progress.push(`downloaded ${formatBytes(bytes)}`);
          }
        },
        signal: exec.signal,
      });
      const state = await refreshRouterState();
      const result = installed.result ?? {};
      const resultLine = result.ok
        ? `pwsh: ok (${result.method ?? 'unknown'}${result.version === undefined ? '' : `, ${result.version}`}${result.path === undefined ? '' : ` at ${result.path}`})`
        : `pwsh: failed — ${result.message ?? installed.message ?? 'unknown error'}`;
      const summary = [
        installed.ok ? 'PowerShell 7 install completed.' : 'PowerShell 7 install finished with problems.',
        resultLine,
        ...(Array.isArray(installed.notes) ? installed.notes : []),
        ...progress.slice(-8),
        '',
        await describeStatus(ctx, state, exec),
      ].join('\n');
      return { ok: installed.ok === true, summary };
    },
  });
}

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:pwsh7-router',
    order: ctx.systemPrompt.getSectionOrder('TOOL_PWSH') + 1,
    text: [
      'On Windows this deployment routes the `pwsh` tool to PowerShell 7.',
      'If PowerShell 7 is missing or misconfigured, call `shell_router`: action `status` reports the resolved executable,',
      '`diagnose` runs real commands under the current sandbox policy, and `install` downloads a per-user copy into',
      '%LOCALAPPDATA%\\dsh\\pwsh7 (no administrator rights) with a winget fallback.',
      'A shell installed this way becomes usable without restarting the app.',
    ].join(' '),
  });

  ctx.tools.register(createToolDefinition(ctx));

  ctx.on('app-boot/config-reload', () => {
    // Detection is cheap and must never break the host reload path.
    refreshRouterState().catch(() => {});
  });
}

export { configPath, getRouterState };
