// lib/install-plan.mjs — identify how PowerShell 7 was installed and choose the upgrade strategy.
//
// A system upgrade must target the executable a *new terminal* resolves, not merely
// %ProgramFiles%\PowerShell\7. The same directory can be an official MSI product, a manual ZIP
// extraction, a Chocolatey/Scoop shim, or the Microsoft Store alias. Upgrading the wrong one (or
// only adding a directory to PATH) is what left Windows Terminal on 7.6.6 in 0.3.4.
//
// The planner is deliberately split from execution:
//   * registry/PATH readers are injectable and failure-tolerant;
//   * detectInstallations()/chooseMainInstallation()/planUpgrade() are pure for tests;
//   * resolveUpgradePlan() wires the readers to the pure decision functions.
//
// Only Node builtins and sibling modules are imported; no @deepseek-ai packages.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import {
  comparePwshVersions,
  discoveredPortablePwshPaths,
  fileOrSymlinkExists,
  isPathInside,
  localAppData,
  routerRoot,
} from './paths.mjs';
import { installDirectory, systemVersionedDirectories } from './install-scope.mjs';

const W = path.win32;

/** Asset architecture suffixes published by PowerShell. */
export const PWSH_ASSET_ARCHITECTURES = Object.freeze(['win-x64', 'win-arm64', 'win-x86']);

/** A directory name that is a PowerShell version (`7.6.9`), not a product directory (`7`). */
const VERSION_DIRECTORY = /^\d+\.\d+(?:\.\d+)*$/;

function programFiles(env) {
  return env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
}

function programFilesX86(env) {
  return env['ProgramFiles(x86)']
    ?? env['PROGRAMFILES(X86)']
    ?? env['ProgramFiles(X86)']
    ?? 'C:\\Program Files (x86)';
}

function programData(env) {
  return env.ProgramData ?? env.PROGRAMDATA ?? 'C:\\ProgramData';
}

function systemRoot(env) {
  return env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? 'C:\\Windows';
}

function key(value) {
  return typeof value === 'string' ? W.normalize(value).replace(/[\\/]+$/, '').toLowerCase() : '';
}

function directoryOf(value) {
  return typeof value === 'string' ? W.normalize(value).replace(/[\\/]+$/, '') : '';
}

/** The architecture of the *operating system*, which is what a system install must match. */
export function resolvePwshArchitecture(env = process.env, runtimeArch = process.arch) {
  const osArch = String(env.PROCESSOR_ARCHITEW6432 ?? env.PROCESSOR_ARCHITECTURE ?? '').trim().toLowerCase();
  if (osArch === 'arm64' || runtimeArch === 'arm64') return 'win-arm64';
  if (osArch === 'x86' && !env.PROCESSOR_ARCHITEW6432) return 'win-x86';
  return 'win-x64';
}

// ---------------------------------------------------------------------------
// Environment expansion (PATH values are often REG_EXPAND_SZ)
// ---------------------------------------------------------------------------

/** Expand `%NAME%` using the environment, case-insensitively, plus the standard Windows defaults. */
export function expandEnvironmentVariables(value, env = process.env) {
  const source = String(value ?? '');
  const variables = new Map();
  for (const [name, entry] of Object.entries(env)) {
    if (typeof entry === 'string') variables.set(name.toLowerCase(), entry);
  }
  const defaults = {
    systemroot: systemRoot(env),
    windir: systemRoot(env),
    programfiles: programFiles(env),
    'programfiles(x86)': programFilesX86(env),
    programdata: programData(env),
    localappdata: localAppData(env),
    userprofile: env.USERPROFILE ?? env.UserProfile ?? '',
    public: env.PUBLIC ?? 'C:\\Users\\Public',
  };
  for (const [name, entry] of Object.entries(defaults)) {
    if (!variables.has(name)) variables.set(name, entry);
  }
  return source.replace(/%([^%]+)%/g, (match, name) => variables.get(String(name).toLowerCase()) ?? match);
}

// ---------------------------------------------------------------------------
// Registry / PATH readers
// ---------------------------------------------------------------------------

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: options.timeoutMs ?? 20_000,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: options.env ?? process.env,
      signal: options.signal,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error,
      });
    });
  });
}

function windowsPowerShellPath(env) {
  return W.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function encodedPowerShellArgs(script) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference = 'SilentlyContinue';\n${script}`, 'utf16le').toString('base64')];
}

const MSI_QUERY_SCRIPT = `
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$items = @(Get-ItemProperty $paths | Where-Object { $_.DisplayName -match '^PowerShell 7' } | ForEach-Object {
  $hive = if (([string]$_.PSPath) -like '*HKEY_LOCAL_MACHINE*') { 'HKLM' } else { 'HKCU' }
  [pscustomobject]@{
    DisplayName = [string]$_.DisplayName
    DisplayVersion = [string]$_.DisplayVersion
    InstallLocation = [string]$_.InstallLocation
    ProductCode = [string]$_.PSChildName
    Hive = $hive
  }
})
ConvertTo-Json -Compress -Depth 4 -InputObject $items
`;

/** Normalize the JSON (array or single object) returned by a PowerShell MSI query. */
export function parseMsiProductRecords(raw, env = process.env) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const records = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  const results = [];
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const name = String(record.DisplayName ?? '').trim();
    if (!/^PowerShell 7/i.test(name) || /preview/i.test(name)) continue;
    const hive = String(record.Hive ?? '').toUpperCase() === 'HKLM' ? 'HKLM' : 'HKCU';
    const scope = hive === 'HKLM' ? 'system' : 'user';
    const version = String(record.DisplayVersion ?? '').trim();
    const fallback = scope === 'system'
      ? W.join(programFiles(env), 'PowerShell', '7')
      : W.join(localAppData(env), 'Programs', 'PowerShell', '7');
    const installLocation = String(record.InstallLocation ?? '').trim().replace(/^"(.*)"$/, '$1');
    const directory = directoryOf(installLocation || fallback);
    results.push({
      kind: 'msi',
      scope,
      path: W.join(directory, 'pwsh.exe'),
      directory,
      version: version || undefined,
      productCode: String(record.ProductCode ?? '').trim() || undefined,
      name,
      source: 'msi',
    });
  }
  return results;
}

/** Read installed PowerShell MSI products from the uninstall registry keys. */
export async function readMsiProducts(env = process.env, run = execFileAsync) {
  const result = await run(
    windowsPowerShellPath(env),
    encodedPowerShellArgs(MSI_QUERY_SCRIPT),
    { env, timeoutMs: 25_000, windowsHide: true },
  );
  if (!result?.ok) return [];
  return parseMsiProductRecords(result.stdout, env);
}

async function registryPathValue(keyPath, env, run) {
  const result = await run('reg.exe', ['query', keyPath, '/v', 'Path'], {
    env,
    timeoutMs: 10_000,
    windowsHide: true,
  });
  if (!result?.ok) return '';
  const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im.exec(result.stdout ?? '');
  return match ? match[1].trim() : '';
}

/**
 * Persisted PATH entries for a new process, machine first then user (the Windows order). Falls
 * back to the current process PATH when both registry reads fail. Values are expanded and
 * de-duplicated case-insensitively.
 */
export async function readPersistedPathEntries(env = process.env, run = execFileAsync) {
  const machine = await registryPathValue(
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    env,
    run,
  );
  const user = await registryPathValue('HKCU\\Environment', env, run);
  const entries = [];
  const seen = new Set();
  const add = (raw, source) => {
    for (const part of String(raw ?? '').split(W.delimiter)) {
      const trimmed = part.trim().replace(/^"(.*)"$/, '$1');
      const expanded = expandEnvironmentVariables(trimmed, env).trim();
      if (!expanded) continue;
      const normalised = directoryOf(expanded);
      const dedupe = key(normalised);
      if (!dedupe || seen.has(dedupe)) continue;
      seen.add(dedupe);
      entries.push({ value: normalised, source });
    }
  };
  add(machine, 'machine');
  add(user, 'user');
  if (entries.length === 0) {
    add(env.PATH ?? env.Path ?? '', 'process');
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Classification / detection
// ---------------------------------------------------------------------------

/** Classify one pwsh.exe path into an installation descriptor. */
export function classifyPwshPath(executable, options = {}) {
  if (typeof executable !== 'string' || !executable.trim()) return undefined;
  const env = options.env ?? process.env;
  const root = options.root ?? routerRoot(env);
  const msiProducts = Array.isArray(options.msiProducts) ? options.msiProducts : [];
  const normalised = W.normalize(executable.trim());
  const directory = directoryOf(W.dirname(normalised));
  const matchingProduct = msiProducts.find((product) => key(product.directory) === key(directory));
  if (matchingProduct) {
    return { ...matchingProduct, path: normalised, directory };
  }

  if (isPathInside(normalised, W.join(root, 'powershell7'))) {
    return {
      kind: 'plugin-user',
      scope: 'user',
      path: normalised,
      directory,
      version: VERSION_DIRECTORY.test(W.basename(directory)) ? W.basename(directory) : undefined,
      source: 'plugin',
    };
  }

  const systemDir = installDirectory(env, 'system', root);
  if (isPathInside(normalised, systemDir)) {
    const relative = W.relative(systemDir, normalised);
    const first = relative.split(/[\\/]/)[0];
    if (VERSION_DIRECTORY.test(first)) {
      return {
        kind: 'plugin-system-legacy',
        scope: 'system',
        path: normalised,
        directory: W.join(systemDir, first),
        version: first,
        source: 'legacy',
      };
    }
    return {
      kind: 'portable',
      scope: 'system',
      path: normalised,
      directory: systemDir,
      canonical: true,
      source: 'canonical',
    };
  }

  const appData = localAppData(env);
  if (isPathInside(normalised, W.join(appData, 'Microsoft', 'WindowsApps'))) {
    return { kind: 'store', scope: 'user', path: normalised, directory, source: 'store' };
  }

  const chocoBin = W.join(programData(env), 'chocolatey', 'bin');
  if (isPathInside(normalised, chocoBin) || /\\chocolatey\\lib\\/i.test(normalised)) {
    return { kind: 'chocolatey', scope: 'system', path: normalised, directory, source: 'chocolatey' };
  }

  const scoopUser = W.join(env.USERPROFILE ?? env.UserProfile ?? '', 'scoop');
  const scoopGlobal = W.join(programData(env), 'scoop');
  if (isPathInside(normalised, scoopUser) || isPathInside(normalised, scoopGlobal)) {
    return {
      kind: 'scoop',
      scope: isPathInside(normalised, scoopGlobal) ? 'system' : 'user',
      path: normalised,
      directory,
      source: 'scoop',
    };
  }

  // A generic shim/symlink: replace the real installation directory, not the shim directory.
  let portablePath = normalised;
  let portableDirectory = directory;
  try {
    const real = fs.realpathSync.native(normalised);
    if (typeof real === 'string' && real.trim()) {
      portablePath = W.normalize(real);
      portableDirectory = directoryOf(W.dirname(portablePath));
    }
  } catch {
    // A missing/broken link keeps the declared path.
  }
  return {
    kind: 'portable',
    scope: isPathInside(portablePath, programFiles(env)) || isPathInside(portablePath, programFilesX86(env))
      ? 'system'
      : 'user',
    path: portablePath,
    directory: portableDirectory,
    source: 'portable',
  };
}

/** Every PowerShell 7 installation this machine can see, de-duplicated by executable path. */
export function detectInstallations(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? routerRoot(env);
  const msiProducts = Array.isArray(options.msiProducts) ? options.msiProducts : [];
  const pathEntries = Array.isArray(options.pathEntries) ? options.pathEntries : [];
  const installations = [];
  const seen = new Set();

  const add = (candidate) => {
    if (!candidate || typeof candidate.path !== 'string' || !candidate.path.trim()) return;
    if (!fileOrSymlinkExists(candidate.path)) return;
    const dedupe = key(candidate.path);
    if (!dedupe || seen.has(dedupe)) return;
    seen.add(dedupe);
    installations.push(candidate);
  };

  for (const product of msiProducts) add(product);
  add(classifyPwshPath(W.join(installDirectory(env, 'system', root), 'pwsh.exe'), { env, root, msiProducts }));
  add(classifyPwshPath(W.join(localAppData(env), 'Programs', 'PowerShell', '7', 'pwsh.exe'), { env, root, msiProducts }));

  for (const entry of systemVersionedDirectories(env, root)) {
    add({
      kind: 'plugin-system-legacy',
      scope: 'system',
      path: entry.path,
      directory: entry.directory,
      version: entry.version,
      source: 'legacy',
    });
  }
  for (const candidate of discoveredPortablePwshPaths(env)) {
    add(classifyPwshPath(candidate, { env, root, msiProducts }));
  }

  for (const alias of [
    W.join(localAppData(env), 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    W.join(programData(env), 'chocolatey', 'bin', 'pwsh.exe'),
    W.join(env.USERPROFILE ?? env.UserProfile ?? '', 'scoop', 'shims', 'pwsh.exe'),
    W.join(programData(env), 'scoop', 'shims', 'pwsh.exe'),
  ]) {
    add(classifyPwshPath(alias, { env, root, msiProducts }));
  }

  for (const entry of pathEntries) {
    if (typeof entry?.value !== 'string') continue;
    add(classifyPwshPath(W.join(entry.value, 'pwsh.exe'), { env, root, msiProducts }));
  }

  return installations;
}

/**
 * Choose the installation a new terminal resolves, in this order:
 * explicit override, the persisted machine+user PATH, canonical system install, plugin legacy,
 * plugin user copy, per-user Programs, Store/package-manager aliases, then any candidate.
 */
export function chooseMainInstallation(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? routerRoot(env);
  const installations = Array.isArray(options.installations) ? options.installations : [];
  const pathEntries = Array.isArray(options.pathEntries) ? options.pathEntries : [];
  const msiProducts = Array.isArray(options.msiProducts) ? options.msiProducts : [];
  const byPath = new Map(installations.map((entry) => [key(entry.path), entry]));
  const classify = (candidate) => classifyPwshPath(candidate, { env, root, msiProducts });

  const declared = typeof options.overridePath === 'string' && options.overridePath.trim()
    ? options.overridePath.trim()
    : undefined;
  if (declared !== undefined && fileOrSymlinkExists(declared)) {
    const found = byPath.get(key(declared)) ?? classify(declared);
    if (found) return { ...found, explicit: true, source: 'override' };
  }

  for (const entry of pathEntries) {
    if (typeof entry?.value !== 'string') continue;
    const candidate = W.join(entry.value, 'pwsh.exe');
    if (!fileOrSymlinkExists(candidate)) continue;
    const found = byPath.get(key(candidate)) ?? classify(candidate);
    if (found) return { ...found, source: entry.source ?? 'path' };
  }

  const preferred = [
    W.join(installDirectory(env, 'system', root), 'pwsh.exe'),
    ...installations.filter((entry) => entry.kind === 'plugin-system-legacy').map((entry) => entry.path),
    ...installations.filter((entry) => entry.kind === 'plugin-user').map((entry) => entry.path),
    W.join(localAppData(env), 'Programs', 'PowerShell', '7', 'pwsh.exe'),
    W.join(localAppData(env), 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    ...installations.filter((entry) => entry.kind === 'chocolatey').map((entry) => entry.path),
    ...installations.filter((entry) => entry.kind === 'scoop').map((entry) => entry.path),
  ];
  for (const candidate of preferred) {
    const found = byPath.get(key(candidate));
    if (found) return found;
  }
  return installations.length > 0 ? installations[0] : undefined;
}

// ---------------------------------------------------------------------------
// Upgrade planning
// ---------------------------------------------------------------------------

/**
 * Map the main installation to an upgrade mechanism:
 *
 *   msi              official MSI, in place (machine or per-user product)
 *   msi-install      no usable main install: install the MSI into Program Files
 *   zip-in-place     manual/portable ZIP directory: replace its contents, keep the path
 *   chocolatey       `choco upgrade powershell-core`
 *   scoop            `scoop update pwsh`
 *   store            Microsoft Store app: `winget upgrade ... --source msstore`
 *   zip-versioned    plugin-managed per-user copy (versioned directory + config switch)
 *   refuse           an explicit DSH_PWSH_PATH/config override owns the executable
 */
export function planUpgrade(main, options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? routerRoot(env);
  const scope = options.scope === 'user' ? 'user' : 'system';
  const canonicalDirectory = installDirectory(env, 'system', root);

  if (!main || (typeof main.path !== 'string' && typeof main.directory !== 'string')) {
    return {
      strategy: 'msi-install',
      targetDirectory: canonicalDirectory,
      allUsers: true,
      reason: 'no PowerShell 7 installation was detected; install the official MSI system-wide',
    };
  }
  if (main.explicit === true) {
    return {
      strategy: 'refuse',
      targetDirectory: main.directory ?? canonicalDirectory,
      reason: `the pwsh tool is pinned to ${main.path} by DSH_PWSH_PATH or the row config; `
        + 'update that installation with its own installer, or remove the override and retry',
    };
  }

  switch (main.kind) {
    case 'msi':
      return {
        strategy: 'msi',
        targetDirectory: main.directory ?? canonicalDirectory,
        allUsers: main.scope !== 'user',
        productCode: main.productCode,
        scope: main.scope,
        reason: `upgrade the ${main.scope === 'user' ? 'per-user' : 'machine-wide'} MSI product in place`,
      };
    case 'plugin-system-legacy':
      return {
        strategy: 'msi',
        targetDirectory: canonicalDirectory,
        allUsers: true,
        cleanupLegacy: true,
        scope: 'system',
        reason: 'the main install is a legacy side-by-side copy; upgrade the canonical MSI and remove it',
      };
    case 'plugin-user':
      return scope === 'system'
        ? {
          strategy: 'msi-install',
          targetDirectory: canonicalDirectory,
          allUsers: true,
          cleanupLegacy: true,
          reason: 'install the official MSI system-wide; the per-user copy is removed afterwards',
        }
        : { strategy: 'zip-versioned', targetDirectory: main.directory, scope: 'user' };
    case 'portable':
      return {
        strategy: 'zip-in-place',
        targetDirectory: main.directory,
        scope: main.scope,
        pathSource: main.source,
        reason: 'the main install is a manual/portable ZIP directory; replace its contents in place',
      };
    case 'store':
      return {
        strategy: 'store',
        targetDirectory: main.directory,
        scope: 'user',
        reason: 'the main install is the Microsoft Store package',
      };
    case 'chocolatey':
      return {
        strategy: 'chocolatey',
        targetDirectory: main.directory,
        scope: 'system',
        reason: 'the main install is managed by Chocolatey',
      };
    case 'scoop':
      return {
        strategy: 'scoop',
        targetDirectory: main.directory,
        scope: main.scope ?? 'user',
        global: main.scope === 'system',
        reason: 'the main install is managed by Scoop',
      };
    default:
      return {
        strategy: 'msi-install',
        targetDirectory: canonicalDirectory,
        allUsers: true,
        reason: 'the installation type is unknown; install the official MSI system-wide',
      };
  }
}

/** Read the machine state and return `{ installations, main, plan, msiProducts, pathEntries }`. */
export async function resolveUpgradePlan(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? routerRoot(env);
  const msiProducts = Array.isArray(options.msiProducts)
    ? options.msiProducts
    : await readMsiProducts(env, options.run);
  const pathEntries = Array.isArray(options.pathEntries)
    ? options.pathEntries
    : await readPersistedPathEntries(env, options.run);
  const installations = detectInstallations({ env, root, msiProducts, pathEntries });
  const main = chooseMainInstallation({
    env,
    root,
    installations,
    pathEntries,
    overridePath: options.declaredPath ?? env.DSH_PWSH_PATH,
    msiProducts,
  });
  const plan = planUpgrade(main, { env, root, scope: options.scope ?? 'system' });
  return { env, root, msiProducts, pathEntries, installations, main, plan };
}

// Unused import guard: comparePwshVersions is intentionally re-exported for callers that plan
// version-aware work next to detection.
export { comparePwshVersions };
