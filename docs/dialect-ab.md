# Dialect contract A/B — does listing the bash mistakes help?

Question: with the same task set, does a system prompt that lists bash-only forms **and their
PowerShell replacements** produce more correct PowerShell 7 commands than a prompt that only names
the dialect?

## Method

- Model: `deepseek-chat`, temperature 0.3, 5 samples per task per condition (one run).
- Two arms, identical except for the extra paragraph:
  - **with**: base paragraph (`You are a coding agent on Windows… one pwsh -Command string`) plus
    `DIALECT_PROMPT`;
  - **without**: the base paragraph only.
- Task set (deliberately bash-inviting; each asks for one command, no explanation):
  grep for TODO, set `FOO=bar`, heredoc, `for` loop, `find -delete`, `2>/dev/null`, `awk` sum,
  `xargs`, `head`, `sed` replace, `chmod +x`, pipe through grep.
- Scoring (`score.ps1`): a command counts as correct when PowerShell's own
  `Parser::ParseInput` reports zero errors **and** no bash-only marker is present (POSIX tool names,
  `export`, `[[`, heredoc, `VAR=value cmd`, `/dev/null`, `bash -c`, …). Nothing is executed.
- Token cost (both levels are opt-in in the plugin, default off): common guidance 1,337 characters
  (~335 tokens) per request; forced mode 1,442 characters (~361 tokens).

## Results

| Run | Arm with contract | Arm without | Notes |
|---|---|---|---|
| 1. ordinary phrasing, 12 tasks × 2 | 24/24 (100%) | 24/24 (100%) | ceiling: capable models already know PS7 |
| 2. bash-inviting, first draft | 40/60 (67%) | 23/60 (38%) | `for`, `find`, `/dev/null` failures dominate |
| 3. + `awk`/`sed`/`xargs`/`chmod` mappings | 54/60 (90%) | 22/60 (37%) | coverage of the list matters |
| 4. + "substitute even if the request names a POSIX tool" | **59/60 (98%)** | 25/60 (42%) | one `chmod` sample still complied |

Final run per task (with / without):

| Task | with | without |
|---|---|---|
| grep for TODO | 5/5 | 5/5 |
| `FOO=bar` then node | 5/5 | 5/5 |
| heredoc | 5/5 | 5/5 |
| `for a b c` | 5/5 | 0/5 |
| `find -delete` | 5/5 | 0/5 |
| `2>/dev/null` | 5/5 | 0/5 |
| `awk` sum | 5/5 | 0/5 |
| `xargs` | 5/5 | 1/5 |
| `head` | 5/5 | 4/5 |
| `sed -i` | 5/5 | 0/5 |
| `chmod +x` | 4/5 | 0/5 |
| pipe through grep | 5/5 | 5/5 |

## Caveats

- Small sample (60 answers per arm, one run, one model, one temperature). The control arm varied
  37–42% across runs, so treat differences below ~5 points as noise.
- Tasks 2–4 deliberately use bash vocabulary; on ordinary phrasing the arms tie at 100%.
- The score is static (parse + markers), not execution: a "correct" command can still be
  semantically wrong, and a legitimate `-Head` parameter could be misread as POSIX `head` (checked
  samples manually).
- `chmod` is a compliance trap — the request literally names the tool. The added substitution
  sentence fixes most of it (4/5); a genuine equivalent is not always available (`icacls` changes
  ACLs, not POSIX mode bits).
- The harness lives outside the package (`../../ab-experiment/`): `run.mjs` calls the provider, then
  `score.ps1` grades `results.json`. The API key is read from `%USERPROFILE%\.dsh\.credentials.yaml`
  at runtime and never printed.
