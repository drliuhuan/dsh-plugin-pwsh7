// PowerShell 7 dialect guidance for the model and a post-failure correction hint.
//
// Two levers keep the agent from writing bash syntax in a PowerShell shell:
//   1. buildDialectPrompt — a system-prompt paragraph naming the dialect and the
//      bash-only forms that fail. It is opt-in (see ./dialect-config.mjs): the
//      "common" level lists the mistakes and their replacements, and the extra
//      "force" level also tells the model to substitute a named POSIX tool.
//   2. attachDialectHint — afterwards, a failed parse or an unknown POSIX
//      command gets one actionable line appended to stderr.
//
// Everything here is pure and dependency-free: the executor imports it, and the
// tests exercise it without a host, a sandbox, or a PowerShell process.

/** The shared contract: this shell is PowerShell 7, and these bash forms do not work. */
const COMMON_LINES = [
  'The `pwsh` tool is PowerShell 7, not bash and not cmd.',
  'Every call runs as one `pwsh -NoLogo -NoProfile -NonInteractive -Command "<string>"`; there is no intermediate shell, so write PowerShell syntax.',
  'These bash-only forms fail and waste a turn — use the right-hand form instead:',
  "`export NAME=value` → `$env:NAME = 'value'`; `NAME=value command` → `$env:NAME = 'value'; command`;",
  '`[[ ... ]]` and `[ ... ]` → `if (...) { }`;',
  "heredoc `<<EOF` → here-string `@' ... '@` on their own lines;",
  '`source f` → `. ./f`; `x=$(cmd)` → `$x = cmd`; `for i in a b; do ...; done` → `foreach ($i in @(\'a\', \'b\')) { ... }`;',
  'use the backtick for line continuation, not a backslash.',
  'POSIX tools are not PowerShell commands — use the PowerShell equivalents: `grep`=Select-String, `sed`=-replace, `awk`=Import-Csv/ForEach-Object, `xargs`=ForEach-Object, `ls`=Get-ChildItem, `cat`=Get-Content, `rm`=Remove-Item, `head`=Select-Object -First, `tail`=Select-Object -Last, `wc -l`=Measure-Object -Line, `find`=Get-ChildItem -Recurse, `chmod`=icacls, `/dev/null`=`$null`.',
  'Quote literals with single quotes, use double quotes only when interpolating `$var`, and quote paths that contain spaces.',
  'Chain with `;`, `&&`, or `||` — all three are supported.',
  'If a call fails with a parser error or "not recognized", do not retry the same text: rewrite it in PowerShell syntax.',
];

/** The "forced" level: substitute even when the request names a POSIX tool. */
const FORCE_LINE = 'If the request names a POSIX tool, use its PowerShell equivalent anyway and say that you substituted it.';

/**
 * Normalize a stored dialect choice. `force` implies `common`: the forced level is an addition to
 * the common contract, never a replacement for it.
 * @param {{ common?: unknown, force?: unknown } | undefined | null} value
 * @returns {{ common: boolean, force: boolean }}
 */
export function normalizeDialect(value) {
  const common = value !== undefined && value !== null && value.common === true;
  const force = common && value !== undefined && value !== null && value.force === true;
  return { common, force };
}

/**
 * The system-prompt text for the configured level, or '' when prompt injection is off.
 * @param {{ common?: boolean, force?: boolean } | undefined} value
 * @returns {string}
 */
export function buildDialectPrompt(value) {
  const { common, force } = normalizeDialect(value);
  if (!common) return '';
  return [...COMMON_LINES, ...(force ? [FORCE_LINE] : [])].join(' ');
}

/** The full contract, for tests and for previewing the forced level. */
export const DIALECT_PROMPT = buildDialectPrompt({ common: true, force: true });

/**
 * Character counts and approximate tokens (~4 characters per token) for both levels, so the
 * settings surface and the setup dialog can disclose the cost before the user opts in.
 * @returns {{ commonChars: number, commonTokens: number, forcedChars: number, forcedTokens: number }}
 */
export function dialectPromptSizes() {
  const commonChars = buildDialectPrompt({ common: true }).length;
  const forcedChars = buildDialectPrompt({ common: true, force: true }).length;
  return {
    commonChars,
    commonTokens: Math.ceil(commonChars / 4),
    forcedChars,
    forcedTokens: Math.ceil(forcedChars / 4),
  };
}

/** A command that failed to parse: never retry it verbatim. */
const PARSE_ERROR = new RegExp(
  [
    'ParserError',
    'Unexpected token',
    'Missing (?:closing|expression|statement|terminator)',
    'The (?:string|hash literal) (?:is )?missing',
    '意外的标记',
    '分析程序错误',
    '字符串缺少终止符',
    '缺少(?:右|左)?(?:括号|花括号|表达式|语句)',
  ].join('|'),
  'i',
);

/** The "command not found" dialects (English and zh-CN PowerShell). */
const NOT_RECOGNIZED = /The term ['"]([^'"]+)['"] is not recognized|无法将[“"]([^”"]+)[”"]项识别为/i;

/** POSIX names a bash-trained model reaches for first, and the PowerShell 7 replacement. */
const POSIX_EQUIVALENTS = {
  awk: 'ForEach-Object / Import-Csv',
  cat: 'Get-Content',
  chmod: 'icacls',
  chown: 'icacls / Set-Acl',
  cp: 'Copy-Item',
  cut: '-split',
  date: 'Get-Date',
  df: 'Get-PSDrive',
  du: 'Measure-Object -Sum',
  env: 'Get-ChildItem Env:',
  export: "$env:NAME = 'value'",
  find: 'Get-ChildItem -Recurse',
  grep: 'Select-String',
  head: 'Select-Object -First',
  kill: 'Stop-Process',
  ln: 'New-Item -ItemType SymbolicLink',
  ls: 'Get-ChildItem',
  mkdir: 'New-Item -ItemType Directory',
  mv: 'Move-Item',
  printf: 'Write-Output / -f',
  ps: 'Get-Process',
  rm: 'Remove-Item',
  sed: '-replace',
  source: '. ./file',
  tail: 'Select-Object -Last',
  touch: 'New-Item',
  unzip: 'Expand-Archive',
  wc: 'Measure-Object -Line',
  wget: 'Invoke-WebRequest',
  which: 'Get-Command',
  xargs: 'ForEach-Object',
};

const PARSE_HINT = '[pwsh7] This shell is PowerShell 7, not bash or cmd. '
  + 'The previous command failed to parse; rewrite it in PowerShell syntax '
  + "(e.g. $env:NAME = 'value', if (...) { }, @' ... '@ here-strings, foreach ($x in ...) { }) "
  + 'instead of retrying the same text.';

/**
 * The one correction line a failed command deserves, or '' when nothing applies.
 * @param {string | undefined} command the command text that ran.
 * @param {{ exitCode?: number | null, stderr?: { text?: string } }} result settled result.
 * @returns {string}
 */
export function dialectHint(command, result) {
  if (result === undefined || result === null) return '';
  if (result.exitCode === 0) return '';
  const stderr = typeof result.stderr?.text === 'string' ? result.stderr.text : '';
  if (stderr === '') return '';
  if (PARSE_ERROR.test(stderr)) return PARSE_HINT;
  const unknown = NOT_RECOGNIZED.exec(stderr);
  if (unknown === null) return '';
  const name = (unknown[1] ?? unknown[2] ?? '').trim();
  if (name === '') return '';
  const replacement = POSIX_EQUIVALENTS[name.toLowerCase()];
  return replacement === undefined
    ? `[pwsh7] \`${name}\` is not a PowerShell 7 command; this shell is not bash or cmd. Use Get-Command to check what is available.`
    : `[pwsh7] \`${name}\` is a bash/POSIX name, not a PowerShell 7 command. Use \`${replacement}\` instead.`;
}

/**
 * Wrap a settled execution handle so a failed command carries the dialect hint.
 * The result is memoized by the wrapped getter, so the hint is appended once.
 * @param {{ result?: () => Promise<unknown> } | undefined} handle executor handle.
 * @param {string | undefined} command the command text that ran.
 * @returns {unknown} the same handle.
 */
export function attachDialectHint(handle, command) {
  if (handle === undefined || handle === null || typeof handle.result !== 'function') return handle;
  const base = handle.result.bind(handle);
  let wrapped;
  handle.result = () => {
    wrapped ??= base().then((result) => {
      const hint = dialectHint(command, result);
      if (hint === '') return result;
      const stderr = result?.stderr;
      if (stderr === undefined || stderr === null || typeof stderr !== 'object') return result;
      const text = typeof stderr.text === 'string' ? stderr.text : '';
      if (text.includes('[pwsh7]')) return result;
      const separator = text === '' || text.endsWith('\n') ? '' : '\n';
      return { ...result, stderr: { ...stderr, text: `${text}${separator}${hint}\n` } };
    });
    return wrapped;
  };
  return handle;
}
