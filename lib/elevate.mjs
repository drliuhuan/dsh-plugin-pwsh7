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

function psArray(values) {
  return `@(${values.map((value) => psQuote(value)).join(', ')})`;
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

// ---------------------------------------------------------------------------
// System-level PowerShell 7 upgrade through the official MSI
// ---------------------------------------------------------------------------
//
// Releases up to 0.3.4 extracted the portable ZIP into a versioned directory next to the official
// installation and prepended that directory to PATH. That never changed the executable Windows
// Terminal, Win+R and every other launcher resolve (`…\PowerShell\7\pwsh.exe`), so the "upgrade"
// was invisible outside DSH. The system path now runs the official MSI in place and, in the same
// elevated session, removes the old versioned copies and their PATH entries.

/**
 * The elevated half of a system upgrade: run the official MSI, then clean the side-by-side copies
 * and rewrite the machine PATH. The result is written as JSON to `markerPath`; every failure keeps
 * the real PowerShell/msiexec message instead of collapsing to an exit code.
 */
export function elevatedSystemInstallScript(input) {
  const {
    msiPath,
    logPath,
    markerPath,
    systemDir,
    legacyDirectories = [],
    expectedVersion = '',
    allUsers = true,
  } = input;
  if (typeof msiPath !== 'string' || !msiPath.trim()) {
    throw new TypeError('elevatedSystemInstallScript: msiPath is required');
  }
  if (typeof systemDir !== 'string' || !systemDir.trim()) {
    throw new TypeError('elevatedSystemInstallScript: systemDir is required');
  }
  return `$ErrorActionPreference = 'Stop'
$data = [ordered]@{
  ok = $false
  exitCode = $null
  restartRequired = $false
  pathUpdated = $false
  cleaned = @()
  warnings = @()
  error = $null
  verified = $false
  version = $null
}
$marker = ${psQuote(markerPath ?? path.join(os.tmpdir(), 'dsh-pwsh7-msi-result.json'))}
$legacyDirectories = ${psArray(legacyDirectories)}
$systemDir = ${psQuote(systemDir)}
$systemExe = Join-Path $systemDir 'pwsh.exe'
$expectedVersion = ${psQuote(expectedVersion)}
$pathScope = ${psQuote(allUsers ? 'Machine' : 'User')}
try {
  $msiexec = Join-Path $env:SystemRoot 'System32\\msiexec.exe'
  $logDir = [System.IO.Path]::GetDirectoryName(${psQuote(logPath)})
  if ($logDir) { [void][System.IO.Directory]::CreateDirectory($logDir) }
  $arguments = @('/i', ${psQuote(`"${msiPath}"`)}, '/qn', '/norestart', '/L*v', ${psQuote(`"${logPath}"`)}, ${psQuote(allUsers ? 'ALLUSERS=1' : 'ALLUSERS=0')})
  $process = Start-Process -FilePath $msiexec -ArgumentList $arguments -Wait -PassThru
  $code = $process.ExitCode
  $data.exitCode = $code
  if ($code -eq 0 -or $code -eq 3010 -or $code -eq 1641) {
    $data.ok = $true
    $data.restartRequired = ($code -eq 3010 -or $code -eq 1641)
    # Verify the canonical executable before deleting anything. If Windows scheduled the file
    # replacement for a reboot, the old side-by-side copy must stay usable and PATH must stay as-is.
    $verified = $true
    $reported = $null
    if ($expectedVersion) {
      try {
        $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($systemExe)
        $reported = '{0}.{1}.{2}' -f $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart
        $data.version = $reported
        $expectedCore = ($expectedVersion -split '-')[0]
        $verified = ($reported -eq $expectedCore)
      } catch {
        $verified = $false
        $data.warnings = @($data.warnings) + ('could not read the version of ' + $systemExe + ': ' + $_.Exception.Message)
      }
    }
    $data.verified = $verified
    if (-not $verified) {
      $data.warnings = @($data.warnings) + ('the canonical ' + $systemExe + ' reports ' + $reported + ' instead of ' + $expectedVersion + '; legacy copies and PATH were left unchanged until the pending file replacement completes')
    } else {
      foreach ($legacy in $legacyDirectories) {
        if (-not (Test-Path -LiteralPath $legacy)) { continue }
        try {
          $item = Get-Item -LiteralPath $legacy -Force -ErrorAction Stop
          if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Remove-Item -LiteralPath $legacy -Force -ErrorAction Stop
          } else {
            Remove-Item -LiteralPath $legacy -Recurse -Force -ErrorAction Stop
          }
          $data.cleaned = @($data.cleaned) + $legacy
        } catch {
          $data.warnings = @($data.warnings) + ('could not remove ' + $legacy + ': ' + $_.Exception.Message)
        }
      }
      try {
        $current = [Environment]::GetEnvironmentVariable('Path', $pathScope)
        $entries = @()
        if ($current) { $entries = @($current -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }) }
        $kept = @()
        foreach ($entry in $entries) {
          $expanded = ([Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))).TrimEnd([char]92)
          $drop = $false
          foreach ($legacy in $legacyDirectories) {
            $root = ([Environment]::ExpandEnvironmentVariables($legacy)).TrimEnd([char]92)
            if ($expanded -ieq $root -or $expanded.StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase)) { $drop = $true; break }
          }
          if (-not $drop) {
            $versionedPattern = [regex]::Escape($systemDir.TrimEnd([char]92)) + '\\\\\\d+\\.\\d+(\\.\\d+)*$'
            if ($expanded -match $versionedPattern) { $drop = $true }
          }
          if (-not $drop) { $kept = @($kept) + $entry.Trim() }
        }
        $target = $systemDir.TrimEnd([char]92)
        $filtered = @($kept | Where-Object {
          ([Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"'))).TrimEnd([char]92) -ine $target
        })
        $next = (@($target) + $filtered) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $next, $pathScope)
        $data.pathUpdated = $true
        ${BROADCAST_SCRIPT}
      } catch {
        $data.warnings = @($data.warnings) + ('could not update the machine PATH: ' + $_.Exception.Message)
      }
    }
  } else {
    $data.error = 'msiexec exited with code ' + $code
  }
} catch {
  $data.error = $_.Exception.Message
}
$json = $data | ConvertTo-Json -Compress -Depth 4
$parent = [System.IO.Path]::GetDirectoryName($marker)
if ($parent) { [void][System.IO.Directory]::CreateDirectory($parent) }
[System.IO.File]::WriteAllText($marker, $json)
if (-not $data.ok) { exit 1 }
`;
}

/** The non-elevated wrapper: raise UAC, wait, and always leave a result for the host to read. */
export function elevatedSystemInstallWrapperScript(input) {
  const { powershell, script, marker } = input;
  return `$ErrorActionPreference = 'Stop'
$data = [ordered]@{ ok = $false; cancelled = $false; error = $null }
try {
  $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ${psQuote(script)} + '"'
  $process = Start-Process -FilePath ${psQuote(powershell)} -ArgumentList $arguments -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -ne 0 -and -not (Test-Path -LiteralPath ${psQuote(marker)})) {
    $data.error = 'elevated installation exited with code ' + $process.ExitCode
  }
} catch {
  $message = $_.Exception.Message
  $data.error = $message
  if ($message -match 'cancel|0x800704C7|取消') { $data.cancelled = $true }
}
if (-not (Test-Path -LiteralPath ${psQuote(marker)})) {
  $parent = [System.IO.Path]::GetDirectoryName(${psQuote(marker)})
  if ($parent) { [void][System.IO.Directory]::CreateDirectory($parent) }
  [System.IO.File]::WriteAllText(${psQuote(marker)}, ($data | ConvertTo-Json -Compress))
}
`;
}

// ---------------------------------------------------------------------------
// Portable ZIP replacement (manual / non-MSI installations)
// ---------------------------------------------------------------------------
//
// When the main install is a ZIP extraction (no MSI product), the only way to upgrade the
// executable a terminal resolves is to replace that directory in place. Renaming the old directory
// first keeps a running pwsh.exe (which holds handles to the renamed files) usable, and the new
// directory appears at the same PATH entry. The script verifies the new file version and rolls back
// on failure.

/** The elevated half of an in-place ZIP upgrade. */
export function elevatedZipReplaceScript(input) {
  const {
    from,
    targetDir,
    markerPath,
    expectedVersion = '',
    legacyDirectories = [],
    pathScope = '',
  } = input;
  if (typeof from !== 'string' || !from.trim()) {
    throw new TypeError('elevatedZipReplaceScript: from is required');
  }
  if (typeof targetDir !== 'string' || !targetDir.trim()) {
    throw new TypeError('elevatedZipReplaceScript: targetDir is required');
  }
  return `$ErrorActionPreference = 'Stop'
$data = [ordered]@{
  ok = $false
  version = $null
  backup = $null
  warnings = @()
  cleaned = @()
  pathUpdated = $false
  error = $null
}
$marker = ${psQuote(markerPath ?? path.join(os.tmpdir(), 'dsh-pwsh7-zip-result.json'))}
$source = ${psQuote(from)}
$target = ${psQuote(targetDir)}
$expectedVersion = ${psQuote(expectedVersion)}
$legacyDirectories = ${psArray(legacyDirectories)}
$pathScope = ${psQuote(pathScope)}
$hadTarget = $false
$movedOld = $false
$backup = $null
try {
  if (-not (Test-Path -LiteralPath (Join-Path $source 'pwsh.exe'))) {
    throw ('the staged upgrade has no pwsh.exe: ' + $source)
  }
  $parent = [System.IO.Path]::GetDirectoryName($target)
  if ($parent) { [void][System.IO.Directory]::CreateDirectory($parent) }
  $hadTarget = Test-Path -LiteralPath $target
  if ($hadTarget) {
    $backup = $target + '.old-' + (Get-Date -Format 'yyyyMMddHHmmssfff')
    $data.backup = $backup
    Move-Item -LiteralPath $target -Destination $backup -Force -ErrorAction Stop
    $movedOld = $true
  }
  try {
    [void][System.IO.Directory]::CreateDirectory($target)
    Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force -ErrorAction Stop
    if ($hadTarget -and $backup) {
      $savedConfig = Join-Path $backup 'powershell.config.json'
      if (Test-Path -LiteralPath $savedConfig) {
        Copy-Item -LiteralPath $savedConfig -Destination (Join-Path $target 'powershell.config.json') -Force -ErrorAction Stop
      }
    }
    $newExe = Join-Path $target 'pwsh.exe'
    $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($newExe)
    $reported = '{0}.{1}.{2}' -f $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart
    $data.version = $reported
    if ($expectedVersion) {
      $expectedCore = ($expectedVersion -split '-')[0]
      if ($reported -ne $expectedCore) {
        throw ('the replaced ' + $newExe + ' reports ' + $reported + ' instead of ' + $expectedVersion)
      }
    }
    $data.ok = $true
    foreach ($legacy in $legacyDirectories) {
      if (-not (Test-Path -LiteralPath $legacy)) { continue }
      try {
        $item = Get-Item -LiteralPath $legacy -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
          Remove-Item -LiteralPath $legacy -Force -ErrorAction Stop
        } else {
          Remove-Item -LiteralPath $legacy -Recurse -Force -ErrorAction Stop
        }
        $data.cleaned = @($data.cleaned) + $legacy
      } catch {
        $data.warnings = @($data.warnings) + ('could not remove ' + $legacy + ': ' + $_.Exception.Message)
      }
    }
    if ($pathScope) {
      try {
        $current = [Environment]::GetEnvironmentVariable('Path', $pathScope)
        $entries = @()
        if ($current) { $entries = @($current -split ';' | Where-Object { $_ -and $_.Trim() -ne '' }) }
        $targetValue = $target.TrimEnd([char]92)
        $kept = @()
        foreach ($entry in $entries) {
          $expanded = ([Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))).TrimEnd([char]92)
          $drop = $false
          if ($expanded -ieq $targetValue) { $drop = $true }
          foreach ($legacy in $legacyDirectories) {
            $root = ([Environment]::ExpandEnvironmentVariables($legacy)).TrimEnd([char]92)
            if ($expanded -ieq $root -or $expanded.StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase)) { $drop = $true; break }
          }
          if (-not $drop) { $kept = @($kept) + $entry.Trim() }
        }
        $next = (@($targetValue) + $kept) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $next, $pathScope)
        $data.pathUpdated = $true
        ${BROADCAST_SCRIPT}
      } catch {
        $data.warnings = @($data.warnings) + ('could not update the PATH: ' + $_.Exception.Message)
      }
    }
    if ($hadTarget -and $backup -and (Test-Path -LiteralPath $backup)) {
      try {
        Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop
      } catch {
        $data.warnings = @($data.warnings) + ('the previous copy is still at ' + $backup + ': ' + $_.Exception.Message)
      }
    }
  } catch {
    # Roll back to the previous directory so a failed upgrade never leaves a broken install. Only
    # remove the target when this attempt actually moved the old directory away first.
    try {
      if ($movedOld -and (Test-Path -LiteralPath $target)) {
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
      }
      if ($movedOld -and $backup -and (Test-Path -LiteralPath $backup)) {
        Move-Item -LiteralPath $backup -Destination $target -Force -ErrorAction Stop
      }
    } catch {
      $data.warnings = @($data.warnings) + ('rollback failed: ' + $_.Exception.Message)
    }
    throw
  }
} catch {
  $data.error = $_.Exception.Message
}
$json = $data | ConvertTo-Json -Compress -Depth 4
$markerParent = [System.IO.Path]::GetDirectoryName($marker)
if ($markerParent) { [void][System.IO.Directory]::CreateDirectory($markerParent) }
[System.IO.File]::WriteAllText($marker, $json)
if (-not $data.ok) { exit 1 }
`;
}

/** Run the in-place ZIP upgrade, raising UAC only when requested and not already elevated. */
export async function runElevatedZipReplace(options = {}) {
  const {
    env = process.env,
    from,
    targetDir,
    expectedVersion = '',
    legacyDirectories = [],
    pathScope = '',
    signal,
  } = options;
  const run = options.run ?? execFileAsync;
  const direct = options.direct === true || options.isElevated === true;
  const powershell = windowsPowerShellPath(env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pwsh7-zip-'));
  const scriptPath = path.join(tmp, 'replace.ps1');
  const wrapperPath = path.join(tmp, 'wrapper.ps1');
  const markerPath = path.join(tmp, 'result.json');
  try {
    fs.writeFileSync(scriptPath, elevatedZipReplaceScript({
      from,
      targetDir,
      markerPath,
      expectedVersion,
      legacyDirectories,
      pathScope,
    }), 'utf8');
    let result;
    if (direct) {
      result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        env,
        signal,
        timeoutMs: 30 * 60 * 1000,
        windowsHide: true,
      });
    } else {
      fs.writeFileSync(wrapperPath, elevatedSystemInstallWrapperScript({
        powershell,
        script: scriptPath,
        marker: markerPath,
      }), 'utf8');
      result = await run(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath], {
        env,
        signal,
        timeoutMs: 30 * 60 * 1000,
        windowsHide: true,
      });
    }
    const marker = readMarker(markerPath);
    if (marker !== undefined) {
      return {
        ok: marker.ok === true,
        cancelled: marker.cancelled === true,
        version: typeof marker.version === 'string' ? marker.version : undefined,
        backup: typeof marker.backup === 'string' ? marker.backup : undefined,
        cleaned: Array.isArray(marker.cleaned) ? marker.cleaned.filter((entry) => typeof entry === 'string') : [],
        warnings: Array.isArray(marker.warnings) ? marker.warnings.filter((entry) => typeof entry === 'string') : [],
        pathUpdated: marker.pathUpdated === true,
        error: typeof marker.error === 'string' && marker.error.trim() ? marker.error.trim() : undefined,
      };
    }
    return {
      ok: false,
      cancelled: false,
      cleaned: [],
      warnings: [],
      error: `the elevated ZIP installer exited without a result (${result?.code ?? 'unknown'})`,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Generic elevated command (Chocolatey / Scoop / Store fallbacks)
// ---------------------------------------------------------------------------

function psArgument(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_./:=+-]+$/.test(text) ? text : psQuote(text);
}

/** The elevated half of a package-manager upgrade: run one executable and record its output. */
export function elevatedCommandScript(input) {
  const { file, args = [], logPath, markerPath } = input;
  return `$ErrorActionPreference = 'Continue'
$output = & ${psQuote(file)} ${args.map(psArgument).join(' ')} 2>&1 | Out-String
$code = $LASTEXITCODE
[System.IO.File]::WriteAllText(${psQuote(logPath)}, $output)
$data = [ordered]@{ ok = ($code -eq 0); code = $code }
[System.IO.File]::WriteAllText(${psQuote(markerPath)}, ($data | ConvertTo-Json -Compress))
`;
}

/** Run a package-manager command, optionally through one UAC prompt. */
export async function runElevatedCommand(options = {}) {
  const { env = process.env, file, args = [], signal } = options;
  const run = options.run ?? execFileAsync;
  if (options.isElevated === true) {
    const result = await run(file, args, { env, signal, timeoutMs: 30 * 60 * 1000, windowsHide: true });
    return {
      ok: result?.ok === true,
      code: result?.code,
      output: [result?.stdout, result?.stderr].filter(Boolean).join('\n'),
      cancelled: false,
    };
  }
  const powershell = windowsPowerShellPath(env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pwsh7-command-'));
  const scriptPath = path.join(tmp, 'command.ps1');
  const wrapperPath = path.join(tmp, 'wrapper.ps1');
  const markerPath = path.join(tmp, 'result.json');
  const logPath = path.join(tmp, 'output.log');
  try {
    fs.writeFileSync(scriptPath, elevatedCommandScript({
      file,
      args,
      logPath,
      markerPath,
    }), 'utf8');
    fs.writeFileSync(wrapperPath, elevatedSystemInstallWrapperScript({
      powershell,
      script: scriptPath,
      marker: markerPath,
    }), 'utf8');
    await run(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath], {
      env,
      signal,
      timeoutMs: 30 * 60 * 1000,
      windowsHide: true,
    });
    const marker = readMarker(markerPath);
    let output = '';
    try {
      output = fs.readFileSync(logPath, 'utf8');
    } catch {
      output = '';
    }
    if (marker !== undefined) {
      return {
        ok: marker.ok === true,
        code: Number.isInteger(marker.code) ? marker.code : undefined,
        cancelled: marker.cancelled === true,
        output: output.trim(),
        error: typeof marker.error === 'string' ? marker.error : undefined,
      };
    }
    return {
      ok: false,
      cancelled: false,
      output: output.trim(),
      error: 'the elevated package-manager command exited without a result',
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readMarker(markerPath) {
  try {
    const text = fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!text) return undefined;
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeMsiMarker(marker) {
  const cleaned = Array.isArray(marker?.cleaned)
    ? marker.cleaned.filter((entry) => typeof entry === 'string')
    : [];
  const warnings = Array.isArray(marker?.warnings)
    ? marker.warnings.filter((entry) => typeof entry === 'string')
    : [];
  return {
    ok: marker?.ok === true,
    cancelled: marker?.cancelled === true,
    exitCode: Number.isInteger(marker?.exitCode) ? marker.exitCode : undefined,
    restartRequired: marker?.restartRequired === true,
    pathUpdated: marker?.pathUpdated === true,
    verified: marker?.verified === true,
    version: typeof marker?.version === 'string' ? marker.version : undefined,
    cleaned,
    warnings,
    error: typeof marker?.error === 'string' && marker.error.trim() ? marker.error.trim() : undefined,
  };
}

/**
 * Run the official PowerShell 7 MSI for the system scope, raising UAC only when the host is not
 * already elevated. Returns the parsed helper result; never throws for a cancelled prompt.
 */
export async function runElevatedSystemInstall(options = {}) {
  const {
    env = process.env,
    msiPath,
    logPath,
    systemDir,
    legacyDirectories = [],
    expectedVersion = '',
    allUsers = true,
    signal,
  } = options;
  const run = options.run ?? execFileAsync;
  // Per-user MSI upgrades run directly and update HKCU; machine-wide upgrades either run directly
  // when the host is already elevated or ask for one UAC approval.
  const direct = options.direct === true || options.isElevated === true || allUsers === false;
  if (typeof msiPath !== 'string' || !msiPath.trim()) {
    throw new TypeError('runElevatedSystemInstall: msiPath is required');
  }
  if (typeof systemDir !== 'string' || !systemDir.trim()) {
    throw new TypeError('runElevatedSystemInstall: systemDir is required');
  }
  const powershell = windowsPowerShellPath(env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pwsh7-system-'));
  const scriptPath = path.join(tmp, 'install.ps1');
  const wrapperPath = path.join(tmp, 'wrapper.ps1');
  const markerPath = path.join(tmp, 'result.json');
  try {
    fs.writeFileSync(scriptPath, elevatedSystemInstallScript({
      msiPath,
      logPath: logPath ?? path.join(tmp, 'install.log'),
      markerPath,
      systemDir,
      legacyDirectories,
      expectedVersion,
      allUsers,
    }), 'utf8');
    let result;
    if (direct) {
      result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        env,
        signal,
        timeoutMs: 30 * 60 * 1000,
        windowsHide: true,
      });
    } else {
      fs.writeFileSync(wrapperPath, elevatedSystemInstallWrapperScript({
        powershell,
        script: scriptPath,
        marker: markerPath,
      }), 'utf8');
      result = await run(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath], {
        env,
        signal,
        timeoutMs: 30 * 60 * 1000,
        windowsHide: true,
      });
    }
    const marker = readMarker(markerPath);
    if (marker !== undefined) return normalizeMsiMarker(marker);
    return {
      ok: false,
      cancelled: false,
      cleaned: [],
      warnings: [],
      error: `the elevated PowerShell 7 installer exited without a result (${result?.code ?? 'unknown'})`,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
