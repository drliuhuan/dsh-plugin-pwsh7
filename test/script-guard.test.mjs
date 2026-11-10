// test/script-guard.test.mjs — pre-execution inspection of script bodies referenced by a command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SCRIPT_OVERRIDE_MARKER,
  destructiveScriptContent,
  scriptOverrideRequested,
  executedScriptReferences,
  scriptReferencesInCommand,
  scriptRefusalReason,
} from '../lib/script-guard.mjs';

const makeDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwsh7-script-'));
  t.after(() => import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true })));
  return dir;
};

test('a script body with a removal command is refused', (t) => {
  const dir = makeDir(t);
  const cleanup = join(dir, 'cleanup.cmd');
  writeFileSync(cleanup, '@echo off\r\ndel /f /q "D:\\x.txt"\r\n');
  const reason = scriptRefusalReason(`cmd /c "${cleanup}"`, dir);
  assert.ok(reason !== null);
  assert.match(reason, /cmd deletion|removal command/);
  assert.match(reason, /Remove-Item instead/);
});

test('a PowerShell script with Remove-Item or the .NET delete API is refused', (t) => {
  const dir = makeDir(t);
  const ps1 = join(dir, 'build.ps1');
  writeFileSync(ps1, 'Get-ChildItem | Remove-Item -Recurse\n');
  assert.match(scriptRefusalReason(`powershell -File "${ps1}"`, dir), /removal command/);
  writeFileSync(ps1, "[System.IO.File]::Delete('D:\\x.txt')\n");
  assert.match(scriptRefusalReason(`powershell -File "${ps1}"`, dir), /\.NET delete API/);
});

test('a benign script is allowed', (t) => {
  const dir = makeDir(t);
  const benign = join(dir, 'build.ps1');
  writeFileSync(benign, 'Write-Output "hello"\n$model = 1\n');
  assert.equal(scriptRefusalReason(`powershell -File "${benign}"`, dir), null);
});

test('relative references resolve against the workdir, quoted paths with spaces are found', (t) => {
  const dir = makeDir(t);
  const nested = join(dir, 'My Scripts');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'run me.cmd'), 'rd /s /q D:\\x\r\n');
  assert.match(scriptRefusalReason('cmd /c "My Scripts\\run me.cmd"', dir), /removal command/);
  writeFileSync(join(dir, 'plain.bat'), 'erase x\r\n');
  assert.match(scriptRefusalReason('.\\plain.bat', dir), /removal command/);
});

test('a command without script references or with a missing one is not refused', (t) => {
  const dir = makeDir(t);
  assert.equal(scriptRefusalReason('Get-ChildItem', dir), null);
  assert.equal(scriptRefusalReason('cmd /c missing.cmd', dir), null);
});

test('Clear-RecycleBin inside a script is refused', (t) => {
  const dir = makeDir(t);
  const script = join(dir, 'empty.ps1');
  writeFileSync(script, 'Clear-RecycleBin -Force\n');
  assert.match(scriptRefusalReason(`pwsh -File "${script}"`, dir), /empties the Recycle Bin/);
});

test('the reference scanner and content scanner stay narrow enough', () => {
  assert.deepEqual(scriptReferencesInCommand('cmd /c "C:\\a b\\x.cmd"'), ['C:\\a b\\x.cmd']);
  assert.deepEqual(scriptReferencesInCommand('nothing here'), []);
  // Fail closed on purpose: a removal word inside a string or comment also refuses the script.
  assert.match(destructiveScriptContent('Write-Output "del is forbidden"'), /removal command/);
  assert.equal(destructiveScriptContent('format C: /q'), null);
});

test('a command that merely mentions a script file is not refused', (t) => {
  const dir = makeDir(t);
  const script = join(dir, 'cleanup.cmd');
  writeFileSync(script, 'del /f /q x\r\n');
  // Deleting or reading the script itself must stay possible; only running it is refused.
  assert.equal(scriptRefusalReason(`Remove-Item "${script}"`, dir), null);
  assert.equal(scriptRefusalReason(`Get-Content "${script}"`, dir), null);
  assert.deepEqual(executedScriptReferences(`Remove-Item "${script}"`), []);
  assert.deepEqual(executedScriptReferences(`cmd /c "${script}"`), [script]);
  assert.deepEqual(executedScriptReferences(`. "${script}"`), [script]);
});
test('the explicit user-approved override marker is recognized', () => {
  assert.equal(scriptOverrideRequested(`# dsh-pwsh7: user-approved script deletions\ncmd /c "${'${'}'}script"`), true);
  assert.equal(scriptOverrideRequested('cmd /c cleanup.cmd'), false);
  assert.equal(scriptOverrideRequested(undefined), false);
  assert.equal(SCRIPT_OVERRIDE_MARKER, '# dsh-pwsh7: user-approved script deletions');
});