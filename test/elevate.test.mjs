// test/elevate.test.mjs — the UAC helper's scripts and failure mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  appxInstallScript,
  appxUninstallScript,
  elevatedCommandScript,
  elevatedPublishScript,
  elevatedSystemInstallScript,
  elevatedSystemInstallWrapperScript,
  elevatedWrapperScript,
  elevatedZipReplaceScript,
  normalizeAppxMarker,
  normalizeAppxUninstallMarker,
  runAppxInstall,
  runAppxUninstall,
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

test('the app-package script installs with Add-AppxPackage and reports the executable', () => {
  const script = appxInstallScript({
    packagePath: 'C:\\Temp\\PowerShell-7.7.0.msixbundle',
    markerPath: 'C:\\Temp\\result.json',
  });
  assert.ok(script.includes('Add-AppxPackage -Path $packagePath'));
  assert.ok(script.includes('-ForceApplicationShutdown'));
  assert.ok(script.includes('0x80073D02'));
  assert.ok(script.includes("Get-AppxPackage -Name 'Microsoft.PowerShell'"));
  assert.ok(script.includes("$packagePath = 'C:\\Temp\\PowerShell-7.7.0.msixbundle'"));
  assert.ok(script.includes("$marker = 'C:\\Temp\\result.json'"));
  assert.ok(script.includes("'pwsh.exe'"));
  assert.ok(script.includes('0x80073CFF'));
  // App packages install for the current user; this helper must never raise UAC.
  assert.ok(!script.includes('-Verb RunAs'));
});

test('the app-package script looks up the identity it was given and stays ASCII for PS 5.1', () => {
  const script = appxInstallScript({
    packagePath: 'C:\\Temp\\PowerShell-LTS-7.6.11.msixbundle',
    markerPath: 'C:\\Temp\\result.json',
    packageName: 'Microsoft.PowerShell-LTS',
  });
  assert.ok(script.includes("Get-AppxPackage -Name 'Microsoft.PowerShell-LTS'"));
  assert.ok(script.includes('Start-Sleep -Milliseconds 500'), 'registration is polled, not raced');
  // BOM-less Windows PowerShell 5.1 scripts are decoded with the ANSI code page: no CJK literals.
  assert.equal(/[\u4e00-\u9fff]/.test(script), false);
  assert.equal(/\$first -match '[^']*0x80073CFB/.test(script), false, 'already-installed is not an in-use retry');
});

test('the app-package screen escapes quotes and reports the registered package', async () => {
  const result = await runAppxInstall({
    env: { ...process.env, SystemRoot: 'C:\\Windows' },
    packagePath: "C:\\O'Brien\\PowerShell-7.7.0.msixbundle",
    run: async (_file, args) => {
      const scriptPath = args[args.length - 1];
      const script = fs.readFileSync(scriptPath, 'utf8');
      assert.ok(script.includes("C:\\O''Brien"), 'single quotes are doubled for PowerShell');
      const marker = /\$marker = '((?:[^']|'')*)'/.exec(script)[1].replace(/''/g, "'");
      fs.writeFileSync(marker, JSON.stringify({
        ok: true,
        path: 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\\pwsh.exe',
        version: '7.7.0.0',
        packageFullName: 'Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe',
        warnings: [],
      }), 'utf8');
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.path, /WindowsApps/);
  assert.equal(result.version, '7.7.0.0');
  assert.equal(result.packageFullName, 'Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe');
  assert.deepEqual(result.warnings, []);
});

test('an app-package helper that exits without a marker is a readable failure', async () => {
  const result = await runAppxInstall({
    env: { ...process.env, SystemRoot: 'C:\\Windows' },
    packagePath: 'C:\\Temp\\PowerShell-7.7.0.msixbundle',
    run: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /without a result/);
});

test('normalizeAppxMarker keeps empty optional fields undefined', () => {
  assert.deepEqual(normalizeAppxMarker({ ok: false, error: ' 0x80073CFF ', warnings: ['x', 7, ' '] }), {
    ok: false,
    cancelled: false,
    path: undefined,
    version: undefined,
    packageFullName: undefined,
    warnings: ['x'],
    error: '0x80073CFF',
  });
});

test('the app-package removal script removes the given identity without UAC', () => {
  const script = appxUninstallScript({
    identity: 'Microsoft.PowerShell-LTS',
    markerPath: 'C:\\Temp\\remove.json',
  });
  assert.ok(script.includes("Get-AppxPackage -Name 'Microsoft.PowerShell-LTS'"));
  assert.ok(script.includes('Remove-AppxPackage -Package $package.PackageFullName'));
  assert.ok(script.includes("$marker = 'C:\\Temp\\remove.json'"));
  assert.ok(!script.includes('-Verb RunAs'), 'removing a per-user package never raises UAC');
  assert.equal(/[\u4e00-\u9fff]/.test(script), false, 'ASCII only for Windows PowerShell 5.1');
});

test('normalizeAppxUninstallMarker keeps the removed packages and absent flag', () => {
  assert.deepEqual(
    normalizeAppxUninstallMarker({ ok: true, removed: ['Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe', 7], absent: false }),
    {
      ok: true,
      removed: ['Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe'],
      absent: false,
      error: undefined,
    },
  );
  assert.deepEqual(normalizeAppxUninstallMarker({ ok: true, absent: true }), {
    ok: true,
    removed: [],
    absent: true,
    error: undefined,
  });
});

test('runAppxUninstall parses the helper marker', async () => {
  const result = await runAppxUninstall({
    env: { ...process.env, SystemRoot: 'C:\\Windows' },
    identity: 'Microsoft.PowerShell',
    run: async (_file, args) => {
      const scriptPath = args[args.length - 1];
      const script = fs.readFileSync(scriptPath, 'utf8');
      const marker = /\$marker = '((?:[^']|'')*)'/.exec(script)[1].replace(/''/g, "'");
      fs.writeFileSync(marker, JSON.stringify({
        ok: true,
        removed: ['Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe'],
        absent: false,
      }), 'utf8');
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, ['Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe']);
  assert.equal(result.absent, false);
});

test('runAppxUninstall reports a missing marker as a readable failure', async () => {
  const result = await runAppxUninstall({
    env: { ...process.env, SystemRoot: 'C:\\Windows' },
    identity: 'Microsoft.PowerShell',
    run: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /without a result/);
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
