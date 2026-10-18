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
    offline: 'Could not reach the DSH host. The install may still work from the shell_router tool.',
    progress: '{received} / {total} ({percent}%)',
    progressUnknown: 'Downloaded {received}',
    manual: 'Manual download',
    retryHint: 'If the download keeps failing, install PowerShell 7 from {url}, then try again.',
    pathLabel: 'Install location'
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
    offline: '无法连接到 DSH 宿主；也可以让模型调用 shell_router 工具的 install 操作来安装。',
    progress: '{received} / {total}（{percent}%）',
    progressUnknown: '已下载 {received}',
    manual: '手动下载',
    retryHint: '如果下载一直失败，请从 {url} 安装 PowerShell 7，然后重试。',
    pathLabel: '安装位置'
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

            ctx.slots.inject('shell.overlay', function () {
              return ctx.slots.register({
                name: 'shell.overlay',
                id: 'pwsh7-setup',
                order: 90,
                locale: LOCALE_NS
              }, Pwsh7SetupDialog);
            });
          }
        };
      }
    });
  }
})();
