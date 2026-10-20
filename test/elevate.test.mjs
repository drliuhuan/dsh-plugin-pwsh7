// test/elevate.test.mjs — the UAC helper's scripts and failure mapping.
import test from 'node:test';
import assert from 'node:assert/strict';

import { elevatedPublishScript, elevatedWrapperScript, runElevatedPublish } from '../lib/elevate.mjs';

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
