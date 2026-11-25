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
  probePwsh,
  routerRoot,
} from './paths.mjs';
import { installDirectory, systemVersionedDirectories } from './install-scope.mjs';

const W = path.win32;

/** Asset architecture suffixes published by PowerShell. */
export const PWSH_ASSET_ARCHITECTURES = Object.freeze(['win-x64', 'win-arm64', 'win-x86']);

/** A directory name that is a PowerShell version (`7.6.9`), not a product directory (`7`). */
const VERSION_DIRECTORY = /^\d+\.\d+(?:\.\d+)*$/;

/**
 * Why a Microsoft Store (MSIX) PowerShell is never used or updated.
 *
 * The `WindowsApps` entry is an app-execution alias, not a normal executable: a non-interactive
 * child process frequently cannot launch it at all, so `pwsh` fails even though the file exists.
 * DSH therefore installs only the official MSI or the portable ZIP and lists a Store copy as
 * unsupported instead of selecting it.
 */
export const STORE_UNSUPPORTED_REASON =
  'Microsoft Store (MSIX) PowerShell cannot be launched reliably from DSH. '
  + 'Install the official MSI or the portable ZIP instead; the Store copy is left untouched.';

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
    return {
      kind: 'store',
      scope: 'user',
      path: normalised,
      directory,
      source: 'store',
      supported: false,
      unsupportedReason: STORE_UNSUPPORTED_REASON,
    };
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
    // An unsupported (Microsoft Store/MSIX) copy is never the implicit main installation.
    if (found !== undefined && found.supported !== false) return { ...found, source: entry.source ?? 'path' };
  }

  const preferred = [
    W.join(installDirectory(env, 'system', root), 'pwsh.exe'),
    ...installations.filter((entry) => entry.kind === 'plugin-system-legacy').map((entry) => entry.path),
    ...installations.filter((entry) => entry.kind === 'plugin-user').map((entry) => entry.path),
    W.join(localAppData(env), 'Programs', 'PowerShell', '7', 'pwsh.exe'),
    ...installations.filter((entry) => entry.kind === 'chocolatey').map((entry) => entry.path),
    ...installations.filter((entry) => entry.kind === 'scoop').map((entry) => entry.path),
  ];
  for (const candidate of preferred) {
    const found = byPath.get(key(candidate));
    if (found !== undefined && found.supported !== false) return found;
  }
  const supported = installations.filter((entry) => entry.supported !== false);
  if (supported.length > 0) return supported[0];
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
        strategy: 'refuse',
        targetDirectory: main.directory,
        scope: 'user',
        reason: 'the main install is a Microsoft Store (MSIX) package. ' + STORE_UNSUPPORTED_REASON,
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

// ---------------------------------------------------------------------------
// Installation list for the Settings picker
// ---------------------------------------------------------------------------

/** Map a detected installation kind onto the method ids the Settings page already localizes. */
function methodForKind(kind) {
  switch (kind) {
    case 'msi':
      return 'msi';
    case 'plugin-user':
      return 'portable';
    case 'plugin-system-legacy':
      return 'legacy-portable';
    case 'portable':
      return 'portable';
    case 'store':
      return 'store';
    case 'chocolatey':
      return 'chocolatey';
    case 'scoop':
      return 'scoop';
    default:
      return 'existing';
  }
}

/**
 * Every PowerShell 7 installation this machine exposes, with the version each executable reports.
 *
 * This backs the Settings "PowerShell 7 to use" dropdown: when several installations exist (machine
 * or per-user MSI, the plugin's portable copy, a legacy side-by-side copy, a Store alias, Chocolatey,
 * Scoop, a custom PATH entry), the user can pin exactly one. Detection reuses the upgrade planner
 * (registry MSI products + persisted machine/user PATH + well-known locations); each executable is
 * then probed in parallel, because only the executable itself knows its real version — the registry
 * or directory names can be stale or missing.
 *
 * `options.plan` lets tests (and callers that already ran the planner) skip detection; `options.probe`
 * replaces the version probe. Entries are returned newest verified version first, then system before
 * user, then by path; unprobeable installations stay listed with `verified: false`.
 *
 * @returns {Promise<{installations: Array<{path: string, directory: string, version: string|null,
 *   verified: boolean, scope: 'system'|'user', method: string, kind: string, source: string}>,
 *   main?: {path: string, kind: string, scope: string}, declaredOverride?: string}>}
 */
export async function listPwshInstallations(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? routerRoot(env);
  const probe = typeof options.probe === 'function' ? options.probe : probePwsh;
  const plan = options.plan ?? await resolveUpgradePlan({
    env,
    root,
    run: options.run,
    msiProducts: options.msiProducts,
    pathEntries: options.pathEntries,
    declaredPath: options.declaredPath,
    scope: 'system',
  });

  const entries = [];
  const seen = new Set();
  const add = (entry) => {
    if (entry === null || typeof entry !== 'object') return;
    if (typeof entry.path !== 'string' || !entry.path.trim()) return;
    const normalised = W.normalize(entry.path.trim());
    const dedupe = key(normalised);
    if (!dedupe || seen.has(dedupe)) return;
    seen.add(dedupe);
    const directory = typeof entry.directory === 'string' && entry.directory.trim()
      ? W.normalize(entry.directory.trim())
      : directoryOf(W.dirname(normalised));
    const kind = typeof entry.kind === 'string' && entry.kind ? entry.kind : 'portable';
    entries.push({
      path: normalised,
      directory,
      scope: entry.scope === 'system' ? 'system' : 'user',
      kind,
      method: methodForKind(kind),
      supported: entry.supported !== false,
      reason: typeof entry.unsupportedReason === 'string' ? entry.unsupportedReason : null,
      source: typeof entry.source === 'string' && entry.source ? entry.source : 'detected',
      recordedVersion: typeof entry.version === 'string' && entry.version.trim() ? entry.version.trim() : undefined,
    });
  };
  if (plan !== null && typeof plan === 'object') {
    add(plan.main);
    for (const entry of plan.installations ?? []) add(entry);
  }

  const probed = await Promise.all(entries.map(async (entry) => {
    let version;
    let verified = false;
    try {
      const result = await probe(entry.path, { env, signal: options.signal });
      if (result?.ok === true && typeof result.version === 'string' && result.version.trim()) {
        version = result.version.trim();
        verified = true;
      }
    } catch {
      // An unprobeable executable is still listed; the picker shows it without a verified version.
    }
    return {
      ...entry,
      version: version ?? entry.recordedVersion ?? null,
      verified,
    };
  }));

  probed.sort((left, right) => {
    if (left.verified !== right.verified) return left.verified ? -1 : 1;
    const byVersion = comparePwshVersions(right.version ?? '', left.version ?? '');
    if (byVersion !== 0) return byVersion;
    if (left.scope !== right.scope) return left.scope === 'system' ? -1 : 1;
    return left.path.localeCompare(right.path);
  });

  const main = plan !== null && typeof plan === 'object' && plan.main !== null && typeof plan.main === 'object'
    ? {
      path: typeof plan.main.path === 'string' ? W.normalize(plan.main.path) : undefined,
      kind: typeof plan.main.kind === 'string' ? plan.main.kind : undefined,
      scope: plan.main.scope === 'system' ? 'system' : 'user',
    }
    : undefined;
  const declaredOverride = typeof options.declaredPath === 'string' && options.declaredPath.trim()
    ? options.declaredPath.trim()
    : (typeof env.DSH_PWSH_PATH === 'string' && env.DSH_PWSH_PATH.trim() ? env.DSH_PWSH_PATH.trim() : undefined);
  return {
    installations: probed,
    ...(main !== undefined ? { main } : {}),
    ...(declaredOverride !== undefined ? { declaredOverride } : {}),
  };
}

// Unused import guard: comparePwshVersions is intentionally re-exported for callers that plan
// version-aware work next to detection.
export { comparePwshVersions };
