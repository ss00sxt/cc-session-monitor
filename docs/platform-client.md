# Platform client contract

The execution daemon is platform-neutral. Native clients never start Claude
Code directly; they use the authenticated loopback RPC endpoint described by
`daemon.json` and `token` in the plugin data directory.

The shared Python client is:

```text
plugins/cc-session-monitor/clients/monitor_client.py
```

It exposes:

```text
sessions()
events(session_id, limit)
cancel(session_id)
dismiss(session_id)
dashboard_url()
```

Platform implementations:

| Platform | Native shell | Status |
|---|---|---|
| Linux | GTK 3 + AppIndicator | Implemented |
| macOS | NSStatusItem + NSPopover | Planned |
| Windows | NotifyIcon + native flyout | Planned |

All shells must preserve these behaviors:

1. One visible row per Claude Code `session_id`.
2. Multiple runs append to that row until the user dismisses it.
3. Active state refreshes every second; durable progress snapshots are emitted
   by the daemon every 30 seconds.
4. Session IDs appear only as hover/tool-tip detail by default.
5. Private model reasoning is never rendered; only high-level thinking state,
   assistant output, tool names, tool summaries, and tool results are shown.
6. Finished rows remain visible until explicitly dismissed.

The daemon's MCP tools and local HTTP RPC use the same method names, so future
clients can be implemented in Swift, C#, Rust, or another native toolkit without
changing session storage or runner behavior.
