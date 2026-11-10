// test/deletion-guard.test.mjs — the settings switch that turns the whole deletion-protection
// layer on or off, and the prompt composition that follows it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  DEFAULT_DELETION_GUARD,
  describeDeletionGuard,
  readDeletionGuard,
  writeDeletionGuard,
} from '../lib/deletion-guard.mjs';
import { readRouterConfig, writeRouterConfig } from '../lib/paths.mjs';
import { createSetupService } from '../lib/setup-service.mjs';
import { createSetupHandlers } from '../lib/setup-routes.mjs';
import { composePromptText } from '../lib/router-features.mjs';

function tempEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwsh7-deletion-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    USERPROFILE: root,
  };
}

function makeService(t) {
  const env = tempEnv(t);
  const service = createSetupService({
    env,
    detect: () => ({
      platform: 'win32',
      pwsh: { found: false, candidates: [] },
      configPath: path.join(env.LOCALAPPDATA, 'dsh', 'pwsh7', 'config.json'),
      config: {},
      notes: [],
    }),
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

test('deletion protection defaults to on and round-trips', (t) => {
  const env = tempEnv(t);
  assert.equal(DEFAULT_DELETION_GUARD, true);
  assert.equal(readDeletionGuard(env), true);
  assert.equal(writeDeletionGuard(false, env), false);
  assert.equal(readDeletionGuard(env), false);
  assert.deepEqual(describeDeletionGuard(env), { enabled: false });
  assert.equal(writeDeletionGuard(true, env), true);
  assert.equal(readDeletionGuard(env), true);
});

test('the switch preserves the other config keys', (t) => {
  const env = tempEnv(t);
  writeRouterConfig({ route: 'system', pwshPath: 'C:\\pwsh.exe' }, env);
  writeDeletionGuard(false, env);
  const config = readRouterConfig(env);
  assert.equal(config.route, 'system');
  assert.equal(config.pwshPath, 'C:\\pwsh.exe');
  assert.equal(config.deletionGuard, false);
});

test('a config without the key keeps the protection on (older files)', (t) => {
  const env = tempEnv(t);
  writeRouterConfig({ route: 'plugin' }, env);
  assert.equal(readDeletionGuard(env), true);
});

test('POST /pwsh7/deletion-guard validates, persists and reports state', async (t) => {
  const { env, service } = makeService(t);
  const handlers = createSetupHandlers(service);

  const bad = makeResponse();
  await handlers.deletionGuard(makeRequest({ body: JSON.stringify({ enabled: 'yes' }) }), bad);
  assert.equal(bad.statusCode, 400);

  const off = makeResponse();
  await handlers.deletionGuard(makeRequest({ body: JSON.stringify({ enabled: false }) }), off);
  assert.equal(off.statusCode, 200);
  const payload = off.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.deletionGuard, { enabled: false });
  assert.equal(payload.state.deletionGuard.enabled, false);
  assert.equal(readDeletionGuard(env), false);

  const get = makeResponse();
  await handlers.deletionGuard(makeRequest({ method: 'GET' }), get);
  assert.equal(get.statusCode, 405);
});

test('the prompt carries the deletion rules only while the protection is on', () => {
  const on = composePromptText('plugin', '', true);
  const off = composePromptText('plugin', '', false);
  assert.match(on, /Deletion safety is a basic/);
  assert.doesNotMatch(off, /Deletion safety is a basic/);
  // The maintenance paragraph still identifies the tool and stays non-empty.
  assert.match(off, /PowerShell 7/);
  // The default (undefined) keeps the rules, so existing callers cannot lose them by accident.
  assert.match(composePromptText('plugin'), /Deletion safety is a basic/);
});
