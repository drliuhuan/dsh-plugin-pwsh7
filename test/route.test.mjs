// test/route.test.mjs — the three routing modes, the forced pwsh5 executable, and the legacy
// side-by-side system copy description.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  describeInstall,
  effectiveRoute,
  resolveExecutorPwshPath,
  resolvePowerShell5,
  routeInfo,
  ROUTE_MODES,
  writeRouteConfig,
} from '../lib/route.mjs';
import { readDialect } from '../lib/dialect-config.mjs';
import { readRouterConfig, writeRouterConfig } from '../lib/paths.mjs';
import { createSetupService } from '../lib/setup-service.mjs';

const W = path.win32;

function makeTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-route-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFile(file, contents = '') {
  fs.mkdirSync(W.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
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

test('ROUTE_MODES includes pwsh5 and effectiveRoute defaults to plugin', () => {
  assert.deepEqual([...ROUTE_MODES], ['plugin', 'system', 'pwsh5']);
  assert.equal(effectiveRoute(undefined), 'plugin');
  assert.equal(effectiveRoute({}), 'plugin');
  assert.equal(effectiveRoute({ route: 'system' }), 'system');
  assert.equal(effectiveRoute({ route: 'pwsh5' }), 'pwsh5');
  assert.equal(effectiveRoute({ route: 'bogus' }), 'plugin');
});

test('writeRouteConfig remembers the route before pwsh5 and restores it on leave', (t) => {
  const env = makeEnv(makeTemp(t));
  writeRouterConfig({ route: 'system', pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }, env);

  writeRouteConfig('pwsh5', env);
  let config = readRouterConfig(env);
  assert.equal(config.route, 'pwsh5');
  assert.equal(config.routeBeforePwsh5, 'system');
  assert.equal(routeInfo(env).previous, 'system');
  assert.equal(routeInfo(env).mode, 'pwsh5');

  writeRouteConfig('plugin', env);
  config = readRouterConfig(env);
  assert.equal(config.route, 'plugin');
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'routeBeforePwsh5'), false);
  assert.equal(routeInfo(env).previous, 'plugin');
});

test('the forced pwsh5 route resolves Windows PowerShell 5.1, not pwsh.exe', (t) => {
  const env = makeEnv(makeTemp(t));
  const powershell = W.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  writeFile(powershell, 'fake powershell');
  assert.equal(resolvePowerShell5(env), W.normalize(powershell));
  assert.equal(
    resolveExecutorPwshPath(undefined, { env, getState: () => ({ route: 'pwsh5' }) }),
    W.normalize(powershell),
  );
  // The plugin route still delegates to the setup-aware resolver.
  assert.equal(
    resolveExecutorPwshPath(undefined, {
      env,
      getState: () => ({ route: 'plugin' }),
      requirePath: () => 'C:\\router\\pwsh.exe',
    }),
    'C:\\router\\pwsh.exe',
  );
});

test('resolvePowerShell5 falls back to the bare powershell name when System32 is unavailable', (t) => {
  const env = makeEnv(makeTemp(t));
  assert.equal(resolvePowerShell5(env), 'powershell');
});

test('describeInstall exposes the canonical system executable and legacy versioned copies', (t) => {
  const env = makeEnv(makeTemp(t));
  const root = W.join(env.LOCALAPPDATA, 'dsh', 'pwsh7');
  const systemDir = W.join(env.ProgramFiles, 'PowerShell', '7');
  const canonical = W.join(systemDir, 'pwsh.exe');
  const legacy = W.join(systemDir, '7.6.9', 'pwsh.exe');
  writeFile(canonical, 'fake canonical');
  writeFile(legacy, 'fake legacy');

  const install = describeInstall({ env, root });
  assert.equal(install.systemCopy, true);
  assert.equal(install.systemExe, W.normalize(canonical));
  assert.deepEqual(install.legacySystemPaths, [W.normalize(legacy)]);
  assert.equal(install.scope, 'system');
  assert.equal(install.path, W.normalize(canonical));

  const legacyInstall = describeInstall({
    env,
    root,
    config: {
      pwshPath: legacy,
      installed: { pwsh: { path: legacy, scope: 'system', method: 'portable' } },
    },
  });
  assert.equal(legacyInstall.path, W.normalize(legacy));
  assert.equal(legacyInstall.legacySystem, true);
  assert.equal(legacyInstall.method, 'legacy-portable');
});

test('the forced pwsh5 route disables the stored prompt level without discarding it', (t) => {
  const env = makeEnv(makeTemp(t));
  writeRouterConfig({ route: 'plugin', dialect: { common: true, force: true } }, env);
  assert.deepEqual(readDialect(env), { common: true, force: true });

  writeRouteConfig('pwsh5', env);
  assert.deepEqual(readDialect(env), { common: false, force: false });

  writeRouteConfig('plugin', env);
  assert.deepEqual(readDialect(env), { common: true, force: true });
});

test('the setup snapshot treats the forced pwsh5 route as ready and offers no PowerShell 7 install', (t) => {
  const env = makeEnv(makeTemp(t));
  const powershell = W.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  writeFile(powershell, 'fake powershell');
  const service = createSetupService({
    env,
    detect: () => ({
      platform: 'win32',
      pwsh: { found: false, candidates: [] },
      config: { route: 'pwsh5', dialect: { common: true, force: true } },
      configPath: 'C:\\config.json',
      route: 'pwsh5',
      notes: [],
    }),
    probeElevation: async () => false,
  });
  t.after(() => service.dispose());
  const snapshot = service.snapshot();
  assert.equal(snapshot.route, 'pwsh5');
  assert.equal(snapshot.routePrevious, 'plugin');
  assert.equal(snapshot.found, true);
  assert.equal(snapshot.version, '5.1');
  assert.equal(snapshot.path, W.normalize(powershell));
  assert.equal(snapshot.canInstall, false);
  assert.deepEqual(snapshot.dialect, { common: false, force: false, sizes: snapshot.dialect.sizes });
});

test('the latest check compares against the installation the upgrade plan will target', async (t) => {
  const env = makeEnv(makeTemp(t));
  const pluginPath = W.join(env.LOCALAPPDATA, 'dsh', 'pwsh7', 'powershell7', '7.6.9', 'pwsh.exe');
  const chocoPath = W.join(env.ProgramData, 'chocolatey', 'bin', 'pwsh.exe');
  const service = createSetupService({
    env,
    detect: () => ({
      platform: 'win32',
      pwsh: { found: true, path: pluginPath, source: 'config' },
      config: { route: 'plugin', pwshPath: pluginPath },
      configPath: 'C:\\config.json',
      route: 'plugin',
      notes: [],
    }),
    probeElevation: async () => false,
    resolveLatest: async () => ({ version: '7.6.9' }),
    probe: async (candidate) => ({
      ok: true,
      version: candidate.toLowerCase() === chocoPath.toLowerCase() ? '7.6.7' : '7.6.9',
    }),
    detectPlan: async () => ({
      main: { kind: 'chocolatey', scope: 'system', path: chocoPath, directory: W.dirname(chocoPath) },
      plan: { strategy: 'chocolatey', targetDirectory: W.dirname(chocoPath), scope: 'system' },
    }),
  });
  t.after(() => service.dispose());
  const info = await service.checkLatest({ force: true });
  assert.equal(info.current, '7.6.7');
  assert.equal(info.updateAvailable, true);
  assert.equal(info.strategy, 'chocolatey');
});

test('the latest check refuses to offer an update for an explicit override', async (t) => {
  const env = makeEnv(makeTemp(t));
  const service = createSetupService({
    env,
    detect: () => ({
      platform: 'win32',
      pwsh: { found: true, path: 'C:\\Custom\\pwsh.exe', source: 'env' },
      config: { route: 'plugin' },
      configPath: 'C:\\config.json',
      route: 'plugin',
      notes: [],
    }),
    probeElevation: async () => false,
    resolveLatest: async () => ({ version: '7.6.9' }),
    probe: async () => ({ ok: true, version: '7.6.7' }),
    detectPlan: async () => ({
      main: { kind: 'portable', explicit: true, scope: 'user', path: 'C:\\Custom\\pwsh.exe', directory: 'C:\\Custom' },
      plan: { strategy: 'refuse', reason: 'pinned by DSH_PWSH_PATH' },
    }),
  });
  t.after(() => service.dispose());
  const info = await service.checkLatest({ force: true });
  assert.equal(info.updateAvailable, false);
  assert.match(info.error, /pinned by DSH_PWSH_PATH/);
});

test('the latest check does not offer a PowerShell 7 update while pwsh5 is forced', async (t) => {
  const env = makeEnv(makeTemp(t));
  writeFile(W.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'fake');
  const service = createSetupService({
    env,
    detect: () => ({
      platform: 'win32',
      pwsh: { found: false, candidates: [] },
      config: { route: 'pwsh5' },
      configPath: 'C:\\config.json',
      route: 'pwsh5',
      notes: [],
    }),
    probeElevation: async () => false,
    resolveLatest: async () => ({ version: '7.7.0', url: 'https://example.test/msi' }),
    probe: async () => ({ ok: true, version: '5.1' }),
  });
  t.after(() => service.dispose());
  const info = await service.checkLatest({ force: true });
  assert.equal(info.version, '7.7.0');
  assert.equal(info.updateAvailable, false);
  assert.equal(service.snapshot().latest.updateAvailable, false);
});
