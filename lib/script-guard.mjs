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

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Script extensions whose bodies are inspected. */
const SCRIPT_REFERENCE_QUOTED = /["']([^"']+\.(?:ps1|psm1|cmd|bat))["']/gi;
const SCRIPT_REFERENCE_BARE = /(?:^|[\s(=,])([^\s"'()=,<>|]+\.(?:ps1|psm1|cmd|bat))(?=[\s)]|$)/gi;

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
  return null;
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
  for (const match of command.matchAll(/\bcmd(?:\.exe)?\b[^\n]*?\/[ck]\b\s+(?:"([^"]+\.(?:cmd|bat))"|([^\s"&|]+\.(?:cmd|bat)))/gi)) {
    add(match[1] ?? match[2]);
  }
  for (const match of command.matchAll(/\b(?:pwsh|powershell)(?:\.exe)?\b[^\n]*?-File\b\s+(?:"([^"]+\.(?:ps1|psm1))"|([^\s"&|]+\.(?:ps1|psm1)))/gi)) {
    add(match[1] ?? match[2]);
  }
  for (const match of command.matchAll(/(?:^|[;&|]\s*)[.&]\s+(?:"([^"]+\.(?:ps1|psm1|cmd|bat))"|([^\s"&|]+\.(?:ps1|psm1|cmd|bat)))/gi)) {
    add(match[1] ?? match[2]);
  }
  const first = command.trim().match(/^(?:"([^"]+\.(?:ps1|psm1|cmd|bat))"|([^\s"&|]+\.(?:ps1|psm1|cmd|bat)))(?=\s|$)/i);
  if (first !== null) add(first[1] ?? first[2]);
  const unique = [];
  for (const candidate of found) {
    if (!unique.some((seen) => seen.toLowerCase() === candidate.toLowerCase())) unique.push(candidate);
  }
  return unique;
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
export function scriptRefusalReason(command, workdir) {
  for (const reference of executedScriptReferences(command)) {
    const path = isAbsolute(reference) ? reference : resolve(workdir ?? process.cwd(), reference);
    if (!existsSync(path)) continue;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return `${reference}: the script cannot be inspected, so it cannot be checked for deletion commands; refused`;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_SCRIPT_BYTES) {
      return `${reference}: the script is too large to inspect before running; refused`;
    }
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return `${reference}: the script cannot be read, so it cannot be checked for deletion commands; refused`;
    }
    const reason = destructiveScriptContent(text);
    if (reason !== null) return `${reference}: ${reason} (script bodies are not covered by the Recycle-Bin guard; run the deletions with Remove-Item instead)`;
  }
  return null;
}
