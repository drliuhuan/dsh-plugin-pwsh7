// test/dialect.test.mjs — the PowerShell 7 dialect contract and the failure hint.
// Run with: node --test test/dialect.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { DIALECT_PROMPT, buildDialectPrompt, dialectPromptSizes, normalizeDialect, dialectHint, attachDialectHint } from '../lib/dialect.mjs';

const settled = (exitCode, stderr) => ({
  exitCode,
  signal: null,
  stdout: { text: '' },
  stderr: { text: stderr },
});

test('the prompt names the dialect and the bash forms that fail', () => {
  assert.match(DIALECT_PROMPT, /PowerShell 7/);
  assert.match(DIALECT_PROMPT, /not bash/);
  assert.match(DIALECT_PROMPT, /export NAME=value/);
  assert.match(DIALECT_PROMPT, /here-string/);
  assert.match(DIALECT_PROMPT, /foreach/);
  assert.match(DIALECT_PROMPT, /xargs/);
  assert.match(DIALECT_PROMPT, /awk/);
  assert.match(DIALECT_PROMPT, /chmod/);
  assert.match(DIALECT_PROMPT, /names a POSIX tool/);
});

test('prompt injection is off by default and force implies common', () => {
  assert.equal(buildDialectPrompt({}), '');
  assert.equal(buildDialectPrompt({ common: false, force: true }), '');
  const common = buildDialectPrompt({ common: true });
  assert.match(common, /PowerShell 7/);
  assert.doesNotMatch(common, /names a POSIX tool/);
  const forced = buildDialectPrompt({ common: true, force: true });
  assert.match(forced, /names a POSIX tool/);
  assert.ok(forced.length > common.length);
});

test('normalizeDialect coerces to booleans and enforces the dependency', () => {
  assert.deepEqual(normalizeDialect(undefined), { common: false, force: false });
  assert.deepEqual(normalizeDialect({ force: true }), { common: false, force: false });
  assert.deepEqual(normalizeDialect({ common: 'yes', force: true }), { common: false, force: false });
  assert.deepEqual(normalizeDialect({ common: true, force: 1 }), { common: true, force: false });
  assert.deepEqual(normalizeDialect({ common: true, force: true }), { common: true, force: true });
});

test('dialectPromptSizes reports both levels in order', () => {
  const sizes = dialectPromptSizes();
  assert.ok(sizes.commonChars > 0);
  assert.ok(sizes.forcedChars > sizes.commonChars);
  assert.equal(sizes.commonTokens, Math.ceil(sizes.commonChars / 4));
  assert.equal(sizes.forcedTokens, Math.ceil(sizes.forcedChars / 4));
});

test('a successful command carries no hint', () => {
  assert.equal(dialectHint('Get-ChildItem', settled(0, '')), '');
  assert.equal(dialectHint('Get-ChildItem', settled(0, 'error noise')), '');
});

test('an English parse error yields the rewrite hint', () => {
  const hint = dialectHint('export FOO=bar', settled(1, "ParserError:\nLine |\n   1 | export FOO=bar\n"));
  assert.match(hint, /^\[pwsh7\]/);
  assert.match(hint, /failed to parse/);
  assert.match(hint, /PowerShell 7/);
});

test('a zh-CN parse error yields the same hint', () => {
  const hint = dialectHint('export FOO=bar', settled(1, '表达式或语句中包含意外的标记“FOO=bar”。'));
  assert.match(hint, /failed to parse/);
});

test('an unknown POSIX command is mapped to its PowerShell replacement', () => {
  const english = dialectHint('grep -rn TODO .', settled(1, "grep : The term 'grep' is not recognized as a name of a cmdlet"));
  assert.match(english, /Select-String/);
  assert.match(english, /bash\/POSIX/);

  const chinese = dialectHint('grep -rn TODO .', settled(1, 'grep : 无法将“grep”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。'));
  assert.match(chinese, /Select-String/);
});

test('an unknown command without a mapping still points at the dialect', () => {
  const hint = dialectHint('frobnicate --now', settled(1, "The term 'frobnicate' is not recognized as a name of a cmdlet"));
  assert.match(hint, /not a PowerShell 7 command/);
  assert.match(hint, /Get-Command/);
});

test('a non-parser failure is left alone', () => {
  assert.equal(dialectHint('Get-Content missing.txt', settled(1, 'Access to the path is denied.')), '');
  assert.equal(dialectHint('Get-ChildItem', settled(null, '')), '');
});

test('attachDialectHint appends the hint exactly once and preserves the result shape', async () => {
  const handle = { result: async () => settled(1, 'ParserError: unexpected token') };
  const wrapped = attachDialectHint(handle, 'export FOO=bar');
  assert.equal(wrapped, handle);
  const first = await handle.result();
  const second = await handle.result();
  assert.equal(first, second);
  assert.match(first.stderr.text, /ParserError: unexpected token/);
  assert.match(first.stderr.text, /\[pwsh7\]/);
  assert.equal(first.exitCode, 1);
  assert.equal(first.signal, null);
});

test('attachDialectHint leaves a successful result untouched', async () => {
  const original = settled(0, '');
  const handle = { result: async () => original };
  attachDialectHint(handle, 'Get-ChildItem');
  const result = await handle.result();
  assert.equal(result, original);
});

test('attachDialectHint does not duplicate an existing hint and tolerates odd handles', async () => {
  const marked = settled(1, 'ParserError: x\n[pwsh7] already explained\n');
  const handle = { result: async () => marked };
  attachDialectHint(handle, 'export FOO=bar');
  const result = await handle.result();
  assert.equal(result, marked);

  assert.equal(attachDialectHint(undefined, 'x'), undefined);
  assert.deepEqual(attachDialectHint({ result: 'not a function' }, 'x'), { result: 'not a function' });
});
