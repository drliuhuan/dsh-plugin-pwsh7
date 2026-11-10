# dsh-plugin-pwsh7

[![npm version](https://img.shields.io/npm/v/dsh-plugin-pwsh7.svg)](https://www.npmjs.com/package/dsh-plugin-pwsh7)
[![license](https://img.shields.io/npm/l/dsh-plugin-pwsh7.svg)](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/LICENSE)

Windows DeepSeek Harness (DSH) bundle that routes the model-facing **`pwsh` tool to PowerShell 7**
(`pwsh.exe`, major version >= 7) instead of falling back to Windows PowerShell 5.1.

- The executor inherits every behavior of the stock `dsh-pwsh-sandbox` executor: sandbox modes,
  `sandbox_permissions` escalation, denial/runner-failure facts, background jobs, output caps, and
  exit markers. It only replaces executable resolution.
- **Deletion safety is always on.** A basic rule in the system prompt and a prelude injected by the
  executor send every `Remove-Item` (and its aliases) to the **Recycle Bin** — files and whole
  directory trees — with no permanent-delete fallback.
- When PowerShell 7 is missing, a model-facing **`shell_router`** tool reports status, diagnoses
  sandbox problems, runs a self-check, switches routing, and removes the plugin-managed copy.
- **Installation is never automatic and is never started by the model.** When PowerShell 7 is
  missing, the Web GUI opens a setup dialog; installation only happens when the user clicks the
  install action there or in **Settings → PowerShell 7**, or when the user installs PowerShell 7
  manually.
- A **PowerShell 7 settings page** in the Web GUI shows the resolved executable, version, install
  directory, scope and method, optionally **self-checks** the whole routing stack, **switches
  routing** back to the system default, **uninstalls** a plugin-managed per-user install, and
  **migrates** a per-user install to the system scope.
- In the Web GUI, a **setup dialog** opens whenever PowerShell 7 is missing — on load and again on
  every `pwsh` run — with a download button and live progress (bytes, percent, phase). Closing it
  never cancels an install, and the next failed run re-opens it.

English | [中文说明](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/README.zh.md)

---

## Why

On Windows, DSH mounts `pwsh-sandbox` as `ctx.shell`, but the resolved executable can end up being
Windows PowerShell 5.1 in some environments. This bundle keeps the stock PowerShell executor and
overrides only its `pwshPath` resolution:

1. **Take over the `pwsh-sandbox` slot**: a DSH patch entry's `name` asserts the targeted row, it
   does not replace it, so the stock row is disabled by id and a `RouterPwshExecutor extends
   SandboxPwshExecutor` row (`id: pwsh7-executor`) is inserted. An explicit `config.pwshPath` still
   wins; otherwise the plugin-resolved PowerShell 7 is used.
2. **Insert the bare `dsh-plugin-pwsh7` row**, which registers the `shell_router` tool
   (`status` / `diagnose` / `selfcheck` / `route` / `uninstall`), a small system-prompt section, the
   setup dialog/settings routes, and the browser bundle.
   That row's name is also what DSH's client-module scanner uses to discover `client.js`; the
   executor row's `./pwsh-executor` subpath is not a client-bundle source.

## Requirements

- Windows 10/11.
- A DSH profile that supports bundles (`@deepseek-ai/dsh-base` / Web profile). Tested against
  DSH desktop 0.2.1-rc.3.
- Node.js >= 22 is only needed to run the repository test suite.

## Installation

Install from npm through the DSH plugin manager:

```
plugin_manager action=install_bundle target=dsh-plugin-pwsh7@0.5.0
```

Or install from a local checkout (a directory install links the checkout, which is convenient while
developing):

```
plugin_manager action=install_bundle target=D:\path\to\dsh-plugin-pwsh7
```

The new bundle is applied through HMR immediately. After changing the plugin's source, restart DSH
to load a fresh module generation.

## Usage

The model-facing `shell_router` tool:

| Action | What it does |
|---|---|
| `status` (default) | Resolved PowerShell 7 path and version, config file, current sandbox policy, shipped-package resolution. |
| `diagnose` | Runs real PowerShell 7 commands under the **current sandbox policy** (version + workspace write) and reports exit codes, stdout/stderr, denial/runner-failure classification, and concrete hints. |
| `install`, `relocate` | **Not performed by the tool.** They return guidance: installation is user-initiated only, from the setup dialog, Settings → PowerShell 7, or a manual install. |
| `selfcheck` | Runs the same read-only self-check as the settings page and returns `ok` / `warn` / `fail` lines. |
| `route` | Persists `route: "plugin"`, `route: "system"`, or `route: "pwsh5"` and reports the new route. `pwsh5` forces Windows PowerShell 5.1 and disables every PowerShell 7 prompt layer. |
| `uninstall` | Removes the plugin-managed per-user portable install (files, temporary directory, managed PATH entry) while keeping the routing preference. |

### Basic rules (always on): deletions go to the Recycle Bin

Unlike the dialect guidance below, the **basic rules are on by default** — they are dropped only
while the user turns Deletion protection off in Settings. They are not part of the opt-in prompt
layer, they stay active in every route (including the forced `pwsh5` route), and they cost about
**561 tokens on every request** (2,241 characters) while enabled.

Two levers enforce one contract — removed files and directories must be recoverable:

1. **System-prompt rules.** The prompt section states that removing a file or directory moves it to
   the Recycle Bin, never deletes it permanently; that `Remove-Item` and its aliases (`rm`, `del`,
   `erase`, `rd`, `rmdir`, `ri`) are redirected; and that `cmd /c del`, `rd /s /q`, a nested
   `pwsh`/`powershell` process, `[System.IO.File]::Delete` and `[System.IO.Directory]::Delete` are
   forbidden bypasses.
2. **Executor guard.** When a `pwsh` command mentions a removal command, the executor prepends a
   small prelude that shadows `Remove-Item` (the stock aliases resolve to the same function), and it
   rewrites the stock module-qualified `Microsoft.PowerShell.Management\Remove-Item` spelling to the
   redirected command so that form cannot slip past the shadow. Every FileSystem target is recycled
   by the **host-side bridge** (`lib/recycle-service.mjs`): the confined command only posts the path
   to a loopback endpoint in the DSH host, which runs `SHFileOperation` with
   `FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI` and then **verifies the
   volume's `$I` record**. The indirection is required, not decorative: under the write-restricted
   token no in-process recycle API can write `<volume>\$RECYCLE.BIN`, and measured on this
   deployment `SHFileOperation` then deletes the file permanently while still returning 0 — so the
   return code alone is never trusted. There is **no permanent-delete fallback**: if the bridge is
   missing or cannot confirm the record, the command fails with an explicit error and nothing is
   deleted. Non-FileSystem providers (registry, environment variables, certificates, …) keep their
   stock behavior through the module-qualified cmdlet.

The guard needs file paths rather than selectors, so `Remove-Item` refuses `-Filter`, `-Include`,
`-Exclude`, `-Stream` and `-Credential`; select items with `Get-ChildItem … | Remove-Item` instead.
`-WhatIf`/`-Confirm` still work (the prelude supports `ShouldProcess`). It also differs from the
stock cmdlet in deliberately narrow ways: a non-empty directory is recycled as a tree even without
`-Recurse`; hidden and read-only items are recycled regardless of `-Force`; `-Path` and
`-LiteralPath` may be combined; and a wildcard that matches nothing writes an error instead of
silently succeeding. A path on a network share, a volume without a Recycle Bin, or a file over the
bin quota cannot be recycled, so the command fails with an explicit error and the item stays put.

Items in the Recycle Bin remain recoverable but still use disk space, so the plugin never claims
that space was reclaimed and the model is told not to empty the Recycle Bin unless the user asks.

**Restore.** The bridge journals every removal it verified (original path, `$I`/`$R` pair, type and
size; in memory, bounded, cleared when DSH stops). `shell_router` action `restore` with a path puts
one of those items back, and the same loopback endpoint answers `POST /restore` with the same token — a same-volume rename of the `$R` payload, so timestamps, attributes and a
whole tree return untouched; the `$I` record is removed and the result is verified. This is
deliberately narrow: only items **this session** recycled through the `pwsh` tool can be restored.
After a DSH restart, or for deletions made by a script, a native API, or outside DSH (all of which
the text-level guard cannot see), the journal has no entry and the tool refuses with a reason —
those are restored from the Recycle Bin in Explorer. The model is required to say so after every
removal it performs.

**Destructive removals are refused.** Even inside the granted workspace, the bridge will not touch a
volume root; anything inside — or an ancestor of — the Windows, Program Files, Program Files (x86),
ProgramData or DSH-state (`~/.dsh`) trees; the user profile itself or any ancestor of it; or the
session workspace root itself. Descendants of the user profile stay allowed (a workspace may live
under the home directory), and ordinary files and folders inside the workspace are unaffected. The
refusal reaches the command as an explicit error: nothing is deleted, and the model must tell the
user the exact path so they can delete it themselves in Explorer. The Recycle Bin directory of the
current user is also probed for writability before any operation (an unwritable or missing bin is
refused, not attempted).

The protected set is compared on the **resolved** path: PowerShell expands `$env:NAME` before the
bridge sees the path, `..` segments and links are canonicalized, and the documented defaults
(`C:\Windows`, Program Files, Program Files (x86), ProgramData, and every plausible profile spelling:
`USERPROFILE`, `HOMEDRIVE`+`HOMEPATH`, `os.homedir()`) are protected even when the matching
environment variable is absent or rewritten. An environment variable can widen the protected set,
never narrow it or redirect it — `ABC=C:\` followed by removing `ABC` is refused exactly like `C:\`.

**Full access widens the reach, not the protections.** Under `danger-full-access` the bridge accepts
paths outside the session workspace — that mode exists to work on files elsewhere, and the sandbox
no longer contains anything — while every protected location, the over-long-path limit, the volume
checks and the forbidden command forms stay refused exactly as under `workspace-write`. Under
`workspace-write` the grant remains the session workspace.

**The switch.** Settings → PowerShell 7 → Deletion protection (on by default) turns the whole layer
off: the prelude, the bridge, the script inspection and the destructive-command refusals stop, and
deletions behave exactly like stock PowerShell (permanent). Turning it off takes two consecutive
confirmations; while it is off the basic prompt rules are dropped, so the model is not told to
recycle. The setting is additive in `config.json` (`deletionGuard`), so older config files keep the
protection on.

**Scripts are inspected before they run.** A command that *runs* a script it names (`.ps1`,
`.psm1`, `.cmd`, `.bat` via `cmd /c`, `pwsh -File`, the call/dot-source operators, or the script in
command position) is refused when the body contains a removal command — script bodies are outside
the text guard, and this check applies in every sandbox mode. Scripts that cannot be read, or are
larger than 2 MB, are refused rather than run uninspected. A script created and executed inside the
same command remains a documented gap.

Command comments (including the old `# dsh-pwsh7: user-approved script deletions` marker)
never authorize a bypass. Script dependencies are inspected recursively, with cycle and size/depth
limits. Missing scripts, dynamic script paths and script execution combined with a directory change
are refused. Use a separate command with an explicit working directory and perform removals through
`Remove-Item`. Common native deletion APIs, dynamic evaluation/invocation and encoded nested
PowerShell commands are also refused. Bare launcher names (`npm.cmd`, `pnpm.cmd`) are resolved
through PATH and their real file is inspected, so running the package manager through the tool
stays possible. This remains a best-effort text guard, not a security boundary: arbitrary binaries,
script replacement races, and content overwrites require separate protection.

These refusals — protected locations, over-long paths, a disabled or too-small Recycle Bin, the
forbidden command forms, and volumes without a Recycle Bin (network, removable, optical or non-NTFS)
— are applied before and independently of the sandbox mode, so they hold under `danger-full-access`
too.

The guard is a command-text layer, so a deliberately obfuscated invocation of the stock cmdlet
(resolving it through a variable, a nested shell, or a .NET API) cannot be intercepted; the basic
rules explicitly forbid those forms. Within the model's normal `Remove-Item` usage the redirection
is mechanical, not advisory.

The guard applies to commands run through the model-facing `pwsh` tool; the plugin's own elevated
maintenance scripts (`powershell.exe -File`, which delete install leftovers) are not routed through
it. `shell_router status` reports the rule and its prompt cost.

### Model guidance (PowerShell 7 dialect)

The **dialect layer** is opt-in and off by default (upgrading never starts spending its prompt
tokens; the always-on basic rules above are separate and cost about 561 tokens (2,241 characters).
Two levels are available in the **setup dialog** (when PowerShell 7 is missing) and in
**Settings → PowerShell 7 → Prompt guidance**; the choice is stored as `dialect` in `config.json` and
takes effect on the next model step without a restart.

| Level | What it adds | Cost per request |
|---|---|---|
| Common guidance | States that `pwsh` is PowerShell 7 (not bash, not cmd), lists the bash-only forms that fail beside their PowerShell replacements (`export`, `[[ ]]`, heredoc, `source`, `$(...)`, `for … do`, POSIX tools), and tells the model to rewrite after a parser error. | 1,337 chars ≈ 335 tokens |
| Force PowerShell 7 mode | Adds: substitute the PowerShell equivalent even when the request names a POSIX tool. Requires the common level (checking it also checks common). | 1,442 chars ≈ 361 tokens |

Measured on 12 bash-inviting tasks with 5 samples each (see `docs/dialect-ab.md`): 38–42% correct
commands without guidance, 98% with both levels. On ordinary phrasing both arms scored 100%, so the
cost buys reliability against bash-flavoured requests, not a general improvement.

Independently of the system prompt, when a command still fails the executor appends one actionable
`[pwsh7]` line to its stderr: a parser error (English and zh-CN) gets a syntax reminder, and a
"command not recognized" error maps common POSIX names to their PowerShell 7 replacements (`grep` →
`Select-String`, `cat` → `Get-Content`, `ls` → `Get-ChildItem`, …). The hint never changes the exit
code or the command, and is appended once per settled result.

### Composer quick toggle (Web)

The client contributes a compact **pwsh7** chip to `conversation.input.right` — the list slot the
composer renders immediately before its model selector — so it sits beside the model picker in the
input row, not in a status bar. Clicking the chip opens a small menu (like the model selector's own
menu) with three prompt levels plus a routing switch; the chip's word and rounded border carry the
state:

| Choice | Chip |
|---|---|
| Forced (common + substitution) | green text, green rounded border |
| Common guidance only | blue text, blue rounded border |
| Off | grey text, grey rounded border |
| `pwsh5` (force Windows PowerShell 5.1) | **yellow text and border; label `pwsh5`** |

Choosing a different prompt level opens an inline confirmation inside the menu: switching
mid-session changes the model request prefix and can drop the prompt cache (KV cache), so only
`Switch` posts `POST /pwsh7/dialect`; `Cancel` or an outside click leaves the stored level
untouched. Choosing `pwsh5` instead posts `POST /pwsh7/route` with `mode: "pwsh5"`: the `pwsh` tool
runs `…\System32\WindowsPowerShell\v1.0\powershell.exe`, all PowerShell 7 prompt guidance and
dialect hints are disabled (the stored level is kept), and the previous route is remembered so
leaving `pwsh5` restores it. The chip polls `/pwsh7/state` every 60 s (so a change made in Settings
shows up here) and hides itself when the host has no setup routes.

### Settings page (Web)

### Settings page (Web)

The browser half also registers a **PowerShell 7** page in the Web GUI's settings menu
(`settings.section`). It is read-only until an action is chosen:

- **Status:** resolved PowerShell 7 version and executable, install directory, config path, install
  scope and method, plugin version, and whether the install is plugin-managed/removable.
- **Routing:** one click chooses *Plugin-managed PowerShell 7*, *System default*, or *PowerShell 5.1*.
  The system-default route resolves only system installations — `Program Files`, the per-user
  Programs directory, the Store alias, and `PATH` entries outside the plugin root — and falls back
  to Windows PowerShell 5.1 when no system PowerShell 7 exists. The `PowerShell 5.1` route forces
  that executable directly and turns every PowerShell 7 prompt layer off. The choice is stored as
  `route` in `config.json` and takes effect for the next `pwsh` command.
- **Self-check:** reports executable resolution, PowerShell major version, route, config validity,
  install/scope consistency, persisted `PATH` entry, shipped-package resolution, sandbox policy, and
  a running install, each as `ok` / `warn` / `fail` with details.
- **Install/repair:** starts the same shared install job as the setup dialog (user scope), with live
  progress.
- **Migrate to system / Update system-wide:** runs the official PowerShell 7 MSI, which upgrades
  `%ProgramFiles%\PowerShell\7\pwsh.exe` in place (the executable Windows Terminal and every other
  launcher resolve). An unelevated host raises one UAC prompt; the job shows
  `waiting for administrator approval (UAC)`. After the MSI verifies the new version, the same
  elevated session removes any legacy `…\PowerShell\7\<version>` side-by-side copy and its machine
  PATH entry, then the per-user copy and routing are updated.
- **Uninstall:** available only for the plugin-managed per-user portable install. It removes the
  installed versions and temporary directory, drops the managed `PATH` entry, and leaves
  system/package-manager installations untouched.

### Setup dialog (Web)

The browser half renders into DSH's root `shell.overlay` slot, so it works in the ordinary Web GUI
and in the desktop shell without a second window:

- **When it opens:** on first load **even when `pwsh.exe` is already present** — that first run is
  the initial setup: it confirms whether PowerShell 7 exists, shows where it came from (automatic
  detection, `DSH_PWSH_PATH`, or the router config; system vs user installation), and lets the user
  choose the prompt-injection level. Confirming stores `onboarding.completed`, so later launches do
  not reopen it. While `pwsh.exe` is still missing, it also reopens on every failed `pwsh` run
  (`missingSeq`); "Not now" hides it until the next failed run, and a page reload opens it again
  while PowerShell 7 is still missing.
- **Detected state:** when PowerShell 7 is found the dialog title and lead say
  **“PowerShell 7 setup / PowerShell 7 is installed”**, never “not found”; it shows a compact fact
  list — version, executable, scope (System / Current user) and source — plus the prompt-guidance
  choices. `Done` saves the guidance and the confirmation.
- **Updates:** the dialog asks `/pwsh7/latest` for the newest release and compares it with the
  installed executable. With a user-folder copy it offers **Update in user folder** and **Install
  system-wide** (elevated; removes the user copy and its PATH entry). With a system copy it offers
  **Update system-wide**. A failed check leaves the installed state untouched and only shows the
  error line. Settings → PowerShell 7 shows the same update actions later.
- **What it does when missing:** `Download and install` starts the shared, user-initiated
  installation job. The scope defaults to **system (official MSI)**; the current-user option uses
  the portable ZIP. The dialog shows `downloading → extracting → verifying`, transferred bytes,
  total, and percent. `Cancel download` aborts it. Manual **MSI** and portable **ZIP** links are
  shown next to the download and retry/failure states.
- **Why one job:** the dialog and the settings page share one coordinator, so whichever surface the
  user starts an install from shows the same progress, and two installs cannot race on the same
  archive under `%LOCALAPPDATA%\dsh\pwsh7\tmp`. The model's `shell_router` tool never starts one.
- **Transport:** `GET /pwsh7/state` (snapshot), `GET /pwsh7/events` (SSE, progress coalesced to
  ~7 frames/s), `POST /pwsh7/install`, `POST /pwsh7/cancel`, `POST /pwsh7/dialect`,
  `POST /pwsh7/onboarding`, `POST /pwsh7/latest`. SSE drives smooth progress; a 3 s
  `/pwsh7/state` poll stays active as the fallback for carriers that buffer event streams. These
  routes are same-origin and accept POST bodies only as `application/json`.
- **Failure:** the dialog keeps the installer's message, offers `Retry`, and links to the official
  PowerShell releases page. A failed install does not affect `pwsh` routing until one succeeds.
- **Scope:** the dialog belongs to the Web GUI. A headless/CLI composition still gets `shell_router`
  status/diagnose/selfcheck and the settings routes when the Web app is composed, but installation
  without a browser is a manual step.

### Explicit paths

Resolution order for the pwsh executable:

1. `DSH_PWSH_PATH` environment variable
2. `pwshPath` in `%LOCALAPPDATA%\dsh\pwsh7\config.json`
3. `%ProgramFiles%\PowerShell\7\pwsh.exe`
4. `%LOCALAPPDATA%\dsh\pwsh7\powershell7\…\pwsh.exe` (portable installs, newest first)
5. `%LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe`
6. every `PATH` entry
7. `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` (Store alias)
8. `%ProgramFiles(x86)%\PowerShell\7\pwsh.exe`

The stock `pwsh-sandbox` row still accepts its official `pwshPath` config field; an explicit config
value takes precedence over automatic detection.

### Routing modes

`route` in `config.json` selects which executable the `pwsh` tool runs:

| Route | Resolution |
|---|---|
| `plugin` (default) | `DSH_PWSH_PATH` → `config.pwshPath` → well-known locations including the plugin-managed portable install → `PATH`; missing PowerShell 7 raises the setup hint. |
| `system` | System-installed locations only: `Program Files`, `Program Files (x86)`, `%LOCALAPPDATA%\Programs`, the Store alias, `PATH` entries outside `%LOCALAPPDATA%\dsh\pwsh7`, then Windows PowerShell 5.1 as the stock last resort. `DSH_PWSH_PATH` and `config.pwshPath` are ignored. |
| `pwsh5` | Always `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (Windows PowerShell 5.1). Every PowerShell 7 prompt/dialect layer is disabled; the always-on deletion-safety rule keeps applying; the stored prompt level is kept for when the route is left. |

The settings page switches the route at runtime (`POST /pwsh7/route`); no restart is needed.

### Config file

`%LOCALAPPDATA%\dsh\pwsh7\config.json`:

```json
{
  "version": 1,
  "route": "plugin",
  "pwshPath": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "installed": {
    "pwsh": {
      "path": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "version": "7.6.7",
      "method": "existing",
      "scope": "user",
      "at": "2026-10-17T00:00:00.000Z"
    }
  },
  "updatedAt": "2026-10-17T00:00:00.000Z"
}
```

## Installation (user-initiated)

Installation is only started by the user, from the Web setup dialog or Settings → PowerShell 7,
or by installing PowerShell 7 outside DSH. The model-facing tool never starts an install.

The first-run dialog defaults to `scope: "system"` and the official MSI; choose
`scope: "user"` for the portable ZIP. Both the first-run dialog and Settings also expose manual
**MSI** download/upgrade links (primary) and a portable ZIP link. Until the latest-release check
returns, those links fall back to the official PowerShell releases page.

| Scope | Method | Destination | Persistent PATH |
|---|---|---|---|
| `user` | portable ZIP | `%LOCALAPPDATA%\dsh\pwsh7\powershell7\<version>` | Current user (`HKCU\Environment`) |
| `system` | **official MSI, in place** | `%ProgramFiles%\PowerShell\7\pwsh.exe` (canonical; no `<version>` subdirectory) | System, managed by the official installer; the canonical directory is ensured first |

A system install/upgrade runs the official `PowerShell-<version>-win-x64.msi`. The MSI upgrades the
canonical `…\PowerShell\7\pwsh.exe` in place, so Windows Terminal, Win+R and every other launcher
see the new version — not just DSH's `pwsh` tool. An unelevated DSH host raises one UAC prompt
(`Start-Process -Verb RunAs`) and the job reports `waiting for administrator approval (UAC)`. The
elevated helper verifies the canonical executable's file version before it deletes anything; only
then does it remove legacy `…\PowerShell\7\<version>` side-by-side copies and their machine PATH
entries. If Windows scheduled the file replacement for a reboot, the legacy copy and PATH are left
alone and the job reports that a reboot/closed terminals are required.

User installation needs no elevation and keeps the existing PATH behavior (preserve value types,
avoid duplicates, refresh the host process PATH, notify Windows). Already running terminals may
need reopening after a system upgrade.

The settings page can migrate an existing per-user install to the system scope in one step
(`POST /pwsh7/relocate`): it runs the system MSI (or reuses a canonical install that is already
current), removes the per-user copy, and points the config at the canonical system executable.

To install without the Web GUI, install PowerShell 7 yourself (official MSI/Store/release zip) and
set `DSH_PWSH_PATH` or `config.json` to its `pwsh.exe`.

Download sources:

| Scope | Asset | Destination |
|---|---|---|
| `user` | `PowerShell-<version>-win-x64.zip` | `%LOCALAPPDATA%\dsh\pwsh7\powershell7\<version>\` |
| `system` | `PowerShell-<version>-win-x64.msi` | `%ProgramFiles%\PowerShell\7\pwsh.exe` (in place) |

- HTTPS streaming download into `%LOCALAPPDATA%\dsh\pwsh7\tmp`, with progress callbacks and
  cancellation. The ZIP is checked for the ZIP magic; the MSI for the OLE/Windows Installer magic.
- User scope extracts with the Windows built-in `tar.exe` (bsdtar) and runs the new `pwsh.exe` once
  to verify a major version >= 7 before writing `config.json`.
- System scope runs the official MSI with `msiexec /i … /qn /norestart ALLUSERS=1`; it does not
  extract a ZIP into Program Files. The installer is verified against `PowerShell-<version>` by
  reading the updated `pwsh.exe` file version before cleanup.
- `auto` falls back to winget only for the user scope. A system-scope failure carries the exact
  elevated MSI/winget command instead of silently installing a per-user copy.
- winget receives `--scope user` or `--scope machine`; fallback never changes the selected scope.
- Live-tested on Windows: 106,364,316-byte zip downloaded in ~31 s, extracted to 244.8 MB, verified
  `7.6.7`.

### Upgrading an existing installation (whatever installed it)

The system-side upgrade does not assume MSI. It resolves the executable a **new terminal** gets
from the persisted machine+user `PATH`, classifies its installation, and uses the mechanism that
owns it:

| Original installation | Detection | Upgrade mechanism |
|---|---|---|
| Machine-wide official MSI | uninstall registry product `PowerShell 7-x64` (HKLM) | `msiexec /i … ALLUSERS=1` in place, one UAC prompt |
| Per-user MSI | uninstall product in HKCU | `msiexec /i … ALLUSERS=0` in place (no elevation) |
| Manual/portable ZIP on `PATH` | `pwsh.exe` in a directory with no MSI/Store/package-manager marker | replace that directory: rename old → copy new → verify file version → delete old; rollback on failure. The PATH entry is unchanged |
| Chocolatey | `…\chocolatey\bin\pwsh.exe` shim | `choco upgrade powershell-core -y` (elevated when needed) |
| Scoop | `…\scoop\shims\pwsh.exe` shim | `scoop update pwsh` (global: `-g`, elevated) |
| Microsoft Store | `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` | `winget upgrade --id Microsoft.PowerShell --source msstore`; if winget is absent, the error explains how to update from Store |
| Plugin-managed per-user copy | `%LOCALAPPDATA%\dsh\pwsh7\powershell7\<version>` | download the latest ZIP into a new version directory and repoint the config |
| Legacy plugin system side-by-side copy | `%ProgramFiles%\PowerShell\7\<version>` | upgrade the canonical MSI, then remove the versioned copy and its PATH entry |
| `DSH_PWSH_PATH` / row `pwshPath` override | explicit override wins | **refused** with an explanation; update that copy with its own installer or remove the override |
| Unknown / missing | nothing detected | install the official MSI into Program Files |

The same detection also supports `win-arm64` and `win-x86` releases, chosen from the OS
architecture. A missing package manager or a failed upgrade never silently falls back to installing
a separate per-user copy: the result names the concrete recovery command.

## Sandbox behavior

- The executor runs through `ctx.sandbox.confine()` and the Windows ACL restricted-token runner, with
  the same `workspace-write` / `read-only` / `danger-full-access` semantics as the stock executor.
- PowerShell 7 works in all three modes (verified: `workspace-write` can write inside the workspace
  and is denied outside it; `danger-full-access` is unconfined).
- If the Windows sandbox reports `SetNamedSecurityInfoW failed (Win32 5)` / `grantWrite(<workspace>)`,
  the workspace DACL is missing rights. Run DSH's bundled **`diagnose-windows-sandbox-acl`** skill
  against the workspace root (it backs up and verifies), or temporarily switch the session to full
  access.

## Troubleshooting

1. Run `shell_router action="status"` and check the resolved path/version.
2. Run `shell_router action="diagnose"` to execute real commands under the current sandbox policy.
3. Common causes:
   - **Still Windows PowerShell 5.1** — detection did not find PowerShell 7. Set `DSH_PWSH_PATH` or
     the `pwshPath` config entry, then check `status` again.
   - **PowerShell 7 installed in a custom location** — set `DSH_PWSH_PATH` or `config.json`.
   - **Sandbox/ACL failure** — see the sandbox section above.

## Architecture

| Path | Role |
|---|---|
| `index.js` | Bare package row: installs `shell_router`, the system-prompt section, setup/settings routes, and the reload hook |
| `client.js` | Browser half: `shell.overlay` setup dialog plus the `settings.section` PowerShell 7 page, SSE + polling, install/route/uninstall/relocate/self-check actions, en/zh copy |
| `lib/shipped.mjs` | Loads the shipped `@deepseek-ai/*` packages from the running DSH installation (`app.asar`) |
| `lib/paths.mjs` | PowerShell 7 detection, version probing, `config.json` IO |
| `lib/route.mjs` | Routing mode (plugin/system/pwsh5) persistence, system-default and pwsh5 executable resolution, install and legacy-copy description |
| `lib/install-plan.mjs` | Detects MSI/portable/Store/Chocolatey/Scoop/plugin installs from persisted PATH + registry and chooses the upgrade strategy |
| `lib/install.mjs` | User-scope portable install (official zip), system-scope MSI/portable-in-place/package-manager upgrades, legacy copy cleanup, winget fallback; progress and phase callbacks |
| `lib/install-scope.mjs` | Registry PATH persistence/removal (preserving value kind), elevation probes, Program Files scope, system versioned-copy enumeration |
| `lib/elevate.mjs` | One-shot UAC helper: system MSI upgrade, canonical-version verification, legacy copy/PATH cleanup |
| `lib/state.mjs` | Process-wide resolution cache shared by the executor and the tool; missing-run signal |
| `lib/maintenance.mjs` | Removes a plugin-managed per-user portable install (files, temp dir, managed PATH entries) |
| `lib/selfcheck.mjs` | Read-only self-check: executable, version, route, config, install, PATH, shipped packages, sandbox, job, routes |
| `lib/router-features.mjs` | Installs `shell_router`, the system-prompt section, the setup coordinator, and routes from the bare package row |
| `lib/setup-service.mjs` | Single job coordinator: install/relocate/uninstall/route, progress snapshots, cancel, `missingSeq` |
| `lib/setup-routes.mjs` | The eight `/pwsh7/*` routes (`state`, `events`, `install`, `cancel`, `route`, `uninstall`, `relocate`, `selfcheck`) |
| `lib/status.mjs` | `status` / `diagnose` implementations |
| `lib/executors/pwsh.mjs` | PowerShell 7 executor (extends the official `SandboxPwshExecutor`), branches on the route |
| `cordis.patch.yml` | Bundle patch: disables the stock `pwsh-sandbox`, inserts the executor and bare package rows (Windows only) |
| `locale/en.json`, `locale/zh.json`, `icon.svg` | Plugin-manager display metadata |

`package.json` `files` ships only the runtime pieces; `test/` stays in the repository.

## Development

```powershell
# Plain Node tests (no running DSH required)
node --test test/*.test.mjs
```

- 141 tests: 137 pass, 0 fail, 4 skipped by default (2 environment-gated real-install probes,
  1 network-gated live GitHub check, 1 registry test restricted to GitHub Actions runners).
- `DSH_PWSH7_NETWORK_TESTS=1` enables the live GitHub release / HEAD checks.
- The environment override prefix is `DSH_PWSH7_*` (`APP_ROOT`, `TAR`, `NETWORK_TESTS`).

## Publishing (maintainers)

Releases are published by GitHub Actions through npm **Trusted Publishing** (OIDC) — no npm token,
OTP or repository secret is involved.

1. Bump `version` in `package.json`, commit and push to `main`.
2. Create and push a matching tag and publish a GitHub Release (for example `v0.2.0`).
3. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs on
   `release: published`, verifies the tag matches `package.json`, runs the test suite, and publishes
   with provenance (`npm publish --access public --provenance`).

One-time npm-side setup (already configured for this repository):

```powershell
npx npm@12 trust github dsh-plugin-pwsh7 `
  --file publish.yml `
  --repo drliuhuan/dsh-plugin-pwsh7 `
  --allow-publish --yes
```

Manual dry run: **Actions → Publish to npm → Run workflow**, keep `dry_run` checked. The workflow
then runs `npm publish --dry-run --provenance` without publishing.

Only `publish.yml` in `drliuhuan/dsh-plugin-pwsh7` is authorized to publish. Inspect or revoke the
relationship with:

```powershell
npx npm@12 trust list dsh-plugin-pwsh7
npx npm@12 trust revoke dsh-plugin-pwsh7 --id <trust-id>
```

## Versioning note

`0.1.0` was the first public release. `0.1.1` is the first release published through npm
**Trusted Publishing** (OIDC) by GitHub Actions, and fixes the npm-hosted README cross-links.
`0.2.0` adds the Web setup dialog and moves installation into one shared coordinator. `0.2.2` adds
user/system installation scopes with persistent PATH. `0.3.0` adds the settings page with self-check,
route switching, user-scope uninstall, and migration to the system scope. `0.3.1` adds the opt-in
prompt-guidance levels (with a measured A/B), latest-release checks with user/system update actions,
the one-time setup confirmation, and the composer chip beside the model selector. `0.3.2` removes
the plugin's steady-state filesystem probes and idle host polling: cached config reads and detection,
memoized prompt assembly, and client surfaces that poll only while useful. `0.3.3` raises the UAC
prompt for system installs/updates itself, installs each machine-wide release side-by-side under
`…\PowerShell\7\<version>`, and puts that directory at the front of the machine PATH so other
software resolves the upgraded `pwsh`.
Earlier internal iterations (0.2.x/0.3.x) included MSYS2 bash routing and used a different package
name; that scope was removed because MSYS2/Cygwin cannot start under the DSH Windows ACL sandbox.
The historical evidence stays in the build workspace (`sandbox-recon/FINDINGS.md`), not in this
package.

## Uninstall

To remove the plugin and restore DSH's native preset:

```
plugin_manager action=remove_bundle target=dsh-plugin-pwsh7
```

`pwsh` then returns to DSH's default resolution. The per-user directory
`%LOCALAPPDATA%\dsh\pwsh7\` is not deleted automatically by the plugin manager; use
**Settings → PowerShell 7 → Uninstall** (or `shell_router action="uninstall"`) first if you also
want to remove the plugin-managed PowerShell 7 installation and its managed `PATH` entry.

## License

MIT — see [LICENSE](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/LICENSE).
