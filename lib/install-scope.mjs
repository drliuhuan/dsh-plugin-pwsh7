import path from 'node:path';
import { execFileProbe, routerRoot } from './paths.mjs';

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

async function runWindowsScript(script, options) {
  const env = options.env ?? process.env;
  const executable = W.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await (options.run ?? execFileProbe)(executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from("$ErrorActionPreference = 'Stop';\n" + script, 'utf16le').toString('base64')],
    { env, signal: options.signal, timeoutMs: 15000 });
  if (!result?.ok) {
    const detail = result?.stderr || result?.stdout || result?.error?.message || 'no output';
    throw new Error(`Windows ${options.scope ?? 'user'} installation configuration failed: ${detail}`);
  }
}

export async function requireSystemAdministrator(options = {}) {
  await runWindowsScript(`
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'System installation requires administrator rights. Run the DSH host as administrator and retry.'
}`, { ...options, scope: 'system' });
}

/** Preserve the raw registry PATH and its value kind (including unexpanded %variables%). */
export function pathUpdateScript(pwshPath, scope) {
  validateScope(scope);
  const directory = W.dirname(pwshPath);
  const hive = scope === 'system' ? 'LocalMachine' : 'CurrentUser';
  const key = scope === 'system'
    ? 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' : 'Environment';
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
# Notify Explorer so newly launched processes inherit the updated PATH.
Add-Type -Namespace DshPwsh7 -Name EnvironmentBroadcast -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);
'@
$result = [UIntPtr]::Zero
[void][DshPwsh7.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result)
`;
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
