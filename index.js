// dsh-plugin-pwsh7 — host plugin entry.
//
// Routes the model-facing `pwsh` tool to PowerShell 7 and exposes a `shell_router` tool for status,
// diagnosis, and per-user installation. The executor class lives in ./lib/executors/pwsh.mjs and is
// mounted by ./cordis.patch.yml; this row installs the tool, the setup routes, and the system-prompt
// section (see ./lib/router-features.mjs).
//
// This row's name must stay the bare package name: DSH's client-module scanner uses it to discover
// the package's `dsh.client` bundle (`client.js`). The executor row's `./pwsh-executor` subpath is
// not a scanner source.

import { installRouterFeatures } from './lib/router-features.mjs';
import { configPath, getRouterState } from './lib/state.mjs';

export const name = 'pwsh7-router';
export const inject = ['tools', 'systemPrompt'];

/**
 * Cordis plugin body: install the tool, system-prompt section, setup routes, and reload hook.
 * @param {object} ctx plugin context.
 */
export function apply(ctx) {
  installRouterFeatures(ctx);
}

export { createToolDefinition, installRouterFeatures } from './lib/router-features.mjs';
export { configPath, getRouterState };
