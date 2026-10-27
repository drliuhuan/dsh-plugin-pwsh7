# dsh-plugin-pwsh7

[![npm version](https://img.shields.io/npm/v/dsh-plugin-pwsh7.svg)](https://www.npmjs.com/package/dsh-plugin-pwsh7)
[![license](https://img.shields.io/npm/l/dsh-plugin-pwsh7.svg)](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/LICENSE)

Windows 上的 DeepSeek Harness（DSH）插件：把模型侧的 **`pwsh` 工具路由到 PowerShell 7**
（`pwsh.exe`，主版本 >= 7），不再落到 Windows PowerShell 5.1。

- 执行器继承 DSH 自带 `dsh-pwsh-sandbox` 的全部行为：沙箱模式、`sandbox_permissions` 升权、
  拒绝/runner 失败标记、后台任务、输出上限与 exit marker；本插件只替换可执行文件解析。
- 找不到 PowerShell 7 时，提供模型可调用的 **`shell_router`** 工具做检测、诊断、自检、路由切换与卸载插件自装副本。
- **安装永远不是自动的，也不会由模型发起。** 缺少 PowerShell 7 时 Web GUI 会弹出安装弹窗；
  只有用户在弹窗或 **设置 → PowerShell 7** 中点击安装，或用户自行安装 PowerShell 7 时才会安装。
- Web GUI 的设置菜单里新增 **PowerShell 7 页面**：显示可执行文件、版本、安装目录、安装范围与方式，
  提供**插件自检**、**切回系统默认路由**、**卸载插件自装的用户级安装**，以及**把用户级安装迁移到系统级**。
- Web GUI 里另有**安装弹窗**：开机检测到缺失时、以及之后**每次 `pwsh` 运行因缺少 PowerShell 7
  失败时**都会弹出，提供下载按钮与实时进度（已下载字节、百分比、阶段）。关闭弹窗不会中断安装，
  下一次失败运行会再次弹出。

[English](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/README.md) | 中文

---

## 它做什么

Windows 预设把 `pwsh-sandbox` 行挂到 `ctx.shell`，但可执行文件解析在部分环境里会落到
Windows PowerShell 5.1。本插件保留官方执行器，只覆盖 `pwshPath` 解析：

1. **接管 `pwsh-sandbox` 槽位**：DSH 的 patch 语义里 `name` 是对目标行的断言而不是就地替换，
   所以先用 id patch 停用官方行，再插入 `RouterPwshExecutor extends SandboxPwshExecutor` 的执行器行
   （`id: pwsh7-executor`）。显式 `config.pwshPath` 优先；否则使用插件检测到的 PowerShell 7。
2. **插入裸包名 `dsh-plugin-pwsh7` 行**：注册 `shell_router` 工具（`status` / `diagnose` / `selfcheck` /
   `route` / `uninstall`）、系统提示小节、安装弹窗/设置页路由与浏览器 bundle。这行的裸包名也是 DSH
   客户端模块扫描器发现 `client.js` 的依据；executor 行的 `./pwsh-executor` 子路径不会被当作客户端
   bundle 来源。

## 环境要求

- Windows 10/11。
- 支持 bundle 的 DSH profile（`@deepseek-ai/dsh-base` / Web profile）。已在 DSH desktop
  0.2.1-rc.3 上验证。
- Node.js >= 22 仅运行仓库测试时需要。

## 安装

通过 DSH 插件管理器从 npm 安装：

```
plugin_manager action=install_bundle target=dsh-plugin-pwsh7@0.3.3
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
| `install`、`relocate` | **工具不会执行安装。** 只返回引导：安装只能由用户在安装弹窗、设置 → PowerShell 7 或手动安装中发起。 |
| `selfcheck` | 运行与设置页相同的只读自检，返回 `ok` / `warn` / `fail`。 |
| `route` | 持久化 `route: "plugin"` 或 `route: "system"`，并返回新路由。 |
| `uninstall` | 删除插件自装的用户级便携安装（文件、临时目录、托管 PATH 条目），保留路由偏好。 |

### 设置页（Web）

浏览器半边还会在 Web GUI 的设置菜单注册一个 **PowerShell 7** 页面（`settings.section`）：

- **状态**：当前 PowerShell 7 版本与可执行文件、安装目录、配置文件路径、安装范围与方式、插件版本，
  以及该安装是否由插件管理、能否卸载。
- **路由**：一键在“插件管理的 PowerShell 7”和“系统默认”之间切换。系统默认只解析系统级安装
  （`Program Files`、用户 `Programs` 目录、Store 别名、插件目录以外的 `PATH` 条目），
  找不到系统 PowerShell 7 时按 DSH 原生行为回退到 Windows PowerShell 5.1。选择写入
  `config.json` 的 `route`，下一条 `pwsh` 命令生效。
- **自检**：检查可执行文件解析、PowerShell 主版本、路由、配置有效性、安装/范围一致性、持久 PATH
  条目、`@deepseek-ai/*` 加载、沙箱策略、是否有安装任务在运行，并以 `ok` / `warn` / `fail` 显示详情。
- **安装/修复**：启动与安装弹窗相同的共享安装任务（用户级），显示实时进度。
- **迁移到系统**：在 `Program Files` 安装 PowerShell 7 并写入系统 PATH（需要管理员），随后删除用户级
  副本并把路由指向系统可执行文件；未提权时给出明确提示，不会卡在 UAC。
- **卸载**：仅对插件自装的用户级便携安装可用；删除已安装版本与临时目录、移除托管的 `PATH` 条目，
  不会触碰系统或其他包管理器管理的安装。

### 安装弹窗（Web）

浏览器半边渲染到 DSH 根级 `shell.overlay` 槽位，因此在普通 Web GUI 和桌面壳里都能用，不需要另开窗口：

- **何时弹出**：首次加载时检测不到 `pwsh.exe`；以及之后**每次 `pwsh` 工具因缺少 PowerShell 7
  失败**时（`missingSeq`）。点“稍后”只关闭到下一次失败运行；只要仍然缺失，刷新页面也会再次弹出。
- **做什么**：点“下载并安装”会启动共享的、由用户发起的安装任务，可选择用户或系统范围。弹窗依次显示
  `下载 → 解压 → 验证`，以及已下载字节、总大小和百分比；“取消下载”可以中止。
- **为什么只有一个任务**：弹窗和设置页共用一个协调器，所以无论用户从哪个界面开始安装，进度都一致，
  也不会在 `%LOCALAPPDATA%\dsh\pwsh7\tmp` 的同一个压缩包上互相踩踏。模型的 `shell_router` 工具不会启动安装。
- **传输**：`GET /pwsh7/state`（快照）、`GET /pwsh7/events`（SSE，进度约 7 帧/秒）、
  `POST /pwsh7/install`、`POST /pwsh7/cancel`。SSE 负责平滑进度，同时始终保留每 3 秒一次的
  `/pwsh7/state` 轮询，作为事件流被缓冲时的兜底。这些路由仅限同源，POST 只接受 `application/json`。
- **失败**：弹窗保留安装器的原始错误，提供“重试”和官方 PowerShell releases 链接；安装失败不影响
  已有的 `pwsh` 路由，直到某次安装成功。
- **范围**：弹窗属于 Web GUI。纯 CLI/无头组合仍可在 Web 组合存在时使用 `shell_router` 的
  status/diagnose/selfcheck 与设置页路由，但没有浏览器时安装需要手动完成。

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

### 路由模式

`config.json` 的 `route` 决定 `pwsh` 工具运行哪个可执行文件：

| 路由 | 解析方式 |
|---|---|
| `plugin`（默认） | `DSH_PWSH_PATH` → `config.pwshPath` → 常见安装位置（含插件托管的便携安装）→ `PATH`；缺失时抛出安装提示。 |
| `system` | 只解析系统级位置：`Program Files`、`Program Files (x86)`、`%LOCALAPPDATA%\Programs`、Store 别名、`%LOCALAPPDATA%\dsh\pwsh7` 以外的 `PATH` 条目，最后按原生行为回退到 Windows PowerShell 5.1；忽略 `DSH_PWSH_PATH` 与 `config.pwshPath`。 |

设置页可在运行时切换路由（`POST /pwsh7/route`），无需重启。

### 配置文件

`%LOCALAPPDATA%\dsh\pwsh7\config.json`：

```json
{
  "version": 1,
  "route": "plugin",
  "pwshPath": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "installed": {
    "pwsh": {
      "path": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "version": "7.6.7",
      "method": "existing",
      "scope": "user",
      "at": "2026-10-17T00:00:00.000Z"
    }
  },
  "updatedAt": "2026-10-17T00:00:00.000Z"
}
```

## 安装（用户发起）

安装只能由用户发起：Web 安装弹窗、设置 → PowerShell 7，或在 DSH 之外自行安装 PowerShell 7。
模型工具不会启动安装。

可在 Web 弹窗选择 `scope: "user"`（默认）或 `scope: "system"`。

| 范围 | 安装位置 | 持久 PATH |
|---|---|---|
| `user` | `%LOCALAPPDATA%\dsh\pwsh7\powershell7\<version>` | 当前用户（`HKCU\Environment`） |
| `system` | `%ProgramFiles%\PowerShell\7` | 系统（`HKLM` 环境变量） |

系统安装需要先以管理员身份启动 DSH；权限不足会在下载前报错。用户安装无需提权。两种方式都会保留已有 PATH 及注册表值类型、避免重复添加、刷新宿主进程 PATH，并广播 Windows 环境变量变更。已打开的终端可能需要重新启动。PATH 写入失败会明确报错，不会显示安装成功。

设置页可以把已有用户级安装一步迁移到系统级（`POST /pwsh7/relocate`）：安装/复用 Program Files
副本、写入系统 PATH、删除用户级副本，并把配置指向系统可执行文件。

没有 Web GUI 时，请自行安装 PowerShell 7（官方 MSI/Store/release zip），并把 `DSH_PWSH_PATH`
或 `config.json` 指向其 `pwsh.exe`。

便携包来源：

| 组件 | 来源 | 安装位置 |
|---|---|---|
| PowerShell 7 | GitHub `PowerShell/PowerShell` 最新 release 的 `PowerShell-*-win-x64.zip` | `%LOCALAPPDATA%\dsh\pwsh7\powershell7\<version>\` |

- HTTPS 流式下载到 `%LOCALAPPDATA%\dsh\pwsh7\tmp`，支持进度回调与取消。
- 解包使用 Windows 自带 `tar.exe`（bsdtar）；不会执行任何下载来的安装器。
- 解包后先真实运行一次新 `pwsh.exe` 验证主版本 >= 7，再写入 `config.json`。
- `auto` 失败回退 `winget install Microsoft.PowerShell`；需要 UAC 提升时返回明确的手动命令，
  不会卡在提权提示上。
- winget 使用对应的 `--scope user` 或 `--scope machine`，回退不会改变安装范围。
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
| `index.js` | 裸包名行：安装 `shell_router`、系统提示小节、安装/设置路由与热重载刷新 |
| `client.js` | 浏览器半边：`shell.overlay` 安装弹窗 + `settings.section` 的 PowerShell 7 设置页、SSE + 轮询、安装/路由/卸载/迁移/自检操作、中英文案 |
| `lib/shipped.mjs` | 从运行中的 DSH 安装（Electron `app.asar`）加载 `@deepseek-ai/*` 包 |
| `lib/paths.mjs` | PowerShell 7 路径探测、版本探测、`config.json` 读写 |
| `lib/route.mjs` | 路由模式持久化、系统默认可执行文件解析、安装信息描述 |
| `lib/install.mjs` | 用户/系统级便携安装（官方 zip）+ 同范围 winget 回退；进度与阶段回调 |
| `lib/install-scope.mjs` | 注册表 PATH 写入/移除（保留值类型）、提权探测、Program Files 范围 |
| `lib/state.mjs` | 进程内解析缓存（executor 与工具共用）；缺失运行信号 |
| `lib/maintenance.mjs` | 删除插件自装的用户级安装（文件、临时目录、托管的 PATH 条目） |
| `lib/selfcheck.mjs` | 只读自检：可执行文件、版本、路由、配置、安装、PATH、内置包、沙箱、任务、路由表 |
| `lib/router-features.mjs` | 从裸包名行安装 `shell_router`、系统提示小节、安装协调器与 Web 路由 |
| `lib/setup-service.mjs` | 单一任务协调器：安装/迁移/卸载/路由、进度快照、取消、`missingSeq` |
| `lib/setup-routes.mjs` | 八个 `/pwsh7/*` 路由（`state`、`events`、`install`、`cancel`、`route`、`uninstall`、`relocate`、`selfcheck`） |
| `lib/status.mjs` | `status` / `diagnose` 实现 |
| `lib/executors/pwsh.mjs` | PowerShell 7 执行器（继承官方 `SandboxPwshExecutor`），按路由分支解析 |
| `cordis.patch.yml` | bundle patch：停用官方 `pwsh-sandbox`，插入执行器行与裸包名行（仅 Windows） |
| `locale/en.json`, `locale/zh.json`, `icon.svg` | 插件管理页显示元数据 |

`package.json` 的 `files` 只打包运行所需文件；`test/` 保留在仓库中，不进入 npm 包。

## 开发

```powershell
# 纯 Node 单元测试（不需要 DSH 运行）
node --test test/*.test.mjs
```

- 141 个测试：137 通过，0 失败，默认跳过 4 个（2 个依赖真实安装路径的环境用例、1 个网络用例、
  1 个仅在 GitHub Actions 运行的注册表用例）。
- 设置 `DSH_PWSH7_NETWORK_TESTS=1` 会启用真实 GitHub release / HEAD 校验。
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
并把安装收敛到单一协调器；`0.2.2` 增加用户/系统安装范围与持久 PATH；`0.3.0` 增加设置页
（自检、路由切换、用户级卸载、迁移到系统范围）；`0.3.1` 增加可选的提示词注入档位（含实测 A/B）、
最新版检测与用户级/系统级升级动作、一次性初始设置确认，以及模型选择器旁的 `pwsh7` 快捷开关；
`0.3.2` 移除了稳定状态下的文件系统探测与空闲轮询：配置读取与检测缓存、提示词组装记忆化，以及只在
需要时才轮询的客户端界面；`0.3.3` 让系统级安装/升级主动弹出 UAC，把每个机器级版本并列安装到
`…\PowerShell\7\<version>`，并把该目录前插到机器 PATH，让其他软件也能解析到升级后的 `pwsh`。
更早的内部迭代（0.2.x/0.3.x）曾包含 MSYS2 bash
路由并使用过不同的包名；由于 MSYS2/Cygwin 无法在 DSH Windows ACL 沙箱中启动，该部分已被移除。
历史实测证据保留在构建工作区的 `sandbox-recon/FINDINGS.md`，不在本包内。

## 卸载

```
plugin_manager action=remove_bundle target=dsh-plugin-pwsh7
```

卸载后原生 Windows 预设恢复，`pwsh` 回到 DSH 原有解析。用户级目录
`%LOCALAPPDATA%\dsh\pwsh7\` 不会被插件管理器自动删除；如果还想移除插件自装的 PowerShell 7
及其托管的 PATH 条目，请先使用 **设置 → PowerShell 7 → 卸载**（或
`shell_router action="uninstall"`）。

## License

MIT，见 [LICENSE](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/LICENSE)。
