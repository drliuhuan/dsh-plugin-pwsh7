// test/settings.test.mjs — the v0.3.0 settings/maintenance host half.
//
// Everything here is hermetic: fake environments point at temp directories, PATH/registry writes
// go through injected runners, installs/relocation preflights/probes are injected seams, and no
// test touches the live HKLM/HKCU PATH or the network. What is pinned:
//   * route config persistence (additive key) and the system resolver order/exclusions,
//   * the executor getter branch,
//   * `/pwsh7/state` extended fields,
//   * user-scope uninstall safety + file/PATH/config cleanup (incl. locked files),
//   * relocate elevation preflight, ordering, and removeUser behavior,
//   * self-check statuses (missing PS7, 5.1 fallback, shipped failure, healthy),
//   * route handler status codes (405/415/400/412/202/409) and route table.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  ROUTE_MODES,
  describeInstall,
  effectiveRoute,
  pluginVersion,
  resolveExecutorPwshPath,
  resolveSystemPwsh,
  routeInfo,
  systemPwshCandidates,
  writeRouteConfig,
} from '../lib/route.mjs';
import {
  SETUP_ROUTES,
  createSetupService,
} from '../lib/setup-service.mjs';
import { createSetupHandlers, setupRouteRows } from '../lib/setup-routes.mjs';
import { SELFCHECK_IDS, runSelfcheck } from '../lib/selfcheck.mjs';
import { removeManagedUserInstall } from '../lib/maintenance.mjs';
import {
  configFile,
  discoveredPortablePwshPaths,
  readRouterConfig,
  routerRoot,
  writeRouterConfig,
} from '../lib/paths.mjs';

const W = path.win32;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeTemp(t, prefix = 'dsh-settings') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeEnv(base) {
  return {
    LOCALAPPDATA: W.join(base, 'localappdata'),
    USERPROFILE: W.join(base, 'user'),
    ProgramFiles: W.join(base, 'Program Files'),
    'ProgramFiles(x86)': W.join(base, 'Program Files (x86)'),
    SystemRoot: W.join(base, 'Windows'),
    PATH: [W.join(base, 'bin'), W.join(base, 'tools')].join(';'),
  };
}

function writeFile(file, contents = 'fake executable') {
  fs.mkdirSync(W.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

function fakeState({ found = false, pwshPath, config, notes = [] } = {}) {
  return {
    platform: 'win32',
    pwsh: found
      ? { found: true, path: pwshPath, source: 'detected', candidates: [] }
      : { found: false, candidates: [] },
    configPath: configFile(process.env),
    config,
    route: effectiveRoute(config),
    routeConfigured: Boolean(
      config !== undefined
      && config !== null
      && typeof config === 'object'
      && Object.prototype.hasOwnProperty.call(config, 'route'),
    ),
    notes,
  };
}

function noopRun() {
  return { ok: true, code: 0, stdout: '', stderr: '' };
}

function decodeScript(args) {
  return Buffer.from(args.at(-1), 'base64').toString('utf16le');
}

// ---------------------------------------------------------------------------
// Route config persistence
// ---------------------------------------------------------------------------

test('effectiveRoute defaults missing/unknown configs to plugin', () => {
  assert.equal(effectiveRoute(undefined), 'plugin');
  assert.equal(effectiveRoute(null), 'plugin');
  assert.equal(effectiveRoute({}), 'plugin');
  assert.equal(effectiveRoute({ route: 'bogus' }), 'plugin');
  assert.equal(effectiveRoute({ route: 'system' }), 'system');
  assert.equal(effectiveRoute({ route: 'plugin' }), 'plugin');
  assert.deepEqual([...ROUTE_MODES], ['plugin', 'system']);
});

test('writeRouteConfig is additive and routeInfo reports configured state', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const pwshPath = 'D:\\tools\\pwsh.exe';
  writeRouterConfig({
    version: 1,
    pwshPath,
    installed: { pwsh: { path: pwshPath, method: 'portable', scope: 'user', version: '7.6.7' } },
    legacyNote: 'keep me',
  }, env);

  const before = routeInfo(env);
  assert.equal(before.mode, 'plugin');
  assert.equal(before.configured, false);

  writeRouteConfig('system', env);
  const after = routeInfo(env);
  assert.equal(after.mode, 'system');
  assert.equal(after.configured, true);

  const stored = readRouterConfig(env);
  assert.equal(stored.route, 'system');
  assert.equal(stored.pwshPath, pwshPath);
  assert.equal(stored.installed.pwsh.version, '7.6.7');
  assert.equal(stored.legacyNote, 'keep me');
  assert.equal(stored.version, 1);

  writeRouteConfig('plugin', env);
  assert.equal(readRouterConfig(env).route, 'plugin');
  assert.throws(() => writeRouteConfig('auto', env), /unsupported route/);
});

test('routeInfo tolerates a missing or invalid config file', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  // absent
  assert.deepEqual(
    { mode: routeInfo(env).mode, configured: routeInfo(env).configured },
    { mode: 'plugin', configured: false },
  );
  // invalid JSON
  fs.mkdirSync(W.dirname(configFile(env)), { recursive: true });
  fs.writeFileSync(configFile(env), '{ not json', 'utf8');
  assert.equal(routeInfo(env).mode, 'plugin');
  assert.equal(routeInfo(env).configured, false);
  // valid JSON but no route key
  writeRouterConfig({ version: 1, pwshPath: 'D:\\x\\pwsh.exe' }, env);
  assert.equal(routeInfo(env).mode, 'plugin');
  assert.equal(routeInfo(env).configured, false);
});

// ---------------------------------------------------------------------------
// System-default resolution
// ---------------------------------------------------------------------------

test('resolveSystemPwsh follows the contract order', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const candidates = {
    programFiles: W.join(base, 'Program Files', 'PowerShell', '7', 'pwsh.exe'),
    programFilesX86: W.join(base, 'Program Files (x86)', 'PowerShell', '7', 'pwsh.exe'),
    localPrograms: W.join(base, 'localappdata', 'Programs', 'PowerShell', '7', 'pwsh.exe'),
    store: W.join(base, 'localappdata', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    pathBin: W.join(base, 'bin', 'pwsh.exe'),
    windowsPowerShell: W.join(base, 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  };
  assert.equal(resolveSystemPwsh(env), 'pwsh');

  writeFile(candidates.windowsPowerShell);
  assert.equal(resolveSystemPwsh(env), candidates.windowsPowerShell);
  writeFile(candidates.pathBin);
  assert.equal(resolveSystemPwsh(env), candidates.pathBin);
  writeFile(candidates.store);
  assert.equal(resolveSystemPwsh(env), candidates.store);
  writeFile(candidates.localPrograms);
  assert.equal(resolveSystemPwsh(env), candidates.localPrograms);
  writeFile(candidates.programFilesX86);
  assert.equal(resolveSystemPwsh(env), candidates.programFilesX86);
  writeFile(candidates.programFiles);
  assert.equal(resolveSystemPwsh(env), candidates.programFiles);
});

test('resolveSystemPwsh excludes plugin-root PATH entries and ignores DSH_PWSH_PATH/config', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const pluginPwsh = W.join(root, 'powershell7', '7.6.7', 'pwsh.exe');
  writeFile(pluginPwsh);
  env.DSH_PWSH_PATH = pluginPwsh;
  writeRouterConfig({ version: 1, route: 'system', pwshPath: pluginPwsh }, env);
  env.PATH = [W.join(root, 'powershell7', '7.6.7'), W.join(base, 'bin')].join(';');

  // The plugin-managed copy is present and on PATH, but it is excluded from the system route.
  assert.equal(resolveSystemPwsh(env), 'pwsh');
  const candidates = systemPwshCandidates(env);
  assert.ok(candidates.every((candidate) => !candidate.toLowerCase().startsWith(root.toLowerCase())));
  assert.ok(!candidates.includes(pluginPwsh));

  const systemPwsh = W.join(base, 'bin', 'pwsh.exe');
  writeFile(systemPwsh);
  assert.equal(resolveSystemPwsh(env), systemPwsh);
});

test('executor getter branch: declared path wins, then route-specific resolution', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const declared = 'D:\\declared\\pwsh.exe';
  assert.equal(resolveExecutorPwshPath(declared, {
    getState: () => ({ route: 'system' }),
    requirePath: () => 'C:\\plugin\\pwsh.exe',
  }), declared);

  const calls = [];
  const pluginPath = resolveExecutorPwshPath(undefined, {
    getState: () => ({ route: 'plugin' }),
    requirePath: () => {
      calls.push('plugin');
      return 'C:\\plugin\\pwsh.exe';
    },
    resolveSystem: () => {
      calls.push('system');
      return 'C:\\system\\powershell.exe';
    },
  });
  assert.equal(pluginPath, 'C:\\plugin\\pwsh.exe');
  assert.deepEqual(calls, ['plugin']);

  const systemPwsh = W.join(base, 'bin', 'pwsh.exe');
  writeFile(systemPwsh);
  env.DSH_PWSH_PATH = W.join(base, 'should-not-be-used.exe');
  const systemPath = resolveExecutorPwshPath(undefined, {
    env,
    getState: () => ({ route: 'system' }),
    requirePath: () => {
      throw new Error('plugin route must not be consulted');
    },
    resolveSystem: resolveSystemPwsh,
  });
  assert.equal(systemPath, systemPwsh);

  // A throwing state getter falls back to the plugin route.
  assert.equal(resolveExecutorPwshPath(undefined, {
    getState: () => {
      throw new Error('detection failed');
    },
    requirePath: () => 'C:\\plugin\\pwsh.exe',
  }), 'C:\\plugin\\pwsh.exe');
});

test('the executor module wires the route branch into the pwshPath getter', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'executors', 'pwsh.mjs'), 'utf8');
  assert.match(source, /get pwshPath\(\)/);
  assert.match(source, /resolveExecutorPwshPath/);
  assert.match(source, /getRouterState/);
  assert.match(source, /requirePwshPath/);
});

// ---------------------------------------------------------------------------
// describeInstall / extended state snapshot
// ---------------------------------------------------------------------------

test('describeInstall reports the plugin-managed per-user copy as removable', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const versionDir = W.join(root, 'powershell7', '7.6.7');
  const pwshExe = W.join(versionDir, 'pwsh.exe');
  writeFile(pwshExe);
  env.PATH = [versionDir, W.join(base, 'bin')].join(';');
  const config = {
    version: 1,
    route: 'plugin',
    pwshPath: pwshExe,
    installed: { pwsh: { path: pwshExe, method: 'portable', scope: 'user', version: '7.6.7' } },
  };
  writeRouterConfig(config, env);
  const state = fakeState({ found: true, pwshPath: pwshExe, config });

  const install = describeInstall({ env, root, state });
  assert.deepEqual(Object.keys(install).sort(), [
    'directory', 'exists', 'managed', 'method', 'path', 'pathEntry',
    'removable', 'scope', 'systemCopy', 'userCopy', 'version',
  ]);
  assert.equal(install.exists, true);
  assert.equal(install.managed, true);
  assert.equal(install.removable, true);
  assert.equal(install.scope, 'user');
  assert.equal(install.method, 'portable');
  assert.equal(install.version, '7.6.7');
  assert.equal(install.path, pwshExe);
  assert.equal(install.directory, versionDir);
  assert.equal(install.userCopy, true);
  assert.equal(install.systemCopy, false);
  assert.equal(install.pathEntry, true);

  // A system installation is not removable even if the plugin also has a stale per-user copy.
  const systemExe = W.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  writeFile(systemExe);
  const systemInstall = describeInstall({
    env,
    root,
    state: fakeState({
      found: true,
      pwshPath: systemExe,
      config: { version: 1, route: 'plugin', pwshPath: systemExe, installed: { pwsh: { path: systemExe, method: 'existing', scope: 'system' } } },
    }),
  });
  assert.equal(systemInstall.managed, false);
  assert.equal(systemInstall.removable, false);
  assert.equal(systemInstall.scope, 'system');
  assert.equal(systemInstall.systemCopy, true);
  assert.equal(systemInstall.userCopy, true);
});

test('the state snapshot exposes the v0.3.0 fields', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const service = createSetupService({
    env,
    detect: () => fakeState({ config: readRouterConfig(env) }),
    probeElevation: async () => false,
    refresh: async () => {},
  });
  t.after(() => service.dispose());
  await service.refreshElevation();

  const snapshot = service.snapshot();
  assert.equal(typeof snapshot.pluginVersion, 'string');
  assert.match(snapshot.pluginVersion, /^\d+\.\d+\.\d+/);
  assert.equal(snapshot.route, 'plugin');
  assert.equal(snapshot.routeConfigured, false);
  assert.equal(typeof snapshot.systemPath, 'string');
  assert.ok(snapshot.systemPath.length > 0);
  assert.deepEqual(Object.keys(snapshot.install).sort(), [
    'directory', 'exists', 'managed', 'method', 'path', 'pathEntry',
    'removable', 'scope', 'systemCopy', 'userCopy', 'version',
  ]);
  assert.equal(snapshot.install.exists, false);
  assert.deepEqual(snapshot.elevation, { available: false, requiredForSystem: true });
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.relocate, null);

  await service.setRoute('system');
  const routed = service.snapshot();
  assert.equal(routed.route, 'system');
  assert.equal(routed.routeConfigured, true);
  assert.equal(readRouterConfig(env).route, 'system');
  assert.equal(pluginVersion(), snapshot.pluginVersion);
});

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

test('uninstall refuses a system or non-managed installation', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const systemExe = W.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  writeFile(systemExe);
  writeRouterConfig({
    version: 1,
    pwshPath: systemExe,
    installed: { pwsh: { path: systemExe, method: 'portable', scope: 'system', version: '7.6.7' } },
  }, env);

  const service = createSetupService({
    env,
    detect: () => fakeState({
      found: true,
      pwshPath: systemExe,
      config: readRouterConfig(env),
    }),
    probeElevation: async () => false,
    refresh: async () => {},
    install: async () => assert.fail('uninstall must not start an install'),
  });
  t.after(() => service.dispose());

  const outcome = await service.uninstall();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, true);
  assert.match(outcome.error, /not a plugin-managed per-user copy/);
  assert.equal(fs.existsSync(systemExe), true);
});

test('uninstall removes the per-user copy, PATH entries, and stale config keys', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const versionDir = W.join(root, 'powershell7', '7.6.7');
  const pwshExe = W.join(versionDir, 'pwsh.exe');
  const tmpDir = W.join(root, 'tmp');
  writeFile(pwshExe);
  writeFile(W.join(tmpDir, 'PowerShell-7.6.7-win-x64.zip'));
  writeRouterConfig({
    version: 1,
    route: 'system',
    pwshPath: pwshExe,
    installed: { pwsh: { path: pwshExe, method: 'portable', scope: 'user', version: '7.6.7' } },
  }, env);
  env.PATH = [versionDir, W.join(base, 'bin'), tmpDir].join(';');

  const scripts = [];
  const run = async (executable, args) => {
    scripts.push({ executable, args });
    return noopRun();
  };
  const service = createSetupService({
    env,
    detect: () => fakeState({ found: false, config: readRouterConfig(env) }),
    probeElevation: async () => false,
    refresh: async () => {},
  });
  t.after(() => service.dispose());

  const outcome = await service.uninstall({ run });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.warnings, []);
  assert.ok(outcome.removed.includes(versionDir), `removed: ${outcome.removed.join(', ')}`);
  assert.ok(outcome.removed.includes(tmpDir), `removed: ${outcome.removed.join(', ')}`);
  assert.equal(fs.existsSync(versionDir), false);
  assert.equal(fs.existsSync(tmpDir), false);
  assert.deepEqual(discoveredPortablePwshPaths(env), []);

  // PATH: the plugin-root entries are gone, unrelated entries remain (process env).
  const pathValue = env.PATH.toLowerCase();
  assert.ok(!pathValue.includes(versionDir.toLowerCase()));
  assert.ok(!pathValue.includes(tmpDir.toLowerCase()));
  assert.ok(env.PATH.includes(W.join(base, 'bin')));

  // Persisted PATH: user hive, preserved value kind/raw value, broadcast.
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].executable.endsWith('WindowsPowerShell\\v1.0\\powershell.exe'));
  const script = decodeScript(scripts[0].args);
  assert.match(script, /Registry\]::CurrentUser/);
  assert.match(script, /GetValueKind\('Path'\)/);
  assert.match(script, /DoNotExpandEnvironmentNames/);
  assert.match(script, /SendMessageTimeout/);
  assert.ok(script.includes(root.replaceAll("'", "''")));

  // Config keeps only the route (other keys dropped, route preserved).
  const stored = readRouterConfig(env);
  assert.equal(stored.route, 'system');
  assert.equal(stored.pwshPath, undefined);
  assert.equal(stored.installed, undefined);
});

test('uninstall never reports ok while the executable is still installed', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const versionDir = W.join(root, 'powershell7', '7.6.7');
  const pwshExe = W.join(versionDir, 'pwsh.exe');
  writeFile(pwshExe);
  writeRouterConfig({
    version: 1,
    pwshPath: pwshExe,
    installed: { pwsh: { path: pwshExe, method: 'portable', scope: 'user', version: '7.6.7' } },
  }, env);

  const removeDir = (target) => {
    if (target === versionDir) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    fs.rmSync(target, { recursive: true, force: true });
  };
  const service = createSetupService({
    env,
    detect: () => fakeState({ found: false, config: readRouterConfig(env) }),
    probeElevation: async () => false,
    refresh: async () => {},
  });
  t.after(() => service.dispose());

  const outcome = await service.uninstall({ run: async () => noopRun(), removeDir });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.warnings.some((warning) => /EBUSY/.test(warning)));
  assert.equal(fs.existsSync(pwshExe), true);
});

test('uninstall refuses to follow a junction at <root>\\powershell7', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const outside = W.join(base, 'outside');
  const precious = W.join(outside, 'unrelated', 'precious.txt');
  writeFile(precious, 'keep me');
  fs.mkdirSync(root, { recursive: true });
  const slot = W.join(root, 'powershell7');
  try {
    fs.symlinkSync(outside, slot, 'junction');
  } catch (error) {
    t.skip(`junction unavailable: ${error?.code ?? error}`);
    return;
  }

  const outcome = await removeManagedUserInstall({
    env,
    root,
    removePathEntries: async () => [],
    run: async () => noopRun(),
  });
  assert.equal(outcome.ok, false);
  assert.equal(fs.existsSync(precious), true, 'cleanup followed the junction and deleted outside files');
  assert.ok(outcome.warnings.some((warning) => /reparse point/.test(warning)));
});

test('uninstall unlinks a version-directory junction instead of deleting its target', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const outside = W.join(base, 'outside-version');
  const precious = W.join(outside, 'user-data.txt');
  writeFile(precious, 'keep me');
  const slot = W.join(root, 'powershell7', '7.6.7');
  fs.mkdirSync(W.dirname(slot), { recursive: true });
  try {
    fs.symlinkSync(outside, slot, 'junction');
  } catch (error) {
    t.skip(`junction unavailable: ${error?.code ?? error}`);
    return;
  }

  const outcome = await removeManagedUserInstall({
    env,
    root,
    removePathEntries: async () => [],
    run: async () => noopRun(),
  });
  assert.equal(outcome.ok, true);
  assert.equal(fs.existsSync(precious), true, 'cleanup followed the version-directory junction');
  assert.equal(fs.existsSync(slot), false, 'the junction itself should be removed');
});

test('uninstall removes a legacy powershell7\\pwsh.exe and reports leftovers honestly', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const legacyExe = W.join(root, 'powershell7', 'pwsh.exe');
  writeFile(legacyExe);
  writeRouterConfig({
    version: 1,
    pwshPath: legacyExe,
    installed: { pwsh: { path: legacyExe, method: 'portable', scope: 'user', version: '7.6.7' } },
  }, env);

  const outcome = await removeManagedUserInstall({
    env,
    root,
    removePathEntries: async () => [],
    run: async () => noopRun(),
  });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.removed.includes(legacyExe), `removed: ${outcome.removed.join(', ')}`);
  assert.equal(fs.existsSync(legacyExe), false);
});

test('describeInstall ignores a version directory without pwsh.exe', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  fs.mkdirSync(W.join(root, 'powershell7', '9.9.9'), { recursive: true });

  const info = describeInstall({ env, root });
  assert.equal(info.exists, false);
  assert.equal(info.userCopy, false);
  assert.equal(info.removable, false);
  assert.equal(info.path, null);
});

// ---------------------------------------------------------------------------
// Single-owner coordinator
// ---------------------------------------------------------------------------

test('an install and a maintenance operation cannot run at the same time', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const versionDir = W.join(root, 'powershell7', '7.6.7');
  const pwshExe = W.join(versionDir, 'pwsh.exe');
  writeFile(pwshExe);
  writeRouterConfig({
    version: 1,
    pwshPath: pwshExe,
    installed: { pwsh: { path: pwshExe, method: 'portable', scope: 'user', version: '7.6.7' } },
  }, env);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createSetupService({
    env,
    detect: () => fakeState({ found: false, config: readRouterConfig(env) }),
    probeElevation: async () => false,
    refresh: async () => {},
    removeDir: (target) => fs.rmSync(target, { recursive: true, force: true }),
    removePathEntries: async () => {
      await gate;
      return [];
    },
    run: async () => noopRun(),
  });
  t.after(() => service.dispose());

  const uninstall = service.uninstall();
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  const started = service.start('auto', 'user');
  assert.equal(started.started, false);
  assert.equal(started.busy, true);

  const handlers = createSetupHandlers(service);
  const refused = makeResponse();
  await handlers.install(postJson('/pwsh7/install', { method: 'auto', scope: 'user' }), refused);
  assert.equal(refused.statusCode, 409);

  release();
  const outcome = await uninstall;
  assert.equal(outcome.ok, true);
});

// ---------------------------------------------------------------------------
// Relocate
// ---------------------------------------------------------------------------

test('relocate preflights elevation and starts nothing when unelevated', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  let installCalls = 0;
  const service = createSetupService({
    env,
    detect: () => fakeState({ found: false }),
    probeElevation: async () => false,
    refresh: async () => {},
    install: async () => {
      installCalls += 1;
      return { ok: true, result: { ok: true } };
    },
    requireAdministrator: async () => {
      throw new Error('System installation requires administrator rights. Run the DSH host as administrator and retry.');
    },
  });
  t.after(() => service.dispose());

  const outcome = await service.relocate({ method: 'auto' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.requiresElevation, true);
  assert.match(outcome.error, /administrator rights/);
  assert.match(outcome.hint, /administrator/i);
  assert.equal(installCalls, 0);
  assert.equal(service.running, false);
  assert.equal(service.snapshot().phase, 'idle');
});

test('relocate installs to system scope, removes the user copy, and forces the plugin route', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const userVersionDir = W.join(root, 'powershell7', '7.6.7');
  const userExe = W.join(userVersionDir, 'pwsh.exe');
  const systemExe = W.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  writeFile(userExe);
  writeRouterConfig({
    version: 1,
    route: 'system',
    pwshPath: userExe,
    installed: { pwsh: { path: userExe, method: 'portable', scope: 'user', version: '7.6.7' } },
  }, env);

  const order = [];
  let found = false;
  const install = async ({ scope }) => {
    order.push(`install:${scope}`);
    writeFile(systemExe);
    found = true;
    const current = readRouterConfig(env) ?? {};
    writeRouterConfig({
      ...current,
      pwshPath: systemExe,
      installed: { pwsh: { path: systemExe, method: 'portable', scope: 'system', version: '7.6.7' } },
    }, env);
    return {
      ok: true,
      result: { ok: true, scope, method: 'portable', path: systemExe, version: '7.6.7' },
    };
  };
  const removeDir = (target) => {
    order.push(`remove:${target}`);
    fs.rmSync(target, { recursive: true, force: true });
  };
  const removePathEntries = async () => {
    order.push('path-cleanup');
    return [];
  };
  const service = createSetupService({
    env,
    detect: () => fakeState({
      found,
      pwshPath: found ? systemExe : undefined,
      config: readRouterConfig(env),
    }),
    probeElevation: async () => true,
    refresh: async () => {},
    install,
    removeDir,
    removePathEntries,
    requireAdministrator: async () => {
      order.push('preflight');
    },
  });
  t.after(() => service.dispose());

  const outcome = await service.relocate({ method: 'auto' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.started, true);
  assert.equal(order[0], 'preflight');

  const final = await service.waitForIdle(5000);
  assert.equal(final.phase, 'done');
  assert.ok(order.includes('install:system'));
  assert.ok(order.indexOf('path-cleanup') > order.indexOf('install:system'));
  assert.equal(fs.existsSync(userExe), false);
  assert.equal(fs.existsSync(systemExe), true);
  assert.equal(final.relocate.ok, true);
  assert.equal(final.relocate.relocated, true);
  assert.equal(final.relocate.systemPath, systemExe);
  assert.ok(final.relocate.removedUserCopy.includes(userVersionDir));
  assert.deepEqual(final.relocate.warnings, []);

  const stored = readRouterConfig(env);
  assert.equal(stored.route, 'plugin');
  assert.equal(stored.installed.pwsh.path, systemExe);
  assert.equal(stored.installed.pwsh.scope, 'system');
});

test('relocate keeps the user copy when removeUser is false', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const userVersionDir = W.join(root, 'powershell7', '7.6.7');
  const userExe = W.join(userVersionDir, 'pwsh.exe');
  const systemExe = W.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  writeFile(userExe);

  const service = createSetupService({
    env,
    detect: () => fakeState({ found: false, config: readRouterConfig(env) }),
    probeElevation: async () => true,
    refresh: async () => {},
    install: async ({ scope }) => {
      writeFile(systemExe);
      return { ok: true, result: { ok: true, scope, method: 'portable', path: systemExe, version: '7.6.7' } };
    },
    removeDir: (target) => fs.rmSync(target, { recursive: true, force: true }),
    removePathEntries: async () => [],
    requireAdministrator: async () => {},
  });
  t.after(() => service.dispose());

  const outcome = await service.relocate({ method: 'auto', removeUser: false });
  assert.equal(outcome.ok, true);
  const final = await service.waitForIdle(5000);
  assert.equal(final.relocate.relocated, true);
  assert.deepEqual(final.relocate.removedUserCopy, []);
  assert.equal(fs.existsSync(userExe), true);
});

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

function fullRoutes() {
  return Object.values(SETUP_ROUTES);
}

function installInfoFor(env) {
  return describeInstall({ env, root: routerRoot(env) });
}

test('selfcheck reports failures when PowerShell 7 is missing', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const result = await runSelfcheck({
    env,
    root: routerRoot(env),
    state: fakeState({ found: false }),
    install: installInfoFor(env),
    routes: fullRoutes(),
    job: { busy: false, phase: 'idle', error: null },
    probe: async () => {
      throw new Error('must not probe a missing executable');
    },
    describeShipped: () => ({ ok: true, appRoot: 'C:\\dsh' }),
  });

  assert.equal(result.ok, false);
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(result.checks.map((check) => check.id), [...SELFCHECK_IDS]);
  const byId = Object.fromEntries(result.checks.map((check) => [check.id, check.status]));
  assert.equal(byId.executable, 'fail');
  assert.equal(byId.version, 'fail');
  assert.equal(byId.install, 'warn');
  assert.equal(byId.config, 'ok');
  assert.equal(byId.shipped, 'ok');
  assert.equal(byId.sandbox, 'warn');
  assert.equal(byId.routes, 'ok');
  assert.equal(result.summary.fail, 2);
  assert.equal(result.summary.ok + result.summary.warn + result.summary.fail, SELFCHECK_IDS.length);
});

test('selfcheck warns when the system route falls back to Windows PowerShell 5.1', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const windowsPowerShell = W.join(base, 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  writeFile(windowsPowerShell);
  const config = { version: 1, route: 'system' };
  const result = await runSelfcheck({
    env,
    root: routerRoot(env),
    state: fakeState({ found: false, config }),
    install: installInfoFor(env),
    routes: fullRoutes(),
    probe: async () => ({ ok: false, version: '5.1.19041.1', output: '5.1.19041.1' }),
    describeShipped: () => ({ ok: true }),
  });

  const byId = Object.fromEntries(result.checks.map((check) => [check.id, check.status]));
  assert.equal(byId.executable, 'warn');
  assert.equal(byId.version, 'warn');
  const version = result.checks.find((check) => check.id === 'version');
  assert.match(version.detail, /5\.1/);
  assert.match(version.detail, /Windows PowerShell 5\.1/);
});

test('selfcheck fails the shipped-packages check when they cannot be loaded', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const result = await runSelfcheck({
    env,
    root: routerRoot(env),
    state: fakeState({ found: false }),
    install: installInfoFor(env),
    routes: fullRoutes(),
    describeShipped: () => ({ ok: false, error: 'ERR_MODULE_NOT_FOUND' }),
  });

  const shipped = result.checks.find((check) => check.id === 'shipped');
  assert.equal(shipped.status, 'fail');
  assert.match(shipped.detail, /ERR_MODULE_NOT_FOUND/);
  assert.equal(result.ok, false);
});

test('selfcheck is fully green on a healthy plugin-managed install', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const versionDir = W.join(root, 'powershell7', '7.6.7');
  const pwshExe = W.join(versionDir, 'pwsh.exe');
  writeFile(pwshExe);
  env.PATH = [versionDir, W.join(base, 'bin')].join(';');
  const config = {
    version: 1,
    pwshPath: pwshExe,
    installed: { pwsh: { path: pwshExe, method: 'portable', scope: 'user', version: '7.6.7' } },
  };
  writeRouterConfig(config, env);
  const state = fakeState({ found: true, pwshPath: pwshExe, config });
  const ctx = {
    get(name) {
      if (name !== 'sandboxPolicy') return undefined;
      return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'C:\\workspace' }) };
    },
  };

  const result = await runSelfcheck({
    env,
    root,
    state,
    install: installInfoFor(env),
    routes: fullRoutes(),
    job: { busy: false, phase: 'idle', error: null },
    ctx,
    probe: async (executable) => {
      assert.equal(executable, pwshExe);
      return { ok: true, version: '7.6.7', output: '7.6.7' };
    },
    describeShipped: () => ({ ok: true, appRoot: 'C:\\dsh' }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { ok: SELFCHECK_IDS.length, warn: 0, fail: 0 });
  for (const check of result.checks) assert.equal(check.status, 'ok', `${check.id}: ${check.detail}`);
});

// ---------------------------------------------------------------------------
// Self-check honesty
// ---------------------------------------------------------------------------

test('selfcheck reports unreported routes and a broken sandbox service', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const state = fakeState({ found: false });
  const common = {
    env,
    root,
    state,
    install: describeInstall({ env, root, state }),
    job: { busy: false, phase: 'idle', error: null },
    probe: async () => ({ ok: false, version: undefined, output: 'no pwsh' }),
    describeShipped: () => ({ ok: true }),
  };

  const unreported = await runSelfcheck({ ...common, routes: undefined, ctx: { get: () => ({}) } });
  const unreportedById = Object.fromEntries(unreported.checks.map((check) => [check.id, check]));
  assert.equal(unreportedById.routes.status, 'warn');
  assert.match(unreportedById.routes.detail, /did not report/);
  assert.equal(unreportedById.sandbox.status, 'warn');
  assert.match(unreportedById.sandbox.detail, /resolve/);

  const missingRoute = await runSelfcheck({
    ...common,
    routes: fullRoutes().filter((path) => path !== SETUP_ROUTES.relocate),
    ctx: {
      get: () => ({
        resolve() {
          throw new Error('policy unavailable');
        },
      }),
    },
  });
  const missingById = Object.fromEntries(missingRoute.checks.map((check) => [check.id, check]));
  assert.equal(missingById.routes.status, 'fail');
  assert.match(missingById.routes.detail, /missing routes/);
  assert.equal(missingById.sandbox.status, 'warn');
  assert.match(missingById.sandbox.detail, /policy unavailable/);
  assert.equal(missingRoute.ok, false);
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function makeRequest({ method = 'GET', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method;
  req.headers = { host: '127.0.0.1:14630', ...headers };
  return req;
}

function makeResponse() {
  const chunks = [];
  let ended = false;
  return {
    statusCode: 0,
    headers: {},
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    flushHeaders() {},
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
      ended = true;
    },
    on() {},
    get ended() {
      return ended;
    },
    text() {
      return chunks.join('');
    },
    json() {
      return JSON.parse(this.text());
    },
  };
}

function postJson(path, body, headers = {}) {
  return makeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function makeSettingsService(t, env, overrides = {}) {
  const service = createSetupService({
    env,
    detect: () => fakeState({ found: false, config: readRouterConfig(env) }),
    probeElevation: async () => false,
    refresh: async () => {},
    install: async ({ scope }) => ({
      ok: true,
      result: { ok: true, scope, method: 'portable', version: '7.6.7' },
    }),
    requireAdministrator: async () => {},
    removePathEntries: async () => [],
    probe: async () => ({ ok: false, version: undefined, output: 'no pwsh' }),
    describeShipped: () => ({ ok: true }),
    ...overrides,
  });
  t.after(() => service.dispose());
  return service;
}

test('POST bodies larger than the limit are rejected with 413', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const service = makeSettingsService(t, env);
  const handlers = createSetupHandlers(service);
  const res = makeResponse();
  await handlers.route(makeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(5000),
  }), res);
  assert.equal(res.statusCode, 413);
  assert.match(res.json().error, /too large/);
});

test('GET /pwsh7/state returns the extended snapshot', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const service = makeSettingsService(t, env);
  await service.refreshElevation();
  const handlers = createSetupHandlers(service);
  const res = makeResponse();
  await handlers.state(makeRequest({ method: 'GET' }), res);

  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.equal(payload.route, 'plugin');
  assert.equal(payload.routeConfigured, false);
  assert.equal(typeof payload.pluginVersion, 'string');
  assert.equal(typeof payload.systemPath, 'string');
  assert.equal(payload.install.exists, false);
  assert.equal(payload.install.removable, false);
  assert.deepEqual(payload.elevation, { available: false, requiredForSystem: true });
  assert.equal(payload.busy, false);
});

test('POST /pwsh7/route rejects bad requests and persists a valid mode', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const service = makeSettingsService(t, env);
  await service.refreshElevation();
  const handlers = createSetupHandlers(service);

  const getRes = makeResponse();
  await handlers.route(makeRequest({ method: 'GET' }), getRes);
  assert.equal(getRes.statusCode, 405);

  const crossRes = makeResponse();
  await handlers.route(postJson('/pwsh7/route', { mode: 'system' }, { origin: 'https://evil.example' }), crossRes);
  assert.equal(crossRes.statusCode, 403);

  const typeRes = makeResponse();
  await handlers.route(makeRequest({
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ mode: 'system' }),
  }), typeRes);
  assert.equal(typeRes.statusCode, 415);

  const invalidRes = makeResponse();
  await handlers.route(postJson('/pwsh7/route', { mode: 'auto' }), invalidRes);
  assert.equal(invalidRes.statusCode, 400);

  const okRes = makeResponse();
  await handlers.route(postJson('/pwsh7/route', { mode: 'system' }), okRes);
  assert.equal(okRes.statusCode, 200);
  const payload = okRes.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.state.route, 'system');
  assert.equal(readRouterConfig(env).route, 'system');
});

test('POST /pwsh7/uninstall validates confirm/scope and refuses non-managed installs', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const service = makeSettingsService(t, env);
  const handlers = createSetupHandlers(service);

  const missingConfirm = makeResponse();
  await handlers.uninstall(postJson('/pwsh7/uninstall', {}), missingConfirm);
  assert.equal(missingConfirm.statusCode, 400);

  const badScope = makeResponse();
  await handlers.uninstall(postJson('/pwsh7/uninstall', { confirm: true, scope: 'system' }), badScope);
  assert.equal(badScope.statusCode, 400);

  // Nothing installed → refused with 400.
  const refused = makeResponse();
  await handlers.uninstall(postJson('/pwsh7/uninstall', { confirm: true }), refused);
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /per-user/);
});

test('POST /pwsh7/uninstall removes a managed per-user copy (HTTP 200)', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const versionDir = W.join(root, 'powershell7', '7.6.7');
  const pwshExe = W.join(versionDir, 'pwsh.exe');
  writeFile(pwshExe);
  writeRouterConfig({
    version: 1,
    pwshPath: pwshExe,
    installed: { pwsh: { path: pwshExe, method: 'portable', scope: 'user', version: '7.6.7' } },
  }, env);
  const service = makeSettingsService(t, env);
  const handlers = createSetupHandlers(service);

  const res = makeResponse();
  await handlers.uninstall(postJson('/pwsh7/uninstall', { confirm: true, scope: 'user' }), res);
  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.ok(payload.removed.includes(versionDir));
  assert.deepEqual(payload.warnings, []);
  assert.equal(payload.state.install.exists, false);
});

test('POST /pwsh7/uninstall reports locked files with ok:false and warnings (HTTP 200)', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const root = routerRoot(env);
  const versionDir = W.join(root, 'powershell7', '7.6.7');
  const pwshExe = W.join(versionDir, 'pwsh.exe');
  writeFile(pwshExe);
  writeRouterConfig({
    version: 1,
    pwshPath: pwshExe,
    installed: { pwsh: { path: pwshExe, method: 'portable', scope: 'user', version: '7.6.7' } },
  }, env);
  const service = makeSettingsService(t, env, {
    removeDir: (target) => {
      if (target === versionDir) throw new Error('EBUSY: resource busy or locked');
      fs.rmSync(target, { recursive: true, force: true });
    },
  });
  const handlers = createSetupHandlers(service);

  const res = makeResponse();
  await handlers.uninstall(postJson('/pwsh7/uninstall', { confirm: true }), res);
  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.equal(payload.ok, false);
  assert.match(payload.error, /could not be fully removed/);
  assert.ok(payload.warnings.some((warning) => /EBUSY/.test(warning)));
  assert.equal(payload.state.install.exists, true);
});

test('POST /pwsh7/relocate returns 412 when unelevated and 202 when elevated', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  let installs = 0;
  const elevateOnDemand = { value: false };
  const service = makeSettingsService(t, env, {
    install: async ({ scope }) => {
      installs += 1;
      return { ok: true, result: { ok: true, scope, method: 'portable', version: '7.6.7' } };
    },
    requireAdministrator: async () => {
      if (!elevateOnDemand.value) throw new Error('System installation requires administrator rights.');
    },
  });
  const handlers = createSetupHandlers(service);

  const unelevated = makeResponse();
  await handlers.relocate(postJson('/pwsh7/relocate', { method: 'auto' }), unelevated);
  assert.equal(unelevated.statusCode, 412);
  const payload = unelevated.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.requiresElevation, true);
  assert.match(payload.error, /administrator rights/);
  assert.match(payload.hint, /elevated/i);
  assert.equal(installs, 0);
  assert.equal(service.running, false);

  elevateOnDemand.value = true;
  const started = makeResponse();
  await handlers.relocate(postJson('/pwsh7/relocate', { method: 'auto' }), started);
  assert.equal(started.statusCode, 202);
  assert.equal(started.json().started, true);
  await service.waitForIdle(5000);
  assert.equal(installs, 1);
});

test('maintenance routes return 409 while an install job is running', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  let release;
  const service = makeSettingsService(t, env, {
    install: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false, aborted: true, result: { ok: false } }), { once: true });
      release = () => resolve({ ok: true, result: { ok: true, method: 'portable', version: '7.6.7' } });
    }),
  });
  const handlers = createSetupHandlers(service);

  service.start('auto');
  const uninstallRes = makeResponse();
  await handlers.uninstall(postJson('/pwsh7/uninstall', { confirm: true }), uninstallRes);
  assert.equal(uninstallRes.statusCode, 409);

  const relocateRes = makeResponse();
  await handlers.relocate(postJson('/pwsh7/relocate', {}), relocateRes);
  assert.equal(relocateRes.statusCode, 409);

  service.cancel();
  await service.wait();
  assert.equal(typeof release, 'function');
});

test('POST /pwsh7/selfcheck always answers a structured 200', async (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const service = makeSettingsService(t, env, {
    describeShipped: () => ({ ok: false, error: 'unavailable in the test sandbox' }),
  });
  const handlers = createSetupHandlers(service);

  const res = makeResponse();
  await handlers.selfcheck(postJson('/pwsh7/selfcheck', {}), res);
  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.equal(typeof payload.ok, 'boolean');
  assert.deepEqual(payload.checks.map((check) => check.id), [...SELFCHECK_IDS]);
  assert.equal(payload.summary.ok + payload.summary.warn + payload.summary.fail, SELFCHECK_IDS.length);
  const shipped = payload.checks.find((check) => check.id === 'shipped');
  assert.equal(shipped.status, 'fail');

  const wrongType = makeResponse();
  await handlers.selfcheck(makeRequest({
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  }), wrongType);
  assert.equal(wrongType.statusCode, 415);
});

test('the setup/maintenance route table has eight exact routes', (t) => {
  const base = makeTemp(t);
  const env = makeEnv(base);
  const service = createSetupService({
    env,
    detect: () => fakeState({ found: false }),
    probeElevation: async () => false,
    refresh: async () => {},
  });
  t.after(() => service.dispose());
  const handlers = createSetupHandlers(service);
  const rows = setupRouteRows(handlers);
  assert.deepEqual(rows.map((row) => row.path), Object.values(SETUP_ROUTES));
  assert.ok(rows.every((row) => row.kind === 'exact'));
});
