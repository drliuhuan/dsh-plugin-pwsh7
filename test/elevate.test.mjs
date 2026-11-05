// test/elevate.test.mjs — the UAC helper's scripts and failure mapping.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  elevatedCommandScript,
  elevatedPublishScript,
  elevatedSystemInstallScript,
  elevatedSystemInstallWrapperScript,
  elevatedWrapperScript,
  elevatedZipReplaceScript,
  runElevatedPublish,
} from '../lib/elevate.mjs';

test('the elevated script copies the staged tree and updates the machine PATH', () => {
  const script = elevatedPublishScript({
    from: 'C:\\Temp\\staging',
    to: 'C:\\Program Files\\dsh\\pwsh7',
    pathDir: 'C:\\Program Files\\dsh\\pwsh7',
  });
  assert.ok(script.includes("Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force"));
  assert.ok(script.includes("SetEnvironmentVariable('Path', $next, 'Machine')"));
  assert.ok(script.includes("'C:\\Program Files\\dsh\\pwsh7'"));
  // The new directory goes to the front so it wins over the older PowerShell 7 entry.
  assert.ok(script.includes('$next = (@($targetEntry) + $entries) -join'));
});

test('the wrapper raises UAC, waits, and records cancellation', () => {
  const wrapper = elevatedWrapperScript({
    powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    script: 'C:\\Temp\\publish.ps1',
    marker: 'C:\\Temp\\marker.txt',
  });
  assert.ok(wrapper.includes('-Verb RunAs'));
  assert.ok(wrapper.includes('-Wait'));
  assert.ok(wrapper.includes('-PassThru'));
  assert.ok(wrapper.includes('cancelled:'));
  assert.ok(wrapper.includes('Test-Path'));
});

test('the elevated script records ok or a readable error in the result file', () => {
  const script = elevatedPublishScript({
    from: 'C:\\Temp\\staging',
    to: 'C:\\Program Files\\dsh\\pwsh7',
    pathDir: 'C:\\Program Files\\dsh\\pwsh7',
    logPath: 'C:\\Temp\\marker.txt',
  });
  assert.ok(script.includes("$log = 'C:\\Temp\\marker.txt'"));
  assert.ok(script.includes("Set-Content -LiteralPath $log -Value 'ok'"));
  assert.ok(script.includes('catch'));
  assert.ok(script.includes("'error: '"));
  assert.ok(script.includes('exit 1'));
});

test('paths with single quotes are escaped for the PowerShell literals', () => {
  const script = elevatedPublishScript({ from: "C:\\O'Brien", to: 'C:\\target', pathDir: 'C:\\target' });
  assert.ok(script.includes("'C:\\O''Brien'"));
});

test('the system MSI script upgrades in place and cleans legacy copies and PATH entries', () => {
  const script = elevatedSystemInstallScript({
    msiPath: 'C:\\Temp\\PowerShell-7.6.9-win-x64.msi',
    logPath: 'C:\\Temp\\install.log',
    markerPath: 'C:\\Temp\\result.json',
    systemDir: 'C:\\Program Files\\PowerShell\\7',
    legacyDirectories: ['C:\\Program Files\\PowerShell\\7\\7.6.9'],
    expectedVersion: '7.6.9',
  });
  assert.ok(script.includes("'/i'"));
  assert.ok(script.includes("'/qn'"));
  assert.ok(script.includes("'/norestart'"));
  assert.ok(script.includes("'ALLUSERS=1'"));
  assert.ok(script.includes('msiexec.exe'));
  assert.ok(script.includes('C:\\Program Files\\PowerShell\\7\\7.6.9'));
  assert.ok(script.includes("SetEnvironmentVariable('Path', $next, $pathScope)"));
  assert.ok(script.includes("$pathScope = 'Machine'"));
  // The canonical directory is put at the front, not the versioned side-by-side directory.
  assert.ok(script.includes('$next = (@($target) + $filtered) -join'));
  assert.ok(script.includes('$versionedPattern'));
  assert.ok(script.includes('Remove-Item -LiteralPath $legacy -Recurse -Force'));
  assert.ok(script.includes('$data.cleaned'));
  assert.ok(script.includes('ConvertTo-Json -Compress'));
  // The canonical executable is verified before anything is deleted or PATH is rewritten.
  assert.ok(script.includes("$expectedVersion = '7.6.9'"));
  assert.ok(script.includes('FileVersionInfo]::GetVersionInfo'));
  assert.ok(script.includes('$data.verified'));
  assert.ok(script.includes('legacy copies and PATH were left unchanged'));
});

test('the system MSI wrapper raises UAC and always records a result', () => {
  const wrapper = elevatedSystemInstallWrapperScript({
    powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    script: 'C:\\Temp\\install.ps1',
    marker: 'C:\\Temp\\result.json',
  });
  assert.ok(wrapper.includes('-Verb RunAs'));
  assert.ok(wrapper.includes('-Wait'));
  assert.ok(wrapper.includes('-PassThru'));
  assert.ok(wrapper.includes('cancelled'));
  assert.ok(wrapper.includes('Test-Path'));
  assert.ok(wrapper.includes('WriteAllText'));
});

test('single quotes in system MSI paths are escaped for PowerShell', () => {
  const script = elevatedSystemInstallScript({
    msiPath: "C:\\O'Brien\\pwsh.msi",
    logPath: 'C:\\Temp\\install.log',
    markerPath: 'C:\\Temp\\result.json',
    systemDir: 'C:\\Program Files\\PowerShell\\7',
  });
  assert.ok(script.includes("C:\\O''Brien"));
});

test('the in-place ZIP script renames, replaces, verifies and rolls back on failure', () => {
  const script = elevatedZipReplaceScript({
    from: 'C:\\Temp\\staging',
    targetDir: 'C:\\Tools\\pwsh',
    markerPath: 'C:\\Temp\\result.json',
    expectedVersion: '7.6.9',
    legacyDirectories: ['C:\\Program Files\\PowerShell\\7\\7.6.8'],
    pathScope: 'Machine',
  });
  assert.ok(script.includes('Move-Item -LiteralPath $target -Destination $backup'));
  assert.ok(script.includes("Copy-Item -Path (Join-Path $source '*')"));
  assert.ok(script.includes("GetVersionInfo($newExe)"));
  assert.ok(script.includes("$expectedVersion = '7.6.9'"));
  assert.ok(script.includes('rollback failed'));
  assert.ok(script.includes('$movedOld'));
  assert.ok(script.includes('if ($movedOld -and (Test-Path -LiteralPath $target))'));
  assert.ok(script.includes('C:\\Program Files\\PowerShell\\7\\7.6.8'));
  assert.ok(script.includes("SetEnvironmentVariable('Path', $next, $pathScope)"));
  assert.ok(script.includes("$pathScope = 'Machine'"));
});

test('the package-manager script runs an executable and records its output and exit code', () => {
  const script = elevatedCommandScript({
    file: 'C:\\ProgramData\\chocolatey\\bin\\choco.exe',
    args: ['upgrade', 'powershell-core', '-y', '--no-progress'],
    logPath: 'C:\\Temp\\choco.log',
    markerPath: 'C:\\Temp\\choco.json',
  });
  assert.ok(script.includes('choco.exe'));
  assert.ok(script.includes('upgrade'));
  assert.ok(script.includes('powershell-core'));
  assert.ok(script.includes('$LASTEXITCODE'));
  assert.ok(script.includes('$output'));
  assert.ok(script.includes('ConvertTo-Json -Compress'));
});

test('a helper that exits without a marker is reported as an error', async () => {
  const result = await runElevatedPublish({
    env: { ...process.env, SystemRoot: 'C:\\Windows' },
    from: 'C:\\a',
    to: 'C:\\b',
    pathDir: 'C:\\b',
    run: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /without a result/);
  assert.notEqual(result.cancelled, true);
});
