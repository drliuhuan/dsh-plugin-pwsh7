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

English | [中文说明](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/README.zh.md)

---

## Why

On Windows, DSH mounts `pwsh-sandbox` as `ctx.shell`, but the resolved executable can end up being
Windows PowerShell 5.1 in some environments. This bundle keeps the stock PowerShell executor and
overrides only its `pwshPath` resolution:

1. **Replace the `pwsh-sandbox` row** with `RouterPwshExecutor extends SandboxPwshExecutor`. An
   explicit `config.pwshPath` still wins; otherwise the plugin-resolved PowerShell 7 is used.
2. **Register the `shell_router` tool** (`status` / `diagnose` / `install`) plus a small system-prompt
   section describing the routing.

## Requirements

- Windows 10/11.
- A DSH profile that supports bundles (`@deepseek-ai/dsh-base` / Web profile). Tested against
  DSH desktop 0.2.1-rc.2.
- Node.js >= 22 is only needed to run the repository test suite.

## Installation

Install from npm through the DSH plugin manager:

```
plugin_manager action=install_bundle target=dsh-plugin-pwsh7@0.1.0
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
| `index.js` | Plugin entry: `shell_router` tool, system-prompt section, state refresh on config reload |
| `lib/shipped.mjs` | Loads the shipped `@deepseek-ai/*` packages from the running DSH installation (`app.asar`) |
| `lib/paths.mjs` | PowerShell 7 detection, version probing, `config.json` IO |
| `lib/install.mjs` | Per-user portable install (official zip) + winget fallback |
| `lib/state.mjs` | Process-wide resolution cache shared by the executor and the tool |
| `lib/status.mjs` | `status` / `diagnose` implementations |
| `lib/executors/pwsh.mjs` | PowerShell 7 executor (extends the official `SandboxPwshExecutor`) |
| `cordis.patch.yml` | Bundle patch: replaces `pwsh-sandbox` and inserts the plugin row (Windows only) |
| `locale/en.json`, `locale/zh.json`, `icon.svg` | Plugin-manager display metadata |

`package.json` `files` ships only the runtime pieces; `test/` stays in the repository.

## Development

```powershell
# Plain Node tests (no running DSH required)
node --test test/paths.test.mjs test/install.test.mjs
```

- 49 tests: 48 pass, 0 fail, 1 skipped (network-gated by default).
- `DSH_PWSH7_NETWORK_TESTS=1` enables the live GitHub release / HEAD checks: 30/30 pass.
- The environment override prefix is `DSH_PWSH7_*` (`APP_ROOT`, `TAR`, `NETWORK_TESTS`).

## Versioning note

`0.1.0` is the first public release. Earlier internal iterations (0.2.x/0.3.x) included MSYS2 bash
routing and used a different package name; that scope was removed because MSYS2/Cygwin cannot start
under the DSH Windows ACL sandbox. The historical evidence stays in the build workspace
(`sandbox-recon/FINDINGS.md`), not in this package.

## Uninstall

```
plugin_manager action=remove_bundle target=dsh-plugin-pwsh7
```

The native Windows preset is restored and `pwsh` returns to DSH's default resolution. The per-user
directory `%LOCALAPPDATA%\dsh\pwsh7\` is not deleted automatically.

## License

MIT — see [LICENSE](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/LICENSE).
