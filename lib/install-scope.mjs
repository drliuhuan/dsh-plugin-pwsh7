// Shared Windows install-scope helpers: per-user vs Program Files, PATH persistence/removal, and
// elevation probes.
//
// PATH is written to the matching registry hive, preserving the raw (unexpanded) value and its
// value kind, and Explorer is notified so newly launched processes see the change. The same module
// owns the inverse operation used by the v0.3.0 settings page uninstall and by relocation cleanup.

import path from 'node:path';
import { execFileProbe, isPathInside, routerRoot } from './paths.mjs';

const W = path.win32;

export function validateScope(scope) {
  if (!['user', 'system'].includes(scope)) {
    throw new TypeError(`unsupported install scope ${JSON.stringify(scope)}`);
  }
  return scope;
}

export function installDirectory(env = process.env, scope = 'user', root = routerRoot(env)) {
  validateScope(scope);
  return scope === 'system'
    ? W.join(env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files', 'PowerShell', '7')
    : root;
}

function psQuote(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function windowsPowerShellPath(env) {
  return W.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function encodedPowerShellArgs(script) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference = 'Stop';\n" + script, 'utf16le').toString('base64')];
}

/** Registry hive/key for the persisted PATH of a scope. */
function pathRegistryTarget(scope) {
  validateScope(scope);
  return scope === 'system'
    ? { hive: 'LocalMachine', key: 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' }
    : { hive: 'CurrentUser', key: 'Environment' };
}

/**
 * Tell already-running Explorer/broadcast listeners that the environment changed, so newly
 * launched processes inherit the updated PATH (matches the stock installer behavior).
 */
const BROADCAST_ENVIRONMENT_SCRIPT = `
# Notify Explorer so newly launched processes inherit the updated PATH.
Add-Type -Namespace DshPwsh7 -Name EnvironmentBroadcast -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);
'@
$result = [UIntPtr]::Zero
[void][DshPwsh7.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result)
`;

async function runWindowsScript(script, options) {
  const env = options.env ?? process.env;
  const result = await (options.run ?? execFileProbe)(
    windowsPowerShellPath(env),
    encodedPowerShellArgs(script),
    { env, signal: options.signal, timeoutMs: 15000 },
  );
  if (!result?.ok) {
    const detail = decodeWindowsPowerShellError(result?.stderr)
      || decodeWindowsPowerShellError(result?.stdout)
      || result?.error?.message
      || 'no output';
    throw new Error(`Windows ${options.scope ?? 'user'} installation configuration failed: ${detail}`);
  }
  return result;
}

const CLIXML_ESCAPE_PATTERN = /_x([0-9A-Fa-f]{4})_/g;

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9A-Fa-f]+);/g, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, digits) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Windows PowerShell 5.1 serializes its error stream as CLIXML when stderr is redirected:
 *
 *   #< CLIXML
 *   <Objs Version="1.1.0.1" ...><S S="Error">...text_x000D__x000A_</S></Objs>
 *
 * Users must never see that blob (it also ends up in HTTP errors and the Settings page). Pull the
 * `<S S="Error">` records out, decode `_xNNNN_` escapes and XML entities, drop the envelope, and
 * return readable lines. Plain (non-CLIXML) text passes through unchanged.
 */
export function decodeWindowsPowerShellError(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  if (!/#<\s*CLIXML|<Objs\b/i.test(raw)) return raw.trim();

  const records = [...raw.matchAll(/<S\s+S="Error">([\s\S]*?)<\/S>/gi)].map((match) => match[1]);
  const body = records.length > 0 ? records.join('\n') : raw.replace(/<[^>]+>/g, ' ');
  const decoded = decodeXmlEntities(
    body.replace(CLIXML_ESCAPE_PATTERN, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16))),
  );
  return decoded
    .replace(/#<\s*CLIXML/gi, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

const ADMINISTRATOR_REQUIRED_MESSAGE =
  'System installation requires administrator rights. Run the DSH host as administrator and retry.';

export async function requireSystemAdministrator(options = {}) {
  try {
    await runWindowsScript(`
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '${ADMINISTRATOR_REQUIRED_MESSAGE}'
}`, { ...options, scope: 'system' });
  } catch {
    // The script's only job is the elevation probe: any failure (not elevated, CLIXML noise, or a
    // PowerShell spawn problem) maps to the friendly, actionable sentence the Settings page shows.
    throw new Error(ADMINISTRATOR_REQUIRED_MESSAGE);
  }
}

/**
 * Probe whether the current host process is elevated. Never throws; an unparsable/failed probe is
 * reported as "not elevated" (the conservative answer for every admin-requiring action).
 * The default probe is cached per process (elevation cannot change mid-life); an injected `run`
 * seam bypasses the cache so tests stay hermetic.
 */
let cachedElevation;

export async function isProcessElevated(options = {}) {
  const env = options.env ?? process.env;
  if (options.run === undefined && cachedElevation !== undefined) return cachedElevation;
  let elevated = false;
  try {
    const result = await runWindowsScript(`
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'elevated' } else { 'standard' }`,
    { ...options, env, scope: options.scope ?? 'user' });
    elevated = String(result?.stdout ?? '').trim().toLowerCase() === 'elevated';
  } catch {
    elevated = false;
  }
  if (options.run === undefined) cachedElevation = elevated;
  return elevated;
}

/** Reset the cached default elevation probe (tests only). */
export function resetElevationCache() {
  cachedElevation = undefined;
}

/** Preserve the raw registry PATH and its value kind (including unexpanded %variables%). */
export function pathUpdateScript(pwshPath, scope) {
  validateScope(scope);
  const directory = W.dirname(pwshPath);
  const { hive, key } = pathRegistryTarget(scope);
  return `
$directory = ${psQuote(directory)}
$key = [Microsoft.Win32.Registry]::${hive}.CreateSubKey(${psQuote(key)})
try {
  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
  $present = @($raw -split ';' | Where-Object {
    [Environment]::ExpandEnvironmentVariables($_.Trim().Trim([char]34)).TrimEnd([char]92) -ieq $directory.TrimEnd([char]92)
  }).Count -gt 0
  if (-not $present) {
    $next = if ([string]::IsNullOrEmpty($raw)) { $directory } else { $raw.TrimEnd(';') + ';' + $directory }
    $key.SetValue('Path', $next, $kind)
  }
} finally { $key.Dispose() }
${BROADCAST_ENVIRONMENT_SCRIPT}`;
}

export async function updateInstallPath(pwshPath, options = {}) {
  const scope = validateScope(options.scope ?? 'user');
  await runWindowsScript(pathUpdateScript(pwshPath, scope), { ...options, scope });
  const env = options.env ?? process.env;
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const directory = W.dirname(pwshPath);
  const raw = env[key] ?? '';
  if (!raw.split(';').some((entry) =>
    W.normalize(entry.trim().replace(/^"(.*)"$/, '$1')).toLowerCase() === directory.toLowerCase())) {
    env[key] = raw ? `${raw.replace(/;+$/, '')};${directory}` : directory;
  }
}

/**
 * Script that removes every PATH entry under `root` from the persisted scope PATH. Entries are
 * compared after environment-expansion (so `%LOCALAPPDATA%\dsh\pwsh7\...` matches), the raw value
 * and its registry value kind are preserved, and the change is broadcast like an install does.
 */
export function pathRemovalScript(root, scope) {
  validateScope(scope);
  if (typeof root !== 'string' || !root.trim()) {
    throw new TypeError('pathRemovalScript(root, scope): root is required');
  }
  const prefix = W.normalize(root.trim()).replace(/[\\/]+$/, '');
  const { hive, key } = pathRegistryTarget(scope);
  return `
$prefix = ${psQuote(prefix)}
$key = [Microsoft.Win32.Registry]::${hive}.CreateSubKey(${psQuote(key)})
try {
  if ($key.GetValueNames() -contains 'Path') {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = $key.GetValueKind('Path')
    $kept = @($raw -split ';' | Where-Object {
      $entry = $_.Trim().Trim([char]34).TrimEnd([char]92)
      if ([string]::IsNullOrEmpty($entry)) { return $false }
      $expanded = ([Environment]::ExpandEnvironmentVariables($entry)).TrimEnd([char]92)
      return -not ($expanded -ieq $prefix -or $expanded.StartsWith($prefix + '\\', [System.StringComparison]::OrdinalIgnoreCase))
    })
    $next = $kept -join ';'
    if ($next -ne $raw) { $key.SetValue('Path', $next, $kind) }
  }
} finally { $key.Dispose() }
${BROADCAST_ENVIRONMENT_SCRIPT}`;
}

/**
 * Remove this process's PATH entries under `root`; returns the removed entries.
 * Kept in sync with the persisted cleanup so the running host stops resolving the deleted copy.
 */
export function removeProcessPathEntriesUnder(root, env = process.env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path');
  if (key === undefined) return [];
  const raw = env[key] ?? '';
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const removed = [];
  const kept = [];
  for (const entry of raw.split(W.delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed) {
      kept.push(entry);
      continue;
    }
    if (isPathInside(trimmed, root)) removed.push(trimmed);
    else kept.push(entry);
  }
  if (removed.length > 0) env[key] = kept.join(W.delimiter);
  return removed;
}

/**
 * Remove PATH entries under `root` from the persisted scope PATH (registry) and this process.
 * Returns the process entries that were removed; throws only when the registry step fails.
 * Tests inject `run` so no real registry write happens.
 */
export async function removePathEntriesUnder(root, options = {}) {
  const scope = validateScope(options.scope ?? 'user');
  const env = options.env ?? process.env;
  let registryError;
  let removed = [];
  try {
    await runWindowsScript(pathRemovalScript(root, scope), { ...options, scope, env });
  } catch (caught) {
    registryError = caught;
  } finally {
    // The process PATH must be cleaned even when the persisted write/broadcast failed: otherwise
    // this host keeps resolving an executable that was just deleted.
    removed = removeProcessPathEntriesUnder(root, env);
  }
  if (registryError !== undefined) throw registryError;
  return removed;
}
