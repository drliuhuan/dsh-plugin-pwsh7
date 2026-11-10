// The routing feature set: `shell_router`, the system-prompt section, the setup coordinator, the
// Web routes, the settings/maintenance actions, and the reload hook.
//
// These features are installed by the bare `dsh-plugin-pwsh7` Loader row (`index.js`), which is also
// the row DSH's client-module scanner uses to discover `client.js`: it accepts only a bare package
// specifier as a bundle source, not the `./pwsh-executor` subpath used by the replacement row.

import { defineTool } from './shipped.mjs';
import { buildDialectPrompt } from './dialect.mjs';
import { buildBasicRulesPrompt } from './rules.mjs';
import { readDialect } from './dialect-config.mjs';
import { readRouterConfig } from './paths.mjs';
import { effectiveRoute, ROUTE_MODES } from './route.mjs';
import { refreshRouterState } from './state.mjs';
import { describeStatus, runDiagnosis } from './status.mjs';
import { createSetupService } from './setup-service.mjs';
import { createSetupHandlers, setupRouteRows } from './setup-routes.mjs';
import { getActiveRecycleService } from './recycle-service.mjs';
import { isAbsolute, resolve } from 'node:path';

/** Guard against a double mount of the same module instance (for example a manual row plus the bundle). */
let installed = false;

/** Installation is user-initiated in the Web UI only; the tool never starts one. */
export const INSTALL_GUIDANCE = [
  'Installation is user-initiated only and the shell_router tool never starts one.',
  'Ask the user to use the PowerShell 7 setup dialog (it opens automatically when pwsh.exe is missing)',
  'or Settings → PowerShell 7 in the Web GUI, or to install PowerShell 7 manually.',
].join(' ');

/** Maintenance paragraph for the plugin/system routes. */
const MAINTENANCE_PARAGRAPH = [
  'On Windows this deployment routes the `pwsh` tool to PowerShell 7 (plugin-managed per-user copy by default, or the system default).',
  'Installation is user-initiated only: never install or relocate PowerShell 7 yourself. If `pwsh.exe` is missing, a setup dialog opens in the Web GUI automatically;',
  'tell the user to install from that dialog or from Settings → PowerShell 7, or to install PowerShell 7 manually.',
  '`shell_router` actions `status`, `diagnose`, `selfcheck`, `route`, `uninstall`, and `restore` are available for inspection, maintenance, and undoing a removal this session performed.',
  '`route` also accepts `pwsh5`, which forces Windows PowerShell 5.1 and turns every PowerShell 7 prompt layer off; `uninstall` removes the plugin-managed per-user copy. Both are explicit user choices.',
  'The Web app also shows the setup dialog and Settings section with live progress.',
  'A shell installed this way becomes usable without restarting the app.',
].join(' ');

/** Maintenance paragraph for the forced `pwsh5` route. */
const PWSH5_MAINTENANCE_PARAGRAPH = [
  'On Windows this deployment is currently forced to Windows PowerShell 5.1 (`pwsh5` route), chosen by the user from the composer chip or Settings.',
  'The `pwsh` tool therefore runs Windows PowerShell 5.1, and all PowerShell 7 prompt guidance and dialect hints are disabled.',
  'Do not install or relocate PowerShell 7 on your own. `shell_router` actions `status`, `diagnose`, `selfcheck`, and `route` are available;',
  '`route` can switch back to `plugin` or `system` when the user asks.',
].join(' ');

/**
 * Compose the system-prompt section text. The always-on basic rules are independent of the opt-in
 * dialect layer and stay in force in every route, including the forced `pwsh5` route.
 *
 * @param {string} route effective route (`plugin`, `system`, or `pwsh5`).
 * @param {string} [dialectPrompt] the opt-in dialect paragraph (empty when disabled).
 * @returns {string} section text; never empty.
 */
export function composePromptText(route, dialectPrompt = '') {
  const maintenance = route === 'pwsh5' ? PWSH5_MAINTENANCE_PARAGRAPH : MAINTENANCE_PARAGRAPH;
  return [buildBasicRulesPrompt(), dialectPrompt, maintenance]
    .filter((part) => typeof part === 'string' && part !== '')
    .join(' ');
}

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
      '`route` switches between the plugin-managed per-user copy (mode=plugin), the system default (mode=system), and forced Windows PowerShell 5.1 (mode=pwsh5, which disables all PowerShell 7 prompt guidance).',
      '`uninstall` removes only the plugin-managed per-user portable installation (files, PATH entries, config).',
      '`restore` puts a path back from the Recycle Bin when THIS session recycled it through the `pwsh` tool (pass the original path). It cannot restore items deleted before the current DSH run, items deleted by a script or native API, or anything deleted outside DSH — the user restores those from the Recycle Bin in Explorer. After any removal, tell the user they can restore it from the Recycle Bin or ask you to restore it via `shell_router` while this session is running.',
      'Installation and relocation are user-initiated only: this tool never starts one. If PowerShell 7 is missing, the Web setup dialog opens automatically; the user can also use Settings → PowerShell 7 or install PowerShell 7 manually. Calling `install` or `relocate` returns that guidance without touching the machine.',
      'The Web app also shows a setup dialog and a Settings section with live progress; the tool and those surfaces share one install job, so either can observe it.',
      'Deletion safety is always on: the `pwsh` executor redirects every `Remove-Item` call (and its aliases) to the Recycle Bin, and the system prompt states that contract.',
      'Use it when `pwsh` reports that PowerShell 7 is missing, or when the user asks about status, diagnosis, routing, or removing the plugin-managed copy.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'diagnose', 'selfcheck', 'route', 'uninstall', 'restore', 'install', 'relocate'],
        description: 'Operation to perform; omit for `status`. `restore` needs `path`. `install`/`relocate` are accepted only to return user-initiated-installation guidance.',
      },
      mode: {
        type: 'string',
        enum: ['plugin', 'system', 'pwsh5'],
        description: 'For `route`: `plugin` uses the plugin-managed per-user copy, `system` uses the machine default (falling back to Windows PowerShell 5.1), `pwsh5` forces Windows PowerShell 5.1 and disables PowerShell 7 prompt guidance.',
      },
      path: {
        type: 'string',
        description: 'For `restore`: the original absolute path (or a workspace-relative one) of an item this session recycled. Restoring a path this session did not delete is refused.',
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
      if (action === 'restore') {
        const bridge = getActiveRecycleService();
        if (bridge === null || typeof bridge.restore !== 'function') {
          return {
            ok: false,
            summary: 'the pwsh7 recycle bridge is not running in this process, so DSH cannot restore anything; restore the item from the Recycle Bin in Explorer instead.',
          };
        }
        const raw = typeof args.path === 'string' ? args.path.trim() : '';
        if (raw.length === 0) {
          return { ok: false, summary: 'restore requires `path`: the original path of an item this session deleted.' };
        }
        const workspace = exec?.agent?.session?.header?.cwd;
        if (typeof workspace !== 'string' || workspace.length === 0) {
          return { ok: false, summary: 'restore needs the session workspace, and this call does not carry one.' };
        }
        const target = isAbsolute(raw) ? raw : resolve(workspace, raw);
        const outcome = bridge.restore([target], workspace);
        if (outcome.error !== undefined) return { ok: false, summary: outcome.error };
        const lines = outcome.results.map((result) => (
          `${result.ok ? 'restored' : 'refused'}: ${result.path}${result.detail === '' ? '' : ` — ${result.detail}`}`
        ));
        if (outcome.results.length === 0) return { ok: false, summary: 'nothing to restore' };
        return { ok: outcome.results.every((result) => result.ok), summary: lines.join('\n') };
      }
      return {
        ok: false,
        summary: `unknown shell_router action ${JSON.stringify(action)}; use status, diagnose, selfcheck, route, uninstall, or restore.`,
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
      // The basic rules are always on: they are a safety contract, not the opt-in dialect layer,
      // and they stay in force in every route (including the forced pwsh5 route). The dialect
      // paragraph is opt-in and read per assembly, so toggling it in the settings page or the setup
      // dialog takes effect on the next model step without a restart.
      const text = () => {
        let route = 'plugin';
        try {
          route = effectiveRoute(readRouterConfig());
        } catch {
          route = 'plugin';
        }
        let dialect = '';
        try {
          dialect = route === 'pwsh5' ? '' : buildDialectPrompt(readDialect());
        } catch {
          // A broken config must not break the prompt: fall back to the maintenance paragraph only.
          dialect = '';
        }
        return composePromptText(route, dialect);
      };
      systemPrompt.section({
        name: 'tool:pwsh7-router',
        order: systemPrompt.getSectionOrder('TOOL_PWSH') + 1,
        text,
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
