// test/client.test.mjs — the browser half's packaging contract.
//
// DSH only serves a plugin's client bundle when `package.json` declares `dsh.client` and exports
// `./client`; a typo there is a dialog that never appears, with no host error. These checks are the
// cheap guard for that failure mode, plus a syntax check of the classic script itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CLIENT_SOURCE = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');

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

test('the client registers under the package name into the shell overlay slot', () => {
  assert.match(CLIENT_SOURCE, /window\.__ModuleLoader__\.load\(/);
  assert.match(CLIENT_SOURCE, /id: PLUGIN_ID/);
  assert.match(CLIENT_SOURCE, /var PLUGIN_ID = 'dsh-plugin-pwsh7'/);
  assert.match(CLIENT_SOURCE, /ctx\.slots\.inject\('shell\.overlay'/);
  assert.match(CLIENT_SOURCE, /name: 'shell\.overlay'/);
  assert.match(CLIENT_SOURCE, /locale: LOCALE_NS/);
});

test('the dialog talks to all four setup routes and streams progress', () => {
  assert.match(CLIENT_SOURCE, /var ROUTE_STATE = '\/pwsh7\/state'/);
  assert.match(CLIENT_SOURCE, /var ROUTE_EVENTS = '\/pwsh7\/events'/);
  assert.match(CLIENT_SOURCE, /var ROUTE_INSTALL = '\/pwsh7\/install'/);
  assert.match(CLIENT_SOURCE, /var ROUTE_CANCEL = '\/pwsh7\/cancel'/);
  assert.match(CLIENT_SOURCE, /new EventSource\(ROUTE_EVENTS\)/);
  assert.match(CLIENT_SOURCE, /missingSeq/);
  assert.match(CLIENT_SOURCE, /setInterval\(refresh, POLL_MS\)/);
});

test('both dictionaries carry every phase the host can send', () => {
  for (const key of ['idle', 'downloading', 'extracting', 'verifying', 'installing', 'cancelling']) {
    if (key === 'idle') continue;
    const pattern = new RegExp(`\\n\\s*${key}: '[^']+'`);
    assert.match(CLIENT_SOURCE, pattern, `missing ${key} copy`);
  }
  assert.match(CLIENT_SOURCE, /var EN = \{/);
  assert.match(CLIENT_SOURCE, /var ZH = \{/);
});

// ---------------------------------------------------------------------------
// Render smoke test: a fake React runtime lets the dialog's render path run
// without a browser. This catches the failure a syntax check cannot: a hook
// order change, a bad `t()` key, or a broken element tree.
// ---------------------------------------------------------------------------

function makeReactStub(host) {
  let states = 0;
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2);
      return { type, props: props || {}, children };
    },
    useState(initial) {
      states += 1;
      if (states === 1) return [host, () => {}];
      if (states === 2) return [true, () => {}]; // dialog open
      if (states === 3) return [false, () => {}]; // POST busy
      if (states === 4) return [null, () => {}]; // local error
      return [initial, () => {}];
    },
    useRef(initial) {
      return { current: initial };
    },
    useEffect() {},
  };
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
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (node === null || typeof node !== 'object') return '';
  return (node.children || []).map(textOf).join(' ');
}

function renderDialog(host) {
  let captured = null;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    navigator: { language: 'en-US' },
    document: { documentElement: { lang: 'en' } },
    window: {
      __ModuleLoader__: {
        load(options) {
          captured = options;
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' });
  assert.ok(captured !== null, 'the client registered a module');
  assert.equal(captured.id, 'dsh-plugin-pwsh7');

  const registrations = [];
  const plugin = captured.factory((specifier) => {
    assert.equal(specifier, 'react');
    return makeReactStub(host);
  });
  plugin.apply({
    locale: {
      register() {
        return () => {};
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
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.name, 'shell.overlay');
  // The real slot binds a dictionary translator; give the render the same interpolation shape.
  function translate(key, params) {
    const templates = {
      installedBody: '{version} at {path}',
      installedNoVersion: '{path}',
      progress: '{received} / {total} ({percent}%)',
      progressUnknown: 'Downloaded {received}',
    };
    const text = templates[key] ?? key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
  }
  const tree = registrations[0].component({ t: translate });
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
  assert.match(textOf(tree), /downloading/);
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
  assert.match(textOf(installed), /installed/);
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
  assert.match(textOf(failed), /failed/);
  assert.match(textOf(failed), /network unreachable/);
});
