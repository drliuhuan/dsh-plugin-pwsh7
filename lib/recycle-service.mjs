// The host-side Recycle-Bin bridge.
//
// WHY THIS EXISTS
// `workspace-write` confinement is a Windows restricted token whose write-permission SID is
// granted the session workspace and a private temp directory — nothing else. The Recycle Bin is
// not on that list: every recycle API (Microsoft.VisualBasic.FileSystem, SHFileOperation,
// IFileOperation, Shell.Application.MoveHere) writes a `$I`/`$R` record pair under
// `<volume>\$RECYCLE.BIN\<sid>`, and the restricted token denies that write. Measured on this
// deployment: `SHFileOperationW` with ALLOWUNDO returned 0, the file vanished, and NO bin record
// existed — the shell silently falls back to a permanent delete and REPORTS SUCCESS. The success
// code is therefore not evidence, and "trigger it and trust the return" cannot be the contract.
//
// So the recycle is performed by the host process, which is not confined (it is the process that
// applies confinement to child commands), and the result is verified against the bin's own record
// on disk. The confined pwsh only asks; it never writes the bin itself.
//
// TRANSPORT
// A loopback HTTP server bound to 127.0.0.1 on an ephemeral port, started by this service in the
// host process. Network is not file-confined, so a confined shell can reach it; nothing is exposed
// beyond the loopback interface. Each command that mentions a removal gets its own random token,
// bound server-side to the session workspace root — the request body only names paths, and the
// server refuses anything outside that root.
//
// VERDICT
// A path counts as recycled only when the shell reports 0 AND the volume's bin holds an `$I`
// record written after this operation started whose UTF-16 payload names that exact path. Anything
// else is reported as a failure, and the prelude throws: no silent permanent delete.

import { spawn as spawnChild } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

/** Route the prelude posts to. */
export const RECYCLE_ENDPOINT = '/recycle';
/** Route the shell (and `shell_router`) posts to in order to restore a journaled removal. */
export const RESTORE_ENDPOINT = '/restore';
/** Environment variable carrying the bridge URL into the confined shell. */
export const RECYCLE_URL_ENV = 'DSH_PWSH7_RECYCLE_URL';
/** Environment variable carrying the per-command token into the confined shell. */
export const RECYCLE_TOKEN_ENV = 'DSH_PWSH7_RECYCLE_TOKEN';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_PATHS = 64;
const BRIDGE_TIMEOUT_MS = 60_000;
/** Grants issued through the managed-variable snapshot are not revocable per command; they expire. */
const GRANT_TTL_MS = 15 * 60_000;
/** Bound on the restore journal; the oldest entries fall off first. */
const MAX_JOURNAL = 256;
/** 
 * Length above which a Recycle-Bin operation is refused instead of attempted. The Windows shell
 * API SHFileOperation does not reliably handle long paths: measured on a 352-character path it
 * reported success, wrote no $I record and permanently deleted the file. Refusing up front is the
 * only way to keep it.
 */
const MAX_RECYCLE_PATH = 250;

/**
 * The PowerShell program run OUTSIDE the sandbox (host child) that performs the recycle.
 *
 * It receives `{"paths":[...]}` on stdin and writes a JSON array of `{path, code, detail}` on
 * stdout. `code` 0 means the shell reported success; the bridge still verifies the bin record.
 * The flags are ALLOWUNDO (0x0040), NOCONFIRMATION (0x0010), SILENT (0x0004), NOERRORUI (0x0400):
 * the last one is what keeps a failed recycle from opening the "permanently delete?" dialog.
 * Pre-checks refuse a volume whose Recycle Bin is disabled or whose capacity cannot hold the item,
 * because those are exactly the cases in which the shell deletes permanently and says nothing.
 */
export const RECYCLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DshRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SHFILEOPSTRUCT {
    public IntPtr hwnd;
    public uint wFunc;
    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
    public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHFileOperation(ref SHFILEOPSTRUCT op);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool GetVolumeNameForVolumeMountPoint(string mountPoint, StringBuilder volumeName, uint bufferLength);

  public static int Recycle(string path) {
    SHFILEOPSTRUCT op = new SHFILEOPSTRUCT();
    op.wFunc = 3; // FO_DELETE
    op.pFrom = path + "\0\0";
    op.fFlags = (ushort)(0x0040 | 0x0010 | 0x0004 | 0x0400);
    return SHFileOperation(ref op);
  }

  public static string VolumeGuid(string root) {
    StringBuilder buffer = new StringBuilder(64);
    if (!GetVolumeNameForVolumeMountPoint(root, buffer, 64)) return "";
    string name = buffer.ToString(); // \\?\Volume{GUID}\
    int open = name.IndexOf('{');
    int close = name.IndexOf('}');
    if (open < 0 || close <= open) return "";
    return name.Substring(open + 1, close - open - 1);
  }
}
"@

function Get-CapacityBytes([string]$root) {
  $volume = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + [DshRecycle]::VolumeGuid($root)
  $entry = Get-ItemProperty -Path $volume -ErrorAction SilentlyContinue
  if ($null -ne $entry) {
    if ($null -ne $entry.NukeOnDelete -and [int]$entry.NukeOnDelete -eq 1) { return [int64]0 }
    if ($null -ne $entry.MaxCapacity -and [int]$entry.MaxCapacity -gt 0) { return [int64]$entry.MaxCapacity * 1MB }
  }
  # No explicit setting: Windows keeps a fraction of the volume for the bin. Use the smaller bound
  # (5%) so a huge item is refused rather than silently deleted when it does not fit.
  try {
    $drive = [System.IO.DriveInfo]::new($root)
    if ($drive.IsReady -and $drive.TotalSize -gt 0) { return [int64]($drive.TotalSize * 0.05) }
  } catch { }
  return $null
}

function Get-PathBytes([string]$path, [int64]$limit) {
  $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer) { return [int64]$item.Length }
  $sum = [int64]0
  foreach ($child in (Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue)) {
    $sum += [int64]$child.Length
    if ($limit -gt 0 -and $sum -gt $limit) { return $sum }
  }
  return $sum
}

$disabled = $false
try {
  $policy = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer' -Name NoRecycleFiles -ErrorAction SilentlyContinue
  if ($null -ne $policy -and [int]$policy.NoRecycleFiles -eq 1) { $disabled = $true }
} catch { }

$results = @()
foreach ($path in @($payload.paths)) {
  $code = -1
  $detail = ''
  try {
    $root = [System.IO.Path]::GetPathRoot($path)
    $volumeOk = $true
    $volumeWhy = ''
    try {
      $drive = [System.IO.DriveInfo]::new($root)
      if ($drive.DriveType -eq [System.IO.DriveType]::Network -or $drive.DriveType -eq [System.IO.DriveType]::Removable -or $drive.DriveType -eq [System.IO.DriveType]::CDRom) {
        $volumeOk = $false
        $volumeWhy = 'this location has no Recycle Bin (network, removable or optical drive); deleting it would be permanent'
      } elseif ($drive.DriveFormat -ne 'NTFS') {
        $volumeOk = $false
        $volumeWhy = ('the volume uses {0}, which Windows does not recycle on; deleting it would be permanent' -f $drive.DriveFormat)
      }
    } catch {
      $volumeOk = $false
      $volumeWhy = 'the volume type could not be determined, so a recyclable delete cannot be guaranteed'
    }
    # A Recycle Bin that cannot be written for the current user means the shell would either fail
    # or silently delete permanently; probe the user's own bin directory before relying on it.
    # Only for a volume that could recycle at all (no network round-trips on shares).
    $binOk = $true
    $binWhy = ''
    if ($volumeOk) {
      $sid = $null
      try { $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { }
      if ($null -eq $sid) {
        $binOk = $false
        $binWhy = 'the current user cannot be resolved, so a recyclable delete cannot be guaranteed'
      } else {
        $binUserDir = Join-Path (Join-Path $root '$RECYCLE.BIN') $sid
        if (-not (Test-Path -LiteralPath $binUserDir)) {
          $binOk = $false
          $binWhy = 'this volume has no Recycle Bin directory for the current user, so a recyclable delete cannot be guaranteed'
        } else {
          $probe = Join-Path $binUserDir ('.dsh-recycle-probe-' + [guid]::NewGuid().ToString('N'))
          try {
            [System.IO.File]::WriteAllText($probe, 'x')
            [System.IO.File]::Delete($probe)
          } catch {
            $binOk = $false
            $binWhy = 'the Recycle Bin directory for the current user is not writable, so a recyclable delete cannot be guaranteed'
            try { if (Test-Path -LiteralPath $probe) { [System.IO.File]::Delete($probe) } } catch { }
          }
        }
      }
    }
    if (-not $volumeOk) {
      $code = -5
      $detail = $volumeWhy
    } elseif (-not $binOk) {
      $code = -6
      $detail = $binWhy
    } elseif ($path.Length -ge 251) {
      $code = -4
      $detail = 'path too long for a safe Recycle Bin operation; nothing was deleted'
    } else {
      $capacity = Get-CapacityBytes($root)
      $limit = [int64]0
      if ($null -ne $capacity) { $limit = [int64]$capacity }
      $size = Get-PathBytes $path $limit
      if ($disabled -or ($null -ne $capacity -and [int64]$capacity -eq 0)) {
        $code = -2
        $detail = 'the Recycle Bin is disabled for this volume (NoRecycleFiles / NukeOnDelete); nothing was deleted'
      } elseif ($null -ne $capacity -and $size -gt [int64]$capacity) {
        $code = -3
        $detail = 'the item is larger than this volume''s Recycle Bin capacity; nothing was deleted'
      } else {
        $code = [DshRecycle]::Recycle($path)
        if ($code -ne 0) { $detail = ('SHFileOperation returned 0x{0:X}' -f $code) }
      }
    }
  } catch {
    $detail = $_.Exception.Message
  }
  $results += [pscustomobject]@{ path = $path; code = $code; detail = $detail }
}
$results | ConvertTo-Json -Compress
`;

/** The unconfined recycle runner: one pwsh child per request, all paths in one call. */
function runRecycleScript(pwshPath, paths, { spawn = spawnChild, timeoutMs = BRIDGE_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(pwshPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', RECYCLE_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish({ error: 'the recycle helper timed out' }), timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ error: error.message }));
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ error: `the recycle helper exited ${String(code)}: ${stderr.trim() || stdout.trim()}`.trim() });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        finish({ results: Array.isArray(parsed) ? parsed : [parsed] });
      } catch {
        finish({ error: `the recycle helper returned unparseable output: ${stdout.trim() || '(empty)'}` });
      }
    });
    child.stdin.on('error', () => { /* the child may exit before the write lands */ });
    child.stdin.end(JSON.stringify({ paths }));
  });
}

/** Cache of the process-wide protected bases (stable for the process). */
let protectedCache;

/**
 * Locations a removal must never touch, whatever the session workspace is.
 *
 * The bases are deliberately redundant: the environment-derived locations are combined with the
 * documented defaults and with every plausible spelling of the user profile (`USERPROFILE`,
 * `HOMEDRIVE`+`HOMEPATH`, `os.homedir()`). A caller that rewrites an environment variable — or a
 * shell that sets `ABC=C:\` and then removes `ABC` — can therefore only make the protected set
 * larger, never redirect or shrink it: the path is expanded by PowerShell before the bridge sees it
 * and this function then compares the resolved path against every base.
 */
function protectedBases() {
  if (protectedCache !== undefined) return protectedCache;
  const homes = [];
  const addHome = (value) => {
    if (typeof value !== 'string' || value.length === 0) return;
    homes.push(resolve(value));
  };
  addHome(process.env.USERPROFILE);
  const homeDrive = process.env.HOMEDRIVE;
  const homePath = process.env.HOMEPATH;
  if (typeof homeDrive === 'string' && homeDrive.length > 0 && typeof homePath === 'string' && homePath.length > 0) {
    addHome(homeDrive + homePath);
  }
  try {
    addHome(homedir());
  } catch {
    // No home from the OS: the environment-derived candidates still apply.
  }
  const uniqueHomes = [...new Set(homes)];
  const home = uniqueHomes[0] ?? '';
  const dshHome = process.env.DSH_HOME ?? (home === '' ? '' : join(home, '.dsh'));
  // The documented defaults are always protected, even when the matching environment variable is
  // absent or rewritten: an attacker can widen this set, never narrow it.
  const candidates = [
    process.env.SystemRoot, 'C:\\Windows',
    process.env.ProgramFiles, 'C:\\Program Files',
    process.env['ProgramFiles(x86)'], 'C:\\Program Files (x86)',
    process.env.ProgramData, 'C:\\ProgramData',
    dshHome,
    ...uniqueHomes.map((candidate) => join(candidate, '.dsh')),
  ];
  const roots = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    roots.push(resolve(candidate));
  }
  protectedCache = { roots: [...new Set(roots)], homes: uniqueHomes };
  return protectedCache;
}

/**
 * Whether removing `path` would be a destructive removal rather than an ordinary one.
 *
 * Refused outright: a volume root; anything inside — or an ancestor of — the Windows, Program
 * Files, Program Files (x86), ProgramData or DSH-state trees; the user profile itself or any
 * ancestor of it; and the session workspace root itself. Descendants of the user profile stay
 * allowed (a workspace may live under the home directory); descendants of the system trees do not.
 *
 * @param path - the candidate path (canonicalized by the caller).
 * @param workspaceRoot - the session workspace root the grant was issued for.
 */
export function isProtectedRemoval(path, workspaceRoot) {
  const target = resolve(path);
  if (target === '') return false;
  if (samePath(target, parse(target).root)) return true;
  const { roots, homes } = protectedBases();
  for (const base of roots) {
    if (samePath(target, base)) return true;
    if (isInside(target, base)) return true;
    if (isInside(base, target)) return true;
  }
  for (const home of homes) {
    if (samePath(target, home)) return true;
    if (isInside(home, target)) return true;
  }
  if (typeof workspaceRoot === 'string' && workspaceRoot.length > 0 && samePath(target, workspaceRoot)) return true;
  return false;
}

/** Case-insensitive on Windows, exact elsewhere. */
function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Whether `candidate` is `root` itself or sits below it (case-insensitive on Windows). */
function isInside(candidate, root) {
  const path = resolve(candidate);
  const base = resolve(root);
  if (samePath(path, base)) return true;
  const prefix = base.endsWith('\\') || base.endsWith('/') ? base : base + (process.platform === 'win32' ? '\\' : '/');
  return process.platform === 'win32'
    ? path.toLowerCase().startsWith(prefix.toLowerCase())
    : path.startsWith(prefix);
}

/**
 * Whether the volume's Recycle Bin holds a record for `path`, written at or after `notBefore`.
 *
 * The `$I` record is the only reliable evidence: the file's UTF-16LE payload carries the original
 * absolute path, and its mtime is the deletion time. Success codes are not evidence (see the header).
 */
/**
 * The `$I` record the volume's Recycle Bin holds for `path`, written at or after `notBefore`, or
 * null. The record's mtime is the deletion time and its UTF-16LE payload carries the original
 * absolute path — the only reliable evidence that a removal really was recycled.
 */
export function findBinRecord(path, notBefore) {
  const volumeRoot = parse(resolve(path)).root;
  if (volumeRoot === '') return null;
  const binDir = join(volumeRoot, '$RECYCLE.BIN');
  let sidDirs;
  try {
    sidDirs = readdirSync(binDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('S-1-'))
      .map((entry) => join(binDir, entry.name));
  } catch {
    return null;
  }
  const needle = resolve(path).toLowerCase();
  let newest = null;
  for (const dir of sidDirs) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('$I')) continue;
      const record = join(dir, name);
      try {
        const mtime = statSync(record).mtimeMs;
        if (mtime < notBefore - 5_000) continue;
        const text = readFileSync(record).toString('utf16le').toLowerCase();
        if (!text.includes(needle)) continue;
        if (newest === null || mtime > newest.mtime) newest = { record, mtime };
      } catch {
        // A record being written or removed mid-scan: the next one may match.
      }
    }
  }
  return newest === null ? null : newest.record;
}

/** Whether the volume's Recycle Bin holds a record for `path`, written at or after `notBefore`. */
export function binRecordExists(path, notBefore) {
  return findBinRecord(path, notBefore) !== null;
}

/** The payload a bin record names (`$I…` → `$R…`), or null when the name is not a record. */
export function binPayloadPath(record) {
  const name = basename(record);
  if (!name.startsWith('$I')) return null;
  return join(dirname(record), `$R${name.slice(2)}`);
}

/**
 * Put one recycled item back at its original path.
 *
 * A same-volume `rename` of the `$R` payload: timestamps, attributes and a whole directory tree
 * come back untouched, with no copy. The `$I` metadata record is removed afterwards; an orphan
 * record (a failed unlink) is harmless — Explorer ignores it — and must not fail the restore.
 *
 * @returns {{ok: boolean, detail: string}}
 */
function defaultRestoreOne(entry, destination) {
  try {
    renameSync(entry.payload, destination);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    unlinkSync(entry.record);
  } catch {
    // The item is back; a leftover $I is invisible in Explorer and costs nothing.
  }
  try {
    const stat = statSync(destination);
    if (entry.kind === 'file' && stat.size !== entry.size) {
      return { ok: false, detail: 'restored, but the size differs from the recorded deletion' };
    }
  } catch (error) {
    return { ok: false, detail: 'restored, but the result could not be verified: ' + (error instanceof Error ? error.message : String(error)) };
  }
  return { ok: true, detail: '' };
}

/** The bridge instance the host process is running, for the `shell_router` restore action. */
let activeService = null;

/** Publish the running bridge (called by the executor that owns it). */
export function setActiveRecycleService(service) {
  activeService = service;
}

/** The running bridge, or null when this process does not run one. */
export function getActiveRecycleService() {
  return activeService;
}
function canonicalOrNull(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
  response.end(body);
}

/**
 * Create the recycle bridge.
 *
 * @param options.pwshPath - the executable the unconfined helper runs (resolved lazily).
 * @param options.runRecycles - test seam replacing the helper spawn.
 * @param options.verify - test seam replacing the bin-record check.
 * @param options.startServer - false in unit tests that drive {@link RecycleService#handle} directly.
 */
export function createRecycleService(options = {}) {
  const pwshPathOf = typeof options.pwshPath === 'function' ? options.pwshPath : () => options.pwshPath;
  const runRecycles = options.runRecycles ?? ((paths) => runRecycleScript(pwshPathOf(), paths));
  const verify = options.verify ?? binRecordExists;
  const locate = options.locate ?? findBinRecord;
  /** Whether the bridge may accept paths outside the session workspace (danger-full-access). */
  const allowOutsideOf = () => (typeof options.allowOutside === 'function' ? options.allowOutside() === true : options.allowOutside === true);
  const restoreOne = options.restoreOne ?? defaultRestoreOne;

  /**
   * What this session's bridge recycled, newest last. Restore is limited to these entries: DSH can
   * undo its own deletions, never pick an arbitrary item out of the user's Recycle Bin history.
   * Deliberately in-memory — after a restart the journal is gone and the user restores in Explorer.
   */
  const journal = [];

  /** token -> { root: canonical workspace root } */
  const grants = new Map();
  let server;
  let origin;
  let closing = false;

  const start = () => {
    if (server !== undefined) return;
    server = createServer((request, response) => {
      handle(request, response).catch((error) => {
        log('recycle bridge request failed: ' + (error instanceof Error ? error.message : String(error)));
        if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
        else response.destroy();
      });
    });
    server.on('error', (error) => {
      log('recycle bridge could not listen, deletions will fail closed: ' + error.message);
      origin = undefined;
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address !== null && typeof address === 'object') origin = `http://127.0.0.1:${address.port}`;
      server.unref?.();
    });
  };

  const log = (line) => { try { console.warn('pwsh7-router: ' + line); } catch { /* logging only */ } };

  /**
   * Restore paths this session's bridge recycled: journal lookup, workspace-bound parent,
   * no-overwrite, then a same-volume move of the `$R` payload back with verification.
   */
  const restorePaths = (paths, workspaceRoot, allowOutside = false) => {
    const root = canonicalOrNull(workspaceRoot);
    if (root === null) return { results: [], error: 'the session workspace cannot be resolved' };
    const results = [];
    for (const raw of Array.isArray(paths) ? paths : []) {
      if (typeof raw !== 'string' || raw.length === 0 || !isAbsolute(raw)) {
        results.push({ path: String(raw), ok: false, detail: 'not an absolute path' });
        continue;
      }
      const target = resolve(raw);
      const entry = [...journal].reverse().find((candidate) => samePath(candidate.path, target));
      if (entry === undefined) {
        results.push({ path: target, ok: false, detail: 'no removal of this path was recorded in this session; restore it from the Recycle Bin instead' });
        continue;
      }
      if (existsSync(target)) {
        results.push({ path: target, ok: false, detail: 'the target already exists; refusing to overwrite it' });
        continue;
      }
      const parentCanonical = canonicalOrNull(dirname(target));
      if (parentCanonical === null) {
        results.push({ path: target, ok: false, detail: 'the parent folder no longer exists; restore it from the Recycle Bin' });
        continue;
      }
      if (!allowOutside && !isInside(parentCanonical, root)) {
        results.push({ path: target, ok: false, detail: 'the original location is outside this session\'s workspace' });
        continue;
      }
      if (!existsSync(entry.record) || !existsSync(entry.payload)) {
        results.push({ path: target, ok: false, detail: 'the Recycle Bin entry is gone (restored elsewhere or the bin was emptied)' });
        continue;
      }
      const outcome = restoreOne(entry, target);
      if (outcome.ok) {
        const index = journal.indexOf(entry);
        if (index !== -1) journal.splice(index, 1);
      }
      results.push({ path: target, ok: outcome.ok, detail: outcome.detail });
    }
    return { results };
  };

  const handle = async (request, response) => {
    const pathname = (request.url ?? '').split('?')[0];
    const wantsRestore = pathname === RESTORE_ENDPOINT;
    if (request.method !== 'POST' || (!wantsRestore && pathname !== RECYCLE_ENDPOINT)) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    const token = request.headers['x-dsh-recycle-token'];
    const grant = typeof token === 'string' ? grants.get(token) : undefined;
    if (grant === undefined || grant.expiresAt <= Date.now()) {
      if (grant !== undefined) grants.delete(token);
      sendJson(response, 401, { error: 'unknown or expired recycle token' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readBody(request));
    } catch (error) {
      sendJson(response, 400, { error: 'invalid body: ' + (error instanceof Error ? error.message : String(error)) });
      return;
    }
    const paths = Array.isArray(payload?.paths) ? payload.paths : null;
    if (paths === null || paths.length === 0 || paths.length > MAX_PATHS || paths.some((item) => typeof item !== 'string')) {
      sendJson(response, 400, { error: 'paths must be a non-empty array of strings' });
      return;
    }
    if (wantsRestore) {
      sendJson(response, 200, restorePaths(paths, grant.root, grant.allowOutside === true));
      return;
    }

    // Refuse anything the grant does not own BEFORE touching disk: the token is per command and
    // bound to one workspace root, so the confined shell cannot aim the bridge elsewhere.
    const checked = [];
    for (const path of paths) {
      const outcome = checkPath(path, grant);
      if (outcome.refusal !== undefined) {
        sendJson(response, 403, { error: `${path}: ${outcome.refusal}` });
        return;
      }
      checked.push(outcome.target);
    }

    const startedAt = Date.now();
    // Capture type/size BEFORE the helper runs: after a successful recycle the path is gone.
    const meta = new Map();
    for (const path of checked) {
      try {
        const stat = statSync(path);
        meta.set(path, { kind: stat.isDirectory() ? 'dir' : 'file', size: stat.size });
      } catch {
        // Vanished between validation and the helper; the per-path result reports it.
      }
    }
    const run = await runRecycles(checked);
    if (run.error !== undefined) {
      sendJson(response, 500, { error: run.error });
      return;
    }
    const byPath = new Map(run.results.map((entry) => [String(entry.path), entry]));
    const results = checked.map((path) => {
      const entry = byPath.get(path);
      const code = entry === undefined ? -1 : Number(entry.code);
      const reported = code === 0;
      // The shell reports success after a silent permanent delete; only the bin record decides.
      const verified = reported && verify(path, startedAt);
      return {
        path,
        ok: reported && verified,
        code,
        detail: entry?.detail !== undefined && entry.detail !== ''
          ? String(entry.detail)
          : reported && !verified
            ? 'the shell reported success but no Recycle Bin record was written; the item may have been deleted permanently'
            : '',
      };
    });
    if (results.some((entry) => !entry.ok)) {
      log('recycle not confirmed: ' + results.filter((entry) => !entry.ok).map((entry) => entry.path).join(', '));
    }
    for (const result of results) {
      if (!result.ok) continue;
      const record = locate(result.path, startedAt);
      if (record === null) continue;
      const info = meta.get(result.path) ?? { kind: 'file', size: 0 };
      journal.push({
        path: resolve(result.path),
        record,
        payload: binPayloadPath(record),
        kind: info.kind,
        size: info.size,
        at: Date.now(),
      });
      if (journal.length > MAX_JOURNAL) journal.shift();
    }
    sendJson(response, 200, { results });
  };

  const checkPath = (path, grant) => {
    if (!isAbsolute(path)) return { refusal: 'not an absolute path' };
    if (/[\u0000]/.test(path)) return { refusal: 'invalid path' };
    const target = resolve(path);
    let entry;
    try {
      entry = statSync(target);
    } catch {
      return { refusal: 'no such file or directory' };
    }
    const canonical = canonicalOrNull(target);
    if (canonical === null) return { refusal: 'the path cannot be resolved' };
    // Under workspace-write confinement the grant is the session workspace; danger-full-access
    // widens it (the user enabled it to reach files outside the workspace), never the protected
    // locations below.
    if (!grant.allowOutside && !isInside(canonical, grant.root)) return { refusal: 'outside this session\'s workspace' };
    if (Math.max(target.length, canonical.length) > MAX_RECYCLE_PATH) {
      return { refusal: 'path too long for a safe Recycle Bin operation (the Windows shell limit is about 260 characters); shorten it, or delete it from Explorer — nothing was deleted' };
    }
    if (isProtectedRemoval(canonical, grant.root)) {
      return {
        refusal: 'refusing a destructive removal: a volume root, the Windows / Program Files / ProgramData tree, the user profile, DSH state, or the session workspace root itself',
      };
    }
    if (!(entry.isDirectory() || entry.isFile())) return { refusal: 'not a file or directory' };
    return { target };
  };

  return {
    /** Begin listening (idempotent). */
    start,
    /** Issue a token bound to one workspace root, or null when the bridge is not listening. */
    grant(workspaceRoot, grantOptions = {}) {
      start();
      if (origin === undefined) return null;
      const root = canonicalOrNull(workspaceRoot);
      if (root === null) return null;
      const now = Date.now();
      for (const [token, entry] of grants) {
        if (entry.expiresAt <= now) grants.delete(token);
      }
      const token = randomBytes(24).toString('hex');
      grants.set(token, { root, allowOutside: grantOptions.allowOutside === true || (grantOptions.allowOutside === undefined && allowOutsideOf()), expiresAt: now + GRANT_TTL_MS });
      if (grants.size > 512) {
        // A leaked token is a bounded risk: drop the oldest rather than growing without limit.
        const oldest = grants.keys().next().value;
        if (oldest !== undefined) grants.delete(oldest);
      }
      return { url: origin, token };
    },
    /** Retire one token once its command settled. */
    revoke(token) {
      grants.delete(token);
    },
    /**
     * Restore paths this session's bridge recycled.
     *
     * Only journaled removals qualify, the original parent must still be inside the session
     * workspace, and an existing target is never overwritten. Anything else is refused with a
     * reason; the caller (shell_router) surfaces it to the user.
     *
     * @param paths - original paths as the model/user names them.
     * @param workspaceRoot - the session workspace root the caller belongs to.
     * @returns {{results: Array<{path: string, ok: boolean, detail: string}>}}
     */
    restore(paths, workspaceRoot, options = {}) {
      return restorePaths(paths, workspaceRoot, options === undefined ? allowOutsideOf() : options.allowOutside === true || (options.allowOutside === undefined && allowOutsideOf()));
    },    /** Whether this bridge currently accepts paths outside the session workspace. */
    allowOutsideNow() {
      return allowOutsideOf();
    },
    /** Test/inspection seam: a copy of the restore journal. */
    get journal() {
      return journal.slice();
    },
    /** Test/inspection seam: the current origin, when listening. */
    get url() {
      return origin;
    },
    /** Direct handler for tests (no socket). */
    handle,
    /** Stop listening and drop every grant. */
    async close() {
      closing = true;
      grants.clear();
      journal.length = 0;
      if (server === undefined) return;
      const pending = server;
      server = undefined;
      origin = undefined;
      await new Promise((resolvePromise) => pending.close(() => resolvePromise(undefined)));
    },
    get closed() {
      return closing;
    },
  };
}
