# Changelog

All notable changes to `dsh-plugin-pwsh7` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] - 2026-11-10
### Hardened

- Inspect nested script dependencies with cycle, depth, count and byte limits; refuse unresolved
  and dynamic paths, and script invocations combined with working-directory changes.
- Remove the model-controlled script-approval comment bypass. Protection can still be explicitly
  disabled by the user in Settings; command text cannot authorize that action.
- Refuse common object/native deletion APIs, dynamic invocation/evaluation and encoded nested shells.
- Decode UTF-16 script bodies and close quoted script, module import and command separator gaps.
- Text inspection does not protect arbitrary binaries, replacement races or content overwrites.
- Prompt cost drops from 596 to 561 tokens (2,241 characters) because the old override sentence is
  replaced by the shorter "command text is not authorization" rule.

## [0.6.0] - 2026-11-10
### Hardened

- **Destructive removals are refused by the bridge**: a volume root, anything inside or above the
  Windows / Program Files / ProgramData / `~/.dsh` trees, the user profile itself or an ancestor of
  it, and the session workspace root itself. Descendants of the profile stay allowed (a workspace
  may live under it); ordinary workspace files are unaffected.
- **Forbidden command forms never reach the shell**: `Clear-RecycleBin`, `cmd /c del|erase|rd|rmdir`,
  `[System.IO.File]::Delete`, `[System.IO.Directory]::Delete`, and a nested `pwsh`/`powershell` that
  mentions a removal are rejected by the executor before spawning.
- **Over-long paths are refused instead of attempted**: measured on a 352-character path,
  `SHFileOperation` reported success, wrote no `$I` record and permanently deleted the file. Paths
  above 250 characters now fail closed, and the helper enforces the same limit.
- **An unwritable or missing Recycle Bin is refused**: the helper probes the current user's own
  bin directory (create + delete a zero-byte probe) before touching the item, so a volume where
  the shell would fail or fall back to a permanent delete is rejected instead (code -6).
- **Refusals are reported to the user**: the always-on rules now require the model to name the exact
  path and say the user can delete it themselves in Explorer when recycling is refused (too-long
  path, network/removable/non-NTFS volume, disabled or unwritable bin, over-quota item, protected
  location, or a shell that could not confirm the record) — never to try another deletion method.
- **`danger-full-access` widens the reach, never the protections**: the bridge's grant then accepts
  paths outside the session workspace (that mode exists to work on files elsewhere), while the
  protected-location, over-long-path, volume, capacity and forbidden-command refusals stay exactly
  as under `workspace-write`.
- **Deletion protection is switchable** (Settings → PowerShell 7 → Deletion protection): on by
  default; turning it off takes two consecutive warnings and then every deletion behaves like stock
  PowerShell — no prelude, bridge, script inspection or command refusals, and the basic prompt rules
  are dropped while it is off. Stored additively as `deletionGuard` in `config.json`.
- **Protected bases are redundant and resolved**: the documented defaults (`C:\Windows`, Program
  Files, Program Files (x86), ProgramData) and every plausible profile spelling are protected even
  when an environment variable is absent or rewritten; `$env:NAME` is expanded by the shell and `..`
  / links are canonicalized before the check, so `ABC=C:\` followed by removing `ABC` is refused
  exactly like `C:\`.
- **A user-approved override exists for deletion scripts**: when the user explicitly asks for one,
  the model may prefix the command with `# dsh-pwsh7: user-approved script deletions`; the scan is
  skipped for that command and a visible warning says the deletions are permanent and cannot be
  restored by DSH. The marker never unlocks the forbidden direct commands.
- **Scripts are inspected before they run** (every sandbox mode): a command that runs a
  `.ps1`/`.psm1`/`.cmd`/`.bat` file is refused when the body contains a removal command; unreadable
  or over-2 MB scripts are refused too. A script generated and run inside the same command remains
  the documented gap.- **Volumes without a Recycle Bin are refused**: a network drive / UNC share, a removable or optical
  drive, and a non-NTFS volume (FAT/exFAT/ReFS) cannot recycle — Windows deletes permanently there —
  so the helper refuses them before any operation (the volume type is probed with DriveInfo).
- **Huge items are refused before the shell runs**: the capacity pre-check now falls back to 5% of
  the volume when no explicit Recycle-Bin setting exists, so an item that cannot fit is refused
  instead of silently deleted.
- **All of the above are mode-independent**: they run before and independently of the sandbox mode,
  so `danger-full-access` cannot bypass them. (Script bodies remain the documented text-level gap.)

### Fixed

- **`Remove-Item` now really reaches the Recycle Bin under `workspace-write` confinement.** The
  shipped implementation recycled in-process (`Microsoft.VisualBasic.FileIO.FileSystem`, then
  `Shell.Application.NameSpace(10).MoveHere`) and treated "the item left its path" as success.
  Measured on a sandboxed session: the write-restricted token's write SID is granted the workspace
  and a private temp directory only — never `<volume>\$RECYCLE.BIN` — so every in-process recycle
  API was denied, Windows fell back to deleting the file permanently, and `SHFileOperation`
  returned **0** while writing no bin record. Reinstalling a plugin then failed with
  `ERR_PNPM_EPERM` because the deleted file's junction survived, and users were silently losing
  data behind a "recycle" that never happened.

### Added

- **Host-side recycle bridge** (`lib/recycle-service.mjs`). The confined command only posts the
  FileSystem target to a loopback endpoint owned by the DSH host process (random port, per-command
  token bound to the session workspace). The host runs `SHFileOperation` with
  `FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI`, so no dialog can appear, and
  then verifies the volume's `$I` record for that exact path. Only a verified record is reported as
  success; a missing record, a disabled Recycle Bin (policy / `NukeOnDelete`), an item larger than
  the volume's bin capacity, or a bridge that cannot be reached fails the command with an explicit
  error and leaves the item in place. Works in `dsh web`, DSH Desktop and headless compositions
  because the bridge lives in the plugin's host process, not in the web server.
- `lib/executors/pwsh.mjs` publishes the bridge through the **`shellEnv` registry** (the trusted
  managed-variable snapshot the pwsh tool merges last, the same channel DSH_HOME uses) and issues
  the per-execution grant from the session's workspace root. A hand-built `spec.env`/`dshEnv`
  overlay is kept only as a fallback: measured on the live host, those overlays did not reach the
  child, while the registry does. The bridge listens from construction so the first command after
  boot already has an origin. Grants expire after 15 minutes; the token is bound server-side to
  that workspace root. The grant is refused for paths outside that workspace.
- Executor members are public (`_`-prefixed): DSH's service seam can hand an executor's methods a
  Proxy receiver, and ES `#private` members fail the brand check there ("Receiver must be an
  instance of class …"), which took the whole `pwsh` tool down.
- Tests: `test/recycle-service.test.mjs` (token authority, workspace binding, verified-vs-unverified
  verdicts, helper failure, revocation) and new prelude cases (bridge success, unconfirmed recycle,
  missing bridge fails closed), plus the renamed prelude sourcing test.
- **Restore from the Recycle Bin (`shell_router` action `restore`).** The bridge journals every
  removal it verified (original path, `$I`/`$R` pair, type, size) in memory for the life of the
  process. `restore <path>` — and the same loopback endpoint's `POST /restore` — puts a journaled item back with a same-volume rename of the `$R`
  payload (timestamps, attributes and a whole tree preserved), removes the `$I` record and verifies
  the result. Only items **this session** recycled through the `pwsh` tool qualify; journaled
  entries are dropped on restart, and deletions made by scripts, native APIs or outside DSH cannot
  be restored (the tool refuses with the reason and points at Explorer). The model is required to
  tell the user, after every removal, that the item is in the Recycle Bin, that `shell_router
  restore` can undo it while this session runs, and which cases fall outside that.

### Changed

- The prelude no longer contains any in-process recycle call. When the bridge is unavailable it
  throws instead of attempting a recycle that the sandbox would turn into a permanent delete.

## [0.5.0] - 2026-11-10

### Added

- **Basic rules (always on): `Remove-Item` deletions go to the Recycle Bin.** The system-prompt
  section now always carries a deletion-safety paragraph — independent of the opt-in dialect level
  and active in every route, including the forced `pwsh5` route. It states that `Remove-Item` (and
  its aliases `rm`, `del`, `erase`, `rd`, `rmdir`, `ri`) moves files and directory trees to the
  Recycle Bin, and that `cmd /c del`, `rd /s /q`, a nested `pwsh`/`powershell` process,
  `[System.IO.File]::Delete` and `[System.IO.Directory]::Delete` are forbidden bypasses. Cost:
  about 255 tokens per request; `shell_router status` reports it.
- **Executor-level Recycle-Bin guard.** A `pwsh` command that mentions a removal command is
  prefixed with a prelude that shadows `Remove-Item` and moves each FileSystem target to the Recycle
  Bin through `Microsoft.VisualBasic.FileIO.FileSystem` (`SendToRecycleBin`), falling back to
  `Shell.Application.NameSpace(10).MoveHere` and verifying that the item actually left its path.
  There is no permanent-delete fallback: when both routes fail, the command fails with an explicit
  error and nothing is deleted. Non-FileSystem providers (registry, environment variables,
  certificates) keep their stock behavior.
- The stock module-qualified `Microsoft.PowerShell.Management\Remove-Item` spelling is rewritten to
  the redirected command, so it cannot bypass the shadowing function.
- `Remove-Item` rejects `-Filter`, `-Include`, `-Exclude`, `-Stream` and `-Credential` under the
  guard; `Get-ChildItem … | Remove-Item` selects items, and `-WhatIf`/`-Confirm` keep working.
- The Settings page's prompt-guidance hint now discloses that the basic deletion-safety rules are
  separate from the optional dialect layer and always on; the `pwsh5` copy says the deletion rule
  still applies.

### Changed

- The prompt guidance disclosure no longer implies that every prompt layer is opt-in: the dialect
  layer remains opt-in and off by default, while the basic rules always apply.
- Guarded removals deliberately differ from the stock cmdlet: a non-empty directory is recycled as a
  tree without `-Recurse`, hidden/read-only items are recycled regardless of `-Force`, `-Path` and
  `-LiteralPath` may be combined, and a wildcard with no matches writes an error instead of
  succeeding silently. Paths that cannot reach a Recycle Bin (network shares, volumes without one,
  bin quota exceeded) fail with an explicit error and leave the item in place.

## [0.4.1] - 2026-11-05

### Fixed

- **The first-run dialog no longer claims PowerShell 7 is missing when it was found.** The
  dialog's title and lead text were static; the first-run onboarding therefore always showed
  “需要 PowerShell 7 / 没有找到 pwsh.exe”, even when the host had already resolved
  `C:\Program Files\PowerShell\7\pwsh.exe`. They now follow `found`: an installed runtime shows
  “PowerShell 7 设置 / 已检测到 PowerShell 7”, while the missing copy is used only when the host
  really cannot resolve it.
- **A negative detection is re-checked immediately.** The shared router state no longer caches a
  `found: false` result for 10 seconds, so installing PowerShell 7 while DSH is running is visible
  on the next state snapshot.
- **Persisted PATH and 64-bit Program Files are also searched.** If `pwsh.exe` is in a custom
  directory or a shim (Store/winget/Chocolatey/Scoop) that was added to the registry PATH after
  DSH started, the detector now falls back to the persisted machine+user PATH. `ProgramW6432` is
  checked as well, covering a 32-bit host on a 64-bit OS.
- The Settings view prefers the executor's `found` result over a transient/empty install
  description, so it cannot show “Not found” for a working runtime.

### Added

- **First-run download defaults to the official system-wide MSI.** The setup dialog preselects
  the system scope; the current-user portable ZIP is still available.
- **Manual download/upgrade options** in the first-run dialog and Settings: an MSI download /
  MSI upgrade link (primary) plus the portable ZIP link. Until the latest-release check returns,
  the links fall back to the official releases page.

## [0.4.0] - 2026-11-05

### Fixed

- **A system-level upgrade now upgrades the main installation, not just PATH.** System scope runs
  the official PowerShell 7 `win-x64.msi` (elevated through UAC when needed), which upgrades
  `%ProgramFiles%\PowerShell\7\pwsh.exe` in place. That is the executable Windows Terminal, Win+R
  and every other launcher resolve, so the new version is visible outside DSH. The previous
  behavior extracted the portable ZIP into `%ProgramFiles%\PowerShell\7\<version>`, prepended that
  directory to the machine PATH, and left the main MSI installation untouched — which is why a
  "successful" 7.6.9 upgrade still opened 7.6.6 in Windows Terminal.
- **A side-by-side copy can no longer hide an outdated main installation.** The latest-release
  check probes the canonical system executable and reports an update when *it* is old, even if the
  plugin-managed side-by-side copy is current.
- **Legacy side-by-side system copies are removed** in the same elevated session, together with
  their machine PATH entries, once the MSI upgrade is verified. The verification happens before
  deletion, so a pending reboot keeps the old copy usable.
- **User-scope `install` also upgrades.** Reusing an existing portable copy now compares its
  version with the latest release; `Update` no longer reports "using existing" while a newer
  release exists.

### Added

- **The upgrade now detects how PowerShell 7 was originally installed** and picks the matching
  mechanism instead of assuming MSI:
  - machine/per-user **MSI** → official MSI upgrade (`ALLUSERS=1` / `ALLUSERS=0`);
  - **manual/portable ZIP** on PATH → replace that directory in place (rename → copy → verify →
    rollback on failure), so the existing PATH entry keeps resolving the upgraded executable;
  - **Chocolatey** → `choco upgrade powershell-core`;
  - **Scoop** → `scoop update pwsh` (or `-g` for a global install);
  - **Microsoft Store** → `winget upgrade … --source msstore`, with Store guidance if winget is
    unavailable;
  - **plugin-managed per-user copy** → versioned ZIP update;
  - **legacy plugin side-by-side system copy** → MSI upgrade of the canonical install plus cleanup;
  - **`DSH_PWSH_PATH` / row `pwshPath` override** → refused with an explanation instead of being
    overwritten;
  - **unknown/no install** → official MSI system install.
  The main installation is selected from the *persisted* machine+user PATH (the executable a new
  Windows Terminal resolves), with canonical/plugin fallbacks. Architecture-specific assets
  (`win-x64`, `win-arm64`, `win-x86`) are chosen from the OS architecture.
- **Forced Windows PowerShell 5.1 route (`pwsh5`).** The composer chip next to the model picker
  now offers `pwsh5` (Windows PowerShell 5.1) in addition to Off/Common/Force. Selecting it forces
  the `pwsh` tool to `…\System32\WindowsPowerShell\v1.0\powershell.exe`, disables every PowerShell 7
  prompt/dialect layer without discarding the stored level, and turns the chip border yellow. The
  settings page exposes the same route and remembers the previous route so leaving `pwsh5`
  restores it.
- `shell_router` route mode `pwsh5`, self-check/status support for the forced 5.1 executable, and
  an install-scope helper that lists legacy side-by-side system copies.

### Changed

- System install strategy: `auto`/`portable`/`msi` with `scope: "system"` all use the official MSI
  in place; `winget` remains an explicit alternative. The user scope keeps the portable ZIP.
- The settings page shows the canonical system executable and a warning when a legacy versioned
  copy is still active.
- Uninstall's junction/reparse-point detection now works on Windows directory junctions that
  Node's `lstat` reports as plain directories, and removes the junction without following it.
  It compares the real parent path plus the leaf name, so an 8.3 short path
  (`C:\Users\RUNNER~1\...`) is no longer mistaken for a junction.

## [0.3.4] - 2026-10-27

### Changed

- **The manifest now declares which DSH it is built for** (`engines.dsh: ^0.2.0-rc.2`) instead of
  only `engines.node`. Without that declaration the plugin manager and the market can only report
  `unknown` for this plugin — a host-version question no manifest answered. The range covers the
  release line it has actually been exercised on, so a newer 0.2.x host still installs and an
  incompatible line is refused up front.

- Verified against DSH desktop **0.2.1-rc.3** (the previous note named 0.2.1-rc.2). No host API
  changed between them for this plugin: the `SandboxPwshExecutor` base class, its `execute(spec)`
  seam, the `pwshPath` getter that this executor overrides, `defineTool`, and the sandbox's
  `matchesSignature` / `classifyRunnerFailure` helpers all still exist under the same names.

## [0.3.3] - 2026-10-20

### Changed

- **System installs and updates raise the UAC prompt themselves.** When the host is not elevated,
  the portable installer downloads and extracts the verified archive into the user-writable router
  temp directory, then spawns an elevated helper (`Start-Process -Verb RunAs`) that copies the tree
  into the system location and updates the machine PATH. The settings page and setup dialog no
  longer stop with "run DSH as administrator"; the job shows `waiting for administrator approval
  (UAC)` while the prompt is open, and cancelling it fails the job with a clear message while
  leaving the per-user copy untouched. A caller that injects its own administrator check keeps the
  strict preflight behavior.
- **System installs use a versioned side-by-side directory and prepend PATH.** A machine-wide
  install now lands in `…\PowerShell\7\<version>` instead of overwriting the existing installation,
  so upgrading cannot collide with a running `pwsh.exe` or with an official install's files. The
  new directory is moved to the **front** of the machine PATH (and user PATH for user-scope
  installs), so other software resolves the upgraded `pwsh`; the older directory stays behind it.
  The elevated helper also records the real PowerShell error in its result file instead of only
  an exit code. Relocation/upgrade notices no longer say "moving to system scope" for an install
  that was already system-wide.

### Fixed

- **Settings showed `Version: Unknown` while the update row named the version.** The install
  description can only infer a version from a versioned directory or `installed.pwsh.version`, so a
  system-level install at `…\PowerShell\7\pwsh.exe` had none; the update row probes `pwsh -v` and
  knew it. The probe result is now cached and used for `install.version` (and the top-level
  `version`) in every snapshot.

### Changed

- **Settings: one `Update` action**. The maintenance card no longer shows separate *update in
  user folder* / *update system-wide* buttons; it always offers the single label `Update`
  (`升级`). A user-folder installation then chooses between *Update in place* (keeps the user copy
  and its PATH entry) and *Update and move to system* (elevated relocate, removes the user copy and
  PATH entry); a system installation updates system-wide. The setup dialog keeps its two explicit
  update labels.

## [0.3.2] - 2026-10-20

### Changed

- **Host-side hot paths no longer hit the filesystem in steady state**:
  - `readRouterConfig` is cached by config `mtimeMs`/size and invalidated by every in-process
    `writeRouterConfig` (which now also bumps a monotonic generation counter);
  - `readDialect` is memoized against that generation, so model-prompt assembly does no filesystem
    access at all (measured ~0.028 ms → ~0.002 ms per assembly);
  - `getRouterState` keeps its cached detection for 10 s (was 1.5 s) and invalidates on a generation
    bump; `discoveredPortablePwshPaths` caches its `readdir` for 2 s;
  - `/pwsh7/state` snapshots reuse the generation-memoized config values (~0.39 ms → ~0.29 ms).
- **Client surfaces poll only when useful**: the setup dialog polls only while it is open (SSE
  still drives re-opening), both dialog and settings pause polling/SSE while the page is hidden,
  and the composer chip polls every 60 s instead of 15 s and skips hidden tabs.

## [0.3.1] - 2026-10-20

### Added

- **Opt-in prompt injection with two levels** (`dialect` in `config.json`, default **off**):
  - *Common PowerShell 7 guidance* (1,337 chars ≈ 335 tokens/request): states that `pwsh` is
    PowerShell 7 (not bash, not cmd) and lists the bash-only forms that fail with their PowerShell
    equivalents (`export`/`NAME=value`, `[[ ]]`, heredoc, `source`, `$(...)`, `for … do`,
    POSIX tools → cmdlets, `/dev/null` → `$null`), plus the rewrite-after-a-parser-error rule.
  - *Force PowerShell 7 mode* (1,442 chars ≈ 361 tokens/request): additionally substitutes the
    PowerShell equivalent when the request names a POSIX tool. Checking it also checks the common
    level; the level is normalized so `force` cannot be set without `common`.
  Both are selectable in the **setup dialog** and on the **Settings → PowerShell 7** page, which
  disclose the token cost and the measured lift. The prompt section reads the stored level on every
  assembly, so a change applies to the next model step with no restart.
- **`POST /pwsh7/dialect`** (`{"common": boolean, "force"?: boolean}`) persists the level additively
  and returns a fresh state snapshot; the install route accepts the same `dialect` object so the
  setup dialog can record the choice while it installs. `shell_router status` reports the active
  level, and the self-check verifies the exact routes.
- **One-time initial setup dialog even when PowerShell 7 is already present**: the overlay now opens
  on first load regardless of `found`, shows the detected version, executable, source
  (automatic detection / `DSH_PWSH_PATH` / router config) and system-vs-user scope, and lets the
  user confirm the prompt-injection level. `POST /pwsh7/onboarding` stores
  `onboarding.completed`, so later launches stay quiet; a missing executable still reopens it on
  every failed run. Confirming after an install records the same flag.
- **Latest-release check and update actions** (`POST /pwsh7/latest`): the host resolves the newest
  PowerShell 7 release, probes the installed executable and reports
  `{version, current, updateAvailable, error}` in the snapshot (cached five minutes, failures stay
  non-fatal). The setup dialog and the settings page show a compact fact list (version, executable,
  scope, source); with a user-folder copy they offer *Update in user folder* and *Install
  system-wide* (elevated, removes the user copy and its PATH entry), and with a system copy they
  offer *Update system-wide*. Dialog copy was shortened to labels instead of paragraphs.
- **Composer quick toggle** (`conversation.input.right`, beside the model selector): a compact
  `pwsh7` chip whose text and rounded border follow the level — green for forced, blue for common,
  grey for off. Clicking it opens a menu (Off / Common / Force, like the model selector's own
  menu); choosing a level asks for confirmation first (`Cancel` / `Switch`) because switching
  mid-session alters the request prefix and may drop the prompt cache; only `Switch` posts
  `POST /pwsh7/dialect`. The chip polls `/pwsh7/state` every 15 s and hides itself when the host has
  no setup routes.
- **A/B evidence for the contract** (`docs/dialect-ab.md`): on twelve bash-inviting tasks with
  5 samples each, the contract raised the correct-command rate from 38–42% to 98% (the earlier,
  shorter draft reached 67–90%); on ordinary phrasing both arms scored 100% (ceiling).
- **Failure-time dialect hint** (`lib/dialect.mjs`): a failed command's stderr gets one
  `[pwsh7]` line appended when PowerShell reports a parser error (English and zh-CN) or
  "command not recognized", mapping common POSIX names to their PowerShell 7 replacements
  (`grep` → `Select-String`, `cat` → `Get-Content`, …). Delivered by the executor's `execute`
  hook; it never changes the exit code or the command itself.

### Fixed

- **First-run dialog flashed and closed before it could be read**: the dialog opened on the first
  snapshot, then the next SSE/poll frame (`found: true`, phase `idle`) took the "installed outside
  the dialog" branch and closed it. That branch now closes only when `onboarding.completed` is
  true, so the dialog stays open until the user confirms (or dismisses it). Covered by a client
  test that replays the first load plus two state frames.

### Tests

- `test/dialect.test.mjs`: prompt levels and normalization, hint selection (parse error / unknown
  command / mapped POSIX name / non-parser failure), single-append memoization, success passthrough.
- `test/dialect-config.test.mjs`: defaults, `force` implies `common`, key preservation,
  prompt-size disclosure, the HTTP route (persist / validate / 405), and the install-route path.
- `test/client.test.mjs`: the settings page renders both levels with their disclosed cost, the
  setup dialog offers them while the force level stays disabled until common is checked, the
  detected-PowerShell state renders the compact fact list, and a user-folder copy with an available
  update renders both update buttons plus the system-removal hint.
- `test/setup.test.mjs`: the latest-release route (update detected / offline check keeps the
  installed state).
- `test/client.test.mjs` (composer chip): registration in `conversation.input.right`, the chip
  colour per level, the menu contents, and the confirmation path that posts the chosen `dialect`
  only after `Switch`.
- `test/onboarding.test.mjs`: default flag, key preservation, snapshot field, and the HTTP route
  (persist / validate / 405).

## [0.3.0] - 2026-10-19

### Added

- A **PowerShell 7 settings page** in the Web GUI (`settings.section`): PowerShell 7 status,
  version, executable and install directory, install scope/method, config path, and whether the
  installation is plugin-managed.
- **Plugin self-check** (`POST /pwsh7/selfcheck`, `shell_router action="selfcheck"`): executable,
  version, route, config, install/scope consistency, PATH entry, shipped-package resolution, sandbox
  policy, and install-job checks with `ok` / `warn` / `fail` severities.
- **Route switch** between the plugin-managed PowerShell 7 and the system default
  (`POST /pwsh7/route`, persisted as `route` in `config.json`). The system-default route resolves
  only system installations (`Program Files`, `%LOCALAPPDATA%\Programs`, Store alias, PATH entries
  outside the plugin root) and falls back to Windows PowerShell 5.1 stock behavior when no system
  PowerShell 7 exists.
- **Uninstall** of the plugin-managed per-user portable install from the settings page
  (`POST /pwsh7/uninstall`, `shell_router action="uninstall"`): removes the installed versions and
  temporary directory, drops the managed PATH entry, and keeps the routing preference. System
  installations and installations owned by other package managers are never removed.
- **Migrate to system scope** from the settings page (`POST /pwsh7/relocate`): reuses or installs
  PowerShell 7 under Program Files with a system PATH entry (administrator required), then removes the
  per-user copy and points routing at the system executable.
- Settings page live progress for install/relocate through the existing `/pwsh7/state` and
  `/pwsh7/events` stream.
- Uninstall and relocation cleanup resolve real paths and refuse to follow junctions/reparse
  points, handle a legacy `<routerRoot>\powershell7\pwsh.exe`, and report `ok:false` while any
  plugin-managed executable survives.
- Install and maintenance operations share the same single-owner busy slot (an install during
  uninstall/relocate is refused with HTTP 409), and JSON bodies over 4 KiB are rejected with 413.

### Changed

- **Installation is user-initiated only.** Nothing is installed automatically and the model-facing
  `shell_router` tool no longer starts installs or relocation: `install`/`relocate` return guidance
  to use the Web setup dialog, Settings → PowerShell 7, or a manual installation. The tool keeps
  `status`, `diagnose`, `selfcheck`, `route`, and `uninstall`.
- `/pwsh7/state` now reports `route`, `systemPath`, plugin version, install details, elevation
  availability, and job busy state.
- `shell_router status` reports the active route and installation details.
- The setup dialog and the settings page share the same install coordinator and routes.

## [0.2.2] - 2026-10-18

### Added

- User and system installation scopes in the Web dialog, setup API, and `shell_router` tool.
- System portable installation under Program Files with an administrator preflight check.
- Persistent user/system PATH updates that preserve registry value kinds and existing entries,
  avoid duplicates, refresh the host PATH, and broadcast the environment change to Windows.
- Scope-aware winget fallback and reuse of existing installations, including PATH repair.
- Windows CI tests and an npm package build command.

## [0.2.1] - 2026-10-18

### Fixed

- The bundle patch now disables the stock `pwsh-sandbox` row and inserts the router executor under
  its own id (`pwsh7-executor`). DSH's patch semantics treat a patch entry's `name` as an assertion
  against the targeted row, not as a replacement, so the previous id-targeted name change was
  skipped with a `name mismatch` warning and the `pwsh` tool kept running Windows PowerShell 5.1.
- `test/client.test.mjs` now asserts the disable-and-insert shape of the bundle patch.

## [0.2.0] - 2026-10-18

### Added

- Web setup dialog (`client.js`) in DSH's root `shell.overlay` slot. It opens when PowerShell 7 is
  missing — on load and again on every failed `pwsh` run — and shows live download bytes, total,
  percent, and phase (`downloading → extracting → verifying`).
- `Download and install`, `Cancel download`, `Retry`, and `Done` actions, with English and Chinese
  copy and DSH theme tokens.
- `GET /pwsh7/state`, `GET /pwsh7/events` (SSE with a polling fallback), `POST /pwsh7/install`, and
  `POST /pwsh7/cancel` routes, same-origin and JSON-only for state-changing calls.
- `lib/setup-service.mjs`: one process-wide install job shared by the dialog and `shell_router`,
  with progress coalescing, cancellation, phase reporting, and `missingSeq` (the "re-open on every
  run" signal).
- Installer phase callbacks (`download`, `extract`, `verify`, `winget`) so the dialog can name the
  current step, including the winget fallback.
- `test/setup.test.mjs` and `test/client.test.mjs`: coordinator, route, SSE, packaging, and render
  smoke coverage (23 new tests).

### Changed

- The routing features moved into `lib/router-features.mjs`, installed by the bare
  `dsh-plugin-pwsh7` row. That row's name is what DSH's client-module scanner uses to discover
  `client.js`; the executor row's `./pwsh-executor` subpath is not a client-bundle source.
- `shell_router install` now starts or joins the shared setup job instead of calling `ensurePwsh`
  directly; a tool call cancelled mid-install stops only a job that call started.
- The system-prompt section mentions the Web dialog and its shared job.

## [0.1.1] - 2026-10-17

### Changed

- Published through npm **Trusted Publishing** (OIDC) from GitHub Actions — no npm token, OTP, or
  repository secret is used.
- Added `.github/workflows/publish.yml`: runs on a published GitHub Release, verifies the release
  tag matches `package.json`, runs the test suite, and publishes with npm provenance.
- `publishConfig.provenance` is enabled.
- README cross-links were made absolute so they render correctly on npm.
- Added this changelog and included it in the npm package.

## [0.1.0] - 2026-10-17

### Added

- First public release.
- Windows DSH bundle that replaces the `pwsh-sandbox` executor row with a PowerShell 7 resolver,
  keeping the stock sandbox, escalation, job, and rendering behavior.
- Model-facing `shell_router` tool with `status`, `diagnose`, and `install` actions.
- Per-user automatic PowerShell 7 installation from the official GitHub release zip, with a
  winget fallback and no administrator rights.
- Bilingual README (English/Chinese), bilingual plugin-manager locale, and a PowerShell 7 icon.
- 49 unit tests (48 pass, 1 network-gated skip).

[0.5.0]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.4.1...v0.5.0
[0.3.3]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.3.2...v0.3.3
[0.4.1]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.3.4...v0.4.0
[0.3.2]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/drliuhuan/dsh-plugin-pwsh7/releases/tag/v0.1.0
