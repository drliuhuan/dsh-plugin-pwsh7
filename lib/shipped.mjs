// Load the shipped @deepseek-ai packages from the running DSH installation.
//
// A profile-installed bundle is a linked directory outside the DSH install, so a bare
// `import '@deepseek-ai/dsh-tools'` fails with ERR_MODULE_NOT_FOUND (verified live).
// The running Host is Electron, whose patched `fs`/`createRequire` can read app.asar, so we
// root a CommonJS require at the dsh install's package.json. Node 22+/24 supports
// `require()` of ESM packages, and the shipped tools are ESM, so named exports arrive on the
// returned namespace object.
//
// `DSH_PWSH7_APP_ROOT` overrides the install root for tests or unusual layouts; it must
// point at the directory that contains the shipped `node_modules` (normally
// `<resources>/app.asar/dsh`).

import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

let cachedRequire;

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function appRootCandidates() {
  const candidates = [];
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) candidates.push(value);
  };
  add(process.env.DSH_PWSH7_APP_ROOT);
  const resources = process.resourcesPath;
  if (typeof resources === 'string' && resources.length > 0) {
    add(join(resources, 'app.asar', 'dsh'));
    add(join(resources, 'app', 'dsh'));
  }
  if (typeof process.execPath === 'string') {
    const installRoot = dirname(process.execPath);
    add(join(installRoot, 'resources', 'app.asar', 'dsh'));
    add(join(installRoot, 'resources', 'app', 'dsh'));
  }
  return [...new Set(candidates)];
}

function makeRequire() {
  const errors = [];
  for (const root of appRootCandidates()) {
    const manifest = join(root, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const req = createRequire(manifest);
      req.resolve('@deepseek-ai/dsh-tools');
      return req;
    } catch (error) {
      errors.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Source checkout / CLI runs resolve shipped packages normally from this module's location.
  try {
    const req = createRequire(import.meta.url);
    req.resolve('@deepseek-ai/dsh-tools');
    return req;
  } catch (error) {
    errors.push(`module location: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(
    'pwsh7-router: cannot locate the shipped @deepseek-ai packages. '
    + `Tried: ${appRootCandidates().join(' | ') || '(no candidates)'}. `
    + `Set DSH_PWSH7_APP_ROOT to the dsh app root. Details: ${errors.join(' | ')}`,
  );
}

function getRequire() {
  cachedRequire ??= makeRequire();
  return cachedRequire;
}

/**
 * Load one shipped package through the DSH installation's module resolution.
 * @param {string} specifier package specifier, e.g. '@deepseek-ai/dsh-shell'.
 * @returns {any} the package namespace (ESM exports are reachable as properties).
 */
export function shipped(specifier) {
  return getRequire()(specifier);
}

/** `defineTool` from the shipped tool registry, bound lazily. */
export function defineTool(options) {
  return shipped('@deepseek-ai/dsh-tools').defineTool(options);
}

/** Diagnostic fact for the setup/status tool; does not throw when resolution fails. */
export function describeShippedResolution() {
  try {
    const req = getRequire();
    return {
      ok: true,
      appRoot: appRootCandidates().find((root) => existsSync(join(root, 'package.json'))) ?? null,
      tools: req.resolve('@deepseek-ai/dsh-tools'),
      shell: req.resolve('@deepseek-ai/dsh-shell'),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Reset the cached require (tests only). */
export function resetShippedRequire() {
  cachedRequire = undefined;
}

// Keep the path delimiter import used for future executable lookups in this module's tests.
export const PATH_DELIMITER = delimiter;
