// test/rules.test.mjs — the always-on basic rules (deletions go to the Recycle Bin) and the
// Recycle-Bin executor guard.
// Run with: node --test test/rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  BASIC_RULES,
  RECYCLE_GUARD_MARKER,
  RECYCLE_GUARD_PRELUDE,
  buildBasicRulesPrompt,
  basicRulesPromptSizes,
  destructiveCommandReason,
  guardRemoval,
  needsRecycleGuard,
  normalizeRemovalCommand,
} from '../lib/rules.mjs';

test('the basic rules state the Recycle-Bin contract and the forbidden bypasses', () => {
  const prompt = buildBasicRulesPrompt();
  assert.match(prompt, /always-on rule/);
  assert.match(prompt, /Recycle Bin/);
  assert.match(prompt, /Remove-Item/);
  for (const alias of ['rm', 'del', 'erase', 'rd', 'rmdir', 'ri']) {
    assert.match(prompt, new RegExp(`\`${alias}\``), `the rules name the ${alias} alias`);
  }
  assert.match(prompt, /cmd \/c del/);
  assert.match(prompt, /rd \/s \/q/);
  assert.match(prompt, /\[System\.IO\.File\]::Delete/);
  assert.match(prompt, /\[System\.IO\.Directory\]::Delete/);
  assert.match(prompt, /Microsoft\.PowerShell\.Management\\Remove-Item/);
  assert.match(prompt, /Get-ChildItem/);
  assert.match(prompt, /-WhatIf/);
  // Deleting is only half the contract: the user must be told how to get it back, and when DSH
  // cannot help.
  assert.match(prompt, /shell_router/);
  assert.match(prompt, /restore/);
  assert.match(prompt, /restart/);
  assert.match(prompt, /script or a native API/);
  assert.match(prompt, /delete it themselves in Explorer/);
  assert.match(prompt, /user-approved script deletions/);
  assert.match(prompt, /cannot bypass inspection/);
  assert.doesNotMatch(prompt, /dialect/i);
  assert.equal(buildBasicRulesPrompt(), BASIC_RULES.join(' '));
});

test('the disclosed prompt cost matches the paragraph', () => {
  const sizes = basicRulesPromptSizes();
  assert.equal(sizes.chars, buildBasicRulesPrompt().length);
  assert.equal(sizes.tokens, Math.ceil(sizes.chars / 4));
  // The README, CHANGELOG and status line disclose this exact figure; keep them in sync.
  assert.equal(sizes.tokens, 561);
});

test('removal commands are detected, unrelated words are not', () => {
  for (const command of [
    'Remove-Item .\\build -Recurse -Force',
    'rm ./tmp -Recurse',
    'del out.txt',
    'erase out.txt',
    'rd old',
    'rmdir old',
    'ri old',
    'Get-ChildItem -Filter *.tmp | Remove-Item',
    'microsoft.powershell.management\\Remove-Item x',
    '$rm = 1; & $rm',
  ]) {
    assert.equal(needsRecycleGuard(command), true, command);
  }
  for (const command of [
    'Get-ChildItem',
    'form term',
    'docker run --rm image',
    'npm test',
    '',
  ]) {
    assert.equal(needsRecycleGuard(command), false, command);
  }
  assert.equal(needsRecycleGuard(undefined), false);
});

test('the module-qualified stock spelling cannot bypass the shadow', () => {
  assert.equal(
    normalizeRemovalCommand('Microsoft.PowerShell.Management\\Remove-Item C:\\x -Recurse'),
    'Remove-Item C:\\x -Recurse',
  );
  assert.equal(
    normalizeRemovalCommand('microsoft.powershell.management\\remove-item x'),
    'Remove-Item x',
  );
  assert.equal(normalizeRemovalCommand('& "Microsoft.PowerShell.Management\\Remove-Item" x'), '& "Remove-Item" x');
  assert.equal(normalizeRemovalCommand('Get-ChildItem'), 'Get-ChildItem');
  assert.equal(normalizeRemovalCommand(undefined), undefined);

  const qualified = 'Microsoft.PowerShell.Management\\Remove-Item C:\\x';
  const guarded = guardRemoval({ command: qualified });
  assert.ok(guarded.command.startsWith(RECYCLE_GUARD_PRELUDE));
  assert.ok(guarded.command.endsWith('\nRemove-Item C:\\x'));
  assert.doesNotMatch(guarded.command.slice(RECYCLE_GUARD_PRELUDE.length), /Microsoft\.PowerShell\.Management/);
});

test('the guard prepends the prelude once and preserves the rest of the spec', () => {
  const command = 'Remove-Item C:\\tmp\\x -Recurse';
  const spec = { command, workdir: 'C:\\work', timeoutMs: 1000 };
  const guarded = guardRemoval(spec);
  assert.notEqual(guarded, spec);
  assert.equal(spec.command, command, 'the input spec is not mutated');
  assert.equal(guarded.workdir, 'C:\\work');
  assert.equal(guarded.timeoutMs, 1000);
  assert.ok(guarded.command.startsWith(RECYCLE_GUARD_MARKER));
  assert.ok(guarded.command.endsWith(`\n${command}`));
  assert.equal(guarded.command.split(RECYCLE_GUARD_MARKER).length - 1, 1);
  assert.equal(guardRemoval(guarded), guarded, 'the guard is idempotent');
});

test('commands without a removal command are passed through untouched', () => {
  const spec = { command: 'Get-ChildItem' };
  assert.equal(guardRemoval(spec), spec);
  assert.equal(guardRemoval(undefined), undefined);
  assert.equal(guardRemoval(null), null);
  const empty = {};
  assert.equal(guardRemoval(empty), empty);
});

test('the prelude routes every FileSystem target through the host recycle bridge', () => {
  assert.match(RECYCLE_GUARD_PRELUDE, /function Remove-Item \{/);
  assert.match(RECYCLE_GUARD_PRELUDE, /CmdletBinding\(SupportsShouldProcess = \$true/);
  // The recycle happens in the host process; this one only asks (write-restricted token).
  assert.match(RECYCLE_GUARD_PRELUDE, /DSH_PWSH7_RECYCLE_URL/);
  assert.match(RECYCLE_GUARD_PRELUDE, /DSH_PWSH7_RECYCLE_TOKEN/);
  assert.match(RECYCLE_GUARD_PRELUDE, /Invoke-RestMethod/);
  assert.match(RECYCLE_GUARD_PRELUDE, /x-dsh-recycle-token/);
  assert.match(RECYCLE_GUARD_PRELUDE, /Microsoft\.PowerShell\.Management\\Remove-Item/);
  assert.match(RECYCLE_GUARD_PRELUDE, /nothing was deleted permanently/);
  // The confined process must not attempt a recycle itself: those APIs cannot write the bin
  // under the write-restricted token, and the shell then deletes permanently while reporting
  // success (measured). No in-process fallback may remain.
  assert.doesNotMatch(RECYCLE_GUARD_PRELUDE, /Microsoft\.VisualBasic/);
  assert.doesNotMatch(RECYCLE_GUARD_PRELUDE, /SendToRecycleBin/);
  assert.doesNotMatch(RECYCLE_GUARD_PRELUDE, /Shell\.Application/);
  assert.doesNotMatch(RECYCLE_GUARD_PRELUDE, /NameSpace\(10\)/);
  // No fallback may ever delete permanently, and no stock alias is redefined.
  assert.doesNotMatch(RECYCLE_GUARD_PRELUDE, /\[System\.IO\.File\]::Delete/);
  assert.doesNotMatch(RECYCLE_GUARD_PRELUDE, /\[System\.IO\.Directory\]::Delete/);
  assert.doesNotMatch(RECYCLE_GUARD_PRELUDE, /function (rm|del|erase|rd|rmdir|ri) \{/);
});

test('the executor guards before delegating and hints the original command', () => {
  const source = fs.readFileSync(new URL('../lib/executors/pwsh.mjs', import.meta.url), 'utf8');
  assert.match(source, /guardRemoval/);
  assert.match(source, /super\.run\(prepared\)/);
  assert.match(source, /super\.execute\(prepared\)/);
  assert.match(source, /super\.start\(prepared\)/);
  assert.match(source, /createRecycleService/);
  assert.match(source, /RECYCLE_URL_ENV/);
  assert.match(source, /RECYCLE_TOKEN_ENV/);
  // The channel that actually reaches the child: the trusted shellEnv registry snapshot.
  assert.match(source, /static inject = \[[^\]]*'shellEnv'/);
  assert.match(source, /pwsh7-recycle-bridge/);
  assert.match(source, /shellEnv\.register/);
  // The bridge must be listening before the first guarded command runs.
  assert.match(source, /_recycle\.start\(\)/);
  // No ES private members: a Proxy receiver fails the brand check and takes the tool down.
  assert.doesNotMatch(source, /#[a-z]+\(/);
  assert.match(source, /attachDialectHint\(handle, spec\?\.command\)/);
});

test('commands that empty the bin or delete permanently are refused before the shell starts', () => {
  const refused = [
    ['Clear-RecycleBin -Force', /Recycle Bin is forbidden/],
    ['cmd /c del "D:\\x.txt"', /delete permanently/],
    ['cmd.exe /c rd /s /q D:\\x', /delete permanently/],
    ['[System.IO.File]::Delete("D:\\x.txt")', /permanently/],
    ['[System.IO.Directory]::Delete("D:\\x")', /permanently/],
    ['pwsh -Command "del x"', /nested shell/],
    ['pwsh -Command "rm x"', /nested shell/],
    ['powershell -Command "ri x"', /nested shell/],
    ['cmd /k "del x & exit"', /delete permanently/],
    ['[IO.File]::Delete("x")', /permanently/],
    ['[ IO.Directory ] :: Delete("x")', /permanently/],
    ['(Get-Item ./victim.txt).Delete()', /permanently/],
    ['node -e "require(\'fs\').unlinkSync(\'victim.txt\')"', /runtime deletion/],
    ['python -c "import os; os.remove(\'victim.txt\')"', /runtime deletion/],
    ["$c = 'Remove-' + 'Item'; & $c ./victim.txt", /dynamic command/],
    ['pwsh -EncodedCommand AAAA', /encoded nested/],
    ['powershell -enc AAAA', /encoded nested/],
    ['iex $code', /dynamic code/],
    ['powershell.exe -Command "Clear-RecycleBin"', /Recycle Bin is forbidden|nested shell/],
  ];
  for (const [command, expected] of refused) {
    const reason = destructiveCommandReason(command);
    assert.ok(reason !== null, command);
    assert.match(reason, expected);
  }
  for (const command of [
    'Get-ChildItem',
    'Remove-Item -LiteralPath x.txt',
    'echo "del is forbidden"',
    // Method calls and regex anchors used to be mistaken for a dynamic invocation.
    'console.log(1)',
    "$items.Where({ $_.x }).Count",
    "Select-String -Pattern '\\.(json|md)$'",
  ]) {
    assert.equal(destructiveCommandReason(command), null, command);
  }
});

test('the executor refuses destructive commands before spawning', () => {
  const source = fs.readFileSync(new URL('../lib/executors/pwsh.mjs', import.meta.url), 'utf8');
  assert.match(source, /destructiveCommandReason/);
  assert.match(source, /refused: \$\{refusal\}/);
});
