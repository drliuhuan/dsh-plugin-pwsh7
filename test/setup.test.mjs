// test/setup.test.mjs — the PowerShell 7 setup coordinator and its HTTP surface.
//
// The install itself is injected, so these tests never download anything. What they pin is the
// contract the Web dialog relies on: one install at a time, phase/progress snapshots, cancellation,
// `missingSeq` re-open signal, and the JSON/SSE route shapes.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  SETUP_METHODS,
  SETUP_ROUTES,
  createSetupService,
} from '../lib/setup-service.mjs';
import { createSetupHandlers, setupRouteRows } from '../lib/setup-routes.mjs';
import { installRouterFeatures } from '../lib/router-features.mjs';
import { notePwshMissing } from '../lib/state.mjs';

const W = path.win32;

function makeEnv(base = 'C:\\Users\\Tester') {
  return {
    LOCALAPPDATA: W.join(base, 'AppData', 'Local'),
    USERPROFILE: base,
  };
}

function routerState({ found = false, version, path: pwshPath } = {}) {
  return {
    platform: 'win32',
    pwsh: found
      ? {
        found: true,
        path: pwshPath ?? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        source: 'detected',
        candidates: [],
      }
      : { found: false, candidates: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'] },
    configPath: 'C:\\Users\\Tester\\AppData\\Local\\dsh\\pwsh7\\config.json',
    config: found && version !== undefined
      ? { installed: { pwsh: { version, path: pwshPath ?? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' } } }
      : {},
    notes: [],
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('initial snapshot reports the missing executable and the install root', (t) => {
  const service = createSetupService({
    env: makeEnv(),
    detect: () => routerState({ found: false }),
  });
  t.after(() => service.dispose());

  const snapshot = service.snapshot();
  assert.equal(snapshot.found, false);
  assert.equal(snapshot.phase, 'idle');
  assert.equal(snapshot.canInstall, true);
  assert.equal(snapshot.canCancel, false);
  assert.equal(snapshot.installRoot, W.join('C:\\Users\\Tester', 'AppData', 'Local', 'dsh', 'pwsh7'));
  assert.equal(snapshot.missingSeq, 0);
  assert.equal(typeof snapshot.releasesUrl, 'string');
});

test('a successful install publishes download, extract, verify and done phases', async (t) => {
  let found = false;
  const seen = [];
  const service = createSetupService({
    env: makeEnv(),
    detect: () => routerState({ found, version: found ? '7.6.7' : undefined }),
    refresh: async () => {
      found = true;
    },
    install: async ({ onProgress, onPhase }) => {
      onPhase('download');
      onProgress(5 * 1024 * 1024, 10 * 1024 * 1024);
      await delay(170);
      onPhase('extract');
      onProgress(10 * 1024 * 1024, 10 * 1024 * 1024);
      await delay(170);
      onPhase('verify');
      await delay(170);
      return {
        ok: true,
        result: {
          ok: true,
          method: 'portable',
          version: '7.6.7',
          path: 'C:\\portable\\7.6.7\\pwsh.exe',
          message: 'installed',
        },
      };
    },
  });
  t.after(() => service.dispose());
  service.subscribe((snapshot) => seen.push(snapshot));

  const started = service.start('auto');
  assert.equal(started.started, true);
  assert.equal(started.snapshot.canInstall, false);
  assert.equal(started.snapshot.canCancel, true);

  const final = await service.wait();
  assert.equal(final.phase, 'done');
  assert.equal(final.found, true);
  assert.equal(final.version, '7.6.7');
  assert.equal(final.percent, 100);
  assert.equal(final.error, null);
  assert.equal(final.canInstall, false);

  const phases = seen.map((snapshot) => snapshot.phase);
  assert.ok(phases.includes('downloading'), `phases: ${phases.join(', ')}`);
  assert.ok(phases.includes('extracting'), `phases: ${phases.join(', ')}`);
  assert.ok(phases.includes('verifying'), `phases: ${phases.join(', ')}`);
  assert.ok(phases.includes('done'), `phases: ${phases.join(', ')}`);

  // Uninstalled later: a failed run must turn the finished state back into "offer the download".
  found = false;
  notePwshMissing();
  assert.equal(service.snapshot().phase, 'idle');
});

test('a failed install reports the installer message and can be retried', async (t) => {
  let attempts = 0;
  const service = createSetupService({
    env: makeEnv(),
    detect: () => routerState({ found: false }),
    install: async () => {
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, result: { ok: false, method: 'auto', message: 'network unreachable' } };
      }
      return { ok: true, result: { ok: true, method: 'portable', version: '7.6.7', path: 'C:\\pwsh.exe' } };
    },
  });
  t.after(() => service.dispose());

  service.start('auto');
  let final = await service.wait();
  assert.equal(final.phase, 'error');
  assert.match(final.error, /network unreachable/);
  assert.equal(final.canInstall, true, 'a failed run may be retried');

  service.start('auto');
  final = await service.wait();
  assert.equal(final.phase, 'done');
  assert.equal(attempts, 2);
});

test('continuous progress keeps publishing frames instead of postponing them forever', async (t) => {
  const seen = [];
  const service = createSetupService({
    env: makeEnv(),
    detect: () => routerState({ found: false }),
    install: async ({ onProgress }) => {
      for (let index = 1; index <= 20; index += 1) {
        onProgress(index * 1024, 20 * 1024);
        await delay(20);
      }
      return { ok: true, result: { ok: true, method: 'portable', version: '7.6.7' } };
    },
  });
  t.after(() => service.dispose());
  service.subscribe((snapshot) => seen.push(snapshot));

  service.start('auto');
  const final = await service.wait();
  assert.equal(final.phase, 'done');
  const downloading = seen.filter((snapshot) => snapshot.phase === 'downloading');
  assert.ok(downloading.length >= 2, `expected several progress frames, saw ${downloading.length}`);
});

test('a second start joins the running install instead of downloading again', async (t) => {
  let calls = 0;
  let release;
  const service = createSetupService({
    env: makeEnv(),
    detect: () => routerState({ found: false }),
    install: () => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  t.after(() => service.dispose());

  const first = service.start('auto');
  const second = service.start('auto');
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(calls, 1);
  release({ ok: true, result: { ok: true, method: 'portable', version: '7.6.7' } });
  const final = await service.wait();
  assert.equal(final.phase, 'done');
});

test('cancel aborts the active install and settles as cancelled', async (t) => {
  const service = createSetupService({
    env: makeEnv(),
    detect: () => routerState({ found: false }),
    install: ({ onProgress, signal }) => new Promise((resolve) => {
      onProgress(1024, 4096);
      signal.addEventListener('abort', () => {
        resolve({ ok: false, aborted: true, result: { ok: false, message: 'aborted' } });
      }, { once: true });
    }),
  });
  t.after(() => service.dispose());

  service.start('auto');
  const cancelling = service.cancel();
  assert.equal(cancelling.phase, 'cancelling');
  assert.equal(cancelling.canCancel, false);
  const final = await service.wait();
  assert.equal(final.phase, 'cancelled');
  assert.equal(final.found, false);
});

test('missingSeq counts failed pwsh runs so the dialog can re-open each time', (t) => {
  const service = createSetupService({
    env: makeEnv(),
    detect: () => routerState({ found: false }),
  });
  t.after(() => service.dispose());
  const seen = [];
  service.subscribe((snapshot) => seen.push(snapshot.missingSeq));

  notePwshMissing();
  notePwshMissing();

  assert.equal(service.snapshot().missingSeq, 2);
  assert.ok(seen.includes(2), `published seqs: ${seen.join(', ')}`);
});

test('start rejects an unsupported method', (t) => {
  const service = createSetupService({
    env: makeEnv(),
    detect: () => routerState({ found: false }),
  });
  t.after(() => service.dispose());
  assert.throws(() => service.start('msi'), /unsupported install method/);
  assert.deepEqual([...SETUP_METHODS], ['auto', 'portable', 'winget']);
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

function makeService(t, overrides = {}) {
  const service = createSetupService({
    env: makeEnv(),
    detect: () => routerState({ found: false }),
    install: async () => ({ ok: true, result: { ok: true, method: 'portable', version: '7.6.7' } }),
    ...overrides,
  });
  t.after(() => service.dispose());
  return service;
}

test('route table names the eleven exact setup/maintenance routes', () => {
  const noop = () => {};
  const rows = setupRouteRows({
    state: noop,
    events: noop,
    install: noop,
    cancel: noop,
    route: noop,
    dialect: noop,
    onboarding: noop,
    latest: noop,
    uninstall: noop,
    relocate: noop,
    selfcheck: noop,
  });
  assert.deepEqual(rows.map((row) => row.path), [
    SETUP_ROUTES.state,
    SETUP_ROUTES.events,
    SETUP_ROUTES.install,
    SETUP_ROUTES.cancel,
    SETUP_ROUTES.route,
    SETUP_ROUTES.dialect,
    SETUP_ROUTES.onboarding,
    SETUP_ROUTES.latest,
    SETUP_ROUTES.uninstall,
    SETUP_ROUTES.relocate,
    SETUP_ROUTES.selfcheck,
  ]);
  assert.ok(rows.every((row) => row.kind === 'exact'));
});

test('installRouterFeatures wires the prompt and routes from the executor row', (t) => {
  const sections = [];
  const routes = [];
  const disposers = [];
  const ctx = {
    logger: { warn() {} },
    effect(run) {
      const disposer = run();
      disposers.push(disposer);
      return disposer;
    },
    inject(deps, callback) {
      if (deps.includes('tools')) return () => {};
      if (deps.includes('systemPrompt')) {
        callback({
          systemPrompt: {
            getSectionOrder() {
              return 4;
            },
            section(section) {
              sections.push(section);
            },
          },
        });
      }
      if (deps.includes('webServer')) {
        callback({
          webServer: {
            register(row) {
              routes.push(row);
              return () => {};
            },
          },
        });
      }
      return () => {};
    },
    on() {},
  };

  installRouterFeatures(ctx);
  t.after(() => {
    for (const dispose of disposers) if (typeof dispose === 'function') dispose();
  });

  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'tool:pwsh7-router');
  assert.equal(sections[0].order, 5);
  assert.equal(typeof sections[0].text, 'function');
  assert.match(sections[0].text(), /setup dialog/);
  assert.doesNotMatch(sections[0].text(), /dialect/i);
  assert.deepEqual(routes.map((row) => row.path), [
    SETUP_ROUTES.state,
    SETUP_ROUTES.events,
    SETUP_ROUTES.install,
    SETUP_ROUTES.cancel,
    SETUP_ROUTES.route,
    SETUP_ROUTES.dialect,
    SETUP_ROUTES.onboarding,
    SETUP_ROUTES.latest,
    SETUP_ROUTES.uninstall,
    SETUP_ROUTES.relocate,
    SETUP_ROUTES.selfcheck,
  ]);
});

test('GET /pwsh7/state answers the JSON snapshot', async (t) => {
  const service = makeService(t);
  const handlers = createSetupHandlers(service);
  const req = makeRequest({ method: 'GET', headers: { accept: 'application/json' } });
  const res = makeResponse();
  await handlers.state(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const payload = res.json();
  assert.equal(payload.found, false);
  assert.equal(payload.phase, 'idle');
});

test('POST /pwsh7/install starts the job and rejects non-JSON or cross-origin requests', async (t) => {
  const service = makeService(t);
  const handlers = createSetupHandlers(service);

  const crossOrigin = makeRequest({
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'auto' }),
  });
  const crossRes = makeResponse();
  await handlers.install(crossOrigin, crossRes);
  assert.equal(crossRes.statusCode, 403);

  const wrongType = makeRequest({
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ method: 'auto' }),
  });
  const wrongRes = makeResponse();
  await handlers.install(wrongType, wrongRes);
  assert.equal(wrongRes.statusCode, 415);

  const req = makeRequest({
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:14630', 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'auto' }),
  });
  const res = makeResponse();
  await handlers.install(req, res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().started, true);
  const final = await service.wait();
  assert.equal(final.phase, 'done');
});

test('POST /pwsh7/install rejects an unsupported method', async (t) => {
  const service = makeService(t);
  const handlers = createSetupHandlers(service);
  const req = makeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'msi' }),
  });
  const res = makeResponse();
  await handlers.install(req, res);
  assert.equal(res.statusCode, 400);
});

test('the shell_router tool never starts an installation', () => {
  // Installation is user-initiated in the Web UI only; the tool must only return guidance.
  const source = fs.readFileSync(new URL('../lib/router-features.mjs', import.meta.url), 'utf8');
  assert.match(source, /INSTALL_GUIDANCE/);
  assert.match(source, /action === 'install' \|\| action === 'relocate'/);
  assert.doesNotMatch(source, /installer\.start\s*\(/);
  assert.doesNotMatch(source, /ensurePwsh/);
});

test('GET /pwsh7/events opens an SSE stream with the current snapshot', (t) => {
  const service = makeService(t);
  const handlers = createSetupHandlers(service);
  const req = makeRequest({ method: 'GET' });
  const res = makeResponse();
  handlers.events(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  const first = res.text();
  assert.match(first, /^event: state\ndata: /);
  const frame = JSON.parse(first.split('data: ')[1].split('\n\n')[0]);
  assert.equal(frame.found, false);

  req.emit('close');
  assert.equal(res.ended, true, 'the stream is closed with the request');
});

test('POST /pwsh7/latest compares the newest release with the installed executable', async (t) => {
  const service = makeService(t, {
    detect: () => routerState({ found: true, version: '7.6.7' }),
    probe: async () => ({ ok: true, version: '7.6.7' }),
    resolveLatest: async () => ({ version: '7.7.0', url: 'https://example.test/pwsh.zip' }),
  });
  const handlers = createSetupHandlers(service);

  const res = makeResponse();
  await handlers.latest(makeRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), res);
  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.latest.version, '7.7.0');
  assert.equal(payload.latest.current, '7.6.7');
  assert.equal(payload.latest.updateAvailable, true);
  assert.equal(payload.state.latest.updateAvailable, true);
  // The probe fills the version that `describeInstall` cannot infer without a versioned directory.
  assert.equal(payload.state.install.version, '7.6.7');

  const cached = makeResponse();
  await handlers.latest(makeRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), cached);
  assert.equal(cached.json().latest.version, '7.7.0');
});

test('POST /pwsh7/latest keeps the installed state when the check fails', async (t) => {
  const service = makeService(t, {
    detect: () => routerState({ found: true, version: '7.6.7' }),
    probe: async () => ({ ok: true, version: '7.6.7' }),
    resolveLatest: async () => {
      throw new Error('offline');
    },
  });
  const handlers = createSetupHandlers(service);
  const res = makeResponse();
  await handlers.latest(makeRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), res);
  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.equal(payload.latest.version, null);
  assert.equal(payload.latest.current, '7.6.7');
  assert.match(payload.latest.error, /offline/);
  assert.equal(payload.latest.updateAvailable, null);
});
