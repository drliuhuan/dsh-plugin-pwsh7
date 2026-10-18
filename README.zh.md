# dsh-plugin-pwsh7

[![npm version](https://img.shields.io/npm/v/dsh-plugin-pwsh7.svg)](https://www.npmjs.com/package/dsh-plugin-pwsh7)
[![license](https://img.shields.io/npm/l/dsh-plugin-pwsh7.svg)](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/LICENSE)

Windows 上的 DeepSeek Harness（DSH）插件：把模型侧的 **`pwsh` 工具路由到 PowerShell 7**
（`pwsh.exe`，主版本 >= 7），不再落到 Windows PowerShell 5.1。

- 执行器继承 DSH 自带 `dsh-pwsh-sandbox` 的全部行为：沙箱模式、`sandbox_permissions` 升权、
  拒绝/runner 失败标记、后台任务、输出上限与 exit marker；本插件只替换可执行文件解析。
- 找不到 PowerShell 7 时，提供模型可调用的 **`shell_router`** 工具做检测、诊断和
  **用户级自动下载安装**（默认不需要管理员权限）。
- Web GUI 里另有**安装弹窗**：开机检测到缺失时、以及之后**每次 `pwsh` 运行因缺少 PowerShell 7
  失败时**都会弹出，提供下载按钮与实时进度（已下载字节、百分比、阶段）。关闭弹窗不会中断安装，
  下一次失败运行会再次弹出。

[English](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/README.md) | 中文

---

## 它做什么

Windows 预设把 `pwsh-sandbox` 行挂到 `ctx.shell`，但可执行文件解析在部分环境里会落到
Windows PowerShell 5.1。本插件保留官方执行器，只覆盖 `pwshPath` 解析：

1. **替换 `pwsh-sandbox` 行**：`RouterPwshExecutor extends SandboxPwshExecutor`。显式
   `config.pwshPath` 优先；否则使用插件检测到的 PowerShell 7。
2. **插入裸包名 `dsh-plugin-pwsh7` 行**：注册 `shell_router` 工具（`status` / `diagnose` / `install`）、
   系统提示小节与 Web 安装弹窗路由。这行的裸包名也是 DSH 客户端模块扫描器发现 `client.js` 的依据；
   executor 行的 `./pwsh-executor` 子路径不会被当作客户端 bundle 来源。

## 环境要求

- Windows 10/11。
- 支持 bundle 的 DSH profile（`@deepseek-ai/dsh-base` / Web profile）。已在 DSH desktop
  0.2.1-rc.2 上验证。
- Node.js >= 22 仅运行仓库测试时需要。

## 安装

通过 DSH 插件管理器从 npm 安装：

```
plugin_manager action=install_bundle target=dsh-plugin-pwsh7@0.2.0
```

或从本地目录安装（目录安装会链接源码，便于开发）：

```
plugin_manager action=install_bundle target=D:\path\to\dsh-plugin-pwsh7
```

新 bundle 通过 HMR 立即生效；之后修改插件源码需要重启 DSH 才会加载新模块。

## 使用

模型工具 `shell_router`：

| 动作 | 说明 |
|---|---|
| `status`（默认） | 报告解析到的 PowerShell 7 路径与版本、配置文件、当前沙箱策略、`@deepseek-ai/*` 加载状态。 |
| `diagnose` | 在**当前沙箱策略**下真实运行 PowerShell 7 命令（版本 + 工作区写入），输出退出码、stdout/stderr、拒绝/runner 失败判定与具体修复建议。 |
| `install` | 确保 PowerShell 7 可用。`method: "auto"`（默认）优先用户级便携 zip，失败回退 winget；`portable`/`winget` 强制单一方式。已有可用安装时只刷新配置，不会重复下载。 |

### 安装弹窗（Web）

浏览器半边渲染到 DSH 根级 `shell.overlay` 槽位，因此在普通 Web GUI 和桌面壳里都能用，不需要另开窗口：

- **何时弹出**：首次加载时检测不到 `pwsh.exe`；以及之后**每次 `pwsh` 工具因缺少 PowerShell 7
  失败**时（`missingSeq`）。点“稍后”只关闭到下一次失败运行；只要仍然缺失，刷新页面也会再次弹出。
- **做什么**：点“下载并安装”会启动与 `shell_router install` **同一个**用户级安装任务。弹窗依次显示
  `下载 → 解压 → 验证`，以及已下载字节、总大小和百分比；“取消下载”可以中止。
- **为什么只有一个任务**：弹窗和工具共用一个协调器，所以模型触发的安装能在弹窗里看到实时进度，
  弹窗触发的安装也会被工具等待。并发安装会在 `%LOCALAPPDATA%\dsh\pwsh7\tmp` 的同一个压缩包上互相踩踏。
- **传输**：`GET /pwsh7/state`（快照）、`GET /pwsh7/events`（SSE，进度约 7 帧/秒）、
  `POST /pwsh7/install`、`POST /pwsh7/cancel`。SSE 负责平滑进度，同时始终保留每 3 秒一次的
  `/pwsh7/state` 轮询，作为事件流被缓冲时的兜底。这些路由仅限同源，POST 只接受 `application/json`。
- **失败**：弹窗保留安装器的原始错误，提供“重试”和官方 PowerShell releases 链接；安装失败不影响
  已有的 `pwsh` 路由，直到某次安装成功。
- **范围**：弹窗属于 Web GUI。纯 CLI/无头组合仍然可以使用 `shell_router` 工具和同一个安装器，只是
  没有窗口。

### 显式指定路径

`pwsh` 可执行文件解析顺序：

1. 环境变量 `DSH_PWSH_PATH`
2. `%LOCALAPPDATA%\dsh\pwsh7\config.json` 的 `pwshPath`
3. `%ProgramFiles%\PowerShell\7\pwsh.exe`
4. `%LOCALAPPDATA%\dsh\pwsh7\powershell7\…\pwsh.exe`（便携安装，新版本优先）
5. `%LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe`
6. `PATH` 各目录
7. `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`（Store 别名）
8. `%ProgramFiles(x86)%\PowerShell\7\pwsh.exe`

官方 `pwsh-sandbox` 行本身仍支持 `pwshPath` 配置字段；显式配置优先于自动检测。

### 配置文件

`%LOCALAPPDATA%\dsh\pwsh7\config.json`：

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

## 自动安装

默认用户级、无管理员权限：

| 组件 | 来源 | 安装位置 |
|---|---|---|
| PowerShell 7 | GitHub `PowerShell/PowerShell` 最新 release 的 `PowerShell-*-win-x64.zip` | `%LOCALAPPDATA%\dsh\pwsh7\powershell7\<version>\` |

- HTTPS 流式下载到 `%LOCALAPPDATA%\dsh\pwsh7\tmp`，支持进度回调与取消。
- 解包使用 Windows 自带 `tar.exe`（bsdtar）；不会执行任何下载来的安装器。
- 解包后先真实运行一次新 `pwsh.exe` 验证主版本 >= 7，再写入 `config.json`。
- `auto` 失败回退 `winget install Microsoft.PowerShell`；需要 UAC 提升时返回明确的手动命令，
  不会卡在提权提示上。
- 不写入安装目录与临时目录以外的位置。
- 已在本机实测：下载 106,364,316 字节（约 31s），解压后 244.8 MB，验证为 `7.6.7`。

## 沙箱

- 执行器通过 `ctx.sandbox.confine()` 走 Windows ACL restricted-token runner，
  `workspace-write` / `read-only` / `danger-full-access` 与官方执行器一致。
- PowerShell 7 在三种模式下都可用（已实测：`workspace-write` 下工作区内可写、工作区外写入被拒；
  `danger-full-access` 不受限）。
- 若出现 `SetNamedSecurityInfoW failed (Win32 5)` / `grantWrite(<workspace>)`，说明工作区 DACL
  缺少权限。可运行 DSH 内置的 **`diagnose-windows-sandbox-acl`** skill 对工作区根目录做诊断+修复
  （先备份、再校验），或临时把会话切到完全权限。

## 故障排查

1. 先跑 `shell_router action="status"`：确认 PowerShell 7 的解析路径与版本。
2. 再跑 `shell_router action="diagnose"`：在当前沙箱模式下真实执行命令并分类失败。
3. 常见原因：
   - **仍然是 Windows PowerShell 5.1**：检测没找到 PowerShell 7。设置 `DSH_PWSH_PATH` 或
     `config.json` 的 `pwshPath`，再查看 `status`。
   - **PowerShell 7 装在自定义位置**：设置 `DSH_PWSH_PATH` 或 `config.json`。
   - **沙箱 / ACL 失败**：见上一节。

## 结构

| 路径 | 作用 |
|---|---|
| `index.js` | 裸包名行：安装 `shell_router`、系统提示小节、安装弹窗路由与热重载刷新 |
| `client.js` | 浏览器半边：`shell.overlay` 安装弹窗、SSE + 轮询、下载/取消、中英文案 |
| `lib/shipped.mjs` | 从运行中的 DSH 安装（Electron `app.asar`）加载 `@deepseek-ai/*` 包 |
| `lib/paths.mjs` | PowerShell 7 路径探测、版本探测、`config.json` 读写 |
| `lib/install.mjs` | 用户级便携安装（官方 zip）+ winget 回退；进度与阶段回调 |
| `lib/state.mjs` | 进程内解析缓存（executor 与工具共用）；缺失运行信号 |
| `lib/router-features.mjs` | 从裸包名行安装 `shell_router`、系统提示小节、安装协调器与 Web 路由 |
| `lib/setup-service.mjs` | 安装协调器：同一时刻一个任务、进度快照、取消、`missingSeq` |
| `lib/setup-routes.mjs` | `/pwsh7/state`、`/pwsh7/events`（SSE）、`/pwsh7/install`、`/pwsh7/cancel` |
| `lib/status.mjs` | `status` / `diagnose` 实现 |
| `lib/executors/pwsh.mjs` | PowerShell 7 执行器（继承官方 `SandboxPwshExecutor`） |
| `cordis.patch.yml` | bundle patch：替换 `pwsh-sandbox` 并插入裸包名行（仅 Windows） |
| `locale/en.json`, `locale/zh.json`, `icon.svg` | 插件管理页显示元数据 |

`package.json` 的 `files` 只打包运行所需文件；`test/` 保留在仓库中，不进入 npm 包。

## 开发

```powershell
# 纯 Node 单元测试（不需要 DSH 运行）
node --test test/paths.test.mjs test/install.test.mjs test/setup.test.mjs test/client.test.mjs
```

- 72 tests：71 pass，0 fail，1 skipped（网络用例默认跳过）。
- 设置 `DSH_PWSH7_NETWORK_TESTS=1` 会启用真实 GitHub release / HEAD 校验：30/30 pass。
- 环境变量覆盖前缀为 `DSH_PWSH7_*`（`APP_ROOT`、`TAR`、`NETWORK_TESTS`）。

## 发布（维护者）

发布由 GitHub Actions 通过 npm **Trusted Publishing**（OIDC）完成——不需要 npm token、OTP 或仓库
secret。

1. 修改 `package.json` 的 `version`，提交并推送到 `main`。
2. 创建并推送同名 tag，然后发布对应的 GitHub Release（例如 `v0.2.0`）。
3. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) 在 `release: published` 时运行：
   校验 tag 与 `package.json` 版本一致、跑测试、以 provenance 发布
   （`npm publish --access public --provenance`）。

npm 侧的一次性配置（本仓库已完成）：

```powershell
npx npm@12 trust github dsh-plugin-pwsh7 `
  --file publish.yml `
  --repo drliuhuan/dsh-plugin-pwsh7 `
  --allow-publish --yes
```

手动 dry run：**Actions → Publish to npm → Run workflow**，保持 `dry_run` 勾选；工作流只会执行
`npm publish --dry-run --provenance`，不会真的发布。

仅 `drliuhuan/dsh-plugin-pwsh7` 仓库中的 `publish.yml` 被授权发布。查看或撤销：

```powershell
npx npm@12 trust list dsh-plugin-pwsh7
npx npm@12 trust revoke dsh-plugin-pwsh7 --id <trust-id>
```

## 版本说明

`0.1.0` 是第一个公开发布版本。`0.1.1` 是第一个通过 npm **Trusted Publishing**（OIDC）由
GitHub Actions 发布的版本，并修正了 npm 页面 README 的跨文件链接。`0.2.0` 增加 Web 安装弹窗，
并把安装收敛到单一协调器。更早的内部迭代（0.2.x/0.3.x）曾包含 MSYS2 bash 路由并使用过不同的包名；
由于 MSYS2/Cygwin 无法在 DSH Windows ACL 沙箱中启动，该部分已被移除。历史实测证据保留在构建工作区的
`sandbox-recon/FINDINGS.md`，不在本包内。

## 卸载

```
plugin_manager action=remove_bundle target=dsh-plugin-pwsh7
```

卸载后原生 Windows 预设恢复，`pwsh` 回到 DSH 原有解析。用户级目录
`%LOCALAPPDATA%\dsh\pwsh7\` 不会自动删除，可按需手动清理。

## License

MIT，见 [LICENSE](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/LICENSE)。
