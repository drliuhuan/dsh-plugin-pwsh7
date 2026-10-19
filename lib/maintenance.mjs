// Managed per-user installation cleanup, shared by the uninstall route/tool action and the
// relocate-to-system flow.
//
// Only the plugin's own portable copy is touched: `<routerRoot>\powershell7\<version>\` directories,
// a legacy `<routerRoot>\powershell7\pwsh.exe`, `<routerRoot>\tmp`, and PATH entries under the router
// root. Deletion is confined to the *real* router root: reparse points are never followed and every
// directory is resolved with `realpath` before it is removed, so a junction cannot redirect the
// cleanup outside the plugin's own directory. Files locked by a running process are reported as
// warnings instead of throwing; `ok` stays false while a plugin-managed executable is still present.

import fs from 'node:fs';
import path from 'node:path';

import {
  fileOrSymlinkExists,
  isPathInside,
  readRouterConfig,
  routerRoot,
  writeRouterConfig,
} from './paths.mjs';
import { removePathEntriesUnder } from './install-scope.mjs';
import { effectiveRoute } from './route.mjs';

const W = path.win32;

/** Portable install directory names; anything else under `powershell7` is left alone. */
const VERSION_DIRECTORY = /^\d+\.\d+(?:\.\d+)*$/;

function errorText(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function isReparsePoint(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function realpath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return undefined;
  }
}

function normalise(value) {
  return W.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
}

/** True when `target`'s real path is the real `base` or lives below it. */
function isRealPathInside(target, base) {
  const child = realpath(target);
  if (child === undefined) return false;
  const parent = realpath(base);
  if (parent === undefined) return false;
  const childValue = normalise(child);
  const parentValue = normalise(parent);
  return childValue === parentValue || childValue.startsWith(parentValue + W.sep);
}

function defaultRemoveDir(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Remove the plugin-managed per-user portable installation.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.root]                router root override (tests)
 * @param {Function} [options.removeDir]         `rmSync` seam (tests)
 * @param {Function} [options.removePathEntries] PATH cleanup seam (tests, no registry write)
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ ok: boolean, removed: string[], warnings: string[], remaining: string[] }>}
 */
export async function removeManagedUserInstall(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? routerRoot(env);
  const removeDir = options.removeDir ?? defaultRemoveDir;
  const removePath = options.removePathEntries ?? removePathEntriesUnder;
  const installingRoot = W.join(root, 'powershell7');

  const removed = [];
  const warnings = [];
  /** A reparse point at the slot we would clear blocks the whole cleanup. */
  let blocked = false;

  const configBefore = readRouterConfig(env) ?? {};
  const configuredPaths = [configBefore.pwshPath, configBefore.installed?.pwsh?.path]
    .filter((value) => typeof value === 'string' && isPathInside(value, root));

  /** Remove one directory only when its real path is inside the real router root. */
  const removeContainedDirectory = (target) => {
    if (!isRealPathInside(target, root)) {
      warnings.push(`refusing to remove ${target}: its real path is outside ${root}`);
      return false;
    }
    const existed = exists(target);
    try {
      removeDir(target);
      if (existed) removed.push(target);
      return true;
    } catch (caught) {
      warnings.push(`${target}: ${errorText(caught)}`);
      return false;
    }
  };

  /** A link is unlinked, never followed; recursive deletion of a link target is never attempted. */
  const unlinkReparse = (target) => {
    try {
      fs.unlinkSync(target);
      removed.push(target);
      return true;
    } catch (caught) {
      warnings.push(`${target}: ${errorText(caught)}`);
      return false;
    }
  };

  // 1. The per-version portable directories and a legacy pwsh.exe directly under powershell7.
  if (isReparsePoint(installingRoot)) {
    blocked = true;
    warnings.push(
      `refusing to remove ${installingRoot}: it is a reparse point; remove it manually after verifying its target`,
    );
  } else if (exists(installingRoot)) {
    let entries = [];
    try {
      entries = fs.readdirSync(installingRoot, { withFileTypes: true });
    } catch (caught) {
      warnings.push(`${installingRoot}: ${errorText(caught)}`);
    }
    for (const entry of entries) {
      const target = W.join(installingRoot, entry.name);
      if (VERSION_DIRECTORY.test(entry.name)) {
        if (isReparsePoint(target)) unlinkReparse(target);
        else removeContainedDirectory(target);
      } else if (entry.name.toLowerCase() === 'pwsh.exe' && fileOrSymlinkExists(target)) {
        if (isReparsePoint(target)) unlinkReparse(target);
        else removeContainedDirectory(target);
      }
    }
    // Prune the now-empty parent; never follow or remove a reparse point here.
    try {
      if (!isReparsePoint(installingRoot) && exists(installingRoot)
        && fs.readdirSync(installingRoot).length === 0) {
        removeDir(installingRoot);
        removed.push(installingRoot);
      }
    } catch (caught) {
      warnings.push(`${installingRoot}: ${errorText(caught)}`);
    }
  }

  // 2. Download temporary directory.
  const tmpDir = W.join(root, 'tmp');
  if (isReparsePoint(tmpDir)) unlinkReparse(tmpDir);
  else if (exists(tmpDir)) removeContainedDirectory(tmpDir);

  // 3. PATH entries under the root (persisted user hive + this process).
  try {
    await removePath(root, { env, scope: 'user', run: options.run, signal: options.signal });
  } catch (caught) {
    warnings.push(`PATH cleanup failed: ${errorText(caught)}`);
  }

  // 4. Keep only the routing preference in config; the executable metadata belongs to the install.
  try {
    const current = readRouterConfig(env) ?? {};
    const next = { version: current.version ?? 1, route: effectiveRoute(current) };
    writeRouterConfig(next, env);
  } catch (caught) {
    warnings.push(`config cleanup failed: ${errorText(caught)}`);
  }

  // 5. Verify nothing the plugin can still resolve survived. This includes the explicit
  //    `<root>\powershell7\pwsh.exe` candidate and executable paths the config pointed at.
  const remaining = [];
  const remember = (target) => {
    if (fileOrSymlinkExists(target) && !remaining.includes(target)) remaining.push(target);
  };
  remember(W.join(installingRoot, 'pwsh.exe'));
  for (const configured of configuredPaths) remember(configured);
  if (!blocked && exists(installingRoot) && !isReparsePoint(installingRoot)) {
    try {
      for (const entry of fs.readdirSync(installingRoot)) {
        if (VERSION_DIRECTORY.test(entry)) remember(W.join(installingRoot, entry, 'pwsh.exe'));
        else if (entry.toLowerCase() === 'pwsh.exe') remember(W.join(installingRoot, entry));
      }
    } catch {
      // The directory vanished or is unreadable; the explicit probes above still answer.
    }
  }
  if (blocked) remaining.push(installingRoot);

  if (remaining.length > 0) {
    warnings.push(
      `PowerShell 7 is still present at ${remaining[0]}; close any process using it and retry the uninstall`,
    );
  }

  return { ok: remaining.length === 0 && !blocked, removed, warnings, remaining };
}
