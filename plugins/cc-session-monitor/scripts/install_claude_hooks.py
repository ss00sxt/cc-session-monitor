#!/usr/bin/env python3
"""Install or remove CC Session Monitor hooks in Claude Code user settings."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path


EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "MessageDisplay",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
    "SessionEnd",
]


def is_monitor_handler(handler: dict) -> bool:
    return "claude_hook.py" in str(handler.get("command", "")) or any("claude_hook.py" in str(arg) for arg in handler.get("args", []))


def remove_monitor_groups(settings: dict) -> None:
    hooks = settings.setdefault("hooks", {})
    for event in list(hooks):
        groups = []
        for group in hooks.get(event, []):
            handlers = [handler for handler in group.get("hooks", []) if not is_monitor_handler(handler)]
            if handlers:
                groups.append({**group, "hooks": handlers})
        if groups:
            hooks[event] = groups
        else:
            hooks.pop(event, None)
    if not hooks:
        settings.pop("hooks", None)


def install(settings_path: Path, hook_path: Path, remove: bool = False) -> Path | None:
    settings = json.loads(settings_path.read_text(encoding="utf-8")) if settings_path.exists() else {}
    remove_monitor_groups(settings)
    if not remove:
        hooks = settings.setdefault("hooks", {})
        for event in EVENTS:
            handler = {
                "type": "command",
                "command": "python3",
                "args": [str(hook_path)],
                "timeout": 5,
            }
            # Tool hooks can be fire-and-forget. MessageDisplay stays synchronous
            # so its output cannot arrive after Stop/SessionEnd and revive an idle
            # or completed row.
            if event in {"PreToolUse", "PostToolUse", "PostToolUseFailure"}:
                handler["async"] = True
            group = {"hooks": [handler]}
            if event in {"SessionStart", "SessionEnd", "PreToolUse", "PostToolUse", "PostToolUseFailure"}:
                group["matcher"] = ""
            hooks.setdefault(event, []).append(group)

    settings_path.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if settings_path.exists():
        backup = settings_path.with_name(f"{settings_path.name}.backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(settings_path, backup)
    fd, temporary = tempfile.mkstemp(prefix="settings-", suffix=".json", dir=settings_path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(settings, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, settings_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return backup


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--settings", default=str(Path.home() / ".claude/settings.json"))
    parser.add_argument("--remove", action="store_true")
    args = parser.parse_args()
    plugin_root = Path(__file__).resolve().parents[1]
    backup = install(Path(args.settings), plugin_root / "clients/claude_hook.py", args.remove)
    action = "Removed" if args.remove else "Installed"
    print(f"{action} CC Session Monitor hooks in {args.settings}")
    if backup:
        print(f"Backup: {backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
