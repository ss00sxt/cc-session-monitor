#!/usr/bin/env python3
"""Forward local Claude Code lifecycle events to CC Session Monitor."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from monitor_client import MonitorClient


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("CC_MONITOR_DATA_DIR", Path.home() / ".local/state/cc-session-monitor"))


def summarize(prompt: str) -> str:
    text = re.sub(r"\s+", " ", prompt or "").strip()
    text = re.sub(r"^[/#]+", "", text).strip()
    chars = list(text or "本地 Claude Code 会话")
    return "".join(chars if len(chars) <= 20 else chars[:19] + ["…"])


def event_from_hook(payload: dict) -> dict:
    name = payload.get("hook_event_name", "")
    data: dict = {"cwd": payload.get("cwd"), "transcriptPath": payload.get("transcript_path")}
    if name == "SessionStart":
        data.update({"summary": payload.get("session_title") or f"{Path(payload.get('cwd') or '.').name} CC会话", "model": payload.get("model"), "source": payload.get("source")})
    elif name == "UserPromptSubmit":
        data.update({"summary": summarize(payload.get("prompt", "")), "prompt": payload.get("prompt", "")})
    elif name == "MessageDisplay":
        data.update({"text": payload.get("delta", ""), "final": bool(payload.get("final")), "messageId": payload.get("message_id"), "index": payload.get("index")})
    elif name in {"PreToolUse", "PostToolUse", "PostToolUseFailure"}:
        tool_input = payload.get("tool_input") or {}
        summary_value = tool_input.get("command") or tool_input.get("file_path") or tool_input.get("path") or tool_input.get("pattern") or payload.get("tool_name")
        data.update({
            "tool": payload.get("tool_name"),
            "toolUseId": payload.get("tool_use_id"),
            "summary": str(summary_value or "")[:300],
            "input": tool_input,
            "output": payload.get("tool_response") or payload.get("error", ""),
            "isError": name == "PostToolUseFailure",
        })
    elif name in {"Stop", "StopFailure", "SessionEnd"}:
        data.update({
            "output": payload.get("last_assistant_message") or last_assistant_text(payload.get("transcript_path")),
            "error": payload.get("error") or payload.get("error_type"),
            "reason": payload.get("reason"),
        })
    return {
        "session_id": payload.get("session_id"),
        "event_name": name,
        "run_id": payload.get("turn_id"),
        "cwd": payload.get("cwd"),
        "data": data,
    }


def last_assistant_text(transcript_path: str | None) -> str:
    if not transcript_path:
        return ""
    try:
        path = Path(transcript_path)
        content = path.read_text(encoding="utf-8", errors="replace")[-512_000:]
        for line in reversed(content.splitlines()):
            item = json.loads(line)
            if item.get("type") != "assistant":
                continue
            blocks = item.get("message", {}).get("content", [])
            text = "\n".join(block.get("text", "") for block in blocks if block.get("type") == "text")
            if text:
                return text
    except Exception:
        return ""
    return ""


def ensure_daemon(client: MonitorClient) -> None:
    try:
        client.sessions()
        return
    except Exception:
        pass
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(
        ["node", str(PLUGIN_ROOT / "src/daemon.js"), "--data-dir", str(DATA_DIR)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        env=os.environ.copy(),
    )
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            client.sessions()
            return
        except Exception:
            time.sleep(0.1)


def main() -> int:
    if os.environ.get("CC_SESSION_MONITOR_MANAGED") == "1":
        return 0
    try:
        payload = json.load(sys.stdin)
        if not payload.get("session_id") or not payload.get("hook_event_name"):
            return 0
        client = MonitorClient(DATA_DIR)
        ensure_daemon(client)
        client.call("cc_external_event", event_from_hook(payload))
    except Exception:
        # Observability must never block or alter the Claude Code session.
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
