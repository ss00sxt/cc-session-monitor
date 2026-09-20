"""Platform-neutral client for the CC Session Monitor daemon."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.request import Request, urlopen


class MonitorClient:
    """Small stable interface shared by Linux, macOS, and Windows shells."""

    def __init__(self, data_dir: str | Path):
        self.data_dir = Path(data_dir)

    def _connection(self) -> tuple[str, str]:
        info = json.loads((self.data_dir / "daemon.json").read_text(encoding="utf-8"))
        token = (self.data_dir / "token").read_text(encoding="utf-8").strip()
        return f"http://{info.get('host', '127.0.0.1')}:{info['port']}", token

    def call(self, method: str, params: dict | None = None) -> dict:
        base_url, token = self._connection()
        request = Request(
            f"{base_url}/api/rpc",
            data=json.dumps({"method": method, "params": params or {}}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            method="POST",
        )
        with urlopen(request, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("error"):
            raise RuntimeError(payload["error"].get("message", "Monitor request failed"))
        return payload["result"]

    def sessions(self) -> dict:
        return self.call("cc_get_sessions")["snapshot"]

    def events(self, session_id: str, limit: int = 200, after_seq: int = 0) -> list[dict]:
        return self.call(
            "cc_get_events",
            {"session_id": session_id, "limit": limit, "after_seq": after_seq},
        )["events"]

    def dismiss(self, session_id: str) -> None:
        self.call("cc_dismiss", {"session_id": session_id})

    def update_settings(self, language: str) -> dict:
        return self.call("cc_update_settings", {"language": language})["settings"]

    def cancel(self, session_id: str) -> None:
        self.call("cc_cancel", {"session_id": session_id})

    def dashboard_url(self) -> str:
        return self.call("cc_get_sessions")["dashboard_url"]
