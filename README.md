# CC Session Monitor

<p>
  <a href="./README.md"><kbd>English</kbd></a>
  <a href="./README.zh-CN.md"><kbd>简体中文</kbd></a>
</p>

A lightweight Codex plugin for viewing and managing local Claude Code sessions.

It is especially useful for people who want **Codex to plan, orchestrate, and review while Claude Code handles execution**.

CC Session Monitor records Claude Code session status, visible model output, and tool activity on your machine, then presents them through an Ubuntu top-bar icon and a browser dashboard. It can monitor work delegated by Codex as well as Claude Code sessions started manually in a terminal.

> The current release supports **Ubuntu (GNOME/X11)**. A shared platform interface is already in place for future macOS and Windows clients.

## Features

- A persistent Ubuntu top-bar icon with a red notification dot for new sessions.
- A compact summary, status, and elapsed time for each Claude Code session.
- Incremental display of model responses, prompts, tool calls, and tool results.
- Markdown rendering with expandable prompts and tool results.
- Continued runs reuse the same row when they share a session ID.
- Completed sessions remain available until you dismiss them.
- English and Simplified Chinese user interfaces.
- A larger browser dashboard for long execution histories.
- Local durable state, so monitoring can continue after the initiating Codex turn or terminal exits.
- Delegated Claude Code runs live in separate user services; restarting the monitor does not stop them.

## How it works

The plugin does not scan arbitrary processes on your computer. It receives Claude Code lifecycle events through two controlled paths:

1. **Codex delegation**: Codex starts or resumes a Claude Code session through the plugin tools.
2. **Terminal sessions**: after installing the Claude Code lifecycle hooks, the plugin receives session, message, and tool events from locally launched `claude` CLI sessions.

On Ubuntu, delegated runs use independent systemd user services. Each run writes a local event spool that the monitor replays after a restart, so output produced while the dashboard is offline appears when it returns. Terminal sessions are owned by your terminal; their hooks reconnect on the next event. A session started by an older plugin version may still share the monitor's process group, so the installer refuses to restart the monitor while such a run is active.

Monitoring data stays on your machine by default. The service listens only on a loopback address and does not upload logs to a third party.

## Platform support

| Platform | Status | Native UI |
|---|---|---|
| Ubuntu / GNOME | Supported | GTK 3 + AppIndicator top-bar icon |
| macOS | Planned | Menu Bar + Popover |
| Windows | Planned | System Tray + Flyout |

Ubuntu GNOME/X11 is the currently tested environment. The browser dashboard may work on other Linux desktops, but they are not yet part of the supported matrix.

## Requirements

- Ubuntu, preferably with a GNOME/X11 desktop session
- A running systemd user manager for restart-safe delegated runs
- Node.js 20 or newer
- Python 3
- Claude Code CLI, installed and authenticated
- Codex desktop or Codex CLI

Install the Ubuntu native UI dependencies:

```bash
sudo apt update
sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-appindicator3-0.1
```

The plugin has no npm runtime dependencies.

## Installation

```bash
git clone https://github.com/ss00sxt/cc-session-monitor.git
cd cc-session-monitor
codex plugin marketplace add "$PWD"
codex plugin add cc-session-monitor@personal
```

After installation, start a new Codex task so Codex can load the plugin skill and MCP tools.

### Enable monitoring for terminal sessions

To monitor `claude` sessions started directly in a terminal, install the Claude Code hooks and the Ubuntu background service:

```bash
PLUGIN_ROOT="$(find "$HOME/.codex/plugins/cache/personal/cc-session-monitor" \
  -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"

python3 "$PLUGIN_ROOT/scripts/install_claude_hooks.py"
python3 "$PLUGIN_ROOT/scripts/install_linux_service.py"
```

The hook installer preserves existing Claude Code hooks and creates a timestamped backup before editing `~/.claude/settings.json`. Both installers are safe to run repeatedly.

## Quick start

### Option 1: delegate work from Codex

In a new Codex task, ask Codex to delegate the implementation and review the result:

```text
Delegate this implementation to Claude Code, record its progress, and review the changes when it finishes.
```

Codex creates a short task summary, starts a resumable Claude Code session, and sends its state to CC Session Monitor. When the executor finishes, Codex should independently inspect the changes and run appropriate verification.

To continue the same work later, ask Codex to resume the existing session. The plugin appends the new run to the same row and preserves the executor context.

### Option 2: monitor Claude Code from a terminal

After installing the hooks, start Claude Code normally:

```bash
claude
```

The Ubuntu top-bar icon shows a red dot when a new session appears. A short summary is generated locally from the first prompt, without an additional model call.

### Inspect a session

- Click the top-bar icon to view recent Claude Code sessions.
- Click a session row to expand model output, prompts, tool calls, and results.
- Click a tool row to expand or collapse its result.
- Hover over a session to reveal its session ID.
- Open **Browser details** for a larger execution history view.
- Dismiss completed sessions with the close button.

## Data and privacy

- State and event logs are stored in the local plugin data directory.
- Delegated runs also keep a per-run local output spool until removed; protect this directory as you would a Claude Code transcript.
- The background API binds only to loopback and uses a local authentication token.
- Common API-key and Authorization-header patterns are redacted before events are stored.
- Private model chain-of-thought is never shown. The UI displays only high-level status, visible responses, tool names, tool summaries, and tool results.
- Claude Code remains responsible for its own API configuration; the plugin does not copy credentials into event logs.

## Optional configuration

| Environment variable | Purpose |
|---|---|
| `CC_MONITOR_CLAUDE_PATH` | Override the `claude` executable |
| `CC_MONITOR_CLAUDE_SETTINGS` | Override the Claude Code settings file |
| `CC_MONITOR_ENV_FILE` | Load an environment file before launching Claude Code |
| `CC_MONITOR_DATA_DIR` | Override the state and event storage directory |
| `CC_MONITOR_PORT` | Override the local monitor port |
| `CC_MONITOR_TRAY=0` | Disable the Ubuntu top-bar client |

## Remove hooks and the background service

```bash
python3 "$PLUGIN_ROOT/scripts/install_claude_hooks.py" --remove
python3 "$PLUGIN_ROOT/scripts/install_linux_service.py" --remove
```

Hook removal deletes only handlers registered by CC Session Monitor and leaves unrelated Claude Code hooks intact.

## Development

```bash
cd plugins/cc-session-monitor
npm run check
npm test
python3 clients/linux_tray.py --data-dir /tmp --plugin-root "$PWD" --check
```

The daemon and data contract are platform-neutral. Future macOS and Windows clients only need to implement their native menu-bar or system-tray shell. See the [platform client contract](docs/platform-client.md).

## Roadmap

- Improve Ubuntu / Wayland compatibility.
- Add a macOS Menu Bar client.
- Add a Windows System Tray client.
- Add packaged installers, automatic updates, and more diagnostics.

## License

[MIT](plugins/cc-session-monitor/LICENSE)
