# CC Session Monitor

<p>
  <a href="./README.md"><kbd>English</kbd></a>
  <a href="./README.zh-CN.md"><kbd>简体中文</kbd></a>
</p>

一个用于浏览和管理本机 Claude Code 会话的轻量级 Codex 插件。

它特别适合希望由 **Codex 负责规划、指挥和审核，由 Claude Code 负责具体执行** 的用户。

CC Session Monitor 会在本机记录 Claude Code 的会话状态、模型输出和工具调用，并通过 Ubuntu 顶栏图标与浏览器面板实时展示。你可以用它观察由 Codex 委派的任务，也可以查看自己在终端中手动启动的 Claude Code 会话。

> 当前版本支持 **Ubuntu（GNOME/X11）**。macOS 和 Windows 客户端已经预留统一接口，将在后续版本开放。

## 主要功能

- 在 Ubuntu 顶栏显示常驻图标；出现新会话时显示红点提醒。
- 展示每个 Claude Code 会话的简短概述、运行状态和持续时间。
- 实时追加模型回答、Prompt、工具调用及工具结果。
- 支持 Markdown，长 Prompt 和工具结果可以点击展开或收起。
- 同一个 session 再次执行时继续使用原有任务行，不重复创建提示。
- 已完成的任务会保留，直到用户主动关闭。
- 提供 English 和简体中文界面。
- 提供浏览器详细面板，适合查看较长的执行记录。
- 会话状态持久化到本机；关闭 Codex 或终端后，后台监控服务仍可继续运行。
- 委派的 Claude Code 任务运行在独立的用户服务中；重启监控服务不会中断任务。

## 工作方式

插件不会扫描或读取系统中的任意进程。它通过两种受控方式接收 Claude Code 会话事件：

1. **Codex 委派任务**：Codex 使用插件提供的工具启动或继续 Claude Code 会话。
2. **终端手动启动**：安装 Claude Code lifecycle hooks 后，插件接收本机 `claude` CLI 发出的会话、消息和工具事件。

在 Ubuntu 上，委派任务由独立的 systemd 用户服务运行。任务输出先写入本机日志，监控服务重启后会补读离线期间的事件。终端会话由终端本身管理，其 hooks 会在下一次事件发生时重新连接。旧版本插件启动的任务可能仍与监控服务共用进程组，因此安装器会在此类任务运行时拒绝重启监控服务。

所有监控数据默认保存在本机。服务只监听 loopback 地址，不会主动把日志上传到第三方。

## 当前支持情况

| 平台 | 状态 | 原生界面 |
|---|---|---|
| Ubuntu / GNOME | 已支持 | GTK 3 + AppIndicator 顶栏图标 |
| macOS | 计划中 | Menu Bar + Popover |
| Windows | 计划中 | System Tray + Flyout |

当前已在 Ubuntu GNOME/X11 环境测试。其他 Linux 桌面可能能够运行浏览器面板，但暂未作为正式支持范围。

## 安装要求

- Ubuntu，推荐 GNOME/X11 桌面环境
- 正在运行的 systemd 用户管理器，以支持委派任务在监控服务重启后继续运行
- Node.js 20 或更高版本
- Python 3
- 已安装并登录的 Claude Code CLI
- 已安装 Codex 桌面版或 Codex CLI

安装 Ubuntu 原生界面依赖：

```bash
sudo apt update
sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-appindicator3-0.1
```

插件本身没有 npm 运行时依赖。

## 安装插件

```bash
git clone https://github.com/ss00sxt/cc-session-monitor.git
cd cc-session-monitor
codex plugin marketplace add "$PWD"
codex plugin add cc-session-monitor@personal
```

安装完成后，请新建一个 Codex 任务，让 Codex 重新加载插件的 skill 和 MCP 工具。

### 启用终端会话监控

如果还希望监控自己在终端中直接运行的 `claude`，需要安装 Claude Code hooks 和 Ubuntu 后台服务：

```bash
PLUGIN_ROOT="$(find "$HOME/.codex/plugins/cache/personal/cc-session-monitor" \
  -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"

python3 "$PLUGIN_ROOT/scripts/install_claude_hooks.py"
python3 "$PLUGIN_ROOT/scripts/install_linux_service.py"
```

Hook 安装器会保留已有 Claude Code hooks，并在修改 `~/.claude/settings.json` 前创建带时间戳的备份。两个安装命令都可以安全地重复执行。

## 使用教程

### 方法一：让 Codex 启动 Claude Code 任务

在新的 Codex 任务中直接描述需求，例如：

```text
请把这个实现任务交给 Claude Code，持续记录执行进度，完成后由你审核结果。
```

Codex 会生成简短任务概述、启动可继续的 Claude Code session，并把状态交给 CC Session Monitor 展示。任务完成后，Codex 应独立检查修改和测试结果。

如果要继续同一项工作，可以明确要求 Codex 恢复原 session。插件会在同一行继续追加内容，保留已有上下文。

### 方法二：监控终端中的 Claude Code

完成 hooks 安装后，照常运行：

```bash
claude
```

新会话出现时，Ubuntu 顶栏图标会显示红点。手动启动的会话会根据第一条 Prompt 在本机生成简短概述，不会额外调用模型。

### 查看任务详情

- 点击顶栏图标查看最近的 Claude Code 会话。
- 点击任务行展开模型输出、Prompt、工具调用和结果。
- 点击工具行可以展开对应结果，再次点击收起。
- 将鼠标悬停在任务上可以查看 session ID。
- 点击“浏览器详细面板”可以在更大的页面中查看记录。
- 已完成任务可以通过关闭按钮从列表中移除。

## 数据与隐私

- 状态和事件日志存储在本机插件数据目录。
- 委派任务还会保存每次运行的本地输出日志；请像保护 Claude Code 对话记录一样保护该目录。
- 后台 API 只绑定本机 loopback 地址，并使用本地令牌鉴权。
- 常见 API Key 和 Authorization Header 会在写入事件日志前脱敏。
- 插件不展示模型的私有思维链，只显示高级状态、可见回答、工具名称、工具参数摘要和工具结果。
- Claude Code 所使用的 API 配置由 Claude Code 自己管理；插件不会把密钥复制到事件日志。

## 可选配置

| 环境变量 | 用途 |
|---|---|
| `CC_MONITOR_CLAUDE_PATH` | 指定 `claude` 可执行文件 |
| `CC_MONITOR_CLAUDE_SETTINGS` | 指定 Claude Code settings 文件 |
| `CC_MONITOR_ENV_FILE` | 指定启动 Claude Code 前加载的环境变量文件 |
| `CC_MONITOR_DATA_DIR` | 指定状态和事件存储目录 |
| `CC_MONITOR_PORT` | 指定本地监控服务端口 |
| `CC_MONITOR_TRAY=0` | 禁用 Ubuntu 顶栏客户端 |

## 卸载 hooks 和后台服务

```bash
python3 "$PLUGIN_ROOT/scripts/install_claude_hooks.py" --remove
python3 "$PLUGIN_ROOT/scripts/install_linux_service.py" --remove
```

Hook 卸载只会移除 CC Session Monitor 自己注册的处理器，不会删除其他 Claude Code hooks。

## 开发与测试

```bash
cd plugins/cc-session-monitor
npm run check
npm test
python3 clients/linux_tray.py --data-dir /tmp --plugin-root "$PWD" --check
```

核心守护进程与数据接口不依赖具体桌面平台。未来的 macOS 和 Windows 客户端只需要实现原生菜单栏或系统托盘外壳，详情参见[平台客户端约定](docs/platform-client.md)。

## Roadmap

- 完善 Ubuntu / Wayland 兼容性。
- 提供 macOS Menu Bar 客户端。
- 提供 Windows System Tray 客户端。
- 增加安装包、自动升级和更完整的诊断工具。

## License

[MIT](plugins/cc-session-monitor/LICENSE)
