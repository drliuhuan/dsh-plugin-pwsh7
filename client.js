// dsh-plugin-pwsh7 — client half.
//
// A setup dialog for the one Windows failure the host half cannot fix silently: PowerShell 7 is
// missing, so the `pwsh` tool cannot run. The host opens no window of its own, so the dialog is
// rendered into the shell's root `shell.overlay` slot:
//
//   * on first load it asks `/pwsh7/state` and opens when `pwsh.exe` is absent;
//   * it subscribes to `/pwsh7/events` (SSE) so a `pwsh` run that fails *later* re-opens it, with
//     live download progress. Polling is the fallback when SSE is unavailable;
//   * "Download and install" POSTs `/pwsh7/install`; the host downloads the official PowerShell 7
//     zip per-user, and every later frame carries bytes/total/phase;
//   * closing the dialog never cancels the install. It stays open on success or failure so the
//     result is visible, and the next failed `pwsh` run re-opens it by `missingSeq`.
//
// The component is deliberately plain React over `var`/`function` (like the other third-party DSH
// client bundles): this file is a classic script, not part of a TypeScript build.
(function () {
  'use strict';

  /** The Loader row name, which is also this browser artifact's module id. */
  var PLUGIN_ID = 'dsh-plugin-pwsh7';

  /** Locale namespace owned by this plugin (registered in apply). */
  var LOCALE_NS = 'pwsh7';

  /** Host routes; every URL is relative to the page's own origin. */
  var ROUTE_STATE = '/pwsh7/state';
  var ROUTE_EVENTS = '/pwsh7/events';
  var ROUTE_INSTALL = '/pwsh7/install';
  var ROUTE_CANCEL = '/pwsh7/cancel';
  /** Maintenance routes used by the Settings page (v0.3.0). */
  var ROUTE_ROUTE = '/pwsh7/route';
  var ROUTE_UNINSTALL = '/pwsh7/uninstall';
  var ROUTE_RELOCATE = '/pwsh7/relocate';
  var ROUTE_SELFCHECK = '/pwsh7/selfcheck';

  /**
   * Self-check ids the host reports. The title is always looked up as
   * `selfcheck.<id>` in this plugin's dictionaries; the server owns `detail`.
   */
  var SELFCHECK_IDS = [
    'plugin-version', 'route', 'executable', 'version', 'config', 'install',
    'path-env', 'shipped', 'sandbox', 'install-job', 'routes'
  ];

  /** Progress polling remains a safety net for a browser without EventSource. */
  var POLL_MS = 3000;

  var EN = {
    title: 'PowerShell 7 is required',
    lead: 'This deployment runs the pwsh tool through PowerShell 7, but pwsh.exe was not found on this machine.',
    body: 'Choose an installation scope. The matching user or system PATH will be updated. Install location: {path}.',
    scopeLabel: 'Installation scope',
    userScope: 'Current user (no administrator rights)',
    systemScope: 'System (run DSH as administrator)',
    hint: 'The archive is about 100 MB. Extracting uses the Windows built-in tar.exe; no downloaded installer is executed.',
    download: 'Download and install',
    later: 'Not now',
    cancel: 'Cancel download',
    close: 'Close',
    retry: 'Retry',
    done: 'Done',
    preparing: 'Preparing the download…',
    downloading: 'Downloading PowerShell 7…',
    extracting: 'Extracting and installing…',
    verifying: 'Verifying the new pwsh.exe…',
    installing: 'Installing with winget…',
    cancelling: 'Cancelling the download…',
    installed: 'PowerShell 7 is installed',
    installedBody: 'Version {version} at {path}. The pwsh tool is ready again; retry the command that needed it.',
    installedNoVersion: 'PowerShell 7 is installed at {path}. The pwsh tool is ready again.',
    failed: 'PowerShell 7 could not be installed',
    cancelled: 'The download was cancelled',
    cancelledBody: 'You can retry, or install PowerShell 7 yourself from {url}.',
    offline: 'Could not reach the DSH host. Retry from this dialog or Settings → PowerShell 7 once the host is back.',
    progress: '{received} / {total} ({percent}%)',
    progressUnknown: 'Downloaded {received}',
    manual: 'Manual download',
    retryHint: 'If the download keeps failing, install PowerShell 7 from {url}, then try again.',
    pathLabel: 'Install location',
    // Settings page (settings.section, id `pwsh7`) ---------------------------
    settingsNav: 'PowerShell 7',
    settingsTitle: 'PowerShell 7',
    settingsSubtitle: 'Installation state, routing and maintenance for the PowerShell 7 that this plugin manages.',
    loading: 'Reading the PowerShell 7 state…',
    loadFailed: 'Could not read the PowerShell 7 state from the DSH host.',
    notInstalled: 'Not found',
    statusReady: 'PowerShell {version}',
    statusReadyNoVersion: 'PowerShell 7 is ready',
    sectionInstall: 'Installation',
    sectionRoute: 'Routing',
    sectionActions: 'Maintenance',
    labelPsVersion: 'PowerShell version',
    labelPath: 'Executable',
    labelDirectory: 'Install directory',
    labelScope: 'Installation scope',
    labelMethod: 'Install method',
    labelConfig: 'Configuration file',
    labelManaged: 'Managed by this plugin',
    labelRemovable: 'Removable from this page',
    labelUserCopy: 'Per-user copy',
    labelSystemCopy: 'System-wide copy',
    labelPathEntry: 'PATH entry present',
    yes: 'Yes',
    no: 'No',
    unknown: 'Unknown',
    scopeUser: 'Current user',
    scopeSystem: 'System',
    methodPortable: 'Portable archive',
    methodWinget: 'winget',
    methodAuto: 'Automatic',
    methodExisting: 'Existing installation',
    installedNone: 'PowerShell 7 was not found. Install a per-user copy here, or install PowerShell 7 yourself.',
    routePlugin: 'Plugin-managed',
    routeSystem: 'System default',
    routePluginHint: 'Prefers the plugin-managed copy (or DSH_PWSH_PATH), then any PowerShell 7 installed on this machine.',
    routeSystemHint: 'Uses a system-wide PowerShell 7 only. When none is installed, the pwsh tool falls back to Windows PowerShell 5.1.',
    routeSystemPath: 'The system default currently resolves to {path}.',
    routeSystemMissing: 'No system-wide PowerShell 7 was found; the pwsh tool will fall back to Windows PowerShell 5.1.',
    routeSaving: 'Switching the route…',
    routeSaved: 'Routing switched to {mode}.',
    actionInstall: 'Install for current user',
    actionInstallHint: 'Downloads the portable PowerShell 7 archive (about 100 MB) into the per-user plugin folder. No administrator rights are needed.',
    actionRelocate: 'Move to system scope',
    actionRelocateHint: 'Installs PowerShell 7 for all users and removes the per-user copy. DSH must run as administrator.',
    relocateConfirm: 'Install PowerShell 7 for all users, then remove the per-user copy? This lets every Windows account use it.',
    relocateConfirmButton: 'Move to system',
    relocateStarted: 'Moving PowerShell 7 to the system scope…',
    relocateDone: 'PowerShell 7 is now installed system-wide at {path}.',
    relocateDoneNoPath: 'PowerShell 7 is now installed system-wide.',
    relocateRemoved: 'Removed {count} per-user copies.',
    relocateFailed: 'Moving PowerShell 7 to the system scope failed: {error}',
    actionUninstall: 'Uninstall per-user copy',
    actionUninstallHint: 'Removes only the PowerShell 7 copy this plugin installed for the current user, plus its PATH entry.',
    uninstallConfirm: 'Remove the per-user PowerShell 7 copy and its PATH entry? A system-wide installation is not touched.',
    uninstallConfirmButton: 'Remove per-user copy',
    uninstallDone: 'The per-user PowerShell 7 copy was removed.',
    uninstallWarnings: 'Some files could not be removed:',
    actionFailed: 'The action failed.',
    elevationRequired: 'This action needs administrator rights.',
    elevationHint: 'Restart DSH as administrator, then try again.',
    busyJob: 'A PowerShell 7 install or removal job is already running.',
    selfcheckRun: 'Run self-check',
    selfcheckRunning: 'Checking…',
    selfcheckSummary: '{ok} ok · {warn} warnings · {fail} failures',
    selfcheckAt: 'Checked at {time}',
    selfcheckEmpty: 'Run the self-check to verify the plugin, the installation and the routing.',
    statusWarn: 'warning',
    statusFail: 'failed',
    confirmCancel: 'Cancel',
    'selfcheck.plugin-version': 'Plugin version',
    'selfcheck.route': 'Routing mode',
    'selfcheck.executable': 'pwsh executable',
    'selfcheck.version': 'PowerShell version',
    'selfcheck.config': 'Configuration file',
    'selfcheck.install': 'Installation',
    'selfcheck.path-env': 'PATH environment',
    'selfcheck.shipped': 'Bundled executor',
    'selfcheck.sandbox': 'Sandbox integration',
    'selfcheck.install-job': 'Install job',
    'selfcheck.routes': 'HTTP routes'
  };

  var ZH = {
    title: '需要 PowerShell 7',
    lead: '这个部署会把 pwsh 工具交给 PowerShell 7 执行，但这台电脑上没有找到 pwsh.exe。',
    body: '选择安装范围，安装后会写入对应的用户或系统 PATH。安装位置：{path}。',
    scopeLabel: '安装范围',
    userScope: '当前用户（无需管理员权限）',
    systemScope: '系统（请以管理员身份运行 DSH）',
    hint: '压缩包约 100 MB。解压使用 Windows 自带的 tar.exe，不会执行下载来的安装程序。',
    download: '下载并安装',
    later: '稍后',
    cancel: '取消下载',
    close: '关闭',
    retry: '重试',
    done: '完成',
    preparing: '正在准备下载…',
    downloading: '正在下载 PowerShell 7…',
    extracting: '正在解压并安装…',
    verifying: '正在验证 pwsh.exe…',
    installing: '正在通过 winget 安装…',
    cancelling: '正在取消下载…',
    installed: 'PowerShell 7 已安装',
    installedBody: '版本 {version}，位置 {path}。pwsh 工具已经可以使用，请重试刚才的命令。',
    installedNoVersion: 'PowerShell 7 已安装到 {path}。pwsh 工具已经可以使用。',
    failed: 'PowerShell 7 安装失败',
    cancelled: '下载已取消',
    cancelledBody: '你可以重试，或者从 {url} 手动安装 PowerShell 7。',
    offline: '无法连接到 DSH 宿主；恢复后请重试本弹窗或 设置 → PowerShell 7。',
    progress: '{received} / {total}（{percent}%）',
    progressUnknown: '已下载 {received}',
    manual: '手动下载',
    retryHint: '如果下载一直失败，请从 {url} 安装 PowerShell 7，然后重试。',
    pathLabel: '安装位置',
    // 设置页（settings.section，id 为 `pwsh7`） -----------------------------
    settingsNav: 'PowerShell 7',
    settingsTitle: 'PowerShell 7',
    settingsSubtitle: '本插件所管理 PowerShell 7 的安装状态、路由方式与维护操作。',
    loading: '正在读取 PowerShell 7 状态…',
    loadFailed: '无法从 DSH 宿主读取 PowerShell 7 状态。',
    notInstalled: '未找到',
    statusReady: 'PowerShell {version}',
    statusReadyNoVersion: 'PowerShell 7 已就绪',
    sectionInstall: '安装信息',
    sectionRoute: '路由方式',
    sectionActions: '维护操作',
    labelPsVersion: 'PowerShell 版本',
    labelPath: '可执行文件',
    labelDirectory: '安装目录',
    labelScope: '安装范围',
    labelMethod: '安装方式',
    labelConfig: '配置文件',
    labelManaged: '由本插件托管',
    labelRemovable: '可在此卸载',
    labelUserCopy: '当前用户副本',
    labelSystemCopy: '系统副本',
    labelPathEntry: '已加入 PATH',
    yes: '是',
    no: '否',
    unknown: '未知',
    scopeUser: '当前用户',
    scopeSystem: '系统',
    methodPortable: '便携压缩包',
    methodWinget: 'winget',
    methodAuto: '自动',
    methodExisting: '已有安装',
    installedNone: '没有找到 PowerShell 7。可以在这里安装当前用户副本，或自行安装 PowerShell 7。',
    routePlugin: '插件托管',
    routeSystem: '系统默认',
    routePluginHint: '优先使用插件托管的副本或 DSH_PWSH_PATH，其次是本机已安装的 PowerShell 7。',
    routeSystemHint: '只使用系统范围的 PowerShell 7。本机没有安装时，pwsh 工具会回退到 Windows PowerShell 5.1。',
    routeSystemPath: '系统默认目前解析到 {path}。',
    routeSystemMissing: '没有找到系统范围的 PowerShell 7，pwsh 工具将回退到 Windows PowerShell 5.1。',
    routeSaving: '正在切换路由…',
    routeSaved: '已切换到{mode}。',
    actionInstall: '为当前用户安装',
    actionInstallHint: '把约 100 MB 的便携版 PowerShell 7 下载到当前用户的插件目录，无需管理员权限。',
    actionRelocate: '迁移到系统范围',
    actionRelocateHint: '为所有用户安装 PowerShell 7 并删除当前用户副本。DSH 需要以管理员身份运行。',
    relocateConfirm: '为所有用户安装 PowerShell 7，然后删除当前用户副本？这样每个 Windows 账户都能使用。',
    relocateConfirmButton: '迁移到系统',
    relocateStarted: '正在把 PowerShell 7 迁移到系统范围…',
    relocateDone: 'PowerShell 7 已安装到系统范围：{path}。',
    relocateDoneNoPath: 'PowerShell 7 已安装到系统范围。',
    relocateRemoved: '已删除 {count} 个当前用户副本。',
    relocateFailed: '把 PowerShell 7 迁移到系统范围失败：{error}',
    actionUninstall: '卸载当前用户副本',
    actionUninstallHint: '只删除本插件为当前用户安装的 PowerShell 7 及其 PATH 项。',
    uninstallConfirm: '删除当前用户的 PowerShell 7 副本及其 PATH 项？系统范围的安装不受影响。',
    uninstallConfirmButton: '删除当前用户副本',
    uninstallDone: '当前用户的 PowerShell 7 副本已删除。',
    uninstallWarnings: '以下文件未能删除：',
    actionFailed: '操作失败。',
    elevationRequired: '此操作需要管理员权限。',
    elevationHint: '请以管理员身份重新启动 DSH，然后重试。',
    busyJob: '已有 PowerShell 7 安装或删除任务在运行。',
    selfcheckRun: '运行自检',
    selfcheckRunning: '正在检查…',
    selfcheckSummary: '{ok} 项正常 · {warn} 项警告 · {fail} 项失败',
    selfcheckAt: '检查时间：{time}',
    selfcheckEmpty: '运行自检以检查插件、安装与路由配置。',
    statusWarn: '警告',
    statusFail: '失败',
    confirmCancel: '取消',
    'selfcheck.plugin-version': '插件版本',
    'selfcheck.route': '路由方式',
    'selfcheck.executable': 'pwsh 可执行文件',
    'selfcheck.version': 'PowerShell 版本',
    'selfcheck.config': '配置文件',
    'selfcheck.install': '安装状态',
    'selfcheck.path-env': 'PATH 环境变量',
    'selfcheck.shipped': '内置执行器',
    'selfcheck.sandbox': '沙箱集成',
    'selfcheck.install-job': '安装任务',
    'selfcheck.routes': 'HTTP 路由'
  };

  /**
   * Dialog styling copied from the shell's own modal layer (`--dsw-*` tokens only), prefixed so a
   * theme change reaches this dialog exactly like a shipped one. The mask/panel geometry follows
   * the app's modal CSS: fixed whole-viewport root, blurred mask, 440 px panel, 24 px insets.
   */
  var CSS = [
    '.pwsh7_root{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;',
    'padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}',
    '.pwsh7_mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1);',
    'backdrop-filter:var(--dsw-mask-blur);animation:pwsh7_fade var(--ds-transition-duration) var(--ds-ease-in-out)}',
    '.pwsh7_dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:16px;',
    'width:min(440px,100%);max-height:calc(100dvh - 48px);overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);',
    'background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);',
    'animation:pwsh7_fade var(--ds-transition-duration) var(--ds-ease-in-out)}',
    '.pwsh7_header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 0 24px}',
    '.pwsh7_title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
    '.pwsh7_close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;',
    'padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);',
    'font:inherit;font-size:18px;line-height:1;cursor:pointer}',
    '.pwsh7_close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
    '.pwsh7_close:focus-visible,.pwsh7_button:focus-visible,.pwsh7_link:focus-visible{',
    'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
    '.pwsh7_description{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}',
    '.pwsh7_body{display:flex;flex-direction:column;gap:12px;min-width:0;max-height:min(52vh,360px);overflow-y:auto;',
    'padding:4px 24px 0;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);',
    '--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
    '.pwsh7_text{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
    '.pwsh7_hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-word}',
    '.pwsh7_path{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);',
    'word-break:break-all}',
    '.pwsh7_progress{position:relative;height:6px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-module-platform)}',
    '.pwsh7_bar{display:block;height:100%;width:0;border-radius:inherit;background:var(--dsw-alias-state-business-primary);',
    'transition:width .2s ease-out}',
    '.pwsh7_progress[data-indeterminate=true] .pwsh7_bar{width:35%;animation:pwsh7_indeterminate 1.2s ease-in-out infinite}',
    '.pwsh7_meta{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;line-height:18px;',
    'color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
    '.pwsh7_state{display:flex;align-items:flex-start;gap:10px}',
    '.pwsh7_stateIcon{flex:none;display:grid;place-items:center;width:22px;height:22px;margin-top:1px;border-radius:999px}',
    '.pwsh7_stateIcon[data-tone=success]{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}',
    '.pwsh7_stateIcon[data-tone=error]{background:var(--dsw-alias-state-error-tertiary);color:var(--dsw-alias-state-error-primary)}',
    '.pwsh7_stateTitle{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}',
    '.pwsh7_stateBody{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
    '.pwsh7_error{margin:0;padding:8px 10px;max-height:150px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2);',
    'border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-state-error-primary);',
    'font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}',
    '.pwsh7_footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:20px 24px 24px}',
    '.pwsh7_button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;',
    'padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);',
    'font:inherit;font-size:14px;line-height:22px;cursor:pointer;white-space:nowrap}',
    '.pwsh7_button:disabled{opacity:.4;cursor:not-allowed}',
    '.pwsh7_primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
    '.pwsh7_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
    '.pwsh7_outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent}',
    '.pwsh7_outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
    '.pwsh7_ghost{color:var(--dsw-alias-label-secondary)}',
    '.pwsh7_ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
    '.pwsh7_link{color:var(--dsw-alias-link);text-decoration:none;font-weight:500;word-break:break-all}',
    '.pwsh7_link:hover{text-decoration:underline dotted;text-underline-offset:3px}',
    // Settings page (`settings.section`, id `pwsh7`) --------------------------
    '.pwsh7_setRoot{box-sizing:border-box;height:100%;display:flex;flex-direction:column;min-width:0;',
    'color:var(--dsw-alias-label-primary)}',
    '.pwsh7_setScroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:4px 4px 48px;scroll-padding-bottom:48px;',
    '--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
    '.pwsh7_setInner{box-sizing:border-box;width:100%;max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:16px}',
    '.pwsh7_setHead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;padding:4px 4px 0}',
    '.pwsh7_setTitle{margin:0;font-size:16px;line-height:24px;font-weight:500}',
    '.pwsh7_setSubtitle{flex:1 1 100%;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
    '.pwsh7_badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:20px;',
    'font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
    '.pwsh7_badge[data-tone=success]{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}',
    '.pwsh7_badge[data-tone=error]{background:var(--dsw-static-red-600-a08);color:var(--dsw-alias-state-error-primary)}',
    '.pwsh7_card{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;min-width:0;padding:14px 16px;',
    'border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}',
    '.pwsh7_cardHead{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
    '.pwsh7_cardTitle{margin:0;font-size:14px;line-height:22px;font-weight:500}',
    '.pwsh7_rows{display:flex;flex-direction:column;gap:6px;margin:0;padding:0}',
    '.pwsh7_row{display:grid;grid-template-columns:minmax(120px,170px) minmax(0,1fr);gap:8px 12px;align-items:baseline;min-width:0;margin:0}',
    '.pwsh7_rowLabel{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
    '.pwsh7_rowValue{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);word-break:break-word}',
    '.pwsh7_rowValue[data-mono=true]{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;',
    'color:var(--dsw-alias-label-secondary);word-break:break-all}',
    '.pwsh7_flags{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0}',
    '.pwsh7_flag{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;',
    'border:.5px solid var(--dsw-alias-border-l2);font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
    '.pwsh7_flag[data-on=true]{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}',
    '.pwsh7_flagDot{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-idle-primary)}',
    '.pwsh7_flag[data-on=true] .pwsh7_flagDot{background:var(--dsw-alias-state-success-primary)}',
    '.pwsh7_empty{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
    '.pwsh7_seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:2px;border-radius:var(--dsw-radius-md);',
    'background:var(--dsw-alias-bg-module-platform)}',
    '.pwsh7_segBtn{box-sizing:border-box;height:28px;padding:0 12px;border:0;border-radius:calc(var(--dsw-radius-md) - 2px);',
    'background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:28px;',
    'cursor:pointer;white-space:nowrap}',
    '.pwsh7_segBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
    '.pwsh7_segBtn[data-on=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
    'box-shadow:var(--dsw-elevation-soft)}',
    '.pwsh7_segBtn:disabled{opacity:.5;cursor:not-allowed}',
    '.pwsh7_segBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
    '.pwsh7_actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
    '.pwsh7_actionHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
    '.pwsh7_confirm{display:flex;flex-direction:column;gap:8px;padding:10px 12px;',
    'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base)}',
    '.pwsh7_confirmText{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
    '.pwsh7_danger{color:var(--dsw-alias-state-error-primary)}',
    '.pwsh7_danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
    '.pwsh7_notice{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md);font-size:12px;line-height:18px;',
    'background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);word-break:break-word}',
    '.pwsh7_warnBox{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md);font-size:12px;line-height:18px;',
    'background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);word-break:break-word}',
    '.pwsh7_warnList{margin:4px 0 0;padding:0 0 0 18px;font-family:var(--ds-font-family-code);font-size:11px;line-height:17px}',
    '.pwsh7_detailList{margin:4px 0 0;padding:0 0 0 18px;font-family:var(--ds-font-family-code);font-size:11px;line-height:17px;',
    'color:var(--dsw-alias-label-secondary);word-break:break-all}',
    '.pwsh7_errorBox{display:flex;flex-direction:column;gap:4px;margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md);',
    'background:var(--dsw-static-red-600-a08);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;word-break:break-word}',
    '.pwsh7_checks{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}',
    '.pwsh7_check{display:flex;align-items:flex-start;gap:8px;min-width:0}',
    '.pwsh7_checkDot{flex:none;width:7px;height:7px;margin-top:7px;border-radius:999px;background:var(--dsw-alias-state-idle-primary)}',
    '.pwsh7_check[data-status=ok] .pwsh7_checkDot{background:var(--dsw-alias-state-success-primary)}',
    '.pwsh7_check[data-status=warn] .pwsh7_checkDot{background:var(--dsw-alias-state-warn-primary)}',
    '.pwsh7_check[data-status=fail] .pwsh7_checkDot{background:var(--dsw-alias-state-error-primary)}',
    '.pwsh7_checkBody{display:flex;flex-direction:column;gap:1px;min-width:0}',
    '.pwsh7_checkTitle{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
    '.pwsh7_checkTitle[data-status=warn]{color:var(--dsw-alias-state-warn-label)}',
    '.pwsh7_checkTitle[data-status=fail]{color:var(--dsw-alias-state-error-primary)}',
    '.pwsh7_checkDetail{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
    '.pwsh7_summary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
    '.pwsh7_selfHead{display:flex;align-items:center;flex-wrap:wrap;gap:8px}',
    '@media (max-width:560px){.pwsh7_row{grid-template-columns:1fr;gap:2px 0}.pwsh7_setInner{max-width:none}}',
    '@keyframes pwsh7_fade{0%{opacity:0}to{opacity:1}}',
    '@keyframes pwsh7_indeterminate{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}',
    '@media (prefers-reduced-motion:reduce){.pwsh7_mask,.pwsh7_dialog,.pwsh7_progress[data-indeterminate=true] .pwsh7_bar{animation:none}',
    '.pwsh7_bar{transition:none}}'
  ].join('');

  /** The active locale service, captured on apply for fallback translation. */
  var localeFace = null;

  /** React runtime, assigned when the loader materializes this module. */
  var React = null;

  //#region helpers -----------------------------------------------------------

  /** `{name}` interpolation used by both the bound translator and the fallback. */
  function interpolate(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  /** The language this surface should draw in when no `t` prop is bound. */
  function activeLanguage() {
    try {
      if (localeFace !== null && typeof localeFace.getLocale === 'function') {
        var active = String(localeFace.getLocale().active || '');
        if (active.indexOf('zh') === 0) return 'zh';
        if (active.length > 0) return 'en';
      }
    } catch (error) {
      // Fall through to the document/browser hints.
    }
    try {
      var hint = String((globalThis.navigator && globalThis.navigator.language) || document.documentElement.lang || '');
      return hint.indexOf('zh') === 0 ? 'zh' : 'en';
    } catch (error) {
      return 'en';
    }
  }

  function fallbackTranslate(key, params) {
    var dictionary = activeLanguage() === 'zh' ? ZH : EN;
    var text = dictionary[key];
    if (text === undefined) return key;
    return interpolate(text, params);
  }

  /** Human byte size, matching the host tool's own wording. */
  function formatBytes(bytes) {
    var value = Number(bytes);
    if (!isFinite(value) || value <= 0) return '0 B';
    if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GiB';
    if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MiB';
    if (value >= 1024) return (value / 1024).toFixed(1) + ' KiB';
    return Math.round(value) + ' B';
  }

  function busyPhase(phase) {
    return phase === 'downloading' || phase === 'extracting' || phase === 'verifying'
      || phase === 'installing' || phase === 'cancelling';
  }

  function onlineFetch(url, options) {
    return fetch(url, options);
  }

  /** Local time for a self-check `checkedAt`, degrading to the raw server string. */
  function formatCheckedAt(value) {
    try {
      var date = new Date(String(value));
      if (isNaN(date.getTime())) return String(value);
      return date.toLocaleString();
    } catch (error) {
      return String(value);
    }
  }

  /** Contract order for self-check ids, so the page never reorders the host's answer. */
  function selfcheckRank(id) {
    var at = SELFCHECK_IDS.indexOf(id);
    return at === -1 ? SELFCHECK_IDS.length : at;
  }

  function textOrNull(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /**
   * Normalize one `/pwsh7/state` snapshot into the view model the Settings page renders.
   *
   * The contract's extended fields are read first; a host that has not restarted with the new
   * version still sends the older dialogs fields, so `found`/`path`/`version` remain the fallback
   * and the page degrades to "unknown" instead of throwing.
   *
   * @param {object|null} raw
   * @returns {object|null}
   */
  function readState(raw) {
    if (raw === null || typeof raw !== 'object') return null;
    var install = raw.install !== null && typeof raw.install === 'object' ? raw.install : null;
    var elevation = raw.elevation !== null && typeof raw.elevation === 'object' ? raw.elevation : null;
    return {
      raw: raw,
      pluginVersion: textOrNull(raw.pluginVersion),
      found: install !== null && typeof install.exists === 'boolean' ? install.exists : raw.found === true,
      version: install !== null ? textOrNull(install.version) : textOrNull(raw.version),
      path: install !== null ? textOrNull(install.path) : textOrNull(raw.path),
      directory: install !== null ? textOrNull(install.directory) : null,
      scope: install !== null && (install.scope === 'user' || install.scope === 'system') ? install.scope : null,
      method: install !== null ? textOrNull(install.method) : null,
      managed: install !== null && install.managed === true,
      removable: install !== null && install.removable === true,
      userCopy: install !== null && install.userCopy === true,
      systemCopy: install !== null && install.systemCopy === true,
      pathEntry: install !== null && install.pathEntry === true,
      configPath: textOrNull(raw.configPath),
      route: raw.route === 'system' ? 'system' : 'plugin',
      routeConfigured: raw.routeConfigured === true,
      systemPath: textOrNull(raw.systemPath),
      elevationAvailable: elevation !== null && elevation.available === true,
      elevationRequired: elevation === null || elevation.requiredForSystem !== false,
      busy: raw.busy === true,
      phase: typeof raw.phase === 'string' ? raw.phase : 'idle',
      percent: typeof raw.percent === 'number' ? raw.percent : null,
      received: typeof raw.received === 'number' ? raw.received : 0,
      total: typeof raw.total === 'number' && raw.total > 0 ? raw.total : null,
      message: textOrNull(raw.message),
      error: textOrNull(raw.error),
      installRoot: textOrNull(raw.installRoot),
      result: raw.result !== null && typeof raw.result === 'object' ? raw.result : null
    };
  }

  /** String values from a server array, dropping anything else. */
  function stringList(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(function (entry) {
      return typeof entry === 'string' && entry.length > 0;
    });
  }

  /**
   * A stable identity for one `state.relocate` outcome.
   *
   * The snapshot is rebuilt on every event, so object identity cannot answer "have I already shown
   * this result?". The signature can: identical content means the same finished relocation, while a
   * later relocation (or a different outcome) changes it and earns one fresh notice.
   *
   * @param {object|null|undefined} relocate
   * @returns {string|null}
   */
  function relocateSignature(relocate) {
    if (relocate === null || typeof relocate !== 'object') return null;
    return JSON.stringify([
      relocate.ok === true,
      relocate.relocated === true,
      textOrNull(relocate.systemPath),
      textOrNull(relocate.error),
      stringList(relocate.removedUserCopy),
      stringList(relocate.warnings)
    ]);
  }

  /**
   * Translate the host's finished relocation into one page notice.
   *
   * `state.relocate` is `{ok, relocated, systemPath, removedUserCopy, warnings, error?}` and is NOT
   * cleared by later state frames, so the page renders it exactly once (see `relocateSignature`)
   * instead of letting every event re-announce the same outcome.
   *
   * @param {Function} t the page translator.
   * @param {object|null|undefined} relocate
   * @returns {{text: string, warnings: string[], details: string[]}|null}
   */
  function relocateNoticeFor(t, relocate) {
    if (relocate === null || typeof relocate !== 'object') return null;
    var removed = stringList(relocate.removedUserCopy);
    var warnings = stringList(relocate.warnings);
    var systemPath = textOrNull(relocate.systemPath);
    var succeeded = relocate.ok === true || relocate.relocated === true;
    if (succeeded) {
      var done = systemPath !== null
        ? interpolate(t('relocateDone'), { path: systemPath })
        : t('relocateDoneNoPath');
      if (removed.length > 0) {
        done += ' ' + interpolate(t('relocateRemoved'), { count: removed.length });
      }
      return { text: done, warnings: warnings, details: removed };
    }
    // A record with no verdict at all says nothing worth a notice.
    var error = textOrNull(relocate.error);
    if (error === null && relocate.ok !== false) return null;
    return {
      text: interpolate(t('relocateFailed'), { error: error === null ? t('actionFailed') : error }),
      warnings: warnings,
      details: []
    };
  }

  //#endregion

  //#region component ---------------------------------------------------------

  /**
   * The setup dialog. Rendered into `shell.overlay`; returns `null` while closed so the overlay
   * layer stays click-through outside the modal.
   * @param {object} props slot props; `t` is bound by `locale`.
   * @returns {object|null} the dialog tree.
   */
  function Pwsh7SetupDialog(props) {
    var t = typeof props.t === 'function' ? props.t : fallbackTranslate;

    var hostState = React.useState(null);
    var host = hostState[0];
    var setHost = hostState[1];

    var openState = React.useState(false);
    var open = openState[0];
    var setOpen = openState[1];

    var busyState = React.useState(false);
    var busy = busyState[0];
    var setBusy = busyState[1];

    var localErrorState = React.useState(null);
    var localError = localErrorState[0];
    var setLocalError = localErrorState[1];

    var scopeState = React.useState('user');
    var scope = scopeState[0];
    var setScope = scopeState[1];

    var dismissed = React.useRef(0);
    /** True only while the user has hidden a RUNNING install; a new busy phase may re-open it. */
    var suppressBusy = React.useRef(false);
    var initialised = React.useRef(false);
    var mounted = React.useRef(true);
    var serial = React.useRef(0);
    var pollTimer = React.useRef(null);
    var source = React.useRef(null);
    var primaryRef = React.useRef(null);
    var restoreFocus = React.useRef(null);
    var dismissRef = React.useRef(null);

    /** Adopt one host snapshot. `missingSeq` is the "every run re-opens it" signal. */
    function adopt(next) {
      if (!mounted.current) return;
      if (next === null || typeof next !== 'object') return;
      // Invalidate any poll response still in flight: an SSE frame or a POST response is fresher
      // than a snapshot requested before it.
      serial.current += 1;
      setHost(next);
      if (!initialised.current) {
        initialised.current = true;
        dismissed.current = Number(next.missingSeq) || 0;
        if (next.found !== true) setOpen(true);
        return;
      }
      if (next.found !== true) {
        var seq = Number(next.missingSeq) || 0;
        var running = busyPhase(next.phase);
        if (!running) suppressBusy.current = false;
        // A new failed run always re-opens. A running install also re-opens unless the user hid
        // THIS run; auto-opening on every progress frame would make "hide while it downloads"
        // impossible. Starting a later install clears the suppression above.
        if (seq > dismissed.current || (running && !suppressBusy.current)) setOpen(true);
        return;
      }
      // Installed outside the dialog (or after a finished job): a plain "found" frame closes it;
      // a finished job keeps it open so the success panel is visible.
      suppressBusy.current = false;
      if (next.phase !== 'done') setOpen(false);
    }

    function refresh() {
      var ticket = (serial.current += 1);
      onlineFetch(ROUTE_STATE, { cache: 'no-store', credentials: 'omit' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (next) {
          if (ticket === serial.current) adopt(next);
        })
        .catch(function () {
          // A missing route means a host without this version of the plugin; do not invent a popup.
        });
    }

    function stopPolling() {
      if (pollTimer.current !== null) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }

    function startPolling() {
      if (pollTimer.current !== null) return;
      pollTimer.current = setInterval(refresh, POLL_MS);
    }

    function connectEvents() {
      if (typeof EventSource !== 'function') {
        startPolling();
        return;
      }
      try {
        source.current = new EventSource(ROUTE_EVENTS);
      } catch (error) {
        startPolling();
        return;
      }
      source.current.addEventListener('state', function (event) {
        try {
          adopt(JSON.parse(event.data));
        } catch (error) {
          // A malformed frame is not worth a broken dialog; polling still covers the state.
        }
      });
      source.current.onopen = function () {
        setLocalError(null);
      };
      source.current.onerror = function () {
        // EventSource reconnects on its own; the always-on poll also keeps progress moving if a
        // carrier buffers the stream.
        startPolling();
      };
    }

    function dismiss() {
      dismissed.current = host && Number.isFinite(Number(host.missingSeq)) ? Number(host.missingSeq) : 0;
      suppressBusy.current = host !== null && busyPhase(host.phase);
      setOpen(false);
    }
    dismissRef.current = dismiss;

    function post(url, body) {
      return onlineFetch(url, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + response.status);
          return data;
        });
      });
    }

    function startInstall() {
      if (busy) return;
      setBusy(true);
      setLocalError(null);
      post(ROUTE_INSTALL, { method: 'auto', scope: scope })
        .then(function (data) {
          if (data && data.state) adopt(data.state);
        })
        .catch(function (error) {
          setLocalError(error && error.message ? error.message : String(error));
        })
        .then(function () {
          if (mounted.current) setBusy(false);
        });
    }

    function cancelInstall() {
      if (busy) return;
      setBusy(true);
      post(ROUTE_CANCEL, {})
        .then(function (data) {
          if (data && data.state) adopt(data.state);
        })
        .catch(function (error) {
          setLocalError(error && error.message ? error.message : String(error));
        })
        .then(function () {
          if (mounted.current) setBusy(false);
        });
    }

    React.useEffect(function () {
      mounted.current = true;
      refresh();
      // Always poll: SSE gives smooth progress, while the poll is the safety net for a carrier
      // that buffers event streams or reports `found` after the initial fetch.
      startPolling();
      connectEvents();
      return function () {
        mounted.current = false;
        stopPolling();
        if (source.current !== null) {
          try {
            source.current.close();
          } catch (error) {
            // Already closed.
          }
          source.current = null;
        }
      };
    }, []);

    React.useEffect(function () {
      if (!open) return undefined;
      restoreFocus.current = document.activeElement;
      var timer = setTimeout(function () {
        if (primaryRef.current !== null && typeof primaryRef.current.focus === 'function') primaryRef.current.focus();
      }, 0);
      function onKeyDown(event) {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        if (dismissRef.current) dismissRef.current();
      }
      document.addEventListener('keydown', onKeyDown, true);
      return function () {
        clearTimeout(timer);
        document.removeEventListener('keydown', onKeyDown, true);
        var previous = restoreFocus.current;
        restoreFocus.current = null;
        if (previous !== null && typeof previous.focus === 'function') {
          try {
            previous.focus();
          } catch (error) {
            // The element may have unmounted.
          }
        }
      };
    }, [open]);

    if (!open || host === null) return null;

    var phase = typeof host.phase === 'string' ? host.phase : 'idle';
    var working = busyPhase(phase);
    var accepted = phase === 'done';
    var failed = phase === 'error';
    var cancelled = phase === 'cancelled';
    var percent = typeof host.percent === 'number' ? host.percent : null;
    var total = typeof host.total === 'number' && host.total > 0 ? host.total : null;
    var received = typeof host.received === 'number' ? host.received : 0;
    var releasesUrl = typeof host.releasesUrl === 'string' ? host.releasesUrl : 'https://github.com/PowerShell/PowerShell/releases/latest';

    // Status body ------------------------------------------------------------
    var body = [];
    if (localError !== null) {
      body.push(React.createElement('p', { key: 'offline', className: 'pwsh7_hint' }, t('offline')));
      body.push(React.createElement('pre', { key: 'offline-error', className: 'pwsh7_error' }, localError));
    }

    if (working) {
      body.push(React.createElement('p', { key: 'working', className: 'pwsh7_text', 'aria-live': 'polite' }, t(phase)));
      body.push(React.createElement(
        'div',
        {
          key: 'progress',
          className: 'pwsh7_progress',
          role: 'progressbar',
          'aria-label': t(phase),
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': percent === null ? undefined : percent,
          'data-indeterminate': percent === null || phase === 'installing' || phase === 'cancelling' ? 'true' : undefined
        },
        React.createElement('span', {
          key: 'bar',
          className: 'pwsh7_bar',
          style: percent === null || phase === 'installing' || phase === 'cancelling' ? undefined : { width: percent + '%' }
        })
      ));
      if (phase !== 'installing' && phase !== 'cancelling' && phase !== 'verifying') {
        var progressText = total === null
          ? (received > 0 ? interpolate(t('progressUnknown'), { received: formatBytes(received) }) : t('preparing'))
          : interpolate(t('progress'), {
            received: formatBytes(received),
            total: formatBytes(total),
            percent: String(percent === null ? 0 : percent)
          });
        body.push(React.createElement(
          'div',
          { key: 'meta', className: 'pwsh7_meta' },
          React.createElement('span', { key: 'text' }, progressText),
          React.createElement('span', { key: 'root' }, formatBytes(received))
        ));
      }
      if (typeof host.installRoot === 'string') {
        body.push(React.createElement('p', { key: 'path', className: 'pwsh7_hint' }, host.installRoot));
      }
    } else if (accepted) {
      body.push(React.createElement(
        'div',
        { key: 'done', className: 'pwsh7_state' },
        React.createElement(
          'span',
          { className: 'pwsh7_stateIcon', 'data-tone': 'success', 'aria-hidden': 'true' },
          React.createElement('svg', { viewBox: '0 0 16 16', width: 12, height: 12, focusable: 'false' },
            React.createElement('path', {
              d: 'M3 8.5 6.2 11.7 13 4.9',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round'
            }))
        ),
        React.createElement(
          'div',
          { style: { minWidth: 0 } },
          React.createElement('p', { className: 'pwsh7_stateTitle' }, t('installed')),
          React.createElement('p', { className: 'pwsh7_stateBody' },
            host.version && host.path
              ? interpolate(t('installedBody'), { version: host.version, path: host.path })
              : interpolate(t('installedNoVersion'), { path: host.path || host.installRoot || '' }))
        )
      ));
    } else if (failed) {
      body.push(React.createElement(
        'div',
        { key: 'failed', className: 'pwsh7_state' },
        React.createElement(
          'span',
          { className: 'pwsh7_stateIcon', 'data-tone': 'error', 'aria-hidden': 'true' },
          React.createElement('svg', { viewBox: '0 0 16 16', width: 12, height: 12, focusable: 'false' },
            React.createElement('path', {
              d: 'M8 2.2 1.6 13.4h12.8L8 2.2Zm0 3.2v3.4m0 2.1v.2',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.5,
              strokeLinecap: 'round',
              strokeLinejoin: 'round'
            }))
        ),
        React.createElement(
          'div',
          { style: { minWidth: 0 } },
          React.createElement('p', { className: 'pwsh7_stateTitle' }, t('failed')),
          React.createElement('p', { className: 'pwsh7_stateBody' }, host.error || t('failed'))
        )
      ));
      body.push(React.createElement('p', { key: 'retry-hint', className: 'pwsh7_hint' },
        interpolate(t('retryHint'), { url: releasesUrl })));
      body.push(React.createElement(
        'p',
        { key: 'manual', className: 'pwsh7_hint' },
        React.createElement('a', {
          className: 'pwsh7_link',
          href: releasesUrl,
          target: '_blank',
          rel: 'noopener noreferrer'
        }, t('manual'))
      ));
    } else {
      if (cancelled) {
        body.push(React.createElement('p', { key: 'cancelled', className: 'pwsh7_text' }, t('cancelled')));
        body.push(React.createElement('p', { key: 'cancelled-body', className: 'pwsh7_hint' },
          interpolate(t('cancelledBody'), { url: releasesUrl })));
      } else {
        body.push(React.createElement('p', { key: 'body', className: 'pwsh7_text' },
          interpolate(t('body'), { path: (host.installRoots && host.installRoots[scope]) || host.installRoot || '' })));
        body.push(React.createElement('p', { key: 'hint', className: 'pwsh7_hint' }, t('hint')));
        body.push(React.createElement(
          'p',
          { key: 'manual', className: 'pwsh7_hint' },
          React.createElement('a', {
            className: 'pwsh7_link',
            href: releasesUrl,
            target: '_blank',
            rel: 'noopener noreferrer'
          }, t('manual'))
        ));
      }
    }

    if (!busyPhase(host.phase) && !host.found) {
      body.push(React.createElement('label', { key: 'scope', className: 'pwsh7_text' },
        t('scopeLabel'),
        React.createElement('select', {
          value: scope, disabled: busy,
          onChange: function (event) { setScope(event.target.value); }
        },
          React.createElement('option', { value: 'user' }, t('userScope')),
          React.createElement('option', { value: 'system' }, t('systemScope')))));
    }

    // Footer -----------------------------------------------------------------
    var footer = [];
    if (working) {
      footer.push(React.createElement(
        'button',
        {
          key: 'cancel',
          type: 'button',
          className: 'pwsh7_button pwsh7_outline',
          disabled: phase === 'cancelling' || busy,
          onClick: cancelInstall
        },
        t('cancel')
      ));
      footer.push(React.createElement(
        'button',
        {
          key: 'working-primary',
          type: 'button',
          className: 'pwsh7_button pwsh7_primary',
          disabled: true
        },
        t(phase)
      ));
    } else if (accepted) {
      footer.push(React.createElement(
        'button',
        {
          key: 'done',
          type: 'button',
          ref: primaryRef,
          className: 'pwsh7_button pwsh7_primary',
          onClick: dismiss
        },
        t('done')
      ));
    } else {
      footer.push(React.createElement(
        'button',
        {
          key: 'later',
          type: 'button',
          className: 'pwsh7_button pwsh7_ghost',
          onClick: dismiss
        },
        failed || cancelled ? t('close') : t('later')
      ));
      footer.push(React.createElement(
        'button',
        {
          key: 'install',
          type: 'button',
          ref: primaryRef,
          className: 'pwsh7_button pwsh7_primary',
          disabled: busy,
          onClick: startInstall
        },
        failed || cancelled ? t('retry') : (busy ? t('preparing') : t('download'))
      ));
    }

    return React.createElement(
      React.Fragment,
      null,
      React.createElement('style', { key: 'style', dangerouslySetInnerHTML: { __html: CSS } }),
      React.createElement(
        'div',
        {
          key: 'root',
          className: 'pwsh7_root'
        },
        React.createElement('div', {
          key: 'mask',
          className: 'pwsh7_mask',
          'aria-hidden': 'true',
          onMouseDown: dismiss
        }),
        React.createElement(
          'div',
          {
            key: 'dialog',
            className: 'pwsh7_dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'pwsh7-dialog-title'
          },
          React.createElement(
            'div',
            { key: 'header', className: 'pwsh7_header' },
            React.createElement('h2', { key: 'title', id: 'pwsh7-dialog-title', className: 'pwsh7_title' }, t('title')),
            React.createElement(
              'button',
              {
                key: 'close',
                type: 'button',
                className: 'pwsh7_close',
                'aria-label': t('close'),
                title: t('close'),
                onClick: dismiss
              },
              '\u00d7'
            )
          ),
          React.createElement('p', { key: 'lead', className: 'pwsh7_description' }, t('lead')),
          React.createElement('div', { key: 'body', className: 'pwsh7_body' }, body),
          React.createElement('div', { key: 'footer', className: 'pwsh7_footer' }, footer)
        )
      )
    );
  }

  //#region settings page -----------------------------------------------------

  /**
   * The plugin's Settings page, registered into the `settings.section` slot (id `pwsh7`, order 80).
   *
   * The host gives a section the content area only — no card wrapper — so this component draws its
   * own header, cards and scrolling region, like every other third-party settings section. It reads
   * the SAME live snapshot the setup dialog uses (`/pwsh7/state`, `/pwsh7/events` with the 3 s poll
   * as the fallback), so an install, a relocation or a removal that is running in the host is
   * visible here while it happens, and every action adopts the state the server returns.
   *
   * Only `react` is available to this bundle: everything below is `React.createElement` plus the
   * classic-script style of the rest of this file. Copy lives in the `pwsh7` dictionaries.
   *
   * @param {object} props owner props; `t` is bound by the `settings.section` inject.
   * @returns {object} the page tree.
   */
  function Pwsh7Settings(props) {
    var t = typeof props.t === 'function' ? props.t : fallbackTranslate;

    var hostState = React.useState(null);
    var host = readState(hostState[0]);
    var setHost = hostState[1];

    /** `{message, hint, requiresElevation, warnings}` for the last failed request. */
    var errorState = React.useState(null);
    var actionError = errorState[0];
    var setActionError = errorState[1];

    /** Which local request is in flight: route | install | relocate | uninstall | selfcheck. */
    var busyState = React.useState(null);
    var busyAction = busyState[0];
    var setBusyAction = busyState[1];

    /** Which inline confirmation is open: relocate | uninstall | null. */
    var confirmState = React.useState(null);
    var confirming = confirmState[0];
    var setConfirming = confirmState[1];

    /** The last `/pwsh7/selfcheck` response, or null before the first run. */
    var checkState = React.useState(null);
    var selfcheck = checkState[0];
    var setSelfcheck = checkState[1];

    /** `{text, warnings}` for the last successful action. */
    var noticeState = React.useState(null);
    var notice = noticeState[0];
    var setNotice = noticeState[1];

    var mounted = React.useRef(true);
    var serial = React.useRef(0);
    var pollTimer = React.useRef(null);
    var source = React.useRef(null);
    var hadState = React.useRef(false);
    /** Signature of the `state.relocate` outcome already turned into a notice. */
    var relocateSeen = React.useRef(null);

    /** Adopt one host snapshot; the serial guard drops a stale poll response. */
    function adopt(next) {
      if (!mounted.current) return;
      if (next === null || typeof next !== 'object') return;
      serial.current += 1;
      // A "could not reach the host" message belongs to the loading surface only; the first real
      // snapshot retires it. Later action failures keep their own message.
      var firstState = hadState.current !== true;
      hadState.current = true;
      if (firstState) setActionError(null);
      // A finished relocation reports through state, not through the 202 that started it: show the
      // system executable, the removed user copies and any warnings once the job settles.
      var signature = relocateSignature(next.relocate);
      if (signature !== null && signature !== relocateSeen.current) {
        var relocationNotice = relocateNoticeFor(t, next.relocate);
        if (relocationNotice !== null) {
          relocateSeen.current = signature;
          setNotice(relocationNotice);
        }
      }
      setHost(next);
    }

    function refresh() {
      var ticket = (serial.current += 1);
      onlineFetch(ROUTE_STATE, { cache: 'no-store', credentials: 'omit' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (next) {
          if (ticket === serial.current) adopt(next);
        })
        .catch(function () {
          if (!mounted.current || hadState.current) return;
          setActionError({
            message: t('loadFailed'),
            hint: null,
            requiresElevation: false,
            warnings: []
          });
        });
    }

    function stopPolling() {
      if (pollTimer.current !== null) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }

    function startPolling() {
      if (pollTimer.current !== null) return;
      pollTimer.current = setInterval(refresh, POLL_MS);
    }

    function connectEvents() {
      if (typeof EventSource !== 'function') {
        startPolling();
        return;
      }
      try {
        source.current = new EventSource(ROUTE_EVENTS);
      } catch (error) {
        startPolling();
        return;
      }
      source.current.addEventListener('state', function (event) {
        try {
          adopt(JSON.parse(event.data));
        } catch (error) {
          // A malformed frame is not worth a broken page; polling still covers the state.
        }
      });
      source.current.onerror = function () {
        // EventSource reconnects on its own; the always-on poll keeps progress moving if not.
        startPolling();
      };
    }

    /** POST JSON and reject with the server's `error`/`hint` attached, so 412 can be rendered. */
    function postJson(url, body) {
      return onlineFetch(url, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (response) {
        return response.json().then(function (data) {
          var payload = data !== null && typeof data === 'object' ? data : {};
          if (!response.ok || payload.ok === false) {
            var failure = new Error(textOrNull(payload.error) || ('HTTP ' + response.status));
            failure.status = response.status;
            failure.payload = payload;
            throw failure;
          }
          return payload;
        }, function () {
          // A non-JSON body (proxy page, host gone): the status is still worth showing.
          throw new Error('HTTP ' + response.status);
        });
      });
    }

    /**
     * Run one action with the page-wide busy guard, then clear it. Every rejection becomes the
     * inline error block; an HTTP 412 (elevation required) is marked so the hint is rendered.
     */
    function runAction(label, work) {
      if (busyAction !== null || (host !== null && host.busy)) return;
      setBusyAction(label);
      setActionError(null);
      setNotice(null);
      setConfirming(null);
      // A new action supersedes the previous relocation report: mark the outcome currently in the
      // snapshot as seen, so only a NEWER relocation can raise a notice again.
      if (host !== null && host.raw !== null && typeof host.raw === 'object') {
        relocateSeen.current = relocateSignature(host.raw.relocate);
      }
      Promise.resolve()
        .then(work)
        .catch(function (error) {
          if (!mounted.current) return;
          var failure = error !== null && typeof error === 'object' ? error : {};
          var payload = failure.payload !== null && typeof failure.payload === 'object' ? failure.payload : {};
          setActionError({
            message: textOrNull(failure.message) || t('actionFailed'),
            hint: textOrNull(payload.hint),
            requiresElevation: payload.requiresElevation === true || failure.status === 412,
            warnings: Array.isArray(payload.warnings)
              ? payload.warnings.filter(function (entry) { return typeof entry === 'string'; })
              : []
          });
        })
        .then(function () {
          if (mounted.current) setBusyAction(null);
        });
    }

    function swapRoute(mode) {
      if (host === null || host.route === mode) return;
      runAction('route', function () {
        return postJson(ROUTE_ROUTE, { mode: mode }).then(function (data) {
          if (data.state) adopt(data.state);
          else refresh();
          if (mounted.current) {
            setNotice({
              text: interpolate(t('routeSaved'), { mode: t(mode === 'system' ? 'routeSystem' : 'routePlugin') }),
              warnings: []
            });
          }
        });
      });
    }

    function startInstall() {
      runAction('install', function () {
        return postJson(ROUTE_INSTALL, { method: 'auto', scope: 'user' }).then(function (data) {
          if (data.state) adopt(data.state);
          else refresh();
        });
      });
    }

    function startRelocate() {
      runAction('relocate', function () {
        return postJson(ROUTE_RELOCATE, { removeUser: true, method: 'auto' }).then(function (data) {
          if (data.state) adopt(data.state);
          else refresh();
          if (mounted.current) setNotice({ text: t('relocateStarted'), warnings: [] });
        });
      });
    }

    function startUninstall() {
      runAction('uninstall', function () {
        return postJson(ROUTE_UNINSTALL, { confirm: true, scope: 'user' }).then(function (data) {
          if (data.state) adopt(data.state);
          else refresh();
          var warnings = Array.isArray(data.warnings)
            ? data.warnings.filter(function (entry) { return typeof entry === 'string'; })
            : [];
          if (mounted.current) setNotice({ text: t('uninstallDone'), warnings: warnings });
        });
      });
    }

    function runSelfcheck() {
      runAction('selfcheck', function () {
        return postJson(ROUTE_SELFCHECK, {}).then(function (data) {
          if (mounted.current) setSelfcheck(data);
        });
      });
    }

    React.useEffect(function () {
      mounted.current = true;
      refresh();
      // Poll unconditionally: SSE gives smooth progress, the poll is the safety net for a carrier
      // that buffers the stream. The setup dialog does the same, and both may be mounted at once.
      startPolling();
      connectEvents();
      return function () {
        mounted.current = false;
        stopPolling();
        if (source.current !== null) {
          try {
            source.current.close();
          } catch (error) {
            // Already closed.
          }
          source.current = null;
        }
      };
    }, []);

    /** One label/value row; `mono` marks paths and configuration values. */
    function row(key, label, value, mono) {
      return React.createElement(
        'div',
        { key: key, className: 'pwsh7_row' },
        React.createElement('span', { key: 'label', className: 'pwsh7_rowLabel' }, label),
        React.createElement('span', {
          key: 'value',
          className: 'pwsh7_rowValue',
          'data-mono': mono === true ? 'true' : undefined
        }, value)
      );
    }

    /** One boolean flag chip, with an explicit yes/no so absence never reads as "off". */
    function flag(key, label, on) {
      return React.createElement(
        'span',
        { key: key, className: 'pwsh7_flag', 'data-on': on ? 'true' : 'false' },
        React.createElement('span', { key: 'dot', className: 'pwsh7_flagDot', 'aria-hidden': 'true' }),
        label + ': ' + (on ? t('yes') : t('no'))
      );
    }

    function scopeLabel(scope) {
      if (scope === 'user') return t('scopeUser');
      if (scope === 'system') return t('scopeSystem');
      return t('unknown');
    }

    function methodLabel(method) {
      if (method === 'portable') return t('methodPortable');
      if (method === 'winget') return t('methodWinget');
      if (method === 'auto') return t('methodAuto');
      if (method === 'existing') return t('methodExisting');
      return method === null ? t('unknown') : method;
    }

    /** The inline failure block: server message, an elevation hint for 412, warnings for uninstall. */
    function errorBlock(key, failure) {
      var children = [];
      if (failure.requiresElevation) {
        children.push(React.createElement('p', { key: 'elevation', className: 'pwsh7_rowValue' }, t('elevationRequired')));
      }
      children.push(React.createElement('p', { key: 'message', className: 'pwsh7_rowValue' }, failure.message));
      if (failure.hint !== null && failure.hint !== undefined) {
        children.push(React.createElement('p', { key: 'hint', className: 'pwsh7_hint' }, failure.hint));
      }
      if (failure.requiresElevation) {
        children.push(React.createElement('p', { key: 'elevation-hint', className: 'pwsh7_hint' }, t('elevationHint')));
      }
      if (Array.isArray(failure.warnings) && failure.warnings.length > 0) {
        children.push(React.createElement('p', { key: 'warnings', className: 'pwsh7_hint' }, t('uninstallWarnings')));
        children.push(React.createElement(
          'ul',
          { key: 'warning-list', className: 'pwsh7_warnList' },
          failure.warnings.map(function (entry, index) {
            return React.createElement('li', { key: 'warning-' + index }, entry);
          })
        ));
      }
      return React.createElement('div', { key: key, className: 'pwsh7_errorBox', role: 'alert' }, children);
    }

    function actionButton(key, label, action, options) {
      var extra = options !== null && typeof options === 'object' ? options : {};
      return React.createElement('button', {
        key: key,
        type: 'button',
        className: 'pwsh7_button ' + (extra.danger === true ? 'pwsh7_outline pwsh7_danger' : 'pwsh7_outline'),
        'data-action': action,
        disabled: extra.disabled === true,
        onClick: extra.onClick
      }, label);
    }

    function routeButton(mode, label, on, disabled) {
      return React.createElement('button', {
        key: 'route-' + mode,
        type: 'button',
        className: 'pwsh7_segBtn',
        'data-action': 'route-' + mode,
        'data-on': on ? 'true' : 'false',
        'aria-pressed': on ? 'true' : 'false',
        disabled: disabled,
        onClick: function () { swapRoute(mode); }
      }, label);
    }

    // Loading / unreachable host -------------------------------------------------
    if (host === null) {
      var loadingHead = React.createElement(
        'div',
        { key: 'head', className: 'pwsh7_setHead' },
        React.createElement('h2', { key: 'title', className: 'pwsh7_setTitle' }, t('settingsTitle')),
        React.createElement('p', { key: 'subtitle', className: 'pwsh7_setSubtitle' }, t('settingsSubtitle'))
      );
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('style', { key: 'style', dangerouslySetInnerHTML: { __html: CSS } }),
        React.createElement(
          'div',
          { key: 'root', className: 'pwsh7_setRoot' },
          React.createElement(
            'div',
            { key: 'scroll', className: 'pwsh7_setScroll' },
            React.createElement(
              'div',
              { key: 'inner', className: 'pwsh7_setInner' },
              loadingHead,
              actionError !== null ? errorBlock('load-error', actionError) : null,
              actionError === null
                ? React.createElement('p', { key: 'loading', className: 'pwsh7_empty' }, t('loading'))
                : null,
              React.createElement(
                'div',
                { key: 'retry-row', className: 'pwsh7_actions' },
                actionButton('retry', t('retry'), 'retry', {
                  onClick: function () { setActionError(null); refresh(); }
                })
              )
            )
          )
        )
      );
    }

    var busy = host.busy || busyAction !== null;

    // Header --------------------------------------------------------------------
    var header = React.createElement(
      'div',
      { key: 'head', className: 'pwsh7_setHead' },
      React.createElement('h2', { key: 'title', className: 'pwsh7_setTitle' }, t('settingsTitle')),
      host.pluginVersion !== null
        ? React.createElement('span', { key: 'plugin-version', className: 'pwsh7_badge' }, 'v' + host.pluginVersion)
        : null,
      React.createElement('span', {
        key: 'status',
        className: 'pwsh7_badge',
        'data-tone': host.found ? 'success' : 'error'
      }, host.found
        ? (host.version !== null ? interpolate(t('statusReady'), { version: host.version }) : t('statusReadyNoVersion'))
        : t('notInstalled')),
      React.createElement('p', { key: 'subtitle', className: 'pwsh7_setSubtitle' }, t('settingsSubtitle'))
    );

    // Live install/relocate progress --------------------------------------------
    var workingPhase = busyPhase(host.phase);
    var determinate = workingPhase && host.percent !== null
      && host.phase !== 'installing' && host.phase !== 'cancelling' && host.phase !== 'verifying';
    var phaseLabel = workingPhase ? t(host.phase) : t('busyJob');
    var progressCard = host.busy || workingPhase
      ? React.createElement(
        'section',
        { key: 'progress', className: 'pwsh7_card', 'aria-live': 'polite' },
        React.createElement('p', { key: 'phase', className: 'pwsh7_rowValue' }, phaseLabel),
        React.createElement(
          'div',
          {
            key: 'track',
            className: 'pwsh7_progress',
            role: 'progressbar',
            'aria-label': phaseLabel,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': determinate ? host.percent : undefined,
            'data-indeterminate': determinate ? undefined : 'true'
          },
          React.createElement('span', {
            key: 'bar',
            className: 'pwsh7_bar',
            style: determinate ? { width: host.percent + '%' } : undefined
          })
        ),
        host.total !== null
          ? React.createElement(
            'div',
            { key: 'meta', className: 'pwsh7_meta' },
            React.createElement('span', { key: 'text' }, interpolate(t('progress'), {
              received: formatBytes(host.received),
              total: formatBytes(host.total),
              percent: String(host.percent === null ? 0 : host.percent)
            })),
            React.createElement('span', { key: 'received' }, formatBytes(host.received))
          )
          : null,
        host.message !== null
          ? React.createElement('p', { key: 'message', className: 'pwsh7_hint' }, host.message)
          : null
      )
      : null;

    // Installation ---------------------------------------------------------------
    var installRows = [];
    if (host.found) {
      installRows.push(row('version', t('labelPsVersion'), host.version === null ? t('unknown') : host.version));
      installRows.push(row('path', t('labelPath'), host.path === null ? t('unknown') : host.path, true));
      installRows.push(row('directory', t('labelDirectory'), host.directory === null ? t('unknown') : host.directory, true));
      installRows.push(row('scope', t('labelScope'), scopeLabel(host.scope)));
      installRows.push(row('method', t('labelMethod'), methodLabel(host.method)));
    } else {
      installRows.push(React.createElement('p', { key: 'missing', className: 'pwsh7_empty' }, t('installedNone')));
    }
    installRows.push(row('config', t('labelConfig'), host.configPath === null ? t('unknown') : host.configPath, true));
    installRows.push(React.createElement(
      'div',
      { key: 'flags', className: 'pwsh7_flags' },
      [
        flag('managed', t('labelManaged'), host.managed),
        flag('removable', t('labelRemovable'), host.removable),
        flag('user-copy', t('labelUserCopy'), host.userCopy),
        flag('system-copy', t('labelSystemCopy'), host.systemCopy),
        flag('path-entry', t('labelPathEntry'), host.pathEntry)
      ]
    ));

    var installCard = React.createElement(
      'section',
      { key: 'install', className: 'pwsh7_card' },
      React.createElement('h3', { key: 'title', className: 'pwsh7_cardTitle' }, t('sectionInstall')),
      React.createElement('div', { key: 'rows', className: 'pwsh7_rows' }, installRows)
    );

    // Routing --------------------------------------------------------------------
    var routeCard = React.createElement(
      'section',
      { key: 'route', className: 'pwsh7_card' },
      React.createElement('h3', { key: 'title', className: 'pwsh7_cardTitle' }, t('sectionRoute')),
      React.createElement(
        'div',
        { key: 'seg', className: 'pwsh7_seg', role: 'group', 'aria-label': t('sectionRoute') },
        routeButton('plugin', t('routePlugin'), host.route === 'plugin', busy),
        routeButton('system', t('routeSystem'), host.route === 'system', busy)
      ),
      React.createElement(
        'p',
        { key: 'hint', className: 'pwsh7_actionHint' },
        host.route === 'system' ? t('routeSystemHint') : t('routePluginHint')
      ),
      host.route === 'system'
        ? React.createElement(
          'p',
          { key: 'resolved', className: 'pwsh7_actionHint' },
          host.systemPath !== null
            ? interpolate(t('routeSystemPath'), { path: host.systemPath })
            : t('routeSystemMissing')
        )
        : null,
      busyAction === 'route'
        ? React.createElement('p', { key: 'saving', className: 'pwsh7_hint' }, t('routeSaving'))
        : null
    );

    // Maintenance actions --------------------------------------------------------
    var actionChildren = [];

    if (!host.found) {
      actionChildren.push(React.createElement('p', { key: 'install-hint', className: 'pwsh7_actionHint' }, t('actionInstallHint')));
      actionChildren.push(React.createElement(
        'div',
        { key: 'install-row', className: 'pwsh7_actions' },
        actionButton('install-button', t('actionInstall'), 'install', {
          disabled: busy,
          onClick: startInstall
        })
      ));
    }

    if (host.userCopy) {
      actionChildren.push(React.createElement('p', { key: 'relocate-hint', className: 'pwsh7_actionHint' }, t('actionRelocateHint')));
      if (confirming === 'relocate') {
        actionChildren.push(React.createElement(
          'div',
          { key: 'relocate-confirm', className: 'pwsh7_confirm' },
          React.createElement('p', { key: 'text', className: 'pwsh7_confirmText' }, t('relocateConfirm')),
          React.createElement(
            'div',
            { key: 'buttons', className: 'pwsh7_actions' },
            actionButton('relocate-cancel', t('confirmCancel'), 'relocate-cancel', {
              onClick: function () { setConfirming(null); }
            }),
            actionButton('relocate-do', t('relocateConfirmButton'), 'relocate-confirm', {
              disabled: busy,
              onClick: startRelocate
            })
          )
        ));
      } else {
        actionChildren.push(React.createElement(
          'div',
          { key: 'relocate-row', className: 'pwsh7_actions' },
          actionButton('relocate-button', t('actionRelocate'), 'relocate', {
            disabled: busy,
            onClick: function () { setConfirming('relocate'); }
          })
        ));
      }
    }

    if (host.removable) {
      actionChildren.push(React.createElement('p', { key: 'uninstall-hint', className: 'pwsh7_actionHint' }, t('actionUninstallHint')));
      if (confirming === 'uninstall') {
        actionChildren.push(React.createElement(
          'div',
          { key: 'uninstall-confirm', className: 'pwsh7_confirm' },
          React.createElement('p', { key: 'text', className: 'pwsh7_confirmText' }, t('uninstallConfirm')),
          React.createElement(
            'div',
            { key: 'buttons', className: 'pwsh7_actions' },
            actionButton('uninstall-cancel', t('confirmCancel'), 'uninstall-cancel', {
              onClick: function () { setConfirming(null); }
            }),
            actionButton('uninstall-do', t('uninstallConfirmButton'), 'uninstall-confirm', {
              danger: true,
              disabled: busy,
              onClick: startUninstall
            })
          )
        ));
      } else {
        actionChildren.push(React.createElement(
          'div',
          { key: 'uninstall-row', className: 'pwsh7_actions' },
          actionButton('uninstall-button', t('actionUninstall'), 'uninstall', {
            danger: true,
            disabled: busy,
            onClick: function () { setConfirming('uninstall'); }
          })
        ));
      }
    }

    if (host.busy) {
      actionChildren.push(React.createElement('p', { key: 'busy-job', className: 'pwsh7_hint' }, t('busyJob')));
    }

    if (notice !== null && typeof notice.text === 'string') {
      actionChildren.push(React.createElement('p', { key: 'notice', className: 'pwsh7_notice' }, notice.text));
      if (Array.isArray(notice.details) && notice.details.length > 0) {
        actionChildren.push(React.createElement(
          'ul',
          { key: 'notice-details', className: 'pwsh7_detailList' },
          notice.details.map(function (entry, index) {
            return React.createElement('li', { key: 'detail-' + index }, entry);
          })
        ));
      }
      if (Array.isArray(notice.warnings) && notice.warnings.length > 0) {
        actionChildren.push(React.createElement(
          'div',
          { key: 'notice-warnings', className: 'pwsh7_warnBox' },
          t('uninstallWarnings'),
          React.createElement(
            'ul',
            { key: 'list', className: 'pwsh7_warnList' },
            notice.warnings.map(function (entry, index) {
              return React.createElement('li', { key: 'warning-' + index }, entry);
            })
          )
        ));
      }
    }

    if (actionError !== null) actionChildren.push(errorBlock('action-error', actionError));

    // Self-check -----------------------------------------------------------------
    var checks = [];
    if (selfcheck !== null && Array.isArray(selfcheck.checks)) {
      checks = selfcheck.checks.slice().sort(function (left, right) {
        return selfcheckRank(left && left.id) - selfcheckRank(right && right.id);
      });
    }
    var checkRows = checks.map(function (check, index) {
      var item = check !== null && typeof check === 'object' ? check : {};
      var id = typeof item.id === 'string' ? item.id : '';
      var status = item.status === 'ok' || item.status === 'warn' || item.status === 'fail' ? item.status : 'fail';
      var detail = typeof item.detail === 'string' ? item.detail : '';
      var suffix = status === 'ok' ? '' : ' · ' + t(status === 'warn' ? 'statusWarn' : 'statusFail');
      return React.createElement(
        'li',
        { key: 'check-' + (id || index), className: 'pwsh7_check', 'data-status': status },
        React.createElement('span', { key: 'dot', className: 'pwsh7_checkDot', 'aria-hidden': 'true' }),
        React.createElement(
          'span',
          { key: 'body', className: 'pwsh7_checkBody' },
          React.createElement('span', {
            key: 'title',
            className: 'pwsh7_checkTitle',
            'data-status': status
          }, t('selfcheck.' + id) + suffix),
          detail !== '' ? React.createElement('span', { key: 'detail', className: 'pwsh7_checkDetail' }, detail) : null
        )
      );
    });

    var summaryText = null;
    var checkedText = null;
    if (selfcheck !== null) {
      var summary = selfcheck.summary !== null && typeof selfcheck.summary === 'object' ? selfcheck.summary : null;
      if (summary !== null) {
        summaryText = interpolate(t('selfcheckSummary'), {
          ok: Number(summary.ok) || 0,
          warn: Number(summary.warn) || 0,
          fail: Number(summary.fail) || 0
        });
      }
      if (typeof selfcheck.checkedAt === 'string' && selfcheck.checkedAt.length > 0) {
        checkedText = interpolate(t('selfcheckAt'), { time: formatCheckedAt(selfcheck.checkedAt) });
      }
    }

    actionChildren.push(React.createElement(
      'div',
      { key: 'selfcheck', className: 'pwsh7_rows' },
      React.createElement(
        'div',
        { key: 'head', className: 'pwsh7_selfHead' },
        actionButton('selfcheck-button', busyAction === 'selfcheck' ? t('selfcheckRunning') : t('selfcheckRun'), 'selfcheck', {
          disabled: busy,
          onClick: runSelfcheck
        }),
        summaryText !== null
          ? React.createElement('p', { key: 'summary', className: 'pwsh7_summary' }, summaryText)
          : null,
        checkedText !== null
          ? React.createElement('p', { key: 'at', className: 'pwsh7_summary' }, checkedText)
          : null
      ),
      checkRows.length > 0
        ? React.createElement('ul', { key: 'checks', className: 'pwsh7_checks' }, checkRows)
        : React.createElement('p', { key: 'empty', className: 'pwsh7_empty' }, t('selfcheckEmpty'))
    ));

    var actionsCard = React.createElement(
      'section',
      { key: 'actions', className: 'pwsh7_card' },
      React.createElement('h3', { key: 'title', className: 'pwsh7_cardTitle' }, t('sectionActions')),
      actionChildren
    );

    return React.createElement(
      React.Fragment,
      null,
      React.createElement('style', { key: 'style', dangerouslySetInnerHTML: { __html: CSS } }),
      React.createElement(
        'div',
        { key: 'root', className: 'pwsh7_setRoot' },
        React.createElement(
          'div',
          { key: 'scroll', className: 'pwsh7_setScroll' },
          React.createElement(
            'div',
            { key: 'inner', className: 'pwsh7_setInner' },
            header,
            progressCard,
            installCard,
            routeCard,
            actionsCard
          )
        )
      )
    );
  }

  //#endregion

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: PLUGIN_ID,
      factory: function (require) {
        React = require('react');

        return {
          inject: ['slots', 'locale'],
          /**
           * Client plugin body: own the locale dictionaries and contribute the setup dialog to the
           * shell's root overlay slot.
           * @param {object} ctx the plugin's client cordis context.
           */
          apply: function (ctx) {
            localeFace = ctx.locale;

            if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
              ctx.effect(function () {
                return ctx.locale.register(LOCALE_NS, 'en', EN);
              }, PLUGIN_ID + ': en dictionary');
              ctx.effect(function () {
                return ctx.locale.register(LOCALE_NS, 'zh', ZH);
              }, PLUGIN_ID + ': zh dictionary');
            }

            // The settings page's label and its `t` prop come from the SAME bound translator, so a
            // language switch re-labels the nav row and the mounted page together. A host without
            // `locale.bind` keeps working through the plugin's own fallback translator.
            var translate = fallbackTranslate;
            try {
              if (ctx.locale !== undefined && typeof ctx.locale.bind === 'function') {
                var bound = ctx.locale.bind(LOCALE_NS);
                if (typeof bound === 'function') translate = bound;
              }
            } catch (error) {
              // Keep the fallback translator.
            }

            ctx.slots.inject('shell.overlay', function () {
              return ctx.slots.register({
                name: 'shell.overlay',
                id: 'pwsh7-setup',
                order: 90,
                locale: LOCALE_NS
              }, Pwsh7SetupDialog);
            });

            ctx.slots.inject('settings.section', function () {
              return ctx.slots.register({
                name: 'settings.section',
                id: 'pwsh7',
                order: 80,
                label: function () { return translate('settingsNav'); },
                locale: LOCALE_NS,
                inject: function () { return { t: translate }; }
              }, Pwsh7Settings);
            });
          }
        };
      }
    });
  }
})();
