// test/prelude.test.mjs — parse and behavior checks for the Recycle-Bin prelude against a real
// PowerShell 7. The file skips itself when no `pwsh` is on PATH (the pure contract is covered by
// test/rules.test.mjs). The default cases use -WhatIf / non-file-system providers only, so the
// suite stays side-effect free; the single real-recycle test is opt-in (DSH_PWSH7_TEST_RECYCLE=1)
// and Windows-only.
// Run with: node --test test/prelude.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RECYCLE_GUARD_PRELUDE } from '../lib/rules.mjs';

function findPwsh() {
  for (const candidate of ['pwsh', 'pwsh.exe']) {
    try {
      const result = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
      });
      if (result.status === 0) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const pwsh = findPwsh();

/** Run one guarded command string; `2>&1` is folded in by PowerShell so stderr is observable. */
function runWithPrelude(script) {
  return spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${RECYCLE_GUARD_PRELUDE}\n${script}`], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
}

function makeTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pwsh7-prelude-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ');

test('the prelude parses, shadows Remove-Item, and recycles every removal form with -WhatIf', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, (t) => {
  const directory = makeTemp(t);
  const file = path.join(directory, 'a.txt');
  fs.writeFileSync(file, 'x');

  const quotedFile = `'${file.replace(/'/g, "''")}'`;
  const result = runWithPrelude([
    '$ErrorActionPreference = "Continue"',
    'Write-Output ("command-type=" + (Get-Command Remove-Item).CommandType)',
    `Remove-Item -LiteralPath ${quotedFile} -WhatIf`,
    `Remove-Item ${quotedFile} -WhatIf`,
    `Remove-Item -Path '${directory.replace(/'/g, "''")}' -Recurse -WhatIf`,
    `Get-ChildItem -LiteralPath '${directory.replace(/'/g, "''")}' | Remove-Item -WhatIf`,
    '$aliases = @("rm", "del", "erase", "rd", "rmdir", "ri") | Where-Object { Get-Alias -Name $_ -ErrorAction SilentlyContinue }',
    `foreach ($alias in $aliases) { & $alias ${quotedFile} -WhatIf }`,
    'Write-Output ("aliases=" + ($aliases -join ","))',
  ].join('\n'));

  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /command-type=Function/);
  // Every removal form is intercepted: no "What if" line may come from the stock cmdlet.
  assert.ok(
    (output.match(/Move to Recycle Bin/gi) ?? []).length >= 5,
    `the prelude never runs the stock cmdlet:\n${output}`,
  );
  assert.doesNotMatch(output, /What if: Performing the operation "Remove File"/i);
  assert.ok(fs.existsSync(file), '-WhatIf must not remove the file');
  assert.ok(fs.existsSync(directory), '-WhatIf must not remove the directory');
});

test('the prelude supports pipeline input and leaves files in place under -WhatIf', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, (t) => {
  const directory = makeTemp(t);
  const files = ['one.txt', 'two.txt'].map((name) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, 'x');
    return file;
  });

  const result = runWithPrelude(`Get-ChildItem -LiteralPath '${directory}' | Remove-Item -WhatIf`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(oneLine(result.stdout + result.stderr), /Move to Recycle Bin/);
  for (const file of files) assert.ok(fs.existsSync(file), `${file} must survive -WhatIf`);
});

test('the prelude keeps non-FileSystem providers on the stock cmdlet', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, () => {
  const result = runWithPrelude([
    '$env:DSH_PWSH7_PRELUDE_TEST = "1"',
    'Remove-Item Env:DSH_PWSH7_PRELUDE_TEST -WhatIf',
    'Write-Output ("after-whatif=" + (Test-Path Env:DSH_PWSH7_PRELUDE_TEST))',
    'Remove-Item Env:DSH_PWSH7_PRELUDE_TEST -ErrorAction Stop',
    'Write-Output ("still-there=" + (Test-Path Env:DSH_PWSH7_PRELUDE_TEST))',
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /after-whatif=True/, 'the delegated stock cmdlet honors -WhatIf');
  assert.match(result.stdout, /still-there=False/);
});

test('the prelude actually recycles a file to the Recycle Bin (opt-in, Windows only)', {
  skip: process.platform !== 'win32' || process.env.DSH_PWSH7_TEST_RECYCLE !== '1'
    ? 'set DSH_PWSH7_TEST_RECYCLE=1 on Windows to exercise the real Recycle-Bin path'
    : false,
}, (t) => {
  // The one test that deletes through Windows: the file must leave its path with exit code 0 and
  // must not be permanently deleted (the Recycle-Bin APIs are the only implementation in play).
  const directory = makeTemp(t);
  const name = `dsh-recycled-${process.pid}-${Date.now()}.txt`;
  const file = path.join(directory, name);
  fs.writeFileSync(file, 'x');
  const result = runWithPrelude(`Remove-Item -LiteralPath '${file.replace(/'/g, "''")}'`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(file), false, 'the recycled file left its path');
  const parent = runWithPrelude([
    '$shell = New-Object -ComObject Shell.Application',
    '$bin = $shell.NameSpace(10)',
    `Write-Output ("in-bin=" + [bool]($bin.Items() | Where-Object { $_.Name -eq '${name}' } | Select-Object -First 1))`,
  ].join('\n'));
  assert.equal(parent.status, 0, parent.stderr);
  assert.match(parent.stdout, /in-bin=True/, 'the file is recoverable from the Recycle Bin');
});

test('the prelude refuses selectors instead of recycling the wrong target', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, (t) => {
  const directory = makeTemp(t);
  fs.writeFileSync(path.join(directory, 'a.txt'), 'x');
  const result = runWithPrelude(`Remove-Item -Path '${directory}' -Filter *.txt -WhatIf`);
  assert.notEqual(result.status, 0, 'a selector must fail');
  assert.match(`${result.stdout}\n${result.stderr}`, /does not support -Filter/);
  assert.ok(fs.existsSync(path.join(directory, 'a.txt')), 'a refused selector must not delete anything');
});

test('the prelude reports a missing path without deleting anything', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, (t) => {
  const directory = makeTemp(t);
  const missing = path.join(directory, 'missing.txt');
  const result = runWithPrelude(`Remove-Item -LiteralPath '${missing}' -ErrorAction Continue`);
  assert.match(`${result.stdout}\n${result.stderr}`, /does not exist/);
});
