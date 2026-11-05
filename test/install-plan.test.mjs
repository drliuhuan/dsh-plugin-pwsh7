// test/install-plan.test.mjs — installation detection and upgrade-strategy selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  chooseMainInstallation,
  classifyPwshPath,
  detectInstallations,
  expandEnvironmentVariables,
  parseMsiProductRecords,
  planUpgrade,
  resolvePwshArchitecture,
  resolveUpgradePlan,
} from '../lib/install-plan.mjs';

const W = path.win32;

function makeTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeEnv(base) {
  return {
    LOCALAPPDATA: W.join(base, 'localappdata'),
    USERPROFILE: W.join(base, 'user'),
    ProgramFiles: W.join(base, 'Program Files'),
    'ProgramFiles(x86)': W.join(base, 'Program Files (x86)'),
    ProgramData: W.join(base, 'ProgramData'),
    SystemRoot: W.join(base, 'Windows'),
    PROCESSOR_ARCHITECTURE: 'AMD64',
    PATH: W.join(base, 'bin'),
  };
}

function writeFile(file) {
  fs.mkdirSync(W.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fake', 'utf8');
}

test('resolvePwshArchitecture maps the OS architecture, not just the Node binary', () => {
  assert.equal(resolvePwshArchitecture({ PROCESSOR_ARCHITECTURE: 'AMD64' }, 'x64'), 'win-x64');
  assert.equal(resolvePwshArchitecture({ PROCESSOR_ARCHITECTURE: 'ARM64' }, 'x64'), 'win-arm64');
  assert.equal(resolvePwshArchitecture({ PROCESSOR_ARCHITECTURE: 'x86' }, 'ia32'), 'win-x86');
  // 32-bit Node on a 64-bit OS must still install the x64 asset.
  assert.equal(
    resolvePwshArchitecture({ PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'AMD64' }, 'ia32'),
    'win-x64',
  );
});

test('expandEnvironmentVariables is case-insensitive and understands standard directories', () => {
  assert.equal(
    expandEnvironmentVariables('%LOCALAPPDATA%\\dsh\\%ProgramFiles%', {
      LOCALAPPDATA: 'C:\\Users\\T\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
    }),
    'C:\\Users\\T\\AppData\\Local\\dsh\\C:\\Program Files',
  );
});

test('parseMsiProductRecords maps machine and per-user products to their directories', () => {
  const env = makeEnv('C:\\base');
  const products = parseMsiProductRecords([
    {
      DisplayName: 'PowerShell 7-x64',
      DisplayVersion: '7.6.6.0',
      InstallLocation: '',
      ProductCode: '{MACHINE}',
      Hive: 'HKLM',
    },
    {
      DisplayName: 'PowerShell 7-x64',
      DisplayVersion: '7.6.7.0',
      InstallLocation: 'D:\\Portable MSI',
      ProductCode: '{USER}',
      Hive: 'HKCU',
    },
    { DisplayName: 'PowerShell 7-preview-x64', DisplayVersion: '7.7.0', Hive: 'HKLM' },
  ], env);

  assert.equal(products.length, 2);
  assert.equal(products[0].scope, 'system');
  assert.equal(products[0].directory, W.join(env.ProgramFiles, 'PowerShell', '7'));
  assert.equal(products[0].productCode, '{MACHINE}');
  assert.equal(products[1].scope, 'user');
  assert.equal(products[1].directory, W.normalize('D:\\Portable MSI'));
});

test('classifyPwshPath recognizes MSI, plugin, legacy, Store, Chocolatey, Scoop and portable paths', (t) => {
  const env = makeEnv(makeTemp(t));
  const root = W.join(env.LOCALAPPDATA, 'dsh', 'pwsh7');
  const msiProducts = parseMsiProductRecords([
    { DisplayName: 'PowerShell 7-x64', DisplayVersion: '7.6.6', Hive: 'HKLM' },
  ], env);
  const systemDir = W.join(env.ProgramFiles, 'PowerShell', '7');

  assert.equal(classifyPwshPath(W.join(systemDir, 'pwsh.exe'), { env, root, msiProducts }).kind, 'msi');
  assert.equal(
    classifyPwshPath(W.join(systemDir, '7.6.9', 'pwsh.exe'), { env, root, msiProducts: [] }).kind,
    'plugin-system-legacy',
  );
  assert.equal(
    classifyPwshPath(W.join(root, 'powershell7', '7.6.7', 'pwsh.exe'), { env, root }).kind,
    'plugin-user',
  );
  assert.equal(
    classifyPwshPath(W.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'), { env, root }).kind,
    'store',
  );
  assert.equal(
    classifyPwshPath(W.join(env.ProgramData, 'chocolatey', 'bin', 'pwsh.exe'), { env, root }).kind,
    'chocolatey',
  );
  assert.equal(
    classifyPwshPath(W.join(env.USERPROFILE, 'scoop', 'shims', 'pwsh.exe'), { env, root }).kind,
    'scoop',
  );
  assert.equal(
    classifyPwshPath(W.join(env.LOCALAPPDATA, 'MyPwsh', 'pwsh.exe'), { env, root }).kind,
    'portable',
  );
});

test('chooseMainInstallation follows the persisted PATH order', (t) => {
  const env = makeEnv(makeTemp(t));
  const root = W.join(env.LOCALAPPDATA, 'dsh', 'pwsh7');
  const legacyDir = W.join(env.ProgramFiles, 'PowerShell', '7', '7.6.9');
  const canonicalDir = W.join(env.ProgramFiles, 'PowerShell', '7');
  writeFile(W.join(legacyDir, 'pwsh.exe'));
  writeFile(W.join(canonicalDir, 'pwsh.exe'));
  const installations = detectInstallations({ env, root, msiProducts: [], pathEntries: [] });
  const main = chooseMainInstallation({
    env,
    root,
    installations,
    pathEntries: [{ value: legacyDir, source: 'machine' }, { value: canonicalDir, source: 'machine' }],
    msiProducts: [],
  });
  assert.equal(main.kind, 'plugin-system-legacy');
  assert.equal(main.directory, W.normalize(legacyDir));
});

test('chooseMainInstallation treats DSH_PWSH_PATH as an explicit override', (t) => {
  const env = makeEnv(makeTemp(t));
  env.DSH_PWSH_PATH = W.join(env.LOCALAPPDATA, 'Custom', 'pwsh.exe');
  writeFile(env.DSH_PWSH_PATH);
  const main = chooseMainInstallation({
    env,
    installations: detectInstallations({ env }),
    pathEntries: [],
    overridePath: env.DSH_PWSH_PATH,
  });
  assert.equal(main.explicit, true);
  assert.equal(main.source, 'override');
});

test('planUpgrade covers every installation kind', (t) => {
  const env = makeEnv(makeTemp(t));
  const root = W.join(env.LOCALAPPDATA, 'dsh', 'pwsh7');
  const canonical = W.join(env.ProgramFiles, 'PowerShell', '7');

  const msi = planUpgrade({ kind: 'msi', scope: 'system', directory: canonical, productCode: '{P}' }, { env, root });
  assert.equal(msi.strategy, 'msi');
  assert.equal(msi.allUsers, true);

  const legacy = planUpgrade({ kind: 'plugin-system-legacy', scope: 'system', directory: W.join(canonical, '7.6.9') }, { env, root });
  assert.equal(legacy.strategy, 'msi');
  assert.equal(legacy.targetDirectory, W.normalize(canonical));
  assert.equal(legacy.cleanupLegacy, true);

  const plugin = planUpgrade({ kind: 'plugin-user', scope: 'user', directory: W.join(root, 'powershell7', '7.6.9') }, { env, root, scope: 'system' });
  assert.equal(plugin.strategy, 'msi-install');

  const portable = planUpgrade({ kind: 'portable', scope: 'system', directory: canonical }, { env, root });
  assert.equal(portable.strategy, 'zip-in-place');

  assert.equal(planUpgrade({ kind: 'store', scope: 'user', directory: 'C:\\Store', path: 'C:\\Store\\pwsh.exe' }, { env, root }).strategy, 'store');
  assert.equal(planUpgrade({ kind: 'chocolatey', scope: 'system', directory: 'C:\\Choco', path: 'C:\\Choco\\pwsh.exe' }, { env, root }).strategy, 'chocolatey');
  assert.equal(planUpgrade({ kind: 'scoop', scope: 'user', directory: 'C:\\Scoop', path: 'C:\\Scoop\\pwsh.exe' }, { env, root }).strategy, 'scoop');
  assert.equal(planUpgrade({ kind: 'portable', explicit: true, directory: 'C:\\x', path: 'C:\\x\\pwsh.exe' }, { env, root }).strategy, 'refuse');
  assert.equal(planUpgrade(undefined, { env, root }).strategy, 'msi-install');
});

test('resolveUpgradePlan prefers a Store alias on PATH over an MSI install', async (t) => {
  const env = makeEnv(makeTemp(t));
  const root = W.join(env.LOCALAPPDATA, 'dsh', 'pwsh7');
  const storeDir = W.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps');
  writeFile(W.join(storeDir, 'pwsh.exe'));
  writeFile(W.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'));
  const info = await resolveUpgradePlan({
    env,
    root,
    scope: 'system',
    msiProducts: parseMsiProductRecords([
      { DisplayName: 'PowerShell 7-x64', DisplayVersion: '7.6.6', Hive: 'HKLM' },
    ], env),
    pathEntries: [{ value: storeDir, source: 'user' }],
  });
  assert.equal(info.main.kind, 'store');
  assert.equal(info.plan.strategy, 'store');
});

test('resolveUpgradePlan refuses an explicit override', async (t) => {
  const env = makeEnv(makeTemp(t));
  const override = W.join(env.LOCALAPPDATA, 'Custom', 'pwsh.exe');
  writeFile(override);
  env.DSH_PWSH_PATH = override;
  const info = await resolveUpgradePlan({ env, msiProducts: [], pathEntries: [] });
  assert.equal(info.main.explicit, true);
  assert.equal(info.plan.strategy, 'refuse');
});
