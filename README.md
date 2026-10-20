# dsh-plugin-pwsh7

[![npm version](https://img.shields.io/npm/v/dsh-plugin-pwsh7.svg)](https://www.npmjs.com/package/dsh-plugin-pwsh7)
[![license](https://img.shields.io/npm/l/dsh-plugin-pwsh7.svg)](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/LICENSE)

Windows DeepSeek Harness (DSH) bundle that routes the model-facing **`pwsh` tool to PowerShell 7**
(`pwsh.exe`, major version >= 7) instead of falling back to Windows PowerShell 5.1.

- The executor inherits every behavior of the stock `dsh-pwsh-sandbox` executor: sandbox modes,
  `sandbox_permissions` escalation, denial/runner-failure facts, background jobs, output caps, and
  exit markers. It only replaces executable resolution.
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
  DSH desktop 0.2.1-rc.2.
- Node.js >= 22 is only needed to run the repository test suite.

## Installation

Install from npm through the DSH plugin manager:

```
plugin_manager action=install_bundle target=dsh-plugin-pwsh7@0.3.2
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
| `route` | Persists `route: "plugin"` or `route: "system"` and reports the new route. |
| `uninstall` | Removes the plugin-managed per-user portable install (files, temporary directory, managed PATH entry) while keeping the routing preference. |

### Model guidance (PowerShell 7 dialect)

Prompt injection is **opt-in and off by default** (upgrading never starts spending prompt tokens).
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
menu) with three levels; the chip's word and rounded border carry the state:

| Level | Chip |
|---|---|
| Forced (common + substitution) | green text, green rounded border |
| Common guidance only | blue text, blue rounded border |
| Off | grey text, grey rounded border |

Choosing a different level opens an inline confirmation inside the menu: switching mid-session
changes the model request prefix and can drop the prompt cache (KV cache), so only `Switch` posts
`POST /pwsh7/dialect`; `Cancel` or an outside click leaves the stored level untouched. The chip
polls `/pwsh7/state` every 15 s (so a change made in Settings shows up here) and hides itself when
the host has no setup routes.

### Settings page (Web)

### Settings page (Web)

The browser half also registers a **PowerShell 7** page in the Web GUI's settings menu
(`settings.section`). It is read-only until an action is chosen:

- **Status:** resolved PowerShell 7 version and executable, install directory, config path, install
  scope and method, plugin version, and whether the install is plugin-managed/removable.
- **Routing:** one click toggles between *Plugin-managed PowerShell 7* and *System default*. The
  system-default route resolves only system installations — `Program Files`, the per-user Programs
  directory, the Store alias, and `PATH` entries outside the plugin root — and falls back to stock
  DSH behavior (Windows PowerShell 5.1) when no system PowerShell 7 exists. The choice is stored as
  `route` in `config.json` and takes effect for the next `pwsh` command.
- **Self-check:** reports executable resolution, PowerShell major version, route, config validity,
  install/scope consistency, persisted `PATH` entry, shipped-package resolution, sandbox policy, and
  a running install, each as `ok` / `warn` / `fail` with details.
- **Install/repair:** starts the same shared install job as the setup dialog (user scope), with live
  progress.
- **Migrate to system:** installs PowerShell 7 under Program Files with a system `PATH` entry
  (administrator required), then removes the per-user copy and points routing at the system
  executable. An unelevated DSH host is told exactly what to do instead of hanging on UAC.
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
- **Detected state:** when PowerShell 7 is found the dialog shows a compact fact list — version,
  executable, scope (System / Current user) and source — plus the prompt-guidance choices. `Done`
  saves the guidance and the confirmation.
- **Updates:** the dialog asks `/pwsh7/latest` for the newest release and compares it with the
  installed executable. With a user-folder copy it offers **Update in user folder** and **Install
  system-wide** (elevated; removes the user copy and its PATH entry). With a system copy it offers
  **Update system-wide**. A failed check leaves the installed state untouched and only shows the
  error line. Settings → PowerShell 7 shows the same update actions later.
- **What it does when missing:** `Download and install` starts the shared, user-initiated
  installation job. The dialog shows `downloading → extracting → verifying`, transferred bytes,
  total, and percent. `Cancel download` aborts it.
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

Choose `scope: "user"` (default) or `scope: "system"` in the Web dialog.

| Scope | Destination | Persistent PATH |
|---|---|---|
| `user` | `%LOCALAPPDATA%\dsh\pwsh7\powershell7\<version>` | Current user (`HKCU\Environment`) |
| `system` | `%ProgramFiles%\PowerShell\7` | System (`HKLM` environment) |

System installation requires starting the DSH host as administrator; an unelevated host fails before downloading. User installation needs no elevation. Both preserve existing PATH entries and registry value types, avoid duplicate entries, refresh the host process PATH, and notify Windows. Already running terminals may need reopening. PATH write failures are reported as installation failures.

The settings page can migrate an existing per-user install to the system scope in one step
(`POST /pwsh7/relocate`): it installs/reuses the Program Files copy, writes the system PATH, removes
the per-user copy, and points the config at the system executable.

To install without the Web GUI, install PowerShell 7 yourself (official MSI/Store/release zip) and
set `DSH_PWSH_PATH` or `config.json` to its `pwsh.exe`.

Portable download source:

| Component | Source | Destination |
|---|---|---|
| PowerShell 7 | Latest `PowerShell/PowerShell` GitHub release, `PowerShell-*-win-x64.zip` | `%LOCALAPPDATA%\dsh\pwsh7\powershell7\<version>\` |

- HTTPS streaming download into `%LOCALAPPDATA%\dsh\pwsh7\tmp`, with progress callbacks and
  cancellation.
- Extraction uses the Windows built-in `tar.exe` (bsdtar). No downloaded installer is ever executed.
- After extraction the new `pwsh.exe` is executed once to verify a major version >= 7 before it is
  written into `config.json`.
- `auto` falls back to `winget install Microsoft.PowerShell`; when elevation would be required the
  result carries the exact manual elevated command instead of hanging on UAC.
- winget receives `--scope user` or `--scope machine`; fallback never changes the selected scope.
- Live-tested on Windows: 106,364,316-byte zip downloaded in ~31 s, extracted to 244.8 MB, verified
  `7.6.7`.

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
| `lib/route.mjs` | Routing mode persistence, system-default executable resolution, install description |
| `lib/install.mjs` | User/system-scope portable install (official zip) + winget fallback; progress and phase callbacks |
| `lib/install-scope.mjs` | Registry PATH persistence/removal (preserving value kind), elevation probes, Program Files scope |
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
memoized prompt assembly, and client surfaces that poll only while useful.
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
