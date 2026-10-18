# Changelog

All notable changes to `dsh-plugin-pwsh7` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.1]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/drliuhuan/dsh-plugin-pwsh7/releases/tag/v0.1.0
