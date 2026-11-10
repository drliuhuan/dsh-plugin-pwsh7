# dsh-plugin-pwsh7

[![npm version](https://img.shields.io/npm/v/dsh-plugin-pwsh7.svg)](https://www.npmjs.com/package/dsh-plugin-pwsh7)
[![license](https://img.shields.io/npm/l/dsh-plugin-pwsh7.svg)](https://github.com/drliuhuan/dsh-plugin-pwsh7/blob/main/LICENSE)

Windows 上的 DeepSeek Harness（DSH）插件：把模型侧的 **`pwsh` 工具路由到 PowerShell 7**
（`pwsh.exe`，主版本 >= 7），不再落到 Windows PowerShell 5.1。

- 执行器继承 DSH 自带 `dsh-pwsh-sandbox` 的全部行为：沙箱模式、`sandbox_permissions` 升权、
  拒绝/runner 失败标记、后台任务、输出上限与 exit marker；本插件只替换可执行文件解析。
- **删除安全始终开启。** 系统提示词中的基础规则与执行器注入的前置定义，把所有 `Remove-Item`
  （及其别名）改为移入**回收站**——文件与整个目录树都一样——不存在永久删除的回退路径。
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
plugin_manager action=install_bundle target=dsh-plugin-pwsh7@0.5.0
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
| `route` | 持久化 `route: "plugin"`、`route: "system"` 或 `route: "pwsh5"`，并返回新路由。`pwsh5` 强制 Windows PowerShell 5.1，并关闭全部 PowerShell 7 提示词层。 |
| `uninstall` | 删除插件自装的用户级便携安装（文件、临时目录、托管 PATH 条目），保留路由偏好。 |

### 基础规则（始终开启）：删除一律进回收站

与下文可选的方言提示层不同，**基础规则是强制的、不能关闭**：它不属于可选的提示词层，
在包括强制 `pwsh5` 在内的所有路由下都生效，每次请求约增加 **506 tokens**（2,021 字符）。

同一条契约由两层共同保证——被删除的文件与目录必须可恢复：

1. **系统提示词规则。** 提示小节声明：删除文件或目录必须移入回收站，绝不永久删除；
   `Remove-Item` 及其别名（`rm`、`del`、`erase`、`rd`、`rmdir`、`ri`）都会被重定向；
   `cmd /c del`、`rd /s /q`、嵌套 `pwsh`/`powershell` 进程、`[System.IO.File]::Delete`、
   `[System.IO.Directory]::Delete` 属于被禁止的绕过方式。
2. **执行器守卫。** 当 `pwsh` 命令涉及删除时，执行器会在命令前注入一小段前置定义，遮蔽
   `Remove-Item`（原性别名解析到同一个函数），并把模块限定写法
   `Microsoft.PowerShell.Management\Remove-Item` 改写为被重定向的命令，避免它绕过遮蔽。
   所有文件系统目标都交给**宿主侧回收桥**（`lib/recycle-service.mjs`）：受限进程只把路径
   POST 给 DSH 宿主进程里的回环接口，由宿主执行
   `SHFileOperation(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI)`，再**核对
   该卷回收站里的 `$I` 记录**。这层间接是必需的：在写受限令牌下，进程内任何回收 API 都写不进
   `<卷>:\$RECYCLE.BIN`；本机实测 `SHFileOperation` 会在此情况下永久删除文件却仍返回 0——所以
   返回码本身绝不作为成功依据。**没有永久删除回退**：桥不可用或无法核实时命令直接报错，且不会
   删除任何东西。非文件系统 provider（注册表、环境变量、证书等）仍通过模块限定名走原 cmdlet。

守卫需要真实路径而不是筛选器，因此 `Remove-Item` 会拒绝 `-Filter`、`-Include`、`-Exclude`、
`-Stream` 和 `-Credential`；请用 `Get-ChildItem … | Remove-Item` 选择条目。`-WhatIf`/`-Confirm`
仍然可用（前置定义支持 `ShouldProcess`）。与原生 cmdlet 相比还有几处刻意的细微差异：非空目录
即使没有 `-Recurse` 也会整树回收；隐藏/只读条目不受 `-Force` 影响；`-Path` 与 `-LiteralPath`
可以同时使用；通配符没有匹配时会写错误而不是静默成功。网络共享、没有回收站的卷、超过回收站
配额的条目无法回收，因此命令会明确报错且条目保持原样。回收站中的条目可恢复但仍占用磁盘空间，
所以插件不会声称空间已释放，也会提示模型不要在用户未要求时清空回收站。

**恢复。** 桥会为每一次核实成功的回收记一条日志（原路径、`$I`/`$R` 记录名、类型与大小；仅内存、
有上限、DSH 停止即清空）。`shell_router` 的 `restore` 动作带原路径即可把其中一条放回去（同一个回环端点也接受 `POST /restore`，token 相同）——
同卷改名移回 `$R`，时间戳、属性、整个目录树原样保留；随后清掉 `$I` 并复核结果。边界刻意为窄：
**只有本会话通过 `pwsh` 工具回收的条目**能恢复。DSH 重启之后、由脚本或原生 API 删除的条目、
以及在 DSH 之外删除的条目，日志里都没有记录，工具会给出明确理由拒绝——这些请用户在资源管理器
回收站里自行还原。模型被要求在每次删除后都向用户说明这一点。

**毁灭性删除一律拒绝。** 即使目标在工作区内，桥也不会删除：任何磁盘根目录；Windows、
Program Files、Program Files (x86)、ProgramData 以及 DSH 自身状态目录（`~/.dsh`）内的任何路径，
或它们的上级目录；用户主目录本身及其任何上级目录；以及会话工作区根目录本身。主目录的**下级**
仍然允许（工作区可能就放在主目录里），工作区内的普通文件和目录不受影响。拒绝会以明确错误返回给
命令，且不会删除任何东西，模型必须把**确切路径**告诉用户、让用户自己在资源管理器里删；删除前
还会探测当前用户的回收站目录是否可写（不可写或不存在时拒绝）。

这些边界**与沙箱模式无关**：`danger-full-access` 只放宽桥接受的**范围**——允许会话工作区之外的
路径（这个模式本来就是用来处理别处文件的，沙箱也不再限制任何东西）——受保护位置、超长路径、
没有回收站的卷、被禁止的命令形式一律照旧拒绝。

**脚本在执行前会被检查。** 命令要**运行**一个脚本时（`cmd /c`、`pwsh -File`、`&`/点源、或脚本本身在命令位置；只是把脚本当参数或删除它不算），执行器会先读脚本体，
里面含删除命令就拒绝执行——脚本体不受文本守卫覆盖，而这个检查**不区分沙箱模式**。读不了、或
大于 2 MB 的脚本同样拒绝，不盲跑。同一条命令里"先生成再执行"的脚本仍是已记录的缺口。

守卫只作用于模型侧 `pwsh` 工具运行的命令；插件自己的提权维护脚本（`powershell.exe -File`，
用于清理安装残留）不经过它。`shell_router status` 会报告该规则及其提示词开销。

守卫是命令文本层：故意混淆的调用（通过变量解析原 cmdlet、嵌套 shell 或 .NET API）无法被拦截，
基础规则会明确禁止这些形式；而在模型正常的 `Remove-Item` 用法中，重定向是机械强制的，不是建议。

### 设置页（Web）

浏览器半边还会在 Web GUI 的设置菜单注册一个 **PowerShell 7** 页面（`settings.section`）：

- **状态**：当前 PowerShell 7 版本与可执行文件、安装目录、配置文件路径、安装范围与方式、插件版本，
  以及该安装是否由插件管理、能否卸载。
- **路由**：可在“插件管理的 PowerShell 7”“系统默认”和“PowerShell 5.1”之间切换。系统默认只解析
  系统级安装（`Program Files`、用户 `Programs` 目录、Store 别名、插件目录以外的 `PATH` 条目），
  找不到系统 PowerShell 7 时按 DSH 原生行为回退到 Windows PowerShell 5.1；`PowerShell 5.1`
  路由直接强制该可执行文件，并关闭全部 PowerShell 7 提示词层（基础删除安全规则仍然生效）。
  选择写入 `config.json` 的 `route`，下一条 `pwsh` 命令生效。
- **自检**：检查可执行文件解析、PowerShell 主版本、路由、配置有效性、安装/范围一致性、持久 PATH
  条目、`@deepseek-ai/*` 加载、沙箱策略、是否有安装任务在运行，并以 `ok` / `warn` / `fail` 显示详情。
- **安装/修复**：启动与安装弹窗相同的共享安装任务（用户级），显示实时进度。
- **迁移到系统 / 系统级升级**：运行官方 PowerShell 7 MSI，原地升级
  `%ProgramFiles%\PowerShell\7\pwsh.exe`——这正是 Windows Terminal 和其他启动器解析的主安装。
  未提权时只弹一次 UAC，任务显示 `waiting for administrator approval (UAC)`。MSI 安装并验证新版本后，
  同一个提权会话会删除旧版插件留下的 `…\PowerShell\7\<version>` 并排副本及其系统 PATH 条目，
  然后删除用户级副本、更新路由。
- **卸载**：仅对插件自装的用户级便携安装可用；删除已安装版本与临时目录、移除托管的 `PATH` 条目，
  不会触碰系统或其他包管理器管理的安装。

### 安装弹窗（Web）

浏览器半边渲染到 DSH 根级 `shell.overlay` 槽位，因此在普通 Web GUI 和桌面壳里都能用，不需要另开窗口：

- **何时弹出**：首次加载时会弹出一次（即使已经检测到 PowerShell 7，也用于确认本次部署的设置）；
  之后每次 `pwsh` 工具因缺少 PowerShell 7 失败时（`missingSeq`）再次弹出。已安装时标题与说明会显示
  “PowerShell 7 设置 / 已检测到 PowerShell 7”，不会再误报“没有找到 pwsh.exe”。
- **做什么**：点“下载并安装”会启动共享的、由用户发起的安装任务。默认走**系统级官方 MSI**；
  需要便携副本时可选择“当前用户”。弹窗依次显示 `下载 → 解压 → 验证`，以及已下载字节、总大小和
  百分比；“取消下载”可以中止。下载、失败和升级位置同时提供**手动 MSI** 与便携 **ZIP** 链接，
  默认 MSI；最新版本检查返回前回退到官方 releases 页面。
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
| `pwsh5` | 始终使用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`（Windows PowerShell 5.1）。关闭全部 PowerShell 7 提示词/方言层，但保留用户已存的提示词级别，离开该路由后恢复。 |

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

首次运行弹窗默认 `scope: "system"`（官方 MSI）；需要便携副本时选择 `scope: "user"`。
首次运行弹窗和设置页都提供手动 **MSI** 下载/升级链接（默认）与便携 **ZIP** 链接；最新版本检查
返回前回退到官方 PowerShell releases 页面。

| 范围 | 方式 | 安装位置 | 持久 PATH |
|---|---|---|---|
| `user` | 便携 ZIP | `%LOCALAPPDATA%\dsh\pwsh7\powershell7\<version>` | 当前用户（`HKCU\Environment`） |
| `system` | **官方 MSI，原地升级** | `%ProgramFiles%\PowerShell\7\pwsh.exe`（主安装，不再创建 `<version>` 子目录） | 系统；由官方安装器维护，并确保主目录排在前面 |

系统级安装/升级运行官方 `PowerShell-<version>-win-x64.msi`，原地升级
`…\PowerShell\7\pwsh.exe`，因此 Windows Terminal、Win+R 等启动器都能看到新版本，而不只是 DSH 的
`pwsh` 工具。未提权的 DSH 只弹一次 UAC（`Start-Process -Verb RunAs`），任务显示
`waiting for administrator approval (UAC)`。提权脚本先读取主 `pwsh.exe` 的文件版本；只有确认已是目标版本，
才删除旧版插件留下的 `…\PowerShell\7\<version>` 并排副本及其系统 PATH 条目。如果 Windows 把文件替换
安排到重启后，脚本会保留并排副本和 PATH，任务会明确提示需要重启/关闭终端。

用户级安装无需提权，并保留既有 PATH 行为（保留值类型、避免重复、刷新宿主进程 PATH、广播 Windows
环境变量变更）。系统级升级后，已打开的终端可能需要重新启动。

设置页可以把已有用户级安装一步迁移到系统级（`POST /pwsh7/relocate`）：运行系统 MSI（若主安装已是
最新则直接复用）、删除用户级副本，并把配置指向主系统可执行文件。

没有 Web GUI 时，请自行安装 PowerShell 7（官方 MSI/Store/release zip），并把 `DSH_PWSH_PATH`
或 `config.json` 指向其 `pwsh.exe`。

下载来源：

| 范围 | 资源 | 安装位置 |
|---|---|---|
| `user` | `PowerShell-<version>-win-x64.zip` | `%LOCALAPPDATA%\dsh\pwsh7\powershell7\<version>\` |
| `system` | `PowerShell-<version>-win-x64.msi` | `%ProgramFiles%\PowerShell\7\pwsh.exe`（原地） |

- HTTPS 流式下载到 `%LOCALAPPDATA%\dsh\pwsh7\tmp`，支持进度回调与取消。ZIP 校验 ZIP magic，
  MSI 校验 OLE/Windows Installer magic。
- 用户级用 Windows 自带 `tar.exe`（bsdtar）解包，并先真实运行一次新 `pwsh.exe` 验证主版本 >= 7，
  再写入 `config.json`。
- 系统级执行官方 MSI：`msiexec /i … /qn /norestart ALLUSERS=1`，不会把 ZIP 解压到 Program Files。
  安装后读取主 `pwsh.exe` 的文件版本进行校验，再清理旧并排副本。
- `auto` 只在用户级回退 `winget install Microsoft.PowerShell`；系统级失败时返回明确的手动
  MSI/winget 命令，不会悄悄改装用户级副本。
- winget 使用对应的 `--scope user` 或 `--scope machine`，回退不会改变安装范围。
- 已在本机实测：下载 106,364,316 字节（约 31s），解压后 244.8 MB，验证为 `7.6.7`。

### 升级已有安装（不假设安装方式）

系统侧升级不再假设 PowerShell 7 是 MSI 安装的。它会从**持久化的机器 PATH + 用户 PATH** 中找出
新终端实际解析到的 `pwsh.exe`，判断它属于哪种安装，再交给对应的机制升级：

| 原安装方式 | 识别方式 | 升级机制 |
|---|---|---|
| 机器级官方 MSI | HKLM 卸载注册表项 `PowerShell 7-x64` | `msiexec /i … ALLUSERS=1` 原地升级，弹一次 UAC |
| 当前用户 MSI | HKCU 卸载注册表项 | `msiexec /i … ALLUSERS=0` 原地升级（无需提权） |
| 手动/便携 ZIP 且在 PATH 中 | 目录里有 `pwsh.exe`，但没有 MSI/Store/包管理器标记 | 原地替换该目录：旧目录改名 → 复制新文件 → 校验文件版本 → 删除旧目录；失败自动回滚。PATH 条目不变 |
| Chocolatey | `…\chocolatey\bin\pwsh.exe` shim | `choco upgrade powershell-core -y`（需要时提权） |
| Scoop | `…\scoop\shims\pwsh.exe` shim | `scoop update pwsh`（全局安装用 `-g`，需要时提权） |
| Microsoft Store | `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` | `winget upgrade --id Microsoft.PowerShell --source msstore`；没有 winget 时明确提示去商店更新 |
| 插件托管的用户级副本 | `%LOCALAPPDATA%\dsh\pwsh7\powershell7\<version>` | 下载最新 ZIP 到新版本目录，并把配置指向新目录 |
| 旧版插件留下的系统并排副本 | `%ProgramFiles%\PowerShell\7\<version>` | 升级主 MSI，然后删除带版本号的副本及其 PATH 条目 |
| `DSH_PWSH_PATH` / 行配置 `pwshPath` 覆盖 | 显式覆盖优先 | **拒绝覆盖**并说明原因；请用该副本自己的安装器升级，或移除覆盖 |
| 未知/未安装 | 没有检测到 | 安装官方 MSI 到 Program Files |

同一套检测也支持 `win-arm64`、`win-x86` 资源，按操作系统架构选择。包管理器缺失或升级失败时，
不会悄悄改装一个额外的用户级副本，而是返回具体的恢复命令。

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
| `lib/route.mjs` | 路由模式（plugin/system/pwsh5）持久化、系统默认可执行文件与 pwsh5 解析、安装信息与旧并排副本描述 |
| `lib/install-plan.mjs` | 从持久 PATH + 注册表识别 MSI/便携/Store/Chocolatey/Scoop/插件安装，并选择升级策略 |
| `lib/install.mjs` | 用户级便携安装（官方 zip）、系统级 MSI/便携原地替换/包管理器升级、旧并排副本清理、winget 回退；进度与阶段回调 |
| `lib/install-scope.mjs` | 注册表 PATH 写入/移除（保留值类型）、提权探测、Program Files 范围、系统目录旧版本副本枚举 |
| `lib/elevate.mjs` | 一次性 UAC 助手：系统 MSI 升级、验证主安装、清理旧并排副本与 PATH |
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
