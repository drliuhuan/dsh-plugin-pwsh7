# Changelog

All notable changes to `dsh-plugin-pwsh7` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.1]: https://github.com/drliuhuan/dsh-plugin-pwsh7/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/drliuhuan/dsh-plugin-pwsh7/releases/tag/v0.1.0
