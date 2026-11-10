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
  assert.match(scriptRefusalReason('cmd /c missing.cmd', dir), /cannot be located/);
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

test('PATH launchers are resolved; only local scripts are cwd-sensitive', (t) => {
  const dir = makeDir(t);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'tool.cmd'), '@echo off\r\necho hi\r\n');
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin};${previousPath ?? ''}`;
  t.after(() => { process.env.PATH = previousPath; });
  assert.equal(scriptRefusalReason('tool.cmd --version', dir), null);
  // A PATH launcher is unaffected by a directory change and must not trip the cwd rule.
  assert.equal(scriptRefusalReason('Set-Location sub; tool.cmd run', dir), null);
  // But a PATH launcher with a deletion body is still inspected and refused.
  writeFileSync(join(bin, 'bad.cmd'), 'del /f /q x\r\n');
  assert.match(scriptRefusalReason('bad.cmd', dir), /removal command/);
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
test('command text never grants a script inspection bypass', () => {
  assert.equal(scriptOverrideRequested(`# dsh-pwsh7: user-approved script deletions\ncmd /c "${'${'}'}script"`), false);
  assert.equal(scriptOverrideRequested('cmd /c cleanup.cmd'), false);
  assert.equal(scriptOverrideRequested(undefined), false);
  assert.equal(SCRIPT_OVERRIDE_MARKER, '# dsh-pwsh7: user-approved script deletions');
  assert.equal(scriptOverrideRequested(`Write-Output '${SCRIPT_OVERRIDE_MARKER}'`), false);
});

test('nested scripts are inspected recursively with cycle and depth protection', (t) => {
  const dir = makeDir(t);
  writeFileSync(join(dir, 'outer.ps1'), '. ./inner.ps1');
  writeFileSync(join(dir, 'inner.ps1'), '[ IO.File ] :: Delete("victim.txt")');
  assert.match(scriptRefusalReason('./outer.ps1', dir), /inner.ps1.*permanently/);
  writeFileSync(join(dir, 'inner.ps1'), '. ./outer.ps1');
  assert.equal(scriptRefusalReason('./outer.ps1', dir), null, 'cycles terminate');
  for (let i = 0; i < 36; i++) writeFileSync(join(dir, `chain${i}.ps1`), `. ./chain${i + 1}.ps1`);
  assert.match(scriptRefusalReason('./chain0.ps1', dir), /limit exceeded/);
});

test('directory changes and dynamic script paths cannot silently bypass inspection', (t) => {
  const dir = makeDir(t);
  writeFileSync(join(dir, 'outer.ps1'), 'Set-Location ./sub; ./inner.ps1');
  // The targeted script has to exist for the cwd rule to matter: a missing script is refused anyway.
  writeFileSync(join(dir, 'inner.ps1'), 'Write-Output hi');
  assert.match(scriptRefusalReason('./outer.ps1', dir), /working-directory change/);
  assert.match(scriptRefusalReason('cd ./sub; ./inner.ps1', dir), /working-directory change/);
  assert.match(scriptRefusalReason('& "$env:TEMP/inner.ps1"', dir), /dynamic script paths/);
  assert.match(scriptRefusalReason('./missing.ps1', dir), /cannot be located/);
});

test('execution positions inspect single quotes, separators and imported modules', (t) => {
  const dir = makeDir(t);
  writeFileSync(join(dir, 'cleanup.ps1'), 'Remove-Item ./victim.txt');
  writeFileSync(join(dir, 'cleanup.psm1'), 'Remove-Item ./victim.txt');
  for (const command of [
    "& './cleanup.ps1'", ". './cleanup.ps1'", "  & './cleanup.ps1'",
    'Write-Output start; ./cleanup.ps1', 'Write-Output start\n./cleanup.ps1',
    "Import-Module './cleanup.psm1'", 'Import-Module -Name ./cleanup.psm1',
    "pwsh -File './cleanup.ps1'",
  ]) {
    assert.match(scriptRefusalReason(command, dir), /removal command/, command);
  }
  assert.deepEqual(executedScriptReferences("& './cleanup.ps1'"), ['./cleanup.ps1']);
  assert.equal(scriptRefusalReason("Get-Content './cleanup.ps1'", dir), null);
});

test('UTF-16 scripts are decoded before inspection and unknown NUL encodings fail closed', (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'cleanup.ps1');
  const body = Buffer.from('Remove-Item ./victim.txt', 'utf16le');
  for (const bytes of [
    Buffer.concat([Buffer.from([255, 254]), body]),
    Buffer.concat([Buffer.from([254, 255]), Buffer.from(body).swap16()]),
    body,
  ]) {
    writeFileSync(file, bytes);
    assert.match(scriptRefusalReason(`pwsh -File "${file}"`, dir), /removal command|encoding/);
  }
  writeFileSync(file, Buffer.concat([Buffer.from([255, 254]), Buffer.from('Write-Output hello', 'utf16le')]));
  assert.equal(scriptRefusalReason(`pwsh -File "${file}"`, dir), null);
});
