import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  decodeWindowsPowerShellError,
  validateScope,
  installDirectory,
  pathUpdateScript,
  pathRemovalScript,
  removePathEntriesUnder,
  removeProcessPathEntriesUnder,
  updateInstallPath,
  requireSystemAdministrator,
  isProcessElevated,
} from '../lib/install-scope.mjs';
import { wingetInstallArgs } from '../lib/install.mjs';
import { createSetupService } from '../lib/setup-service.mjs';
import { routerRoot } from '../lib/paths.mjs';

const W = path.win32;

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
    assert.ok(script.includes('$next = (@($target) + $entries) -join'));
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
  assert.equal(env.Path, 'C:\\PowerShell\\7;C:\\Windows');
  await assert.rejects(updateInstallPath('D:\\pwsh.exe', {
    env, scope: 'system', run: async () => ({ ok: false, stderr: 'Access denied' }),
  }), /Access denied/);
  assert.equal(env.Path, 'C:\\PowerShell\\7;C:\\Windows');
});

test('system installation rejects an unelevated host', async () => {
  await assert.rejects(requireSystemAdministrator({ run: async (_exe, args) => {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(script.includes('IsInRole'));
    return { ok: false, stderr: 'System installation requires administrator rights' };
  } }), /requires administrator rights/);
});

// Real Windows PowerShell 5.1 stderr when piped: CLIXML envelope + _xNNNN_ escapes.
const CLIXML_ELEVATION_ERROR = '#< CLIXML\r\n'
  + '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
  + '<S S="Error">Exception: _x000D__x000A_System installation requires administrator rights. '
  + 'Run the DSH host as administrator and retry._x000D__x000A_'
  + '  + CategoryInfo          : NotSpecified: (:) [], RuntimeException_x000D__x000A_</S>'
  + '<S S="Error">&lt;detail&gt; &amp; more_x000D__x000A_</S></Objs>';

test('decodeWindowsPowerShellError turns CLIXML into readable lines', () => {
  const decoded = decodeWindowsPowerShellError(CLIXML_ELEVATION_ERROR);
  assert.match(decoded, /System installation requires administrator rights/);
  assert.match(decoded, /<detail> & more/);
  assert.ok(!/CLIXML|<Objs|<S S=/.test(decoded), decoded);
  assert.ok(decoded.split('\n').length >= 2, decoded);

  // Plain text passes through unchanged; empty input is empty.
  assert.equal(decodeWindowsPowerShellError('Access denied'), 'Access denied');
  assert.equal(decodeWindowsPowerShellError(''), '');
  assert.equal(decodeWindowsPowerShellError(undefined), '');
});

test('requireSystemAdministrator reports a friendly sentence instead of the CLIXML blob', async () => {
  await assert.rejects(
    requireSystemAdministrator({ run: async () => ({ ok: false, stderr: CLIXML_ELEVATION_ERROR }) }),
    (error) => {
      assert.equal(
        error.message,
        'System installation requires administrator rights. Run the DSH host as administrator and retry.',
      );
      assert.ok(!/CLIXML|<Objs/.test(error.message), error.message);
      return true;
    },
  );
});

test('PATH failures surface decoded CLIXML instead of the raw blob', async () => {
  await assert.rejects(updateInstallPath('D:\\pwsh.exe', {
    env: { Path: 'C:\\Windows' },
    scope: 'system',
    run: async () => ({ ok: false, stderr: CLIXML_ELEVATION_ERROR }),
  }), (error) => {
    assert.match(error.message, /System installation requires administrator rights/);
    assert.ok(!/CLIXML|<Objs/.test(error.message), error.message);
    return true;
  });
});

test('PATH removal script uses the matching hive, preserves the value kind, and broadcasts', () => {
  for (const [scope, hive] of [['user', 'CurrentUser'], ['system', 'LocalMachine']]) {
    const script = pathRemovalScript("C:\\O'Brien\\AppData\\Local\\dsh\\pwsh7", scope);
    assert.ok(script.includes(`Registry]::${hive}`));
    assert.ok(script.includes("'C:\\O''Brien\\AppData\\Local\\dsh\\pwsh7'"));
    assert.ok(script.includes('DoNotExpandEnvironmentNames'));
    assert.ok(script.includes("GetValueKind('Path')"));
    assert.ok(script.includes('SendMessageTimeout'));
    assert.ok(script.includes('SetValue'));
    assert.ok(script.includes("ExpandEnvironmentVariables"));
  }
  assert.throws(() => pathRemovalScript('', 'user'), TypeError);
  assert.throws(() => pathRemovalScript('C:\\root', 'machine'), /unsupported install scope/);
});

test('removePathEntriesUnder strips router-root PATH entries from the process environment', async () => {
  const root = 'C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7';
  const env = {
    Path: [
      'C:\\Windows',
      W.join(root, 'powershell7', '7.6.7'),
      'C:\\Other',
      W.join(root, 'tmp'),
    ].join(';'),
  };
  const runs = [];
  const run = async (executable, args) => {
    runs.push({ executable, args });
    return { ok: true, stdout: '' };
  };

  const removed = await removePathEntriesUnder(root, { env, scope: 'user', run });
  assert.deepEqual(removed, [W.join(root, 'powershell7', '7.6.7'), W.join(root, 'tmp')]);
  assert.equal(env.Path, 'C:\\Windows;C:\\Other');
  const script = Buffer.from(runs[0].args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes('Registry]::CurrentUser'));
  assert.ok(script.includes(root));

  // Idempotent: a second pass runs the registry script but removes no process entries.
  const again = await removePathEntriesUnder(root, { env, scope: 'user', run });
  assert.deepEqual(again, []);
  assert.equal(env.Path, 'C:\\Windows;C:\\Other');
  assert.equal(runs.length, 2);

  // A registry failure still surfaces to the caller (and leaves unrelated entries alone).
  await assert.rejects(removePathEntriesUnder(root, {
    env,
    scope: 'user',
    run: async () => ({ ok: false, stderr: 'Access denied' }),
  }), /Access denied/);
  assert.equal(env.Path, 'C:\\Windows;C:\\Other');
});

test('removeProcessPathEntriesUnder keeps non-router entries and tolerates a missing PATH', () => {
  const root = routerRoot({ LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local' });
  const env = { PATH: `${W.join(root, 'powershell7')};C:\\Windows;D:\\Tools` };
  const removed = removeProcessPathEntriesUnder(root, env);
  assert.deepEqual(removed, [W.join(root, 'powershell7')]);
  assert.equal(env.PATH, 'C:\\Windows;D:\\Tools');
  assert.deepEqual(removeProcessPathEntriesUnder(root, {}), []);
  assert.deepEqual(removeProcessPathEntriesUnder(root, { Path: '' }), []);
});

test('isProcessElevated parses an injected probe and never throws', async () => {
  assert.equal(await isProcessElevated({ run: async () => ({ ok: true, stdout: 'elevated\r\n' }) }), true);
  assert.equal(await isProcessElevated({ run: async () => ({ ok: true, stdout: 'standard\r\n' }) }), false);
  assert.equal(await isProcessElevated({ run: async () => ({ ok: false, stderr: 'blocked' }) }), false);
  assert.equal(await isProcessElevated({ run: async () => { throw new Error('spawn failed'); } }), false);
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
