// The routing feature set: `shell_router`, the system-prompt section, the setup coordinator, the
// Web routes, the settings/maintenance actions, and the reload hook.
//
// These features are installed by the bare `dsh-plugin-pwsh7` Loader row (`index.js`), which is also
// the row DSH's client-module scanner uses to discover `client.js`: it accepts only a bare package
// specifier as a bundle source, not the `./pwsh-executor` subpath used by the replacement row.

import { defineTool } from './shipped.mjs';
import { ROUTE_MODES } from './route.mjs';
import { refreshRouterState } from './state.mjs';
import { describeStatus, runDiagnosis } from './status.mjs';
import { createSetupService } from './setup-service.mjs';
import { createSetupHandlers, setupRouteRows } from './setup-routes.mjs';

/** Guard against a double mount of the same module instance (for example a manual row plus the bundle). */
let installed = false;

/** Installation is user-initiated in the Web UI only; the tool never starts one. */
export const INSTALL_GUIDANCE = [
  'Installation is user-initiated only and the shell_router tool never starts one.',
  'Ask the user to use the PowerShell 7 setup dialog (it opens automatically when pwsh.exe is missing)',
  'or Settings → PowerShell 7 in the Web GUI, or to install PowerShell 7 manually.',
].join(' ');

/** Render the structured self-check as the tool's text summary (schema stays ok/summary). */
export function formatSelfcheck(result) {
  const lines = [
    `pwsh7 self-check: ${result.ok ? 'ok' : 'problems found'}`
    + ` (${result.summary.ok} ok, ${result.summary.warn} warn, ${result.summary.fail} fail)`,
    `checkedAt: ${result.checkedAt}`,
  ];
  for (const check of result.checks) {
    lines.push(`[${check.status}] ${check.id}: ${check.detail}`);
  }
  return lines.join('\n');
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
export function createToolDefinition(ctx, setup, registeredRoutes) {
  const installer = setup ?? createSetupService({ logger: ctx.logger });
  return defineTool({
    name: 'shell_router',
    description: [
      'Inspect or repair how this Windows deployment uses PowerShell 7 for the `pwsh` tool.',
      '`status` (default) reports the resolved executable and version, the routing mode, the installation scope/method/path, whether the install is removable, the config file, and the active sandbox policy.',
      '`diagnose` runs real PowerShell commands under the current sandbox policy and reports failures with concrete hints.',
      '`selfcheck` runs read-only checks (plugin version, route, executable, version, config, install, PATH, shipped packages, sandbox, install job, routes).',
      '`route` switches between the plugin-managed per-user copy (mode=plugin) and the system default (mode=system).',
      '`uninstall` removes only the plugin-managed per-user portable installation (files, PATH entries, config).',
      'Installation and relocation are user-initiated only: this tool never starts one. If PowerShell 7 is missing, the Web setup dialog opens automatically; the user can also use Settings → PowerShell 7 or install PowerShell 7 manually. Calling `install` or `relocate` returns that guidance without touching the machine.',
      'The Web app also shows a setup dialog and a Settings section with live progress; the tool and those surfaces share one install job, so either can observe it.',
      'Use it when `pwsh` reports that PowerShell 7 is missing, or when the user asks about status, diagnosis, routing, or removing the plugin-managed copy.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'diagnose', 'selfcheck', 'route', 'uninstall', 'install', 'relocate'],
        description: 'Operation to perform; omit for `status`. `install`/`relocate` are accepted only to return user-initiated-installation guidance.',
      },
      mode: {
        type: 'string',
        enum: ['plugin', 'system'],
        description: 'For `route`: `plugin` uses the plugin-managed per-user copy, `system` uses the machine default (falling back to Windows PowerShell 5.1).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the requested operation succeeded.' },
          summary: { type: 'string', required: true, description: 'Human-readable status, diagnosis, or result.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const action = args.action ?? 'status';
      if (action === 'install' || action === 'relocate') {
        // Installation/relocation are user-initiated in the Web UI only; never touch the machine
        // from the model-facing tool.
        return { ok: false, summary: INSTALL_GUIDANCE };
      }
      if (action === 'status') {
        const state = await refreshRouterState();
        return { ok: true, summary: await describeStatus(ctx, state, exec) };
      }
      if (action === 'diagnose') {
        const state = await refreshRouterState();
        const result = await runDiagnosis(ctx, state, exec);
        return { ok: result.ok, summary: result.summary };
      }
      if (action === 'selfcheck') {
        const routes = typeof registeredRoutes === 'function' ? registeredRoutes() : undefined;
        const result = await installer.selfcheck({ ctx, routes });
        return { ok: result.ok, summary: formatSelfcheck(result) };
      }
      if (action === 'route') {
        const mode = args.mode;
        if (!ROUTE_MODES.includes(mode)) {
          return { ok: false, summary: 'route requires mode "plugin" or "system".' };
        }
        try {
          await installer.setRoute(mode);
        } catch (caught) {
          return {
            ok: false,
            summary: `could not update the PowerShell 7 route: ${caught instanceof Error ? caught.message : String(caught)}`,
          };
        }
        const state = await refreshRouterState();
        return {
          ok: true,
          summary: [`route set to ${mode}.`, '', await describeStatus(ctx, state, exec)].join('\n'),
        };
      }
      if (action === 'uninstall') {
        const outcome = await installer.uninstall();
        if (!outcome.ok) {
          return {
            ok: false,
            summary: `PowerShell 7 uninstall refused: ${outcome.error ?? 'unknown reason'}`,
          };
        }
        const lines = ['PowerShell 7 per-user installation removed.'];
        for (const removed of outcome.removed ?? []) lines.push(`removed: ${removed}`);
        for (const warning of outcome.warnings ?? []) lines.push(`warning: ${warning}`);
        const state = await refreshRouterState();
        lines.push('', await describeStatus(ctx, state, exec));
        return { ok: outcome.ok === true, summary: lines.join('\n') };
      }
      return {
        ok: false,
        summary: `unknown shell_router action ${JSON.stringify(action)}; use status, diagnose, selfcheck, route, or uninstall.`,
      };
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

  // One install coordinator for the whole process: the tool and the Web surfaces must never race.
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

  // Paths this process actually registered on webServer, reported by selfcheck so the route check
  // reflects reality rather than a second copy of the constant list.
  const registeredPaths = [];

  const registerTool = (scope) => {
    try {
      const tools = scope?.tools ?? scope?.get?.('tools');
      if (tools !== undefined && typeof tools.register === 'function') {
        tools.register(createToolDefinition(scope, setup, () => registeredPaths.slice()));
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
          'On Windows this deployment routes the `pwsh` tool to PowerShell 7 (plugin-managed per-user copy by default, or the system default).',
          'Installation is user-initiated only: never install or relocate PowerShell 7 yourself. If `pwsh.exe` is missing, a setup dialog opens in the Web GUI automatically;',
          'tell the user to install from that dialog or from Settings → PowerShell 7, or to install PowerShell 7 manually.',
          '`shell_router` actions `status`, `diagnose`, `selfcheck`, `route`, and `uninstall` are available for inspection and maintenance.',
          '`route` switches to/from the system default and `uninstall` removes the plugin-managed per-user copy; both are explicit user choices.',
          'The Web app also shows the setup dialog and Settings section with live progress.',
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
      const handlers = createSetupHandlers(setup, {
        logger: scope.logger ?? ctx.logger,
        ctx: scope,
        registeredRoutes: () => registeredPaths.slice(),
      });
      const disposers = [];
      try {
        for (const row of setupRouteRows(handlers)) {
          const dispose = webServer.register(row);
          disposers.push(dispose);
          registeredPaths.push(row.path);
        }
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
          registeredPaths.length = 0;
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
