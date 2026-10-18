# dsh-plugin-pwsh7

[![npm version](https://img.shields.io/npm/v/dsh-plugin-pwsh7.svg)](https://www.npmjs.com/package/dsh-plugin-pwsh7)
[![license](https://img.shields.io/npm/l/dsh-plugin-pwsh7.svg)](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/LICENSE)

Windows DeepSeek Harness (DSH) bundle that routes the model-facing **`pwsh` tool to PowerShell 7**
(`pwsh.exe`, major version >= 7) instead of falling back to Windows PowerShell 5.1.

- The executor inherits every behavior of the stock `dsh-pwsh-sandbox` executor: sandbox modes,
  `sandbox_permissions` escalation, denial/runner-failure facts, background jobs, output caps, and
  exit markers. It only replaces executable resolution.
- When PowerShell 7 is missing, a model-facing **`shell_router`** tool reports status, diagnoses
  sandbox problems, and installs PowerShell 7 per-user (no administrator required).
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
   (`status` / `diagnose` / `install`), a small system-prompt section, and the Web setup routes.
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
plugin_manager action=install_bundle target=dsh-plugin-pwsh7@0.2.1
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
| `install` | Ensures PowerShell 7 exists. `method: "auto"` (default) prefers the per-user portable zip, then falls back to winget; `portable`/`winget` force one strategy. Existing working installations are reused instead of downloading again. |

### Setup dialog (Web)

The browser half renders into DSH's root `shell.overlay` slot, so it works in the ordinary Web GUI
and in the desktop shell without a second window:

- **When it opens:** on first load when `pwsh.exe` cannot be found, and again every time a `pwsh`
  tool run fails for that reason (`missingSeq`). "Not now" hides it until the next failed run; a
  page reload opens it again while PowerShell 7 is still missing.
- **What it does:** `Download and install` starts the same per-user job as `shell_router install`.
  The dialog shows `downloading → extracting → verifying`, transferred bytes, total, and percent.
  `Cancel download` aborts it.
- **Why one job:** the dialog and the tool share one coordinator, so a model-triggered install is
  visible in the dialog (with progress) and a dialog-triggered install is awaited by the tool.
  Concurrent installs would race on the same archive under `%LOCALAPPDATA%\dsh\pwsh7\tmp`.
- **Transport:** `GET /pwsh7/state` (snapshot), `GET /pwsh7/events` (SSE, progress coalesced to
  ~7 frames/s), `POST /pwsh7/install`, `POST /pwsh7/cancel`. SSE drives smooth progress; a 3 s
  `/pwsh7/state` poll stays active as the fallback for carriers that buffer event streams.
  These routes are same-origin and accept POST bodies only as `application/json`.
- **Failure:** the dialog keeps the installer's message, offers `Retry`, and links to the official
  PowerShell releases page. A failed install does not affect `pwsh` routing until one succeeds.
- **Scope:** the dialog belongs to the Web GUI. A headless/CLI composition still gets the
  `shell_router` tool and the same installer, just without a window.

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

### Config file

`%LOCALAPPDATA%\dsh\pwsh7\config.json`:

```json
{
  "version": 1,
  "pwshPath": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "installed": {
    "pwsh": {
      "path": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "version": "7.6.7",
      "method": "existing",
      "at": "2026-10-17T00:00:00.000Z"
    }
  },
  "updatedAt": "2026-10-17T00:00:00.000Z"
}
```

## Automatic installation

Per-user, no administrator rights:

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
- No writes outside the router root and its temp directory.
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
| `index.js` | Bare package row: installs `shell_router`, the system-prompt section, setup routes, and the reload hook |
| `client.js` | Browser half: `shell.overlay` setup dialog, SSE + polling, download/cancel actions, en/zh copy |
| `lib/shipped.mjs` | Loads the shipped `@deepseek-ai/*` packages from the running DSH installation (`app.asar`) |
| `lib/paths.mjs` | PowerShell 7 detection, version probing, `config.json` IO |
| `lib/install.mjs` | Per-user portable install (official zip) + winget fallback; progress and phase callbacks |
| `lib/state.mjs` | Process-wide resolution cache shared by the executor and the tool; missing-run signal |
| `lib/router-features.mjs` | Installs `shell_router`, the system-prompt section, the setup coordinator, and routes from the bare package row |
| `lib/setup-service.mjs` | Single install coordinator: one job, progress snapshots, cancel, `missingSeq` |
| `lib/setup-routes.mjs` | `/pwsh7/state`, `/pwsh7/events` (SSE), `/pwsh7/install`, `/pwsh7/cancel` |
| `lib/status.mjs` | `status` / `diagnose` implementations |
| `lib/executors/pwsh.mjs` | PowerShell 7 executor (extends the official `SandboxPwshExecutor`) |
| `cordis.patch.yml` | Bundle patch: disables the stock `pwsh-sandbox`, inserts the executor and bare package rows (Windows only) |
| `locale/en.json`, `locale/zh.json`, `icon.svg` | Plugin-manager display metadata |

`package.json` `files` ships only the runtime pieces; `test/` stays in the repository.

## Development

```powershell
# Plain Node tests (no running DSH required)
node --test test/paths.test.mjs test/install.test.mjs test/setup.test.mjs test/client.test.mjs
```

- 72 tests: 71 pass, 0 fail, 1 skipped (network-gated by default).
- `DSH_PWSH7_NETWORK_TESTS=1` enables the live GitHub release / HEAD checks: 30/30 pass.
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
`0.2.0` adds the Web setup dialog and moves installation into one shared coordinator.
Earlier internal iterations (0.2.x/0.3.x) included MSYS2 bash routing and used a different package
name; that scope was removed because MSYS2/Cygwin cannot start under the DSH Windows ACL sandbox.
The historical evidence stays in the build workspace (`sandbox-recon/FINDINGS.md`), not in this
package.

## Uninstall

```
plugin_manager action=remove_bundle target=dsh-plugin-pwsh7
```

The native Windows preset is restored and `pwsh` returns to DSH's default resolution. The per-user
directory `%LOCALAPPDATA%\dsh\pwsh7\` is not deleted automatically.

## License

MIT — see [LICENSE](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/LICENSE).
