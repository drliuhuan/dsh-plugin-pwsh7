// Pre-execution inspection of script files a command would run.
//
// The deletion guard is a command-text layer: `cmd /c cleanup.cmd` carries no forbidden text, so a
// script body could delete permanently behind it — and under `danger-full-access` the sandbox no
// longer contains that either. Before spawning, the executor therefore reads every script file the
// command names (`.ps1`, `.psm1`, `.cmd`, `.bat`) and refuses the command when the body contains a
// removal command.
//
// This is a speed bump, not a wall: a script can be generated and run inside one command, obfuscate
// its deletions through variables, or call a helper binary. What it does close is the everyday
// shape `cmd /c cleanup.cmd` / `powershell -File build.ps1` with an explicit `del`/`Remove-Item`
// inside. False positives (a comment mentioning Remove-Item) fail closed on purpose.

import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { destructiveCommandReason } from './rules.mjs';

/** Script extensions whose bodies are inspected. */
const SCRIPT_REFERENCE_QUOTED = /["']([^"']+\.(?:ps1|psm1|cmd|bat))["']/gi;
const SCRIPT_REFERENCE_BARE = /(?:^|[\s(=,])([^\s"'()=,<>|]+\.(?:ps1|psm1|cmd|bat))(?=[\s)]|$)/gi;

/** The line a command carries when the user explicitly asked to run a deletion script anyway. */
export const SCRIPT_OVERRIDE_MARKER = '# dsh-pwsh7: user-approved script deletions';

/**
 * Whether the command carries the explicit user-approved override.
 * @param {unknown} command the model-facing command text.
 * @returns {boolean}
 */
export function scriptOverrideRequested(command) {
  // Command text is model-controlled and cannot establish user authorization.
  // Retained as a compatibility export; no textual marker grants a bypass.
  return false;
}

/** Bigger scripts are not read: inspecting them would cost more than the refusal is worth. */
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

const DELETION_PATTERNS = Object.freeze([
  [/\bClear-RecycleBin\b/i, 'it empties the Recycle Bin'],
  [/\[(?:System\.)?IO\.(?:File|Directory)\]::Delete\b/i, 'it uses the .NET delete API'],
  [/\bcmd(?:\.exe)?\b[^\n]*\/c\b[^\n]*\b(?:del|erase|rd|rmdir)\b/i, 'it runs a cmd deletion'],
  [/\b(?:Remove-Item|Remove-ItemProperty|rm|del|erase|rd|rmdir|ri)\b/i, 'it mentions a removal command'],
]);

/**
 * Why a script body must not be run, or null when it looks free of removals.
 * @param {unknown} text the script source.
 * @returns {string | null}
 */
export function destructiveScriptContent(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const [pattern, reason] of DELETION_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return destructiveCommandReason(text);
}

/**
 * Every script path a command line names, in order, deduplicated.
 * @param {unknown} command the model-facing command text.
 * @returns {string[]}
 */
export function scriptReferencesInCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return [];
  const found = [];
  for (const match of command.matchAll(SCRIPT_REFERENCE_QUOTED)) found.push(match[1]);
  for (const match of command.matchAll(SCRIPT_REFERENCE_BARE)) found.push(match[1]);
  const unique = [];
  for (const candidate of found) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    if (!unique.some((seen) => seen.toLowerCase() === trimmed.toLowerCase())) unique.push(trimmed);
  }
  return unique;
}

/**
 * The script paths a command would RUN — not merely mention.
 *
 * Only execution positions count: `cmd /c <script>`, `pwsh|powershell -File <script>`, the call
 * and dot-source operators (`& <script>`, `. <script>`), and a script path in command position.
 * `Remove-Item cleanup.cmd` mentions a script but does not run it, so the body is not inspected —
 * otherwise a command could not even delete such a file.
 *
 * @param {unknown} command the model-facing command text.
 * @returns {string[]}
 */
export function executedScriptReferences(command) {
  if (typeof command !== 'string' || command.length === 0) return [];
  const found = [];
  const add = (value) => {
    const trimmed = value.trim();
    if (trimmed.length > 0) found.push(trimmed);
  };
  // Keep single-quoted paths separate from bare tokens: including the opening quote in a
  // filesystem lookup made ordinary '& ./script.ps1' calls silently skip inspection.
  const scriptPath = String.raw`(?:"((?:[^"\r\n]|"")+\.(?:ps1|psm1|cmd|bat))"|'((?:[^'\r\n]|'')+\.(?:ps1|psm1|cmd|bat))'|([^\s"';&|(){}]+\.(?:ps1|psm1|cmd|bat)))(?=\s|[;&|(){}]|$)`;
  const positions = [
    String.raw`\bcmd(?:\.exe)?\b[^\r\n]*?\/[ck]\b\s+`,
    String.raw`\b(?:pwsh|powershell)(?:\.exe)?\b[^\r\n]*?-File\b\s+`,
    String.raw`(?:^|[;\r\n|&({])\s*(?:[.&]\s+)?`,
    String.raw`\bImport-Module\s+(?:-Name\s+)?`,
  ];
  for (const position of positions) {
    for (const match of command.matchAll(new RegExp(position + scriptPath, 'gi'))) {
      add(match[1] !== undefined ? match[1].replaceAll('""', '"')
        : match[2] !== undefined ? match[2].replaceAll("''", "'") : match[3]);
    }
  }
  const unique = [];
  for (const candidate of found) {
    if (!unique.some((seen) => seen.toLowerCase() === candidate.toLowerCase())) unique.push(candidate);
  }
  return unique;
}

/**
 * Resolve a script reference the way the shell would: an absolute path as-is, a relative path
 * against the workdir, and a bare launcher name (`npm.cmd`, `pnpm.cmd`, …) through PATH/PATHEXT.
 * Without the PATH step every `npm.cmd` invocation was refused as "cannot be located".
 *
 * @param {string} reference
 * @param {string | undefined} workdir
 * @returns {string | null} the existing file, or null when nothing matches.
 */
export function resolveScriptPath(reference, workdir) {
  if (isAbsolute(reference)) return existsSync(reference) ? reference : null;
  const direct = resolve(workdir ?? process.cwd(), reference);
  if (existsSync(direct)) return direct;
  if (reference.includes('\\') || reference.includes('/')) return null;
  const directories = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0);
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry.length > 0);
  const hasExtension = /\.[^.\\/]+$/.test(reference);
  for (const directory of directories) {
    const candidate = join(directory, reference);
    if (existsSync(candidate)) return candidate;
    if (hasExtension) continue;
    for (const extension of extensions) {
      const withExtension = join(directory, reference + extension);
      if (existsSync(withExtension)) return withExtension;
    }
  }
  return null;
}

/**
 * Why a command must not run because one of the scripts it runs deletes, or null.
 *
 * A reference that does not exist on disk is ignored — the shell reports it. A script that exists
 * but cannot be read is refused: an uninspected body must not run.
 *
 * @param {unknown} command the model-facing command text.
 * @param {string | undefined} workdir the spawn working directory, for relative references.
 * @returns {string | null}
 */
export function scriptRefusalReason(command, workdir, inspection = { seen: new Set(), budget: { bytes: 0 }, depth: 0 }) {
  const references = executedScriptReferences(command);
  // Only a script that really sits in the workdir can be re-aimed by a directory change; a PATH
  // launcher (`Set-Location x; npm.cmd test`) is unaffected and must not be refused.
  const localRelative = references.some(
    (reference) => !isAbsolute(reference) && existsSync(resolve(workdir ?? process.cwd(), reference)),
  );
  if (localRelative && /\b(?:Set-Location|Push-Location|Pop-Location|cd|chdir|sl|pushd|popd)\b/i.test(command)) {
    return 'script execution combined with a working-directory change cannot be inspected safely; run it in a separate command with an explicit workdir';
  }
  if (inspection.depth > 32 || inspection.seen.size > 128) return 'script dependency inspection limit exceeded; refused';
  for (const reference of references) {
    if (/[$`%*?]/.test(reference)) return `${reference}: dynamic script paths cannot be inspected safely; refused`;
    const path = resolveScriptPath(reference, workdir);
    if (path === null) return `${reference}: the script cannot be located for inspection; refused`;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return `${reference}: the script cannot be inspected, so it cannot be checked for deletion commands; refused`;
    }
    if (!stat.isFile()) return `${reference}: not an inspectable script file; refused`;
    const canonical = realpathSync(path);
    const key = JSON.stringify([canonical, resolve(workdir ?? process.cwd())]);
    if (inspection.seen.has(key)) continue;
    inspection.seen.add(key);
    inspection.budget.bytes += stat.size;
    if (inspection.budget.bytes > MAX_SCRIPT_BYTES * 4) return 'script dependency byte limit exceeded; refused';
    if (stat.size > MAX_SCRIPT_BYTES) {
      return `${reference}: the script is too large to inspect before running; refused`;
    }
    let text;
    try {
      const bytes = readFileSync(path);
      if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        text = bytes.subarray(2).toString('utf16le');
      } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
      } else {
        text = bytes.toString('utf8');
      }
      // NULs indicate an unsupported encoding or binary content; never inspect a garbled body.
      if (text.includes('\0')) return `${reference}: the script encoding cannot be inspected safely; refused`;
    } catch {
      return `${reference}: the script cannot be read, so it cannot be checked for deletion commands; refused`;
    }
    const reason = destructiveScriptContent(text);
    if (reason !== null) return `${reference}: ${reason} (script bodies are not covered by the Recycle-Bin guard; run the deletions with Remove-Item instead)`;
    const nested = scriptRefusalReason(text, workdir, { ...inspection, depth: inspection.depth + 1 });
    if (nested !== null) return `${reference} -> ${nested}`;
  }
  return null;
}
