// test/onboarding.test.mjs — the one-time initial-setup confirmation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { readOnboarding, writeOnboarding } from '../lib/onboarding.mjs';
import { readRouterConfig, writeRouterConfig } from '../lib/paths.mjs';
import { createSetupService, SETUP_ROUTES } from '../lib/setup-service.mjs';
import { createSetupHandlers } from '../lib/setup-routes.mjs';

function tempEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwsh7-onboarding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    USERPROFILE: root,
  };
}

function stateFor(env) {
  return {
    platform: 'win32',
    pwsh: { found: true, path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', source: 'detected', candidates: [] },
    configPath: path.join(env.LOCALAPPDATA, 'dsh', 'pwsh7', 'config.json'),
    config: {},
    notes: [],
  };
}

function makeService(t) {
  const env = tempEnv(t);
  const service = createSetupService({
    env,
    detect: () => stateFor(env),
    install: async () => ({ ok: true, result: { ok: true, method: 'portable' } }),
  });
  t.after(() => service.dispose());
  return { env, service };
}

function makeRequest({ method = 'POST', body = '' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  req.resume = () => {};
  setImmediate(() => {
    if (body !== '') req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function makeResponse() {
  const chunks = [];
  return {
    statusCode: 200,
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
    },
    json() {
      return JSON.parse(chunks.join(''));
    },
  };
}

test('onboarding defaults to not completed', (t) => {
  const env = tempEnv(t);
  assert.deepEqual(readOnboarding(env), { completed: false });
});

test('writing the flag preserves route and dialect', (t) => {
  const env = tempEnv(t);
  writeRouterConfig({ route: 'system', dialect: { common: true, force: true } }, env);
  assert.deepEqual(writeOnboarding(true, env), { completed: true });
  assert.deepEqual(readOnboarding(env), { completed: true });
  const config = readRouterConfig(env);
  assert.equal(config.route, 'system');
  assert.deepEqual(config.dialect, { common: true, force: true });
  writeOnboarding(false, env);
  assert.deepEqual(readOnboarding(env), { completed: false });
});

test('the snapshot carries the onboarding state', (t) => {
  const { env, service } = makeService(t);
  assert.deepEqual(service.snapshot().onboarding, { completed: false });
  writeOnboarding(true, env);
  assert.deepEqual(service.snapshot().onboarding, { completed: true });
});

test('POST /pwsh7/onboarding validates and persists the confirmation', async (t) => {
  const { env, service } = makeService(t);
  const handlers = createSetupHandlers(service);

  const done = makeResponse();
  await handlers.onboarding(makeRequest({ body: JSON.stringify({ completed: true }) }), done);
  assert.equal(done.statusCode, 200);
  const payload = done.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.onboarding.completed, true);
  assert.equal(payload.state.onboarding.completed, true);
  assert.deepEqual(readOnboarding(env), { completed: true });

  const invalid = makeResponse();
  await handlers.onboarding(makeRequest({ body: JSON.stringify({ completed: 'yes' }) }), invalid);
  assert.equal(invalid.statusCode, 400);

  const wrongMethod = makeResponse();
  await handlers.onboarding(makeRequest({ method: 'GET' }), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
});

test('the route table includes the onboarding route', () => {
  assert.equal(SETUP_ROUTES.onboarding, '/pwsh7/onboarding');
});
