// lib/elevate.mjs — one-shot UAC helper for the system-level installation.
//
// The DSH host cannot elevate itself, and extracting into %ProgramFiles% or writing the machine
// PATH from an unelevated process fails. Instead the host extracts the already-verified archive
// into a user-writable staging directory, then asks Windows for administrator approval and lets an
// elevated helper copy the tree into place and update the machine PATH.
//
// The helper is spawned with `Start-Process -Verb RunAs`, so Windows shows the UAC consent dialog.
// The elevated script records `ok` or a real PowerShell error in a result file; the wrapper records
// cancellation. The host reads that file, so a failure is never just "exited with code 1".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const W = path.win32;

function windowsPowerShellPath(env = process.env) {
  return W.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Single-quote a value for a PowerShell literal. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const BROADCAST_SCRIPT = `
Add-Type -Namespace DshPwsh7 -Name EnvironmentBroadcast -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);
'@
$result = [UIntPtr]::Zero
[void][DshPwsh7.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result)
`;

/**
 * The elevated half: copy the staged tree into the system installation directory and append that
 * directory to the machine PATH (idempotent, case-insensitive). Every failure is written to the
 * result file with its PowerShell message so the host can show a real error instead of exit code 1.
 */
export function elevatedPublishScript(input) {
  const { from, to, pathDir, logPath } = input;
  return `$ErrorActionPreference = 'Stop'
$log = ${psQuote(logPath ?? path.join(os.tmpdir(), 'dsh-pwsh7-elevated.log'))}
try {
  $source = ${psQuote(from)}
  $target = ${psQuote(to)}
  $targetEntry = ${psQuote(pathDir)}.TrimEnd('\\')
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force
  $current = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $entries = @()
  if ($current) { $entries = @($current -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }) }
  # Prepend: the upgraded directory must resolve before the older PowerShell 7 entry on PATH.
  $entries = @($entries | Where-Object { $_.TrimEnd('\\').ToLowerInvariant() -ne $targetEntry.ToLowerInvariant() })
  $next = (@($targetEntry) + $entries) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $next, 'Machine')
  ${BROADCAST_SCRIPT}
  Set-Content -LiteralPath $log -Value 'ok' -Encoding utf8
} catch {
  Set-Content -LiteralPath $log -Value ('error: ' + $_.Exception.Message) -Encoding utf8
  exit 1
}`;
}

/** The non-elevated wrapper: raise UAC, wait, and record cancel/failure in the result file. */
export function elevatedWrapperScript(input) {
  const { powershell, script, marker } = input;
  return `$ErrorActionPreference = 'Stop'
try {
  $process = Start-Process -FilePath ${psQuote(powershell)} -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${psQuote(script)}) -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    if (-not (Test-Path -LiteralPath ${psQuote(marker)})) {
      Set-Content -LiteralPath ${psQuote(marker)} -Value ('error: elevated installation exited with code ' + $process.ExitCode) -Encoding utf8
    }
  }
} catch {
  Set-Content -LiteralPath ${psQuote(marker)} -Value ('cancelled: ' + $_.Exception.Message) -Encoding utf8
}`;
}

function execFileAsync(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code, error, stdout, stderr });
    });
  });
}

/**
 * Run the elevated publish. Returns `{ ok }`, `{ ok: false, cancelled: true }` when the user
 * dismissed UAC, or `{ ok: false, error }` for every other failure.
 */
export async function runElevatedPublish(options = {}) {
  const { env = process.env, from, to, pathDir, signal } = options;
  const run = options.run ?? execFileAsync;
  const powershell = windowsPowerShellPath(env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pwsh7-elevate-'));
  const scriptPath = path.join(tmp, 'publish.ps1');
  const wrapperPath = path.join(tmp, 'wrapper.ps1');
  const markerPath = path.join(tmp, 'marker.txt');
  try {
    fs.writeFileSync(scriptPath, elevatedPublishScript({ from, to, pathDir, logPath: markerPath }), 'utf8');
    fs.writeFileSync(wrapperPath, elevatedWrapperScript({ powershell, script: scriptPath, marker: markerPath }), 'utf8');
    const result = await run(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath], {
      env,
      signal,
      timeoutMs: 15 * 60 * 1000,
      windowsHide: true,
    });
    let marker = '';
    try {
      marker = fs.readFileSync(markerPath, 'utf8').trim();
    } catch {
      marker = '';
    }
    if (marker === 'ok') return { ok: true };
    if (/^cancelled\b/i.test(marker)) {
      return {
        ok: false,
        cancelled: true,
        error: 'administrator approval was cancelled; approve the Windows UAC prompt and retry',
      };
    }
    if (marker) return { ok: false, error: marker };
    return {
      ok: false,
      error: `the elevated installation helper exited without a result (${result?.code ?? 'unknown'})`,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
