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
  assert.doesNotMatch(prompt, /dialect/i);
  assert.equal(buildBasicRulesPrompt(), BASIC_RULES.join(' '));
});

test('the disclosed prompt cost matches the paragraph', () => {
  const sizes = basicRulesPromptSizes();
  assert.equal(sizes.chars, buildBasicRulesPrompt().length);
  assert.equal(sizes.tokens, Math.ceil(sizes.chars / 4));
  // The README, CHANGELOG and status line disclose this exact figure; keep them in sync.
  assert.equal(sizes.tokens, 255);
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

test('the prelude shadows Remove-Item and recycles every FileSystem target', () => {
  assert.match(RECYCLE_GUARD_PRELUDE, /function Remove-Item \{/);
  assert.match(RECYCLE_GUARD_PRELUDE, /CmdletBinding\(SupportsShouldProcess = \$true/);
  assert.match(RECYCLE_GUARD_PRELUDE, /\[Microsoft\.VisualBasic\.FileIO\.FileSystem\]::DeleteFile/);
  assert.match(RECYCLE_GUARD_PRELUDE, /\[Microsoft\.VisualBasic\.FileIO\.FileSystem\]::DeleteDirectory/);
  assert.equal(RECYCLE_GUARD_PRELUDE.split('SendToRecycleBin').length - 1, 2);
  assert.match(RECYCLE_GUARD_PRELUDE, /Shell\.Application/);
  assert.match(RECYCLE_GUARD_PRELUDE, /NameSpace\(10\)\.MoveHere/);
  assert.match(RECYCLE_GUARD_PRELUDE, /Microsoft\.PowerShell\.Management\\Remove-Item/);
  assert.match(RECYCLE_GUARD_PRELUDE, /nothing was deleted permanently/);
  // No fallback may ever delete permanently, and no stock alias is redefined.
  assert.doesNotMatch(RECYCLE_GUARD_PRELUDE, /\[System\.IO\.File\]::Delete/);
  assert.doesNotMatch(RECYCLE_GUARD_PRELUDE, /\[System\.IO\.Directory\]::Delete/);
  assert.doesNotMatch(RECYCLE_GUARD_PRELUDE, /function (rm|del|erase|rd|rmdir|ri) \{/);
});

test('the executor guards before delegating and hints the original command', () => {
  const source = fs.readFileSync(new URL('../lib/executors/pwsh.mjs', import.meta.url), 'utf8');
  assert.match(source, /guardRemoval/);
  assert.match(source, /super\.execute\(guarded\)/);
  assert.match(source, /attachDialectHint\(handle, spec\?\.command\)/);
});
