// The routing feature set: `shell_router`, the system-prompt section, the setup coordinator, the
// Web routes, and the reload hook.
//
// These features are installed by the bare `dsh-plugin-pwsh7` Loader row (`index.js`), which is also
// the row DSH's client-module scanner uses to discover `client.js`: it accepts only a bare package
// specifier as a bundle source, not the `./pwsh-executor` subpath used by the replacement row.

import { defineTool } from './shipped.mjs';
import { refreshRouterState } from './state.mjs';
import { describeStatus, runDiagnosis } from './status.mjs';
import { createSetupService } from './setup-service.mjs';
import { createSetupHandlers, setupRouteRows } from './setup-routes.mjs';

/** Guard against a double mount of the same module instance (for example a manual row plus the bundle). */
let installed = false;

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
 *
 * @param {object} ctx plugin (Cordis) context
 * @param {ReturnType<import('./setup-service.mjs').createSetupService>} [setup]
 *   the process-wide setup coordinator; when omitted (tool-definition smoke harnesses) one is
 *   created just for this definition.
 */
export function createToolDefinition(ctx, setup) {
  const installer = setup ?? createSetupService({ logger: ctx.logger });
  return defineTool({
    name: 'shell_router',
    description: [
      'Inspect or repair how this Windows deployment routes the `pwsh` tool.',
      '`status` (default) reports the resolved PowerShell 7 executable and version, the config file, and the active sandbox policy.',
      '`diagnose` runs real PowerShell 7 commands under the current sandbox policy and reports failures with concrete hints.',
      '`install` supports scope=user (default, no admin) or scope=system (Program Files, elevated host required), and writes the corresponding PATH.',
      'The Web app also shows a download prompt with live progress whenever a `pwsh` run finds PowerShell 7 missing;',
      'the tool and that prompt share one install job, so either can observe or retry it.',
      'Use it when `pwsh` reports that PowerShell 7 is missing, or when the user asks to set up PowerShell 7.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'diagnose', 'install'],
        description: 'Operation to perform; omit for `status`.',
      },
      scope: {
        type: 'string',
        enum: ['user', 'system'],
        description: 'Installation scope; system requires running the DSH host as administrator. Both update the matching PATH.',
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

      // The Web setup dialog observes the same job: start (or join) it, collect a few progress
      // lines for the transcript, then report the shared final snapshot.
      const progress = [];
      let lastProgressAt = 0;
      let lastPhase;
      const unsubscribe = installer.subscribe((snapshot) => {
        if (snapshot.phase === 'downloading' && snapshot.received > 0) {
          const at = Date.now();
          if (at - lastProgressAt < 4000) return;
          lastProgressAt = at;
          const percent = snapshot.percent === null ? '' : ` (${snapshot.percent}%)`;
          const total = snapshot.total === null ? '' : ` / ${formatBytes(snapshot.total)}`;
          progress.push(`download progress: ${formatBytes(snapshot.received)}${total}${percent}`);
        } else if (snapshot.phase === 'extracting' && lastPhase !== 'extracting') {
          progress.push('download complete; extracting the archive');
        } else if (snapshot.phase === 'installing' && lastPhase !== 'installing') {
          progress.push('installing through winget');
        }
        lastPhase = snapshot.phase;
      });

      let final;
      let stopSignal;
      try {
        const started = installer.start(args.method ?? 'auto', args.scope ?? 'user');
        // A tool-call cancellation stops a download this call started; an install the dialog
        // already started belongs to the user and keeps running.
        if (started.started && exec.signal !== undefined) {
          const abort = () => installer.cancel();
          if (exec.signal.aborted) abort();
          else {
            exec.signal.addEventListener('abort', abort, { once: true });
            stopSignal = () => exec.signal.removeEventListener('abort', abort);
          }
        }
        final = await installer.wait();
      } finally {
        stopSignal?.();
        unsubscribe();
      }

      const state = await refreshRouterState();
      const result = final.result ?? {};
      const succeeded = final.phase === 'done' && result.ok !== false;
      const cancelled = final.phase === 'cancelled';
      const resultLine = succeeded
        ? `pwsh: ok (${result.method ?? 'unknown'}${result.version === undefined ? '' : `, ${result.version}`}${result.path === undefined ? '' : ` at ${result.path}`})`
        : cancelled
          ? 'pwsh: install cancelled'
          : `pwsh: failed — ${final.error ?? result.message ?? 'unknown error'}`;
      const summary = [
        succeeded
          ? 'PowerShell 7 install completed.'
          : cancelled
            ? 'PowerShell 7 install was cancelled.'
            : 'PowerShell 7 install finished with problems.',
        resultLine,
        ...(succeeded && final.message ? [final.message] : []),
        ...progress.slice(-8),
        '',
        await describeStatus(ctx, state, exec),
      ].join('\n');
      return { ok: succeeded, summary };
    },
  });
}

/**
 * Install the routing features on a plugin or service context.
 *
 * Each optional service is looked up with `ctx.inject`, so a composition that lacks `webServer`
 * still gets the tool and the prompt, and a tool registry that rejects the definition is logged
 * rather than failing activation. The row itself keeps its own hard `tools`/`systemPrompt` deps.
 *
 * @param {object} ctx Cordis context of the bare `dsh-plugin-pwsh7` Loader row.
 */
export function installRouterFeatures(ctx) {
  if (installed) return;
  installed = true;

  const warn = (label, error) => {
    ctx.logger?.warn?.(`pwsh7-router: ${label}: ${error instanceof Error ? error.message : String(error)}`);
  };

  // One install coordinator for the whole process: the tool and the Web dialog must never race.
  let setup;
  try {
    setup = createSetupService({ logger: ctx.logger });
  } catch (error) {
    installed = false;
    warn('could not create the setup coordinator', error);
    return;
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      // A config reload may recreate the row from the same module instance; releasing the guard
      // here is what lets the next owner register the tool and routes again.
      installed = false;
      setup.dispose();
    }, 'pwsh7: setup coordinator');
  }

  const registerTool = (scope) => {
    try {
      const tools = scope?.tools ?? scope?.get?.('tools');
      if (tools !== undefined && typeof tools.register === 'function') {
        tools.register(createToolDefinition(scope, setup));
      }
    } catch (error) {
      // The executor must keep working even if the tool registry rejects the definition.
      warn('could not register shell_router', error);
    }
  };

  const registerPrompt = (scope) => {
    try {
      const systemPrompt = scope?.systemPrompt ?? scope?.get?.('systemPrompt');
      if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return;
      systemPrompt.section({
        name: 'tool:pwsh7-router',
        order: systemPrompt.getSectionOrder('TOOL_PWSH') + 1,
        text: [
          'On Windows this deployment routes the `pwsh` tool to PowerShell 7.',
          'If PowerShell 7 is missing or misconfigured, call `shell_router`: action `status` reports the resolved executable,',
          '`diagnose` runs real commands under the current sandbox policy, and `install` downloads a per-user copy into',
          '%LOCALAPPDATA%\\dsh\\pwsh7 (no administrator rights) with a winget fallback.',
          'The Web app also opens a setup dialog with live download progress whenever PowerShell 7 is missing and the',
          '`pwsh` tool is used; that dialog and `install` share one job.',
          'A shell installed this way becomes usable without restarting the app.',
        ].join(' '),
      });
    } catch (error) {
      warn('could not register the system-prompt section', error);
    }
  };

  let routesRegistered = false;
  const registerSetupRoutes = (scope) => {
    if (routesRegistered) return;
    try {
      const webServer = scope?.webServer ?? scope?.get?.('webServer') ?? scope?.get?.('webserver');
      if (webServer === undefined || typeof webServer.register !== 'function') return;
      const handlers = createSetupHandlers(setup, { logger: scope.logger ?? ctx.logger });
      const disposers = [];
      try {
        for (const row of setupRouteRows(handlers)) disposers.push(webServer.register(row));
      } catch (error) {
        // A duplicate path means another copy of this plugin is composed. The tool still works; only
        // the dialog's live state would be missing, so report instead of failing activation.
        warn('could not register setup routes', error);
      }
      routesRegistered = disposers.length > 0;
      if (routesRegistered) {
        const cleanup = () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              // A disposer already run by the server teardown is harmless.
            }
          }
          routesRegistered = false;
        };
        if (typeof scope.effect === 'function') scope.effect(() => cleanup, 'pwsh7: setup routes');
        else if (typeof ctx.effect === 'function') ctx.effect(() => cleanup, 'pwsh7: setup routes');
      }
    } catch (error) {
      warn('could not build the setup routes', error);
    }
  };

  try {
    // `ctx.inject` rather than a one-shot `ctx.get`: a row can be constructed before these services
    // exist, and composition order is not the plugin's to choose.
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (scope) => registerTool(scope));
      ctx.inject(['systemPrompt'], (scope) => registerPrompt(scope));
      ctx.inject(['webServer'], (scope) => registerSetupRoutes(scope));
    } else {
      registerTool(ctx);
      registerPrompt(ctx);
      registerSetupRoutes(ctx);
    }

    if (typeof ctx.on === 'function') {
      ctx.on('app-boot/config-reload', () => {
        // Detection is cheap and must never break the host reload path.
        refreshRouterState().catch(() => {});
      });
    }
  } catch (error) {
    warn('could not attach the routing features', error);
  }
}
