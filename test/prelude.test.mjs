// test/prelude.test.mjs — parse and behavior checks for the Recycle-Bin prelude against a real
// PowerShell 7. The file skips itself when no `pwsh` on PATH (the pure contract is covered by
// test/rules.test.mjs). Default cases use -WhatIf, non-file-system providers, or a throwaway fake
// bridge, so the suite stays side-effect free; the one real-recycle test is opt-in
// (DSH_PWSH7_TEST_RECYCLE=1, unconfined process) and Windows-only.
// Run with: node --test test/prelude.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRecycleService } from '../lib/recycle-service.mjs';
import { RECYCLE_GUARD_PRELUDE } from '../lib/rules.mjs';

function findPwsh() {
  for (const candidate of ['pwsh', 'pwsh.exe']) {
    try {
      const result = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
      });
      if (result.status === 0) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const pwsh = findPwsh();

/** Run one guarded command string; `2>&1` is folded in by PowerShell so stderr is observable. */
function runWithPrelude(script) {
  return spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${RECYCLE_GUARD_PRELUDE}\n${script}`], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
}

/** Async variant: the bridge (an in-process HTTP server) needs the event loop to stay free. */
function runPreludeAsync(script, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${RECYCLE_GUARD_PRELUDE}\n${script}`], {
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

/** The bridge starts listening asynchronously; wait for its origin, then issue a grant. */
async function waitForGrant(service, workspaceRoot) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.url !== undefined) return service.grant(workspaceRoot);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return null;
}

function makeTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pwsh7-prelude-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ');

test('the prelude parses, shadows Remove-Item, and recycles every removal form with -WhatIf', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, (t) => {
  const directory = makeTemp(t);
  const file = path.join(directory, 'a.txt');
  fs.writeFileSync(file, 'x');

  const quotedFile = `'${file.replace(/'/g, "''")}'`;
  const result = runWithPrelude([
    '$ErrorActionPreference = "Continue"',
    'Write-Output ("command-type=" + (Get-Command Remove-Item).CommandType)',
    `Remove-Item -LiteralPath ${quotedFile} -WhatIf`,
    `Remove-Item ${quotedFile} -WhatIf`,
    `Remove-Item -Path '${directory.replace(/'/g, "''")}' -Recurse -WhatIf`,
    `Get-ChildItem -LiteralPath '${directory.replace(/'/g, "''")}' | Remove-Item -WhatIf`,
    '$aliases = @("rm", "del", "erase", "rd", "rmdir", "ri") | Where-Object { Get-Alias -Name $_ -ErrorAction SilentlyContinue }',
    `foreach ($alias in $aliases) { & $alias ${quotedFile} -WhatIf }`,
    'Write-Output ("aliases=" + ($aliases -join ","))',
  ].join('\n'));

  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /command-type=Function/);
  // Every removal form is intercepted: no "What if" line may come from the stock cmdlet.
  assert.ok(
    (output.match(/Move to Recycle Bin/gi) ?? []).length >= 5,
    `the prelude never runs the stock cmdlet:\n${output}`,
  );
  assert.doesNotMatch(output, /What if: Performing the operation "Remove File"/i);
  assert.ok(fs.existsSync(file), '-WhatIf must not remove the file');
  assert.ok(fs.existsSync(directory), '-WhatIf must not remove the directory');
});

test('the prelude supports pipeline input and leaves files in place under -WhatIf', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, (t) => {
  const directory = makeTemp(t);
  const files = ['one.txt', 'two.txt'].map((name) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, 'x');
    return file;
  });

  const result = runWithPrelude(`Get-ChildItem -LiteralPath '${directory}' | Remove-Item -WhatIf`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(oneLine(result.stdout + result.stderr), /Move to Recycle Bin/);
  for (const file of files) assert.ok(fs.existsSync(file), `${file} must survive -WhatIf`);
});

test('the prelude keeps non-FileSystem providers on the stock cmdlet', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, () => {
  const result = runWithPrelude([
    '$env:DSH_PWSH7_PRELUDE_TEST = "1"',
    'Remove-Item Env:DSH_PWSH7_PRELUDE_TEST -WhatIf',
    'Write-Output ("after-whatif=" + (Test-Path Env:DSH_PWSH7_PRELUDE_TEST))',
    'Remove-Item Env:DSH_PWSH7_PRELUDE_TEST -ErrorAction Stop',
    'Write-Output ("still-there=" + (Test-Path Env:DSH_PWSH7_PRELUDE_TEST))',
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /after-whatif=True/, 'the delegated stock cmdlet honors -WhatIf');
  assert.match(result.stdout, /still-there=False/);
});

test('the prelude actually recycles a file to the Recycle Bin (opt-in, Windows only)', {
  skip: process.platform !== 'win32' || process.env.DSH_PWSH7_TEST_RECYCLE !== '1'
    ? 'set DSH_PWSH7_TEST_RECYCLE=1 on Windows, from an UNCONFINED process, to exercise the real Recycle-Bin path'
    : false,
}, async (t) => {
  // The recycle is the host bridge's job (lib/recycle-service.mjs); this exercises the whole
  // chain end to end. It must run UNCONFINED — inside the write-restricted sandbox the helper's
  // recycle cannot write the bin, which is exactly the case the bridge reports as a failure.
  const directory = makeTemp(t);
  const name = `dsh-recycled-${process.pid}-${Date.now()}.txt`;
  const file = path.join(directory, name);
  fs.writeFileSync(file, 'x');
  const service = createRecycleService({ pwshPath: pwsh });
  t.after(() => service.close());
  service.start();
  const grant = await waitForGrant(service, directory);
  assert.ok(grant !== null, 'the bridge must be listening');
  const result = await runPreludeAsync(`Remove-Item -LiteralPath '${file.replace(/'/g, "''")}'`, {
    DSH_PWSH7_RECYCLE_URL: grant.url,
    DSH_PWSH7_RECYCLE_TOKEN: grant.token,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(file), false, 'the recycled file left its path');
  const bin = runWithPrelude([
    '$shell = New-Object -ComObject Shell.Application',
    '$bin = $shell.NameSpace(10)',
    `Write-Output ("in-bin=" + [bool]($bin.Items() | Where-Object { $_.Name -eq '${name}' } | Select-Object -First 1))`,
  ].join('\n'));
  assert.equal(bin.status, 0, bin.stderr);
  assert.match(bin.stdout, /in-bin=True/, 'the file is recoverable from the Recycle Bin');
});

test('the prelude asks the host bridge and never recycles in-process', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, async (t) => {
  const directory = makeTemp(t);
  const file = path.join(directory, 'bridged.txt');
  fs.writeFileSync(file, 'x');
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, token: request.headers['x-dsh-recycle-token'], body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [{ path: file, ok: true, code: 0, detail: '' }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const result = await runPreludeAsync(`Remove-Item -LiteralPath '${file.replace(/'/g, "''")}'`, {
    DSH_PWSH7_RECYCLE_URL: `http://127.0.0.1:${port}`,
    DSH_PWSH7_RECYCLE_TOKEN: 'test-token',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(seen.length, 1, 'exactly one bridge request');
  assert.equal(seen[0].url, '/recycle');
  assert.equal(seen[0].token, 'test-token');
  assert.deepEqual(seen[0].body, { paths: [file] });
  assert.ok(fs.existsSync(file), 'the fake bridge did not delete anything');
});

test('the prelude fails closed when the bridge reports the recycle was not confirmed', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, async (t) => {
  const directory = makeTemp(t);
  const file = path.join(directory, 'refused.txt');
  fs.writeFileSync(file, 'x');
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [{ path: file, ok: false, code: 0, detail: 'no Recycle Bin record was written' }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const result = await runPreludeAsync(`Remove-Item -LiteralPath '${file.replace(/'/g, "''")}'`, {
    DSH_PWSH7_RECYCLE_URL: `http://127.0.0.1:${port}`,
    DSH_PWSH7_RECYCLE_TOKEN: 'test-token',
  });
  assert.notEqual(result.status, 0, 'an unconfirmed recycle must fail the command');
  assert.match(`${result.stdout}\n${result.stderr}`, /no Recycle Bin record was written/);
  assert.match(`${result.stdout}\n${result.stderr}`, /nothing was deleted permanently/);
  assert.ok(fs.existsSync(file), 'a failed bridge answer must not delete anything');
});

test('the prelude refuses to delete when the bridge is not available', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, async (t) => {
  const directory = makeTemp(t);
  const file = path.join(directory, 'no-bridge.txt');
  fs.writeFileSync(file, 'x');
  const result = await runPreludeAsync(`Remove-Item -LiteralPath '${file.replace(/'/g, "''")}'`, {
    DSH_PWSH7_RECYCLE_URL: '',
    DSH_PWSH7_RECYCLE_TOKEN: '',
  });
  assert.notEqual(result.status, 0, 'without the bridge the command must fail');
  assert.match(`${result.stdout}\n${result.stderr}`, /not available in this process/);
  assert.ok(fs.existsSync(file), 'fail closed means the file stays');
});

test('the prelude refuses selectors instead of recycling the wrong target', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, (t) => {
  const directory = makeTemp(t);
  fs.writeFileSync(path.join(directory, 'a.txt'), 'x');
  const result = runWithPrelude(`Remove-Item -Path '${directory}' -Filter *.txt -WhatIf`);
  assert.notEqual(result.status, 0, 'a selector must fail');
  assert.match(`${result.stdout}\n${result.stderr}`, /does not support -Filter/);
  assert.ok(fs.existsSync(path.join(directory, 'a.txt')), 'a refused selector must not delete anything');
});

test('the prelude reports a missing path without deleting anything', {
  skip: pwsh === null ? 'no pwsh on PATH' : false,
}, (t) => {
  const directory = makeTemp(t);
  const missing = path.join(directory, 'missing.txt');
  const result = runWithPrelude(`Remove-Item -LiteralPath '${missing}' -ErrorAction Continue`);
  assert.match(`${result.stdout}\n${result.stderr}`, /does not exist/);
});
