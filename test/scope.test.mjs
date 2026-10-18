import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScope, installDirectory, pathUpdateScript, updateInstallPath, requireSystemAdministrator } from '../lib/install-scope.mjs';
import { wingetInstallArgs } from '../lib/install.mjs';
import { createSetupService } from '../lib/setup-service.mjs';

test('scopes validate and system uses Program Files', () => {
  assert.throws(() => validateScope('machine'), /unsupported install scope/);
  assert.equal(installDirectory({ ProgramFiles: 'D:\\Apps' }, 'system'), 'D:\\Apps\\PowerShell\\7');
  assert.equal(installDirectory({}, 'user', 'D:\\User'), 'D:\\User');
  assert.deepEqual(wingetInstallArgs('pwsh', 'system').slice(-2), ['--scope', 'machine']);
  assert.deepEqual(wingetInstallArgs().slice(-2), ['--scope', 'user']);
});

test('PATH script uses matching registry hive and preserves expandable values', () => {
  for (const [scope, hive] of [['user', 'CurrentUser'], ['system', 'LocalMachine']]) {
    const script = pathUpdateScript("C:\\O'Brien\\pwsh.exe", scope);
    assert.ok(script.includes(`Registry]::${hive}`));
    assert.ok(script.includes("'C:\\O''Brien'"));
    assert.ok(script.includes('DoNotExpandEnvironmentNames'));
    assert.ok(script.includes("GetValueKind('Path')"));
    assert.ok(script.includes(' -ieq '));
    assert.ok(script.includes('SendMessageTimeout'));
  }
});

test('PATH update waits for persistence, updates process PATH and avoids duplicates', async () => {
  const env = { Path: 'C:\\Windows' };
  let calls = 0;
  const run = async (exe, args) => {
    calls++;
    assert.ok(exe.endsWith('WindowsPowerShell\\v1.0\\powershell.exe'));
    assert.equal(args.at(-2), '-EncodedCommand');
    return { ok: true };
  };
  await updateInstallPath('C:\\PowerShell\\7\\pwsh.exe', { env, scope: 'user', run });
  await updateInstallPath('c:\\powershell\\7\\pwsh.exe', { env, scope: 'user', run });
  assert.equal(calls, 2);
  assert.equal(env.Path, 'C:\\Windows;C:\\PowerShell\\7');
  await assert.rejects(updateInstallPath('D:\\pwsh.exe', {
    env, scope: 'system', run: async () => ({ ok: false, stderr: 'Access denied' }),
  }), /Access denied/);
  assert.equal(env.Path, 'C:\\Windows;C:\\PowerShell\\7');
});

test('system installation rejects an unelevated host', async () => {
  await assert.rejects(requireSystemAdministrator({ run: async (_exe, args) => {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(script.includes('IsInRole'));
    return { ok: false, stderr: 'System installation requires administrator rights' };
  } }), /requires administrator rights/);
});

test('setup forwards scope even when another scope is already installed', async (t) => {
  let received;
  const service = createSetupService({
    env: { ProgramFiles: 'C:\\Program Files' },
    detect: () => ({ pwsh: { found: true, path: 'C:\\User\\pwsh.exe' } }),
    refresh: async () => {},
    install: async (options) => {
      received = options;
      return { ok: true, result: { ok: true, scope: options.scope } };
    },
  });
  t.after(() => service.dispose());
  assert.throws(() => service.start('auto', 'bad'), /unsupported install scope/);
  service.start('portable', 'system');
  const final = await service.wait();
  assert.equal(received.scope, 'system');
  assert.equal(final.scope, 'system');
  assert.equal(final.result.scope, 'system');
  assert.equal(final.installRoot, 'C:\\Program Files\\PowerShell\\7');
});

// Run actual registry/broadcast operations only on disposable GitHub Windows runners.
test('Windows PATH persistence is idempotent in both registry scopes', {
  skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true',
}, async () => {
  const { execFileSync } = await import('node:child_process');
  const ps = path => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(path, 'utf16le').toString('base64')], { encoding: 'utf8' }).trim();
  for (const scope of ['user', 'system']) {
    const hive = scope === 'system' ? 'LocalMachine' : 'CurrentUser';
    const key = scope === 'system' ? 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' : 'Environment';
    const open = `$key = [Microsoft.Win32.Registry]::${hive}.OpenSubKey('${key}', $true);`;
    const snapshot = JSON.parse(ps(open + `
      @{ value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);
         kind = [int]$key.GetValueKind('Path') } | ConvertTo-Json -Compress`));
    const env = { ...process.env };
    try {
      const executable = `C:\\dsh-pwsh7-path-test-${scope}\\pwsh.exe`;
      await updateInstallPath(executable, { env, scope });
      await updateInstallPath(executable, { env, scope });
      const actual = ps(open + "$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)");
      assert.equal(actual.split(';').filter(value => value === `C:\\dsh-pwsh7-path-test-${scope}`).length, 1);
      assert.ok(actual.startsWith(snapshot.value.replace(/;+$/, '')));
    } finally {
      const value = String(snapshot.value).replaceAll("'", "''");
      ps(open + `$key.SetValue('Path', '${value}', [Microsoft.Win32.RegistryValueKind]${snapshot.kind}); $key.Dispose()`);
    }
  }
});
