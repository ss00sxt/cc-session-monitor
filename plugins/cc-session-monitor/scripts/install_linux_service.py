#!/usr/bin/env python3
"""Install the persistent Linux user service for CC Session Monitor."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


UNIT_NAME = "cc-session-monitor.service"


def systemd_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render_unit(plugin_root: Path, node_path: str) -> str:
    daemon = plugin_root / "src/daemon.js"
    return f"""[Unit]
Description=CC Session Monitor daemon and Linux tray
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart={systemd_quote(node_path)} {systemd_quote(str(daemon))}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
"""


def write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def systemctl(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["systemctl", "--user", *args], check=check, text=True, capture_output=True)


def legacy_managed_sessions() -> list[str]:
    """Legacy children still share the monitor cgroup; restarting would kill them."""
    data_dir = Path(os.environ.get("CC_MONITOR_DATA_DIR", Path.home() / ".local/state/cc-session-monitor"))
    try:
        state = json.loads((data_dir / "state.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    active = {"starting", "running", "generating", "tool_running", "waiting_permission", "cancelling"}
    result = []
    for session in state.get("sessions", {}).values():
        if session.get("source") != "managed" or session.get("status") not in active:
            continue
        run_id = session.get("currentRunId")
        manifest_path = data_dir / "workers" / str(run_id) / "manifest.json"
        if not manifest_path.exists():
            result.append(session.get("sessionId", "unknown"))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--remove", action="store_true")
    parser.add_argument("--print-unit", action="store_true")
    args = parser.parse_args()
    plugin_root = Path(__file__).resolve().parents[1]
    node_path = shutil.which("node") or "/usr/bin/node"
    unit_path = Path.home() / ".config/systemd/user" / UNIT_NAME
    unit = render_unit(plugin_root, node_path)

    if args.print_unit:
        print(unit, end="")
        return 0
    if args.remove:
        legacy = legacy_managed_sessions()
        if legacy:
            parser.error(f"Cannot stop the legacy monitor while managed Claude Code is active: {', '.join(legacy)}")
        systemctl("disable", "--now", UNIT_NAME, check=False)
        unit_path.unlink(missing_ok=True)
        systemctl("daemon-reload")
        print(f"Removed {UNIT_NAME}")
        return 0

    legacy = legacy_managed_sessions()
    if legacy:
        parser.error(f"Cannot restart the legacy monitor while managed Claude Code is active: {', '.join(legacy)}")
    write_atomic(unit_path, unit)
    systemctl("daemon-reload")
    enable_result = systemctl("enable", UNIT_NAME)
    systemctl("restart", UNIT_NAME)
    print(enable_result.stdout.strip() or f"Installed and started {UNIT_NAME}")
    print(f"Unit: {unit_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
