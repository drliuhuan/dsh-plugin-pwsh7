// Status and self-diagnosis for the Windows PowerShell 7 router.
//
// `status` is read-only: it resolves the pwsh executable, probes its version, and reports the
// current sandbox policy. `diagnose` actually runs commands through PowerShell 7 under the
// current policy, so a sandbox/grant problem is observed instead of guessed.

import { probePwsh } from './paths.mjs';
import { describeShippedResolution, shipped } from './shipped.mjs';

const MAX_OUTPUT_BYTES = 32_000;
const SPILL_BYTES = 4 * 1024 * 1024;

function readStream(reader) {
  try {
    const read = reader.readFrom(0);
    return { text: read.text, truncated: read.lossy === true, spillPath: read.spillPath };
  } catch (error) {
    return { text: '', error: String(error instanceof Error ? error.message : error) };
  }
}

function currentPolicy(ctx, exec) {
  const service = ctx.get('sandboxPolicy');
  if (service === undefined) return undefined;
  try {
    const session = exec?.agent?.session;
    return service.resolve(session === undefined ? {} : { session });
  } catch {
    return undefined;
  }
}

async function currentCwd(ctx, exec) {
  try {
    const workingDirectory = ctx.get('workingDirectory');
    if (workingDirectory !== undefined && exec?.agent !== undefined) {
      return await workingDirectory.ensure(exec.agent, exec.signal);
    }
    const session = exec?.agent?.session;
    if (workingDirectory !== undefined && session !== undefined) return workingDirectory.get(session);
  } catch {
    // Fall through to the process directory.
  }
  return process.cwd();
}

async function spawnAndWait(ctx, argv, { cwd, signal, graceMs = 5000 }) {
  const subprocess = ctx.get('subprocess');
  if (subprocess === undefined) throw new Error('pwsh7-router: ctx.subprocess is not available');
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: SPILL_BYTES } },
      stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: SPILL_BYTES } },
    },
    graceMs,
    ...(signal === undefined ? {} : { signal }),
  });
  const outcome = await handle.done;
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: readStream(handle.collected.stdout),
    stderr: readStream(handle.collected.stderr),
  };
}

function terse(text, limit = 800) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n…` : normalized;
}

async function runThroughExecutorPath(ctx, argv, { mode, policy, cwd, signal, label }) {
  const record = { label, argv, mode, ok: false };
  try {
    let prepared;
    let spawnArgv = argv;
    if (mode !== 'danger-full-access') {
      const sandbox = ctx.get('sandbox');
      if (sandbox === undefined) throw new Error('pwsh7-router: ctx.sandbox is not available');
      prepared = await sandbox.confine(argv, policy, signal ?? new AbortController().signal);
      record.enforcement = prepared.enforcement;
      spawnArgv = prepared.argv;
    }
    Object.assign(record, await spawnAndWait(ctx, spawnArgv, { cwd, signal }));
    record.ok = record.exitCode === 0;
    if (!record.ok && prepared !== undefined) {
      try {
        const sandbox = shipped('@deepseek-ai/dsh-sandbox');
        record.denied = sandbox.matchesSignature(record.exitCode, record.stderr?.text ?? '', prepared.denialSignatures ?? []);
        record.runnerFailure = sandbox.classifyRunnerFailure(record.exitCode, record.stderr?.text ?? '', prepared.runnerFailureRules ?? []);
      } catch {
        record.denied = false;
      }
      if (record.runnerFailure !== undefined) {
        record.hint = `The Windows sandbox runner failed before the command ran (${terse(record.runnerFailure, 300)}). `
          + 'Run the bundled diagnose-windows-sandbox-acl skill against the workspace root, or switch this session to full access.';
      } else if (record.denied) {
        record.hint = `A file operation was denied under ${mode} mode. Writes are only expected inside the workspace`
          + (mode === 'read-only' ? ' and none are expected in read-only.' : '; use the tool\'s sandbox_permissions escalation for a genuinely wider need.');
      }
    }
  } catch (error) {
    record.error = String(error instanceof Error ? error.message : error);
    if (/SetNamedSecurityInfoW|grantWrite|Win32 5/i.test(record.error)) {
      record.hint = 'The Windows sandbox could not provision the workspace write grant. '
        + 'Run the bundled diagnose-windows-sandbox-acl skill on the workspace root, or switch this session to full access.';
    } else if (/SANDBOX_UNAVAILABLE/i.test(record.error)) {
      record.hint = 'No usable sandbox runner for this platform/mode, so the command was not run. '
        + 'Switching to full access or fixing the sandbox runner is required.';
    } else if (/not found/i.test(record.error)) {
      record.hint = 'Install PowerShell 7 with the shell_router tool (action "install").';
    }
  }
  return record;
}

/** Human/model readable status, including the async version probe. */
export async function describeStatus(ctx, state, exec) {
  const lines = [`pwsh7-router (${state.platform})`];
  if (state.pwsh.found) {
    const probe = await probePwsh(state.pwsh.path);
    lines.push(`PowerShell 7: ${state.pwsh.path}${probe.ok ? ` (${probe.version})` : ' (probe failed)'}`);
    if (!probe.ok && probe.output) lines.push(`  probe output: ${terse(probe.output, 300)}`);
  } else {
    lines.push('PowerShell 7: NOT FOUND — run shell_router action "install" (per-user, no admin), set DSH_PWSH_PATH, or install manually.');
  }
  lines.push(`config: ${state.configPath}`);
  if (Array.isArray(state.notes) && state.notes.length > 0) lines.push(`notes: ${state.notes.join('; ')}`);

  try {
    const policy = currentPolicy(ctx, exec);
    lines.push(`sandbox: ${policy === undefined ? 'unknown (no sandboxPolicy service)' : `${policy.mode} (workspace ${policy.workspaceRoot})`}`);
  } catch {
    lines.push('sandbox: unknown');
  }
  const shipped = describeShippedResolution();
  lines.push(`shipped packages: ${shipped.ok ? 'ok' : `unavailable (${shipped.error})`}`);
  return lines.join('\n');
}

/** Run PowerShell 7 commands under the current policy. */
export async function runDiagnosis(ctx, state, exec) {
  const policy = currentPolicy(ctx, exec);
  const mode = policy?.mode ?? 'unknown';
  const cwd = await currentCwd(ctx, exec);
  const results = [];

  if (state.pwsh.found) {
    results.push(await runThroughExecutorPath(
      ctx,
      [state.pwsh.path, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '$PSVersionTable.PSVersion.ToString(); $PSHOME; (Get-Location).Path'],
      { mode, policy, cwd, signal: exec?.signal, label: 'pwsh version' },
    ));
    results.push(await runThroughExecutorPath(
      ctx,
      [state.pwsh.path, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '"ok" | Set-Content .pwsh7-write-probe -ErrorAction Stop; Remove-Item .pwsh7-write-probe -ErrorAction Stop; "workspace-write-ok"'],
      { mode, policy, cwd, signal: exec?.signal, label: 'pwsh workspace write' },
    ));
  } else {
    results.push({ label: 'pwsh', ok: false, error: 'PowerShell 7 not found', hint: 'Run shell_router action "install" or install PowerShell 7 manually.' });
  }

  const hints = results.filter((record) => record.hint !== undefined).map((record) => record.hint);
  const lines = [
    `pwsh7-router diagnose (sandbox mode: ${mode}${mode === 'danger-full-access' ? ', commands run unconfined' : ''})`,
    `cwd: ${cwd}`,
  ];
  results.forEach((record, index) => {
    const status = record.ok ? 'ok' : 'FAILED';
    const exit = record.exitCode !== undefined && record.exitCode !== null ? ` (exit ${record.exitCode})` : '';
    lines.push(`\n[${index + 1}] ${record.label}: ${status}${exit}`);
    if (record.error !== undefined) lines.push(`error: ${terse(record.error)}`);
    if (record.stdout?.text) lines.push(`stdout: ${terse(record.stdout.text)}`);
    if (record.stderr?.text) lines.push(`stderr: ${terse(record.stderr.text)}`);
    if (record.denied === true) lines.push('denied: yes');
    if (record.runnerFailure !== undefined) lines.push(`runner failure: ${terse(record.runnerFailure, 300)}`);
    if (record.hint !== undefined) lines.push(`hint: ${record.hint}`);
  });
  if (hints.length > 0) lines.push(`\nnext: ${hints[0]}`);
  const ok = results.every((record) => record.ok === true);
  return { ok, summary: lines.join('\n'), details: { mode, cwd, results } };
}
