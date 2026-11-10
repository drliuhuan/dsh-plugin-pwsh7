// Basic rules (always on): deleting files or directories must send them to the Recycle Bin.
//
// This layer is deliberately NOT part of the opt-in PowerShell 7 dialect guidance in
// ./dialect.mjs. It is mandatory, active in every route (including the forced `pwsh5` route), and
// therefore costs prompt tokens on every request:
//
//   1. buildBasicRulesPrompt — a system-prompt paragraph that states the rule: every removal goes
//      to the Recycle Bin, the `pwsh` tool enforces it, and the permanent-delete bypasses are
//      forbidden.
//   2. guardRemoval — a PowerShell prelude prepended to a `pwsh` command that mentions a removal
//      command. The prelude shadows `Remove-Item`; the stock aliases (`rm`, `del`, `erase`, `rd`,
//      `rmdir`, `ri`) resolve to the same function, so every call routes its FileSystem targets to
//      the Recycle Bin. The recycle itself happens in the HOST process (lib/recycle-service.mjs):
//      this process runs under the Windows write-restricted token, whose writable roots exclude
//      `<volume>\$RECYCLE.BIN`, so no in-process recycle API can work here — measured, the shell
//      deletes permanently and still returns success. The prelude therefore only asks the bridge,
//      and fails closed (`throw`) when the bridge is missing or reports anything but a verified
//      bin record. There is no permanent-delete fallback.
//
// Non-FileSystem providers (registry, environment variables, certificates, ...) keep their stock
// behavior through the module-qualified cmdlet: the rule is about files on disk, and `pwsh5`
// routes still need `Remove-Item Env:NAME` to work.
//
// Everything here is pure (no host, no filesystem, no PowerShell process), so the contract can be
// exercised on any OS; the prelude itself is validated against a real `pwsh` separately.

/** Comment at the top of the prepended prelude; also the idempotence marker. */
export const RECYCLE_GUARD_MARKER = '# dsh-plugin-pwsh7 basic rule: deletions go to the Recycle Bin';

/** The command aliases that must keep resolving to the interception function. */
export const REMOVAL_TOKENS = Object.freeze([
  'remove-item',
  'rm',
  'del',
  'erase',
  'rd',
  'rmdir',
  'ri',
]);

/**
 * Commands that are refused before the shell even starts because they either empty the Recycle
 * Bin or delete permanently — the two things the guard exists to prevent. This is a text-level
 * speed bump (a script can hide its body from it), but it catches the direct forms the model is
 * forbidden to use.
 */
const DESTRUCTIVE_COMMANDS = Object.freeze([
  [/\bClear-RecycleBin\b/i, 'emptying the Recycle Bin is forbidden'],
  [/\bcmd(?:\.exe)?\b[^\n]*?\/c\b[^\n]*?\b(?:del|erase|rd|rmdir)\b/i, 'cmd /c del, erase, rd and rmdir delete permanently; use Remove-Item instead'],
  [/\[System\.IO\.File\]::Delete\b/i, 'the .NET File::Delete API deletes permanently; use Remove-Item instead'],
  [/\[System\.IO\.Directory\]::Delete\b/i, 'the .NET Directory::Delete API deletes permanently; use Remove-Item instead'],
  [/\b(?:pwsh|powershell)(?:\.exe)?\b[^\n]*?\b(?:del|erase|rd|rmdir|remove-item|clear-recyclebin)\b/i, 'a nested shell that mentions a removal command is a permanent-delete bypass'],
]);

/**
 * Why a command must be refused outright, or null when it may run.
 * @param {unknown} command the model-facing command text.
 * @returns {string | null}
 */
export function destructiveCommandReason(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  for (const [pattern, reason] of DESTRUCTIVE_COMMANDS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

/**
 * A removal command token outside the js filter itself: word-ish boundaries so `form` or `term`
 * never match, while `$rm`, `Remove-Item` and module-qualified forms still do (a false positive
 * only prepends harmless definitions).
 */
const REMOVAL_TOKEN = new RegExp(`(?<![\\w.-])(?:${REMOVAL_TOKENS.join('|')})(?![\\w-])`, 'i');

/**
 * The always-on rules paragraph. Kept in one frozen list so tests, docs and the disclosure sizes
 * cannot drift from the prompt.
 */
export const BASIC_RULES = Object.freeze([
  'Deletion safety is a basic, always-on rule of this deployment: removing a file or a directory must move it to the Recycle Bin, never delete it permanently.',
  'The `pwsh` tool enforces the rule: `Remove-Item` — and its aliases `rm`, `del`, `erase`, `rd`, `rmdir`, `ri` — moves files and whole directory trees to the Recycle Bin, and the module-qualified `Microsoft.PowerShell.Management\\Remove-Item` form is rewritten to the redirected command.',
  'Do not bypass it with `cmd /c del`, `rd /s /q`, a nested `pwsh`/`powershell` process, `[System.IO.File]::Delete` / `[System.IO.Directory]::Delete`, or `Clear-RecycleBin`: the tool refuses those commands outright, and they delete permanently. Remove files only through `pwsh` + `Remove-Item`.',
  '`Remove-Item` refuses `-Filter`, `-Include`, `-Exclude`, `-Stream` and `-Credential` here; use `Get-ChildItem … | Remove-Item` to select items, and `-WhatIf` to preview.',
  'Items in the Recycle Bin are recoverable but still use disk space; never empty the Recycle Bin or claim that space was reclaimed unless the user explicitly asks.',
  'If a removal is refused because the item cannot be recycled — a path too long for the Windows shell, a network/removable/optical/non-NTFS volume, a disabled or unwritable Recycle Bin, an item over the bin quota, a protected location, or a record the shell could not confirm — tell the user the exact path and that they can delete it themselves in Explorer; never attempt another deletion method.',
  'A script that contains deletion commands is refused before it runs. Only when the user explicitly asks you to run that exact script, put the line # dsh-pwsh7: user-approved script deletions at the top of the command — never on your own initiative — and tell the user in the same reply that whatever it deletes is gone permanently and cannot be restored by DSH.',
  'After every successful removal, tell the user where the item went and how to get it back: it is in the Recycle Bin (restorable there in Explorer), and DSH can put it back for the rest of this session with the `shell_router` tool\'s `restore` action, passing the original path. DSH can only restore items THIS session recycled through the `pwsh` tool: after a DSH restart, for anything deleted by a script or a native API (which bypass the guard), or for items deleted outside DSH, DSH cannot restore it — the user restores those from the Recycle Bin themselves.',
]);

/**
 * The system-prompt paragraph for the always-on rules.
 * @returns {string} space-joined rules text (never empty).
 */
export function buildBasicRulesPrompt() {
  return BASIC_RULES.join(' ');
}

/**
 * Prompt cost disclosure for the rules paragraph, in the same shape the dialect layer reports
 * (characters and ~4 characters per token).
 * @returns {{ chars: number, tokens: number }}
 */
export function basicRulesPromptSizes() {
  const chars = buildBasicRulesPrompt().length;
  return { chars, tokens: Math.ceil(chars / 4) };
}

/**
 * Whether a command mentions a removal command and therefore needs the Recycle-Bin prelude.
 * @param {unknown} command the model-facing command text.
 * @returns {boolean}
 */
export function needsRecycleGuard(command) {
  return typeof command === 'string' && REMOVAL_TOKEN.test(command);
}

/**
 * The stock cmdlet's module-qualified spelling. It matches REMOVAL_TOKEN (so the guard is
 * prepended) but would resolve straight to the stock cmdlet and bypass the shadow, so the guard
 * rewrites it to the bare command name. Only Microsoft.PowerShell.Management exports Remove-Item.
 */
const MODULE_QUALIFIED_REMOVAL = /Microsoft\.PowerShell\.Management\\Remove-Item\b/gi;

/**
 * Rewrite the module-qualified stock form to the bare `Remove-Item` command so the prelude's
 * function shadow applies. A no-op for every other command (and for non-strings).
 * @param {unknown} command the model-facing command text.
 * @returns {unknown} the normalized command text (same value when nothing matched).
 */
export function normalizeRemovalCommand(command) {
  if (typeof command !== 'string') return command;
  return command.replace(MODULE_QUALIFIED_REMOVAL, 'Remove-Item');
}

/**
 * The PowerShell prelude that routes removals to the Recycle Bin.
 *
 * `String.raw` keeps the single backslashes of the module-qualified `Remove-Item` call literal; the
 * only interpolation is the marker line at the top, so the generated PowerShell is otherwise
 * verbatim. The function is a proxy in spirit: parameters mirror the stock cmdlet closely enough
 * for agent commands, `-WhatIf`/`-Confirm` arrive through SupportsShouldProcess, and every
 * FileSystem target is handed to the host recycle bridge. `throw` is the only failure path, so a
 * recycle the bridge cannot confirm can never degrade into a permanent delete. The bridge URL and
 * per-command token arrive as environment variables the executor injects
 * (lib/executors/pwsh.mjs); without them the function refuses rather than deleting.
 */
export const RECYCLE_GUARD_PRELUDE = String.raw`${RECYCLE_GUARD_MARKER}
function Remove-Item {
  [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
  param(
    [Parameter(Position = 0, ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true)]
    [string[]] $Path,
    [Parameter(ValueFromPipelineByPropertyName = $true)]
    [Alias('PSPath', 'LP')]
    [string[]] $LiteralPath,
    [switch] $Recurse,
    [switch] $Force,
    [string] $Filter,
    [string[]] $Include,
    [string[]] $Exclude,
    [string[]] $Stream,
    [System.Management.Automation.PSCredential] $Credential
  )
  process {
    $unsupported = @('Filter', 'Include', 'Exclude', 'Stream', 'Credential') | Where-Object { $PSBoundParameters.ContainsKey($_) }
    if (@($unsupported).Count -gt 0) {
      throw ('Remove-Item here only moves items to the Recycle Bin and does not support -' + ((@($unsupported)) -join ', -') + '. Select items with Get-ChildItem and pipe them into Remove-Item instead.')
    }
    $requested = @()
    if ($PSBoundParameters.ContainsKey('LiteralPath')) { $requested += [pscustomobject]@{ Values = $LiteralPath; Literal = $true } }
    if ($PSBoundParameters.ContainsKey('Path')) { $requested += [pscustomobject]@{ Values = $Path; Literal = $false } }
    $seen = @{}
    foreach ($request in $requested) {
      foreach ($candidate in @($request.Values)) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if ($request.Literal) {
          $resolved = @(Resolve-Path -LiteralPath $candidate -ErrorAction SilentlyContinue)
        } else {
          $resolved = @(Resolve-Path -Path $candidate -ErrorAction SilentlyContinue)
        }
        if ($resolved.Count -eq 0) {
          Write-Error ("Cannot find path '" + $candidate + "' because it does not exist.")
          continue
        }
        foreach ($entry in $resolved) {
          # entry.Path keeps the provider-qualified form (Env:NAME, HKCU:..., C:\dir) that Get-Item
          # accepts; entry.ProviderPath is a filesystem path only for the FileSystem provider.
          $item = Get-Item -LiteralPath $entry.Path -Force -ErrorAction SilentlyContinue
          if ($null -eq $item) { continue }
          if ($item.PSProvider.Name -ne 'FileSystem') {
            Microsoft.PowerShell.Management\Remove-Item -LiteralPath $item.PSPath -Recurse:$Recurse.IsPresent -Force:$Force.IsPresent -ErrorAction Stop
            continue
          }
          $key = $item.FullName.ToLowerInvariant()
          if ($seen.ContainsKey($key)) { continue }
          $seen[$key] = $true
          if (-not $PSCmdlet.ShouldProcess($item.FullName, 'Move to Recycle Bin')) { continue }
          # The recycle itself is done by the pwsh7 host bridge, NOT here: this process runs under
          # the Windows write-restricted token, whose writable roots exclude <volume>\$RECYCLE.BIN.
          # Every in-process recycle API therefore fails there — and the shell then deletes the
          # file permanently while still reporting success — so this process only asks the host.
          $bridgeUrl = $env:DSH_PWSH7_RECYCLE_URL
          $bridgeToken = $env:DSH_PWSH7_RECYCLE_TOKEN
          if ([string]::IsNullOrWhiteSpace($bridgeUrl) -or [string]::IsNullOrWhiteSpace($bridgeToken)) {
            throw ("Remove-Item here sends removals to the Recycle Bin through the pwsh7 host bridge, which is not available in this process. Nothing was deleted: '" + $item.FullName + "'")
          }
          $payload = '{"paths":["' + $item.FullName.Replace('\', '\\').Replace('"', '\"') + '"]}'
          try {
            $response = Invoke-RestMethod -Method Post -Uri ($bridgeUrl.TrimEnd('/') + '/recycle') -Headers @{ 'x-dsh-recycle-token' = $bridgeToken } -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 120
          } catch {
            $why = $_.Exception.Message
            if ($null -ne $_.ErrorDetails -and -not [string]::IsNullOrWhiteSpace($_.ErrorDetails.Message)) { $why = $_.ErrorDetails.Message.Trim() }
            throw ("Could not move '" + $item.FullName + "' to the Recycle Bin; nothing was deleted permanently. " + $why)
          }
          $result = @($response.results) | Where-Object { $_.path -eq $item.FullName } | Select-Object -First 1
          if ($null -eq $result -or $result.ok -ne $true) {
            $why = if ($null -ne $result -and $result.detail) { [string]$result.detail } else { 'the recycle bridge returned no result for this path' }
            throw ("Could not move '" + $item.FullName + "' to the Recycle Bin; nothing was deleted permanently. " + $why)
          }
        }
      }
    }
  }
}`;

/**
 * Add the Recycle-Bin prelude to a resolved execution spec when the command removes something, and
 * neutralize the module-qualified `Remove-Item` spelling so the prelude's shadow always applies.
 * Preserves every other spec field and never mutates the input. Already-guarded commands are
 * returned unchanged.
 *
 * @param {{ command?: unknown }} spec resolved execution spec (see the pwsh executor).
 * @returns {object} the original spec, or a shallow copy with the guarded command.
 */
export function guardRemoval(spec) {
  if (spec === undefined || spec === null || typeof spec !== 'object') return spec;
  if (!needsRecycleGuard(spec.command)) return spec;
  if (spec.command.startsWith(RECYCLE_GUARD_PRELUDE)) return spec;
  const command = normalizeRemovalCommand(spec.command);
  return { ...spec, command: `${RECYCLE_GUARD_PRELUDE}\n${command}` };
}
