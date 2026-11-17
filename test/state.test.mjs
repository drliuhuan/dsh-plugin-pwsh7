// test/state.test.mjs — the shared detection cache must not hide a newly installed pwsh.exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getRouterState, refreshRouterState } from '../lib/state.mjs';

const W = path.win32;
const ENV_KEYS = [
  'LOCALAPPDATA',
  'USERPROFILE',
  'ProgramFiles',
  'ProgramW6432',
  'ProgramFiles(x86)',
  'ProgramData',
  'SystemRoot',
  'PATH',
  'DSH_PWSH_PATH',
  'DSH_PWSH7_NO_PERSISTED_PATH',
];

function writeFile(file) {
  fs.mkdirSync(W.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fake', 'utf8');
}

test('a negative detection is re-checked immediately after pwsh.exe appears', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const saved = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
  const programFiles = W.join(base, 'Program Files');
  try {
    process.env.LOCALAPPDATA = W.join(base, 'localappdata');
    process.env.USERPROFILE = W.join(base, 'user');
    process.env.ProgramFiles = programFiles;
    process.env.ProgramW6432 = programFiles;
    process.env['ProgramFiles(x86)'] = W.join(base, 'Program Files (x86)');
    process.env.ProgramData = W.join(base, 'ProgramData');
    process.env.SystemRoot = W.join(base, 'Windows');
    process.env.PATH = '';
    delete process.env.DSH_PWSH_PATH;
    // Keep this test hermetic: do not read the real machine's registry PATH.
    process.env.DSH_PWSH7_NO_PERSISTED_PATH = '1';

    await refreshRouterState();
    assert.equal(getRouterState().pwsh.found, false, 'no pwsh.exe yet');

    const installed = W.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    writeFile(installed);

    // This is the regression: a negative result must not stay cached for the 10 s TTL.
    const detected = getRouterState();
    assert.equal(detected.pwsh.found, true);
    assert.equal(W.normalize(detected.pwsh.path), W.normalize(installed));
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await refreshRouterState();
  }
});

test('an explicit installation pick outranks the recorded install; DSH_PWSH_PATH wins', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-pick-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const saved = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
  const programFiles = W.join(base, 'Program Files');
  const localAppData = W.join(base, 'localappdata');
  try {
    process.env.LOCALAPPDATA = localAppData;
    process.env.USERPROFILE = W.join(base, 'user');
    process.env.ProgramFiles = programFiles;
    process.env.ProgramW6432 = programFiles;
    process.env['ProgramFiles(x86)'] = W.join(base, 'Program Files (x86)');
    process.env.ProgramData = W.join(base, 'ProgramData');
    process.env.SystemRoot = W.join(base, 'Windows');
    process.env.PATH = '';
    delete process.env.DSH_PWSH_PATH;
    process.env.DSH_PWSH7_NO_PERSISTED_PATH = '1';

    const canonical = W.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    const selected = W.join(base, 'custom-tools', 'pwsh.exe');
    writeFile(canonical);
    writeFile(selected);
    // The last install recorded the canonical copy, but the user picked the custom one in Settings.
    fs.mkdirSync(W.dirname(W.join(localAppData, 'dsh', 'pwsh7', 'config.json')), { recursive: true });
    fs.writeFileSync(W.join(localAppData, 'dsh', 'pwsh7', 'config.json'), JSON.stringify({
      version: 1,
      selectedPwshPath: selected,
      installed: { pwsh: { path: canonical, method: 'msi', scope: 'system' } },
    }), 'utf8');

    await refreshRouterState();
    const picked = getRouterState();
    assert.equal(picked.pwsh.found, true);
    assert.equal(W.normalize(picked.pwsh.path), W.normalize(selected), 'the explicit pick wins');
    assert.equal(picked.pwsh.source, 'config');

    // A pick whose executable disappeared falls back to the recorded installation.
    fs.rmSync(selected);
    await refreshRouterState();
    const fallback = getRouterState();
    assert.equal(W.normalize(fallback.pwsh.path), W.normalize(canonical), 'missing pick is ignored');

    // DSH_PWSH_PATH still outranks both.
    const envOverride = W.join(base, 'env-pwsh', 'pwsh.exe');
    writeFile(envOverride);
    process.env.DSH_PWSH_PATH = envOverride;
    await refreshRouterState();
    assert.equal(W.normalize(getRouterState().pwsh.path), W.normalize(envOverride));
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await refreshRouterState();
  }
});
