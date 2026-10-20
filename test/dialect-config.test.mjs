// test/dialect-config.test.mjs — persistence and HTTP surface for the opt-in prompt injection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { describeDialect, readDialect, writeDialect } from '../lib/dialect-config.mjs';
import { readRouterConfig, writeRouterConfig } from '../lib/paths.mjs';
import { createSetupService, SETUP_ROUTES } from '../lib/setup-service.mjs';
import { createSetupHandlers } from '../lib/setup-routes.mjs';

function tempEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwsh7-dialect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    USERPROFILE: root,
  };
}

function stateFor(env) {
  return {
    platform: 'win32',
    pwsh: { found: false, candidates: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'] },
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

test('dialect defaults to off and force implies common', (t) => {
  const env = tempEnv(t);
  assert.deepEqual(readDialect(env), { common: false, force: false });
  assert.deepEqual(writeDialect({ force: true }, env), { common: false, force: false });
  assert.deepEqual(writeDialect({ common: true, force: true }, env), { common: true, force: true });
  assert.deepEqual(readDialect(env), { common: true, force: true });
  assert.deepEqual(writeDialect({ common: false, force: true }, env), { common: false, force: false });
  assert.deepEqual(readDialect(env), { common: false, force: false });
});

test('writing the level preserves the other config keys', (t) => {
  const env = tempEnv(t);
  writeRouterConfig({ route: 'system', pwshPath: 'C:\\pwsh.exe', dialect: { common: true } }, env);
  writeDialect({ common: true, force: true }, env);
  const config = readRouterConfig(env);
  assert.equal(config.route, 'system');
  assert.equal(config.pwshPath, 'C:\\pwsh.exe');
  assert.deepEqual(config.dialect, { common: true, force: true });
});

test('describeDialect reports both prompt sizes', (t) => {
  const env = tempEnv(t);
  const described = describeDialect(env);
  assert.deepEqual({ common: described.common, force: described.force }, { common: false, force: false });
  assert.ok(described.sizes.commonTokens > 0);
  assert.ok(described.sizes.forcedTokens > described.sizes.commonTokens);
});

test('POST /pwsh7/dialect validates and persists the level', async (t) => {
  const { env, service } = makeService(t);
  const handlers = createSetupHandlers(service);

  const ok = makeResponse();
  await handlers.dialect(makeRequest({ body: JSON.stringify({ common: true, force: true }) }), ok);
  assert.equal(ok.statusCode, 200);
  const payload = ok.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.dialect.common, true);
  assert.equal(payload.dialect.force, true);
  assert.equal(payload.state.dialect.common, true);
  assert.deepEqual(readDialect(env), { common: true, force: true });

  const off = makeResponse();
  await handlers.dialect(makeRequest({ body: JSON.stringify({ common: false, force: true }) }), off);
  assert.equal(off.statusCode, 200);
  assert.deepEqual(readDialect(env), { common: false, force: false });

  const invalid = makeResponse();
  await handlers.dialect(makeRequest({ body: JSON.stringify({ common: 'yes' }) }), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.json().error, /common/);

  const wrongMethod = makeResponse();
  await handlers.dialect(makeRequest({ method: 'GET' }), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
});

test('the install request persists the chosen level before starting', async (t) => {
  const { env, service } = makeService(t);
  const handlers = createSetupHandlers(service);

  const res = makeResponse();
  await handlers.install(makeRequest({
    body: JSON.stringify({ method: 'auto', dialect: { common: true } }),
  }), res);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(readDialect(env), { common: true, force: false });
  await service.waitForIdle();
});

test('the route table includes the dialect route', () => {
  assert.equal(SETUP_ROUTES.dialect, '/pwsh7/dialect');
});
