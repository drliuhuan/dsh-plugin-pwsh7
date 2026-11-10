// test/recycle-service.test.mjs — the host-side Recycle-Bin bridge: token authority, workspace
// bound, verdicts that only trust a bin record, and fail-closed behavior.
// Run with: node --test test/recycle-service.test.mjs (or: node test/recycle-service.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { binRecordExists, createRecycleService, isProtectedRemoval } from '../lib/recycle-service.mjs';

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

test('restore only accepts paths this session recycled', async (t) => {
  const workspace = makeWorkspace(t);
  const file = join(workspace, 'restorable.txt');
  writeFileSync(file, 'x');
  const service = createRecycleService({
    runRecycles: async (paths) => {
      for (const path of paths) rmSync(path, { force: true });
      return { results: paths.map((path) => ({ path, code: 0 })) };
    },
    verify: () => true,
    locate: () => join(workspace, '$Ifake'),
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  const recycled = await (await post(url, grant.token, { paths: [file] })).json();
  assert.equal(recycled.results[0].ok, true);
  assert.equal(service.journal.length, 1);
  assert.equal(service.journal[0].path, file);

  // A path that was never removed by this bridge is not a candidate, no matter where it is.
  const outsider = join(workspace, 'never-deleted.txt');
  writeFileSync(outsider, 'y');
  const refused = service.restore([outsider], workspace);
  assert.equal(refused.results[0].ok, false);
  assert.match(refused.results[0].detail, /no removal of this path was recorded/);
});

test('restore refuses an existing target and never overwrites it', async (t) => {
  const workspace = makeWorkspace(t);
  const file = join(workspace, 'collision.txt');
  writeFileSync(file, 'original');
  const record = join(workspace, '$Ifake2');
  const payload = join(workspace, '$Rfake2');
  writeFileSync(record, '');
  writeFileSync(payload, 'original');
  const service = createRecycleService({
    runRecycles: async (paths) => {
      for (const path of paths) rmSync(path, { force: true });
      return { results: paths.map((path) => ({ path, code: 0 })) };
    },
    verify: () => true,
    locate: () => record,
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  await post(url, grant.token, { paths: [file] });
  // Something new took the path after the removal.
  writeFileSync(file, 'replacement');
  const refused = service.restore([file], workspace);
  assert.equal(refused.results[0].ok, false);
  assert.match(refused.results[0].detail, /already exists/);
  assert.equal(readFileSync(file, 'utf8'), 'replacement', 'the new file must survive');
});

test('restore puts a journaled file back and retires the journal entry', async (t) => {
  const workspace = makeWorkspace(t);
  const file = join(workspace, 'bring-back.txt');
  writeFileSync(file, 'payload');
  const record = join(workspace, '$Ifake3');
  const payload = join(workspace, '$Rfake3');
  writeFileSync(record, '');
  writeFileSync(payload, 'payload');
  const service = createRecycleService({
    runRecycles: async (paths) => {
      for (const path of paths) rmSync(path, { force: true });
      return { results: paths.map((path) => ({ path, code: 0 })) };
    },
    verify: () => true,
    locate: () => record,
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  await post(url, grant.token, { paths: [file] });
  assert.equal(existsSync(file), false);
  const outcome = service.restore([file], workspace);
  assert.equal(outcome.results[0].ok, true);
  assert.equal(readFileSync(file, 'utf8'), 'payload');
  assert.equal(existsSync(record), false, 'the $I metadata record is removed');
  assert.equal(service.journal.length, 0, 'the journal entry is retired after a successful restore');
});

test('restore refuses when the Recycle Bin entry is already gone', async (t) => {
  const workspace = makeWorkspace(t);
  const file = join(workspace, 'gone-entry.txt');
  writeFileSync(file, 'x');
  const record = join(workspace, '$Ifake4');
  const payload = join(workspace, '$Rfake4');
  writeFileSync(record, '');
  writeFileSync(payload, 'x');
  const service = createRecycleService({
    runRecycles: async (paths) => {
      for (const path of paths) rmSync(path, { force: true });
      return { results: paths.map((path) => ({ path, code: 0 })) };
    },
    verify: () => true,
    locate: () => record,
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  await post(url, grant.token, { paths: [file] });
  // The user restored it in Explorer (or emptied the bin) in the meantime.
  rmSync(payload, { force: true });
  const refused = service.restore([file], workspace);
  assert.equal(refused.results[0].ok, false);
  assert.match(refused.results[0].detail, /Recycle Bin entry is gone/);
});

test('the loopback /restore route restores a journaled removal', async (t) => {
  const workspace = makeWorkspace(t);
  const file = join(workspace, 'route-restore.txt');
  writeFileSync(file, 'route payload');
  const record = join(workspace, '$Ifake5');
  const payload = join(workspace, '$Rfake5');
  writeFileSync(record, '');
  writeFileSync(payload, 'route payload');
  const service = createRecycleService({
    runRecycles: async (paths) => {
      for (const path of paths) rmSync(path, { force: true });
      return { results: paths.map((path) => ({ path, code: 0 })) };
    },
    verify: () => true,
    locate: () => record,
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  await post(url, grant.token, { paths: [file] });
  const restored = await fetch(`${url}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-recycle-token': grant.token },
    body: JSON.stringify({ paths: [file] }),
  });
  assert.equal(restored.status, 200);
  const body = await restored.json();
  assert.equal(body.results[0].ok, true);
  assert.equal(readFileSync(file, 'utf8'), 'route payload');
  assert.equal(service.journal.length, 0);
});

test('the /restore route refuses a path this session never deleted and needs a token', async (t) => {
  const workspace = makeWorkspace(t);
  const never = join(workspace, 'never.txt');
  writeFileSync(never, 'x');
  const service = createRecycleService({ runRecycles: async () => ({ results: [] }) });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  const refused = await fetch(`${url}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-recycle-token': grant.token },
    body: JSON.stringify({ paths: [never] }),
  });
  assert.equal(refused.status, 200);
  const body = await refused.json();
  assert.equal(body.results[0].ok, false);
  assert.match(body.results[0].detail, /no removal of this path was recorded/);
  const anonymous = await fetch(`${url}/restore`, { method: 'POST', body: JSON.stringify({ paths: [never] }) });
  assert.equal(anonymous.status, 401);
});
test('destructive removals are refused by the bridge', async (t) => {
  const workspace = makeWorkspace(t);
  const home = process.env.USERPROFILE;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const cases = [
    ['volume root', 'D:\\'],
    ['windows tree', systemRoot],
    ['windows child', systemRoot + '\\System32\\drivers\\etc\\hosts'],
    ['user profile', home],
  ];
  for (const [label, candidate] of cases) {
    assert.equal(isProtectedRemoval(candidate, workspace), true, label);
  }
  // An ancestor of the profile is destructive too; a descendant is an ordinary removal.
  assert.equal(isProtectedRemoval(process.env.SystemDrive + '\\Users', workspace), true);
  assert.equal(isProtectedRemoval(workspace + '\\ordinary.txt', workspace), false);
  // The workspace root itself is refused.
  assert.equal(isProtectedRemoval(workspace, workspace), true);
});

test('the bridge refuses a granted broad workspace root itself and the profile inside it', async (t) => {
  let called = false;
  const service = createRecycleService({
    runRecycles: async (paths) => { called = true; return { results: paths.map((path) => ({ path, code: 0 })) }; },
    verify: () => true,
    locate: () => null,
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const usersRoot = (process.env.SystemDrive ?? 'C:') + '\\Users';
  const grant = service.grant(usersRoot);
  assert.ok(grant !== null);
  const profile = process.env.USERPROFILE;
  const refused = await post(url, grant.token, { paths: [profile] });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /destructive removal/);
  assert.equal(called, false, 'the helper must not run for a protected path');
  const selfRefused = await post(url, grant.token, { paths: [usersRoot] });
  assert.equal(selfRefused.status, 403);
});

test('a workspace root deletion is refused but its files are not', async (t) => {
  const workspace = makeWorkspace(t);
  const file = join(workspace, 'allowed.txt');
  writeFileSync(file, 'x');
  let called = false;
  const service = createRecycleService({
    runRecycles: async (paths) => { called = true; return { results: paths.map((path) => ({ path, code: 0 })) }; },
    verify: () => true,
    locate: () => null,
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  const rootRefused = await post(url, grant.token, { paths: [workspace] });
  assert.equal(rootRefused.status, 403);
  assert.match((await rootRefused.json()).error, /destructive removal/);
  const fileAllowed = await post(url, grant.token, { paths: [file] });
  assert.equal(fileAllowed.status, 200);
  assert.equal(called, true);
});
test('a path longer than the Windows shell limit is refused before any deletion', async (t) => {
  const workspace = makeWorkspace(t);
  let deep = workspace;
  for (let index = 0; index < 30; index += 1) deep = join(deep, `segment-${index}`);
  let created = false;
  try {
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'leaf.txt'), 'x');
    created = true;
  } catch {
    created = false;
  }
  if (!created) {
    t.skip('this filesystem cannot create a path beyond MAX_PATH');
    return;
  }
  const leaf = join(deep, 'leaf.txt');
  let called = false;
  const service = createRecycleService({
    runRecycles: async (paths) => { called = true; return { results: paths.map((path) => ({ path, code: 0 })) }; },
    verify: () => true,
    locate: () => null,
  });
  t.after(() => service.close());
  service.start();
  const url = await waitForUrl(service);
  const grant = service.grant(workspace);
  const refused = await post(url, grant.token, { paths: [leaf] });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /path too long/);
  assert.equal(called, false, 'the helper must not run for a long path');
  assert.equal(existsSync(leaf), true, 'the long-path file must survive');
});