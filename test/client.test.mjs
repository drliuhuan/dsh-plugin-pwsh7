// test/client.test.mjs — the browser half's packaging and render contract.
//
// DSH only serves a plugin's client bundle when `package.json` declares `dsh.client` and exports
// `./client`; a typo there is a dialog that never appears, with no host error. These checks are the
// cheap guard for that failure mode, plus a syntax check of the classic script and render smoke
// tests for both surfaces: the v0.2 setup dialog and the v0.3 Settings page.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CLIENT_SOURCE = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');

/** Self-check ids the host reports; each title comes from `selfcheck.<id>`. */
const SELFCHECK_IDS = [
  'plugin-version', 'route', 'executable', 'version', 'config', 'install',
  'path-env', 'shipped', 'sandbox', 'install-job', 'routes',
];

/** Settings-page copy that must exist in BOTH dictionaries. */
const SETTINGS_KEYS = [
  'settingsNav', 'settingsTitle', 'settingsSubtitle', 'loading', 'loadFailed', 'notInstalled',
  'statusReady', 'statusReadyNoVersion', 'sectionInstall', 'sectionRoute', 'sectionActions',
  'labelPsVersion', 'labelPath', 'labelDirectory', 'labelScope', 'labelMethod', 'labelConfig',
  'labelManaged', 'labelRemovable', 'labelUserCopy', 'labelSystemCopy', 'labelPathEntry',
  'yes', 'no', 'unknown', 'scopeUser', 'scopeSystem', 'methodPortable', 'methodWinget',
  'methodAuto', 'methodExisting', 'installedNone', 'routePlugin', 'routeSystem', 'routePluginHint',
  'routeSystemHint', 'routeSystemPath', 'routeSystemMissing', 'routeSaving', 'routeSaved',
  'actionInstall', 'actionInstallHint', 'actionRelocate', 'actionRelocateHint', 'relocateConfirm',
  'relocateConfirmButton', 'relocateStarted', 'relocateDone', 'relocateDoneNoPath',
  'relocateRemoved', 'relocateFailed', 'actionUninstall', 'actionUninstallHint',
  'uninstallConfirm', 'uninstallConfirmButton', 'uninstallDone', 'uninstallWarnings',
  'actionFailed', 'elevationRequired', 'elevationHint', 'busyJob', 'selfcheckRun',
  'selfcheckRunning', 'selfcheckSummary', 'selfcheckAt', 'selfcheckEmpty', 'statusWarn',
  'statusFail', 'confirmCancel',
  ...SELFCHECK_IDS.map((id) => `selfcheck.${id}`),
];

// ---------------------------------------------------------------------------
// Static packaging checks
// ---------------------------------------------------------------------------

test('package.json declares the Web client artifact and ships it', () => {
  assert.equal(PACKAGE.dsh.client.platform, 'web');
  assert.equal(PACKAGE.dsh.client.immediately, true);
  assert.ok(PACKAGE.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'));
  assert.equal(PACKAGE.exports['./client'], './client.js');
  assert.ok(PACKAGE.files.includes('client.js'));
  assert.ok(PACKAGE.files.includes('lib'));
});

test('index.js installs the routing features on the bare package row', () => {
  const source = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.match(source, /import \{ installRouterFeatures \} from '\.\/lib\/router-features\.mjs'/);
  assert.match(source, /installRouterFeatures\(ctx\)/);
});

test('the bundle patch keeps the bare package row that owns the client bundle', () => {
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  const names = [...patch.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(names, ['dsh-plugin-pwsh7/pwsh-executor', 'dsh-plugin-pwsh7']);
  // DSH's scanner only accepts a bare specifier as a client source; the subpath row is skipped.
  assert.ok(names.includes('dsh-plugin-pwsh7'));
  assert.ok(names.includes('dsh-plugin-pwsh7/pwsh-executor'));
  // DSH patch semantics: `name` on an id-targeted entry asserts the row, it does not rename it.
  // The stock executor is disabled and the router executor is inserted under its own id.
  assert.match(patch, /- id: pwsh-sandbox\r?\n\s+disabled: true/);
  assert.match(patch, /- id: pwsh7-executor\r?\n\s+name: 'dsh-plugin-pwsh7\/pwsh-executor'/);
});

test('client.js is a valid classic script', () => {
  // Compile without executing: the bundle needs `window.__ModuleLoader__`, which this test has
  // no business faking, but a syntax error must fail here rather than silently in the browser.
  assert.doesNotThrow(() => new vm.Script(CLIENT_SOURCE, { filename: 'client.js' }));
});

test('the bundle registers exactly one loader entry under the package name', () => {
  assert.match(CLIENT_SOURCE, /window\.__ModuleLoader__\.load\(/);
  assert.match(CLIENT_SOURCE, /id: PLUGIN_ID/);
  assert.match(CLIENT_SOURCE, /var PLUGIN_ID = 'dsh-plugin-pwsh7'/);
  assert.equal((CLIENT_SOURCE.match(/__ModuleLoader__\.load\(/g) || []).length, 1);
  // One factory, and the client services it injects are exactly the two it uses.
  assert.equal((CLIENT_SOURCE.match(/factory: function \(require\)/g) || []).length, 1);
  assert.match(CLIENT_SOURCE, /inject: \['slots', 'locale'\]/);
});

test('the client registers the setup dialog into the shell overlay slot', () => {
  assert.match(CLIENT_SOURCE, /ctx\.slots\.inject\('shell\.overlay'/);
  assert.match(CLIENT_SOURCE, /name: 'shell\.overlay'/);
  assert.match(CLIENT_SOURCE, /locale: LOCALE_NS/);
});

test('the setup dialog keeps its four routes and streams progress', () => {
  assert.match(CLIENT_SOURCE, /var ROUTE_STATE = '\/pwsh7\/state'/);
  assert.match(CLIENT_SOURCE, /var ROUTE_EVENTS = '\/pwsh7\/events'/);
  assert.match(CLIENT_SOURCE, /var ROUTE_INSTALL = '\/pwsh7\/install'/);
  assert.match(CLIENT_SOURCE, /var ROUTE_CANCEL = '\/pwsh7\/cancel'/);
  assert.match(CLIENT_SOURCE, /new EventSource\(ROUTE_EVENTS\)/);
  assert.match(CLIENT_SOURCE, /missingSeq/);
  assert.match(CLIENT_SOURCE, /setInterval\(refresh, POLL_MS\)/);
});

test('the settings page is registered as a settings.section for pwsh7', () => {
  assert.match(CLIENT_SOURCE, /ctx\.slots\.inject\('settings\.section'/);
  assert.match(CLIENT_SOURCE, /name: 'settings\.section'/);
  assert.match(CLIENT_SOURCE, /id: 'pwsh7'/);
  assert.match(CLIENT_SOURCE, /order: 80/);
  // The nav row and the page's `t` come from the same bound translator.
  assert.match(CLIENT_SOURCE, /label: function \(\) \{ return translate\('settingsNav'\); \}/);
  assert.match(CLIENT_SOURCE, /inject: function \(\) \{ return \{ t: translate \}; \}/);

  const { registrations, dictionaries } = boot();
  const entry = registrations.find((candidate) => candidate.options.name === 'settings.section');
  assert.ok(entry, 'settings.section was registered');
  assert.equal(entry.options.id, 'pwsh7');
  assert.equal(entry.options.order, 80);
  assert.equal(entry.options.locale, 'pwsh7');
  assert.equal(entry.options.label(), dictionaries.en.settingsNav);
  assert.equal(typeof entry.options.inject().t, 'function');
  assert.equal(entry.options.inject().t('routePlugin'), dictionaries.en.routePlugin);
});

test('the settings page talks to every v0.3 maintenance route', () => {
  assert.match(CLIENT_SOURCE, /var ROUTE_ROUTE = '\/pwsh7\/route'/);
  assert.match(CLIENT_SOURCE, /var ROUTE_UNINSTALL = '\/pwsh7\/uninstall'/);
  assert.match(CLIENT_SOURCE, /var ROUTE_RELOCATE = '\/pwsh7\/relocate'/);
  assert.match(CLIENT_SOURCE, /var ROUTE_SELFCHECK = '\/pwsh7\/selfcheck'/);
  assert.match(CLIENT_SOURCE, /postJson\(ROUTE_ROUTE, \{ mode: mode \}\)/);
  assert.match(CLIENT_SOURCE, /postJson\(ROUTE_UNINSTALL, \{ confirm: true, scope: 'user' \}\)/);
  assert.match(CLIENT_SOURCE, /postJson\(ROUTE_RELOCATE, \{ removeUser: true, method: 'auto' \}\)/);
  assert.match(CLIENT_SOURCE, /postJson\(ROUTE_SELFCHECK, \{\}\)/);
  // Elevation refusals carry `requiresElevation` + `hint`; the page must render both.
  assert.match(CLIENT_SOURCE, /requiresElevation/);
  assert.match(CLIENT_SOURCE, /elevationRequired/);
  // Localized self-check titles are looked up by the server's id.
  assert.match(CLIENT_SOURCE, /t\('selfcheck\.' \+ id\)/);
  // Live progress reuses the dialog's phase/percent presentation.
  assert.match(CLIENT_SOURCE, /busyPhase\(host\.phase\)/);
  assert.match(CLIENT_SOURCE, /data-indeterminate/);
});

test('the settings page consumes the finished relocation reported in the state snapshot', () => {
  // `state.relocate` is not cleared by later snapshots, so it is adopted exactly once, keyed by a
  // signature, and a new action supersedes the previous report.
  assert.match(CLIENT_SOURCE, /relocateNoticeFor\(t, next\.relocate\)/);
  assert.match(CLIENT_SOURCE, /relocateSignature\(next\.relocate\)/);
  assert.match(CLIENT_SOURCE, /relocateSignature\(host\.raw\.relocate\)/);
  assert.match(CLIENT_SOURCE, /relocateSeen/);
  assert.match(CLIENT_SOURCE, /relocate\.relocated === true/);
  assert.match(CLIENT_SOURCE, /relocate\.systemPath/);
  assert.match(CLIENT_SOURCE, /relocate\.removedUserCopy/);
  assert.match(CLIENT_SOURCE, /relocate\.warnings/);
  assert.match(CLIENT_SOURCE, /relocate\.error/);
  // The outcome is copy from the dictionaries, never a hard-coded English sentence.
  assert.match(CLIENT_SOURCE, /t\('relocateDone'\)/);
  assert.match(CLIENT_SOURCE, /t\('relocateFailed'\)/);
});

test('both dictionaries carry every phase the host can send', () => {
  for (const key of ['downloading', 'extracting', 'verifying', 'installing', 'cancelling']) {
    const pattern = new RegExp(`\\n\\s*${key}: '[^']+'`);
    assert.match(CLIENT_SOURCE, pattern, `missing ${key} copy`);
  }
  assert.match(CLIENT_SOURCE, /var EN = \{/);
  assert.match(CLIENT_SOURCE, /var ZH = \{/);
});

// ---------------------------------------------------------------------------
// Harness: run the classic script under a fake loader and a fake React runtime.
// ---------------------------------------------------------------------------

function makeTranslate(dictionary) {
  return function translate(key, params) {
    const text = dictionary !== undefined && Object.prototype.hasOwnProperty.call(dictionary, key)
      ? dictionary[key]
      : key;
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
  };
}

/**
 * A tiny hook runtime: `useState` consumes an index into `overrides`, `useEffect` records the
 * callback for tests that want to mount (nothing runs automatically), and every setter is captured
 * so an event-driven update can be inspected without a real renderer.
 */
function makeReactStub(overrides = new Map(), captured = {}) {
  let stateIndex = 0;
  if (!Array.isArray(captured.setters)) captured.setters = [];
  if (!Array.isArray(captured.effects)) captured.effects = [];
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2);
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const at = stateIndex;
      stateIndex += 1;
      return [overrides.has(at) ? overrides.get(at) : initial, (next) => {
        captured.setters[at] = next;
      }];
    },
    useRef(initial) {
      return { current: initial };
    },
    useEffect(callback) {
      captured.effects.push(callback);
    },
  };
}

/**
 * Execute client.js in a fresh VM, call its factory, and apply the plugin to a fake cordis context.
 * @param {Map<number, unknown>} overrides per-render useState values.
 * @param {object} options optional `fetch`/`EventSource` fakes and render-tracking.
 * @returns {{dictionaries: object, registrations: object[], captured: object}}
 */
function boot(overrides = new Map(), options = {}) {
  let captured = null;
  const runtime = { setters: [], effects: [], cleanups: [], timers: new Map() };
  const sandbox = {
    console,
    navigator: { language: 'en-US' },
    document: { documentElement: { lang: 'en' } },
    window: {
      __ModuleLoader__: {
        load(optionsArg) {
          captured = optionsArg;
        },
      },
    },
  };
  // Track every timer the bundle creates. Even a test that forgets to unmount cannot leave a
  // polling interval behind and hang the process-isolated `node --test` child.
  sandbox.setInterval = (callback, ms) => {
    const id = setInterval(callback, ms);
    runtime.timers.set(id, 'interval');
    return id;
  };
  sandbox.setTimeout = (callback, ms) => {
    const id = setTimeout(callback, ms);
    runtime.timers.set(id, 'timeout');
    return id;
  };
  sandbox.clearInterval = (id) => {
    runtime.timers.delete(id);
    clearInterval(id);
  };
  sandbox.clearTimeout = (id) => {
    runtime.timers.delete(id);
    clearTimeout(id);
  };
  if (options.fetch !== undefined) sandbox.fetch = options.fetch;
  if (options.EventSource !== undefined) sandbox.EventSource = options.EventSource;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' });
  assert.ok(captured !== null, 'the client registered a module');
  assert.equal(captured.id, 'dsh-plugin-pwsh7');

  /** Mount: run every recorded effect once and keep its cleanup for {@link runtime.dispose}. */
  runtime.runEffects = () => {
    for (const effect of runtime.effects.slice()) {
      const cleanup = effect();
      if (typeof cleanup === 'function') runtime.cleanups.push(cleanup);
    }
    runtime.effects.length = 0;
  };
  /** Unmount: run effect cleanups and clear any timer the bundle did not clear itself. */
  runtime.dispose = () => {
    for (const cleanup of runtime.cleanups.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        // A cleanup that throws must not hide a test result.
      }
    }
    for (const [id, kind] of [...runtime.timers]) {
      if (kind === 'interval') clearInterval(id);
      else clearTimeout(id);
      runtime.timers.delete(id);
    }
  };

  const dictionaries = {};
  const registrations = [];
  const react = makeReactStub(overrides, runtime);
  const plugin = captured.factory((specifier) => {
    assert.equal(specifier, 'react');
    return react;
  });

  plugin.apply({
    locale: {
      register(namespace, locale, dictionary) {
        assert.equal(namespace, 'pwsh7');
        dictionaries[locale] = dictionary;
        return () => {};
      },
      bind() {
        return (key, params) => makeTranslate(dictionaries.en)(key, params);
      },
      getLocale() {
        return { active: 'en' };
      },
    },
    effect(run) {
      return run();
    },
    slots: {
      inject(_name, register) {
        register();
      },
      register(optionsArg, component) {
        registrations.push({ options: optionsArg, component });
        return () => {};
      },
    },
  });

  return { dictionaries, registrations, captured: runtime };
}

/** Render one registered slot; `t` comes from the registration's own inject when it has one. */
function renderSlot(booted, name, extraProps = {}) {
  const entry = booted.registrations.find((candidate) => candidate.options.name === name);
  assert.ok(entry, `no registration for slot ${name}`);
  const injected = typeof entry.options.inject === 'function' ? entry.options.inject() : {};
  const translate = typeof injected.t === 'function' ? injected.t : makeTranslate(booted.dictionaries.en);
  return entry.component(Object.assign({ t: translate }, extraProps));
}

function findNode(node, predicate, found = []) {
  if (node === null || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) {
    if (Array.isArray(child)) {
      for (const nested of child) findNode(nested, predicate, found);
    } else {
      findNode(child, predicate, found);
    }
  }
  return found;
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (node === null || typeof node !== 'object') return '';
  return (node.children || []).map(textOf).join(' ');
}

function findByAction(tree, action) {
  return findNode(tree, (node) => node.props !== undefined && node.props['data-action'] === action);
}

// ---------------------------------------------------------------------------
// Setup dialog render smoke tests
// ---------------------------------------------------------------------------

function renderDialog(host) {
  // Hook order in Pwsh7SetupDialog: 0 host snapshot, 1 open, 2 busy, 3 local error, 4 scope.
  const booted = boot(new Map([[0, host], [1, true]]));
  const tree = renderSlot(booted, 'shell.overlay');
  assert.equal(booted.registrations.length, 2);
  return tree;
}

test('the dialog renders a downloading state with a progress bar', () => {
  const tree = renderDialog({
    found: false,
    phase: 'downloading',
    percent: 42,
    received: 420,
    total: 1000,
    missingSeq: 1,
    installRoot: 'C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7',
    releasesUrl: 'https://github.com/PowerShell/PowerShell/releases/latest',
  });
  const dialogs = findNode(tree, (node) => node.props && node.props.role === 'dialog');
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].props['aria-modal'], 'true');
  const bars = findNode(tree, (node) => node.props && node.props.className === 'pwsh7_bar');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].props.style.width, '42%');
  assert.match(textOf(tree), /Downloading PowerShell 7/);
  assert.match(textOf(tree), /420 B \/ 1000 B \(42%\)/);
});

test('the dialog renders the installed and failed states', () => {
  const installed = renderDialog({
    found: true,
    phase: 'done',
    percent: 100,
    received: 10,
    total: 10,
    missingSeq: 2,
    installRoot: 'C:\\root',
    version: '7.6.7',
    path: 'C:\\root\\powershell7\\7.6.7\\pwsh.exe',
    releasesUrl: 'https://example.test',
  });
  assert.match(textOf(installed), /PowerShell 7 is installed/);
  assert.match(textOf(installed), /7\.6\.7/);

  const failed = renderDialog({
    found: false,
    phase: 'error',
    percent: null,
    received: 0,
    total: null,
    missingSeq: 3,
    installRoot: 'C:\\root',
    error: 'network unreachable',
    releasesUrl: 'https://example.test',
  });
  assert.match(textOf(failed), /PowerShell 7 could not be installed/);
  assert.match(textOf(failed), /network unreachable/);
});

// ---------------------------------------------------------------------------
// Locale dictionaries
// ---------------------------------------------------------------------------

test('the EN and ZH dictionaries have identical keys and the new settings copy', () => {
  const { dictionaries } = boot();
  assert.ok(dictionaries.en, 'the en dictionary was registered');
  assert.ok(dictionaries.zh, 'the zh dictionary was registered');
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort());
  for (const key of SETTINGS_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(dictionaries.en, key),
      `missing EN settings key ${key}`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(dictionaries.zh, key),
      `missing ZH settings key ${key}`,
    );
  }
  // Every self-check title exists in both dictionaries.
  for (const id of SELFCHECK_IDS) {
    assert.match(dictionaries.en[`selfcheck.${id}`], /[A-Za-z]/);
    assert.match(dictionaries.zh[`selfcheck.${id}`], /[\u4e00-\u9fff]/);
  }
});

// ---------------------------------------------------------------------------
// Settings page render smoke tests
// ---------------------------------------------------------------------------

const PWSH_PATH = 'C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7\\powershell7\\7.6.7\\pwsh.exe';
const PWSH_DIRECTORY = 'C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7\\powershell7\\7.6.7';
const CONFIG_PATH = 'C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7\\config.json';

/** A complete v0.3 `/pwsh7/state` snapshot, with per-test patches. */
function makeState(patch = {}, installPatch = {}, elevationPatch = {}) {
  const install = Object.assign({
    exists: true,
    managed: true,
    removable: true,
    scope: 'user',
    method: 'portable',
    version: '7.6.7',
    path: PWSH_PATH,
    directory: PWSH_DIRECTORY,
    userCopy: true,
    systemCopy: false,
    pathEntry: true,
  }, installPatch);
  return Object.assign({
    pluginVersion: '0.3.0',
    found: install.exists === true,
    path: install.path,
    version: install.version,
    installRoot: 'C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7',
    installRoots: {
      user: 'C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7',
      system: 'C:\\ProgramData\\dsh\\pwsh7',
    },
    scope: install.scope,
    method: install.method,
    configPath: CONFIG_PATH,
    phase: 'idle',
    percent: null,
    received: 0,
    total: null,
    message: null,
    error: null,
    missingSeq: 3,
    releasesUrl: 'https://example.test',
    route: 'plugin',
    routeConfigured: true,
    systemPath: null,
    busy: false,
    install,
    elevation: Object.assign({ available: false, requiredForSystem: true }, elevationPatch),
  }, patch);
}

function renderSettings(overrides = new Map()) {
  const booted = boot(overrides);
  return renderSlot(booted, 'settings.section');
}

test('the settings page renders installation details, flags and the route control', () => {
  const tree = renderSettings(new Map([[0, makeState()]]));
  const text = textOf(tree);

  assert.ok(text.includes('PowerShell 7'), 'page title');
  assert.ok(text.includes('v0.3.0'), 'plugin version');
  assert.ok(text.includes('PowerShell 7.6.7'), 'PowerShell status badge');
  assert.ok(text.includes('Installation'), 'installation section');
  assert.ok(text.includes('Routing'), 'routing section');
  assert.ok(text.includes('Maintenance'), 'actions section');
  assert.ok(text.includes(PWSH_PATH), 'executable path');
  assert.ok(text.includes(PWSH_DIRECTORY), 'install directory');
  assert.ok(text.includes(CONFIG_PATH), 'config path');
  assert.ok(text.includes('Current user'), 'scope');
  assert.ok(text.includes('Portable archive'), 'install method');
  assert.ok(text.includes('Removable from this page: Yes'), 'removable flag');
  assert.ok(text.includes('System-wide copy: No'), 'system copy flag');

  const pluginRoute = findByAction(tree, 'route-plugin');
  const systemRoute = findByAction(tree, 'route-system');
  assert.equal(pluginRoute.length, 1);
  assert.equal(systemRoute.length, 1);
  assert.equal(pluginRoute[0].props['data-on'], 'true');
  assert.equal(systemRoute[0].props['data-on'], 'false');
  assert.ok(text.includes('Prefers the plugin-managed copy'), 'plugin-route hint');

  // Installation details are rendered as rows, not as one blob.
  const rows = findNode(tree, (node) => node.props !== undefined && node.props.className === 'pwsh7_row');
  assert.ok(rows.length >= 6, `expected detail rows, got ${rows.length}`);
});

test('the settings page explains the system-default fallback and its resolved path', () => {
  const tree = renderSettings(new Map([[0, makeState({ route: 'system', systemPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })]]));
  const text = textOf(tree);
  assert.ok(text.includes('Windows PowerShell 5.1'), '5.1 fallback hint');
  assert.ok(text.includes('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'resolved system path');
  assert.equal(findByAction(tree, 'route-system')[0].props['data-on'], 'true');

  const missing = renderSettings(new Map([[0, makeState({ route: 'system', systemPath: null })]]));
  assert.ok(textOf(missing).includes('No system-wide PowerShell 7 was found'));
});

test('the settings page only offers uninstall when the install is removable', () => {
  const removable = renderSettings(new Map([[0, makeState()]]));
  assert.equal(findByAction(removable, 'uninstall').length, 1);
  assert.equal(findByAction(removable, 'relocate').length, 1);

  const notRemovable = renderSettings(new Map([[0, makeState({}, { removable: false, managed: false })]]));
  assert.equal(findByAction(notRemovable, 'uninstall').length, 0);
  // The per-user copy still allows relocation even when this page may not remove it.
  assert.equal(findByAction(notRemovable, 'relocate').length, 1);
});

test('a missing PowerShell makes the settings page offer a user-scope install', () => {
  const state = makeState({ found: false, path: null, version: null, busy: false }, {
    exists: false, managed: false, removable: false, scope: null, method: null,
    version: null, path: null, directory: null, userCopy: false, systemCopy: false, pathEntry: false,
  });
  const tree = renderSettings(new Map([[0, state]]));
  const text = textOf(tree);
  assert.ok(text.includes('PowerShell 7 was not found'));
  assert.equal(findByAction(tree, 'install').length, 1);
  assert.equal(findByAction(tree, 'uninstall').length, 0);
  assert.equal(findByAction(tree, 'relocate').length, 0);
  assert.ok(text.includes('Not found'), 'missing status badge');
});

test('relocate and uninstall both require an inline confirmation', () => {
  // Hook order in Pwsh7Settings: 0 state, 1 error, 2 busy, 3 confirming, 4 selfcheck, 5 notice.
  const relocate = renderSettings(new Map([[0, makeState()], [3, 'relocate']]));
  const relocateText = textOf(relocate);
  assert.ok(relocateText.includes('Install PowerShell 7 for all users'));
  assert.equal(findByAction(relocate, 'relocate-confirm').length, 1);
  assert.equal(findByAction(relocate, 'relocate').length, 0);
  assert.equal(findByAction(relocate, 'relocate-cancel').length, 1);

  const uninstall = renderSettings(new Map([[0, makeState()], [3, 'uninstall']]));
  const uninstallText = textOf(uninstall);
  assert.ok(uninstallText.includes('Remove the per-user PowerShell 7 copy'));
  assert.equal(findByAction(uninstall, 'uninstall-confirm').length, 1);
  assert.equal(findByAction(uninstall, 'uninstall').length, 0);
  assert.equal(findByAction(uninstall, 'uninstall-cancel').length, 1);
});

test('a self-check result renders localized titles, server detail and status styling', () => {
  const selfcheck = {
    ok: false,
    checkedAt: '2026-10-19T12:00:00.000Z',
    summary: { ok: 1, warn: 1, fail: 1 },
    checks: [
      { id: 'executable', status: 'fail', detail: 'pwsh.exe was not found' },
      { id: 'plugin-version', status: 'ok', detail: '0.3.0' },
      { id: 'route', status: 'warn', detail: 'route=system' },
    ],
  };
  const tree = renderSettings(new Map([[0, makeState()], [4, selfcheck]]));
  const text = textOf(tree);

  assert.ok(text.includes('Plugin version'), 'localized plugin-version title');
  assert.ok(text.includes('Routing mode'), 'localized route title');
  assert.ok(text.includes('pwsh executable'), 'localized executable title');
  assert.ok(text.includes('pwsh.exe was not found'), 'server detail');
  assert.ok(text.includes('route=system'), 'server detail for warn');
  assert.ok(text.includes('1 ok · 1 warnings · 1 failures'), 'summary');
  assert.ok(text.includes('Checked at'), 'checked timestamp');

  const checks = findNode(tree, (node) => node.props !== undefined && node.props['data-status'] !== undefined && node.props.className === 'pwsh7_check');
  assert.equal(checks.length, 3);
  // Contract order: plugin-version, route, executable — regardless of server order.
  assert.equal(checks[0].props['data-status'], 'ok');
  assert.equal(checks[1].props['data-status'], 'warn');
  assert.equal(checks[2].props['data-status'], 'fail');
  assert.equal(findByAction(tree, 'selfcheck').length, 1);
});

test('an elevation refusal renders the server error, its hint and the local elevation copy', () => {
  const failure = {
    message: 'system scope requires an elevated host',
    hint: 'Restart DSH from an administrator terminal.',
    requiresElevation: true,
    warnings: [],
  };
  const tree = renderSettings(new Map([[0, makeState()], [1, failure]]));
  const text = textOf(tree);
  assert.ok(text.includes('This action needs administrator rights.'));
  assert.ok(text.includes('Restart DSH as administrator'));
  assert.ok(text.includes('system scope requires an elevated host'));
  assert.ok(text.includes('Restart DSH from an administrator terminal.'));
  const alerts = findNode(tree, (node) => node.props !== undefined && node.props.role === 'alert');
  assert.equal(alerts.length, 1);
});

test('uninstall warnings are shown after a successful removal', () => {
  const notice = {
    text: 'The per-user PowerShell 7 copy was removed.',
    warnings: ['C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7\\tmp\\pwsh.zip'],
  };
  const tree = renderSettings(new Map([[0, makeState()], [5, notice]]));
  const text = textOf(tree);
  assert.ok(text.includes('The per-user PowerShell 7 copy was removed.'));
  assert.ok(text.includes('Some files could not be removed:'));
  assert.ok(text.includes('C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7\\tmp\\pwsh.zip'));
});

test('a finished relocation from the state stream becomes exactly one localized notice', () => {
  const systemPath = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const removedPath = 'C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7\\powershell7\\7.6.7';
  const lockedPath = 'C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7\\tmp\\pwsh.zip';
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.closed = false;
      instances.push(this);
    }
    addEventListener(name, handler) {
      (this.listeners[name] ??= []).push(handler);
    }
    close() {
      this.closed = true;
    }
    emit(name, data) {
      for (const handler of this.listeners[name] ?? []) handler({ data });
    }
  }

  const booted = boot(new Map(), {
    EventSource: FakeEventSource,
    // A resolvable response, like the real route; its stale ticket is dropped once the SSE frame
    // lands, so it cannot race the outcome under test.
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(makeState()) }),
  });
  renderSlot(booted, 'settings.section');
  assert.equal(booted.captured.effects.length, 1);
  booted.captured.runEffects();
  try {
    assert.equal(instances.length, 1, 'the page subscribed to /pwsh7/events');

    const state = makeState({
      relocate: {
        ok: true,
        relocated: true,
        systemPath,
        removedUserCopy: [removedPath],
        warnings: [lockedPath],
      },
    });
    instances[0].emit('state', JSON.stringify(state));

    const notice = booted.captured.setters[5];
    assert.ok(notice !== undefined && typeof notice.text === 'string', 'a relocation notice was raised');
    assert.ok(notice.text.includes(systemPath), 'the system executable is named');
    assert.ok(notice.text.includes('Removed 1 per-user copies.'));
    assert.deepEqual(Array.from(notice.details), [removedPath], 'removed user copies are listed');
    assert.deepEqual(Array.from(notice.warnings), [lockedPath], 'warnings are listed');
    // The adopted snapshot is the SSE frame (cross-realm: compare as JSON).
    assert.equal(JSON.stringify(booted.captured.setters[0]), JSON.stringify(state));

    // The same outcome arriving in a later frame must not re-announce itself.
    booted.captured.setters[5] = undefined;
    instances[0].emit('state', JSON.stringify(state));
    assert.equal(booted.captured.setters[5], undefined, 'the same relocation is announced once');

    // A failed relocation reports its server error through the same notice.
    booted.captured.setters[5] = undefined;
    const failed = makeState({
      relocate: {
        ok: false,
        relocated: false,
        systemPath: null,
        removedUserCopy: [],
        warnings: [],
        error: 'the per-user copy is locked by a running process',
      },
    });
    instances[0].emit('state', JSON.stringify(failed));
    const failure = booted.captured.setters[5];
    assert.ok(failure !== undefined && failure.text.includes('Moving PowerShell 7 to the system scope failed'));
    assert.ok(failure.text.includes('the per-user copy is locked by a running process'));
  } finally {
    booted.captured.dispose();
  }
});

test('an existing installation reports a localized method instead of the raw server value', () => {
  const tree = renderSettings(new Map([[0, makeState({}, { method: 'existing', managed: false, removable: false })]]));
  const text = textOf(tree);
  assert.ok(text.includes('Existing installation'));
  assert.ok(!text.includes('existing'), 'the raw method id must not reach the page');
});

test('a running host job renders live progress and disables the maintenance buttons', () => {
  const state = makeState({ busy: true, phase: 'downloading', percent: 42, received: 420, total: 1000 });
  const tree = renderSettings(new Map([[0, state]]));
  const text = textOf(tree);

  assert.ok(text.includes('Downloading PowerShell 7'), 'phase copy');
  assert.ok(text.includes('420 B / 1000 B (42%)'), 'progress meta');
  const bars = findNode(tree, (node) => node.props !== undefined && node.props.className === 'pwsh7_bar');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].props.style.width, '42%');

  for (const action of ['install', 'relocate', 'uninstall', 'selfcheck']) {
    for (const node of findByAction(tree, action)) {
      assert.equal(node.props.disabled, true, `${action} must be disabled while busy`);
    }
  }
});
