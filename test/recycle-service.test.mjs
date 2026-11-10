// test/recycle-service.test.mjs — the host-side Recycle-Bin bridge: token authority, workspace
// bound, verdicts that only trust a bin record, and fail-closed behavior.
// Run with: node --test test/recycle-service.test.mjs (or: node test/recycle-service.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { binRecordExists, createRecycleService } from '../lib/recycle-service.mjs';

const makeWorkspace = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-pwsh7-bridge-'));
  t.after(() => import('node:fs').then((fs) => fs.rmSync(directory, { recursive: true, force: true })));
  return directory;
};

const waitForUrl = async (service) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.url !== undefined) return service.url;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the bridge never started listening');
};

const post = (url, token, body) => fetch(`${url}/recycle`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token === undefined ? {} : { 'x-dsh-recycle-token': token }),
  },
  body: JSON.stringify(body),
});

test('a request without a token is refused', async (t) => {
  const workspace = makeWorkspace(t);
  const service = createRecycleService({ runRecycles: async (paths) => ({ results: paths.map((path) => ({ path, code: 0 })) }) });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const response = await post(url, undefined, { paths: [workspace] });
  assert.equal(response.status, 401);
});

test('a token is bound to its workspace: paths outside it are refused', async (t) => {
  const workspace = makeWorkspace(t);
  const other = makeWorkspace(t);
  const file = join(other, 'outside.txt');
  writeFileSync(file, 'x');
  let called = false;
  const service = createRecycleService({
    runRecycles: async (paths) => { called = true; return { results: paths.map((path) => ({ path, code: 0 })) }; },
    verify: () => true,
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  assert.ok(grant !== null);
  const response = await post(url, grant.token, { paths: [file] });
  assert.equal(response.status, 403);
  assert.equal(called, false, 'nothing may run for a refused path');
});

test('a missing path is refused before the recycle helper runs', async (t) => {
  const workspace = makeWorkspace(t);
  let called = false;
  const service = createRecycleService({
    runRecycles: async (paths) => { called = true; return { results: paths.map((path) => ({ path, code: 0 })) }; },
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  const response = await post(url, grant.token, { paths: [join(workspace, 'missing.txt')] });
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test('a recycle is only reported ok when the bin record verifies it', async (t) => {
  const workspace = makeWorkspace(t);
  const file = join(workspace, 'verified.txt');
  writeFileSync(file, 'x');
  const service = createRecycleService({
    runRecycles: async (paths) => ({ results: paths.map((path) => ({ path, code: 0 })) }),
    verify: (path) => path === file,
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  const response = await post(url, grant.token, { paths: [file] });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].ok, true);
});

test('a shell success code without a bin record is a failure, not a recycle', async (t) => {
  const workspace = makeWorkspace(t);
  const file = join(workspace, 'unverified.txt');
  writeFileSync(file, 'x');
  const service = createRecycleService({
    // Exactly the measured failure mode: SHFileOperation returns 0 after a silent permanent
    // delete, so the return code alone must never be reported as success.
    runRecycles: async (paths) => ({ results: paths.map((path) => ({ path, code: 0 })) }),
    verify: () => false,
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  const response = await post(url, grant.token, { paths: [file] });
  const payload = await response.json();
  assert.equal(payload.results[0].ok, false);
  assert.match(payload.results[0].detail, /no Recycle Bin record/);
});

test('a helper that refuses the recycle reports its own detail', async (t) => {
  const workspace = makeWorkspace(t);
  const file = join(workspace, 'refused.txt');
  writeFileSync(file, 'x');
  const service = createRecycleService({
    runRecycles: async (paths) => ({ results: paths.map((path) => ({ path, code: -2, detail: 'the Recycle Bin is disabled' })) }),
    verify: () => true,
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  const payload = await (await post(url, grant.token, { paths: [file] })).json();
  assert.equal(payload.results[0].ok, false);
  assert.equal(payload.results[0].code, -2);
  assert.match(payload.results[0].detail, /disabled/);
});

test('a helper failure is a bridge error, never a verdict', async (t) => {
  const workspace = makeWorkspace(t);
  const file = join(workspace, 'helper-failure.txt');
  writeFileSync(file, 'x');
  const service = createRecycleService({ runRecycles: async () => ({ error: 'helper timed out' }) });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  const response = await post(url, grant.token, { paths: [file] });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /timed out/);
});

test('revoking a token makes it unusable', async (t) => {
  const workspace = makeWorkspace(t);
  const service = createRecycleService({ runRecycles: async () => ({ results: [] }) });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  service.revoke(grant.token);
  const response = await post(url, grant.token, { paths: [workspace] });
  assert.equal(response.status, 401);
});

test('binRecordExists sees no record for a name that was never recycled', () => {
  assert.equal(binRecordExists(join(tmpdir(), `dsh-pwsh7-never-recycled-${process.pid}.txt`), Date.now() - 60_000), false);
});

test('closed services refuse grants', async (t) => {
  const workspace = makeWorkspace(t);
  const service = createRecycleService({ runRecycles: async () => ({ results: [] }) });
  await service.close();
  assert.equal(service.grant(workspace), null);
});
