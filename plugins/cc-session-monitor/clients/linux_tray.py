#!/usr/bin/env python3
"""Ubuntu/GNOME tray shell for CC Session Monitor.

The daemon API and MonitorClient are platform-neutral. Future macOS and Windows
clients should implement only their native menu-bar/notification-area shell.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import signal
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("AppIndicator3", "0.1")
from gi.repository import AppIndicator3, Gdk, GLib, Gtk, Pango  # noqa: E402

from monitor_client import MonitorClient  # noqa: E402


ACTIVE = {"starting", "running", "generating", "tool_running", "waiting_permission", "cancelling"}
TERMINAL = {"completed", "failed", "cancelled", "orphaned"}
TEXT = {
    "zh-CN": {
        "open": "打开 CC 任务面板", "dashboard": "浏览器详细面板", "quit": "退出托盘图标",
        "language": "语言", "cancel": "取消任务", "dismiss": "关闭提示", "empty": "还没有 Claude Code 任务",
        "connection_failed": "连接监控服务失败", "tooltip": "CC Session Monitor", "instruction": "提示词",
        "tool": "工具", "result": "结果", "error": "错误", "status": "状态", "progress": "进度", "heartbeat": "仍在运行", "event": "事件",
        "cancelled_text": "任务已取消", "failed_text": "任务执行失败", "finished": "已完成", "thinking": "模型思考中", "waiting_output": "尚无新输出",
        "starting": "启动中", "running": "执行中", "generating": "生成中", "tool_running": "调用工具",
        "waiting_permission": "等待权限", "cancelling": "取消中", "completed": "已完成", "failed": "失败",
        "cancelled": "已取消", "orphaned": "失联", "idle": "等待输入", "idle_error": "本轮失败",
    },
    "en": {
        "open": "Open CC task panel", "dashboard": "Browser details", "quit": "Quit tray icon",
        "language": "Language", "cancel": "Cancel task", "dismiss": "Dismiss", "empty": "No Claude Code sessions yet",
        "connection_failed": "Monitor connection failed", "tooltip": "CC Session Monitor", "instruction": "Prompt",
        "tool": "Tool", "result": "Result", "error": "Error", "status": "Status", "progress": "Progress", "heartbeat": "Still running", "event": "Event",
        "cancelled_text": "Task cancelled", "failed_text": "Task failed", "finished": "finished", "thinking": "Model is thinking", "waiting_output": "no new output yet",
        "starting": "Starting", "running": "Running", "generating": "Generating", "tool_running": "Using tool",
        "waiting_permission": "Waiting for permission", "cancelling": "Cancelling", "completed": "Completed", "failed": "Failed",
        "cancelled": "Cancelled", "orphaned": "Disconnected", "idle": "Waiting for input", "idle_error": "Turn failed",
    },
}

HIDDEN_EVENTS = {"external_session_started", "external_turn_completed", "external_session_ended", "session_initialized", "run_started", "run_completed", "model_status", "hook_event"}


def markdown_to_pango(value) -> str:
    """Render a safe, useful Markdown subset as GTK/Pango markup."""
    text = "" if value is None else str(value)

    def inline(source: str) -> str:
        escaped = GLib.markup_escape_text(source)
        escaped = re.sub(r"`([^`]+)`", r"<tt>\1</tt>", escaped)
        escaped = re.sub(r"\[([^\]]+)\]\((https?://[^\s)]+|mailto:[^\s)]+)\)", r'<a href="\2">\1</a>', escaped)
        escaped = re.sub(r"\*\*([^*]+)\*\*|__([^_]+)__", lambda match: f"<b>{match.group(1) or match.group(2)}</b>", escaped)
        escaped = re.sub(r"(?<!\*)\*([^*\n]+)\*|(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9])", lambda match: f"<i>{match.group(1) or match.group(2)}</i>", escaped)
        return escaped

    output, paragraph, code = [], [], []
    fenced = False

    def flush_paragraph():
        if paragraph:
            output.append("\n".join(inline(line) for line in paragraph))
            paragraph.clear()

    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line.startswith("```") or line.startswith("~~~"):
            flush_paragraph()
            if fenced:
                output.append(f'<span font_family="monospace">{GLib.markup_escape_text(chr(10).join(code))}</span>')
                code.clear()
            fenced = not fenced
            continue
        if fenced:
            code.append(line)
            continue
        if not line.strip():
            flush_paragraph()
            continue
        heading = re.match(r"^(#{1,3})\s+(.+)$", line)
        if heading:
            flush_paragraph()
            size = {1: "x-large", 2: "large", 3: "medium"}[len(heading.group(1))]
            output.append(f'<span size="{size}" weight="bold">{inline(heading.group(2))}</span>')
            continue
        bullet = re.match(r"^\s*[-*+]\s+(.+)$", line)
        ordered = re.match(r"^\s*(\d+)[.)]\s+(.+)$", line)
        quote = re.match(r"^>\s?(.*)$", line)
        if bullet:
            flush_paragraph()
            output.append(f"•  {inline(bullet.group(1))}")
        elif ordered:
            flush_paragraph()
            output.append(f"{ordered.group(1)}.  {inline(ordered.group(2))}")
        elif quote:
            flush_paragraph()
            output.append(f'<span foreground="#64748b">│ {inline(quote.group(1))}</span>')
        else:
            paragraph.append(line)
    if fenced:
        output.append(f'<span font_family="monospace">{GLib.markup_escape_text(chr(10).join(code))}</span>')
    flush_paragraph()
    return "\n\n".join(output)


class MonitorWindow(Gtk.Window):
    def __init__(self, client: MonitorClient):
        super().__init__(title="CC Session Monitor")
        self.client = client
        self.selected_id = None
        self.sessions = []
        self.language = "en"
        self.language_initialized = False
        self.rows = {}
        self.detail_session_id = None
        self.detail_last_seq = 0
        self.detail_events = []
        self.tool_cards = {}
        self.pending_tools = []
        self.tool_counter = 0
        self.last_output_label = None
        self.last_output_text = ""
        self.last_output_mode = ""
        self.heartbeat_header = None
        self.set_default_size(470, 620)
        self.set_type_hint(Gdk.WindowTypeHint.UTILITY)
        self.set_keep_above(True)
        self.connect("delete-event", self._hide)
        self.connect("focus-out-event", self._focus_out)

        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        root.set_border_width(10)
        self.add(root)

        self.title_label = Gtk.Label()
        self.title_label.set_markup("<b>CC Session Monitor</b>")
        self.title_label.set_xalign(0)
        root.pack_start(self.title_label, False, False, 0)

        self.list_box = Gtk.ListBox()
        self.list_box.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.list_box.set_sort_func(self._sort_rows)
        self.list_box.connect("row-selected", self._select_row)
        scroll = Gtk.ScrolledWindow()
        scroll.set_min_content_height(190)
        scroll.add(self.list_box)
        root.pack_start(scroll, False, True, 0)

        self.activity_label = Gtk.Label(xalign=0)
        self.activity_label.set_line_wrap(True)
        self.activity_label.get_style_context().add_class("activity")
        self.activity_label.set_no_show_all(True)
        root.pack_start(self.activity_label, False, False, 0)

        self._install_styles()
        self.detail = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=7)
        self.detail.set_border_width(3)
        self.detail_scroll = Gtk.ScrolledWindow()
        self.detail_scroll.get_style_context().add_class("detail-scroll")
        self.detail_scroll.add_with_viewport(self.detail)
        root.pack_start(self.detail_scroll, True, True, 0)

        buttons = Gtk.Box(spacing=8)
        self.cancel_button = Gtk.Button()
        self.cancel_button.connect("clicked", self._cancel)
        self.dismiss_button = Gtk.Button()
        self.dismiss_button.connect("clicked", self._dismiss)
        self.dashboard_button = Gtk.Button()
        self.dashboard_button.connect("clicked", lambda *_: webbrowser.open(self.client.dashboard_url()))
        buttons.pack_start(self.cancel_button, False, False, 0)
        buttons.pack_start(self.dismiss_button, False, False, 0)
        buttons.pack_end(self.dashboard_button, False, False, 0)
        root.pack_start(buttons, False, False, 0)
        self.set_language("en")

    def t(self, key):
        return TEXT.get(self.language, TEXT["en"]).get(key, key)

    @staticmethod
    def _install_styles():
        provider = Gtk.CssProvider()
        provider.load_from_data(b"""
            .message-card { border: 1px solid #d8dee8; border-radius: 9px; padding: 8px; background: #ffffff; }
            .session-row { border: 1px solid #d8dee8; border-radius: 9px; background: #ffffff; transition: 180ms ease-out; }
            .session-row-hover { background: #ffffff; border-color: #a9bad0; box-shadow: 0 7px 18px alpha(#172033, 0.20); }
            .session-id { color: #e5e7eb; background: #172033; border-radius: 6px; padding: 4px 7px; font-family: monospace; font-size: 10px; }
            .prompt-card { background: #eaf8f0; border-color: #9bd6b4; }
            .tool-card { background: #eef6ff; border-color: #c8d9ec; }
            .error-card { background: #fff1f2; border-color: #fda4af; }
            .badge { border: 1px solid #94a3b8; border-radius: 9px; padding: 1px 6px; font-size: 10px; }
            .prompt-badge { color: #25845e; border-color: #69b890; }
            .tool-badge { color: #9a7000; border-color: #c79400; }
            .event-time { color: #64748b; font-size: 10px; }
            .tool-result { border: 1px solid #c79400; border-radius: 7px; padding: 7px; margin-top: 7px; }
            .activity { color: #52677f; background: #eef6ff; border-radius: 7px; padding: 6px 8px; }
            .detail-scroll scrollbar.vertical { margin-top: 2px; margin-bottom: 4px; }
        """)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

    def set_language(self, language):
        language = language if language in TEXT else "en"
        if language == self.language and self.language_initialized:
            return
        changed = self.language_initialized and language != self.language
        self.language = language
        self.language_initialized = True
        self.cancel_button.set_label(self.t("cancel"))
        self.dismiss_button.set_label(self.t("dismiss"))
        self.dashboard_button.set_label(self.t("dashboard"))
        if changed and self.selected_id:
            self._rebuild_detail()

    def present_top_right(self, selected_id: str | None = None):
        self.selected_id = selected_id or self.selected_id
        self.refresh()
        self.show_all()
        screen = self.get_screen()
        monitor = screen.get_primary_monitor()
        area = screen.get_monitor_workarea(monitor)
        width, _ = self.get_size()
        self.move(area.x + area.width - width - 12, area.y + 12)
        self.present()

    def refresh(self):
        try:
            snapshot = self.client.sessions()
            self.set_language(snapshot.get("settings", {}).get("language", "en"))
            self.sessions = snapshot.get("sessions", [])
        except Exception as error:  # UI must stay alive while daemon restarts.
            self._clear_detail()
            self.detail.pack_start(self._simple_card(f"{self.t('connection_failed')}: {error}", "error-card"), False, False, 0)
            self.detail.show_all()
            return True
        current_ids = {session["sessionId"] for session in self.sessions}
        for session_id in set(self.rows) - current_ids:
            self.list_box.remove(self.rows.pop(session_id))

        for session in self.sessions:
            session_id = session["sessionId"]
            row = self.rows.get(session_id)
            if row is None:
                row = self._create_row(session_id)
                self.rows[session_id] = row
                self.list_box.add(row)
            row.sort_key = session.get("updatedAt", "")
            row.summary_label.set_text(session.get("summary", "Claude Code task"))
            row.status_label.set_text(self.t(session.get("status", "")))
            row.elapsed_label.set_text(format_elapsed(session))
        self.list_box.invalidate_sort()
        self.list_box.show_all()

        if self.selected_id in self.rows:
            session = next((item for item in self.sessions if item["sessionId"] == self.selected_id), None)
            self._update_activity(session)
            selected_row = self.list_box.get_selected_row()
            if not selected_row or selected_row.session_id != self.selected_id:
                self.list_box.select_row(self.rows[self.selected_id])
            else:
                self._refresh_detail()
            self._update_buttons()
        elif self.sessions:
            self.list_box.select_row(self.rows[self.sessions[0]["sessionId"]])
        else:
            self.selected_id = None
            self.activity_label.hide()
            self.detail_session_id = None
            self.detail_last_seq = 0
            self.detail_events = []
            self._clear_detail()
            self.detail.pack_start(self._simple_card(self.t("empty")), False, False, 0)
            self.detail.show_all()
        return True

    def _create_row(self, session_id: str):
        row = Gtk.ListBoxRow()
        row.session_id = session_id
        row.sort_key = ""
        row.hide_session_timeout = 0
        row.get_style_context().add_class("session-row")
        row.set_margin_top(2)
        row.set_margin_bottom(2)
        row.set_margin_start(4)
        row.set_margin_end(4)
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
        box = Gtk.Box(spacing=8)
        box.set_border_width(7)
        row.summary_label = Gtk.Label(xalign=0)
        row.summary_label.set_hexpand(True)
        row.status_label = Gtk.Label()
        row.elapsed_label = Gtk.Label()
        box.pack_start(row.summary_label, True, True, 0)
        box.pack_start(row.status_label, False, False, 0)
        box.pack_start(row.elapsed_label, False, False, 0)
        outer.pack_start(box, False, False, 0)
        row.session_id_label = Gtk.Label(label=session_id, xalign=0)
        row.session_id_label.set_selectable(True)
        row.session_id_label.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        row.session_id_label.get_style_context().add_class("session-id")
        row.session_id_label.set_margin_start(10)
        row.session_id_label.set_margin_end(10)
        row.session_revealer = Gtk.Revealer()
        row.session_revealer.set_transition_type(Gtk.RevealerTransitionType.SLIDE_DOWN)
        row.session_revealer.set_transition_duration(130)
        row.session_revealer.add(row.session_id_label)
        outer.pack_start(row.session_revealer, False, False, 0)
        row.add(outer)
        row.add_events(Gdk.EventMask.ENTER_NOTIFY_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK)
        row.connect("enter-notify-event", self._show_session_id)
        row.connect("leave-notify-event", self._schedule_hide_session_id)
        return row

    def _show_session_id(self, row, *_):
        if row.hide_session_timeout:
            GLib.source_remove(row.hide_session_timeout)
            row.hide_session_timeout = 0
        row.get_style_context().add_class("session-row-hover")
        row.set_margin_top(0)
        row.set_margin_bottom(8)
        row.session_revealer.set_reveal_child(True)
        return False

    def _schedule_hide_session_id(self, row, *_):
        if row.hide_session_timeout:
            GLib.source_remove(row.hide_session_timeout)
        row.hide_session_timeout = GLib.timeout_add(180, self._hide_session_id, row)
        return False

    @staticmethod
    def _hide_session_id(row):
        row.hide_session_timeout = 0
        row.get_style_context().remove_class("session-row-hover")
        row.set_margin_top(2)
        row.set_margin_bottom(2)
        row.session_revealer.set_reveal_child(False)
        return False

    @staticmethod
    def _sort_rows(first, second, *_):
        if first.sort_key == second.sort_key:
            return 0
        return -1 if first.sort_key > second.sort_key else 1

    def _select_row(self, _, row):
        if not row:
            return
        self.selected_id = row.session_id
        if self.detail_session_id != self.selected_id:
            self.detail_session_id = self.selected_id
            self.detail_last_seq = 0
            self.detail_events = []
            self._reset_detail_state()
            self._clear_detail()
            self._refresh_detail(initial=True)
        else:
            self._refresh_detail()
        self._update_buttons()

    def _refresh_detail(self, initial: bool = False):
        if not self.selected_id:
            return
        adjustment = self.detail_scroll.get_vadjustment()
        at_bottom = adjustment.get_value() + adjustment.get_page_size() >= adjustment.get_upper() - 8
        old_value = adjustment.get_value()
        try:
            events = self.client.events(
                self.selected_id,
                limit=200,
                after_seq=0 if initial else self.detail_last_seq,
            )
            if not events:
                return
            self.detail_events.extend(events)
            for event in events:
                self._append_event(event)
            self.detail_last_seq = max(event.get("seq", 0) for event in events)
            self.detail.show_all()
            for record in self.tool_cards.values():
                if not record["expanded"]:
                    record["result"].hide()
            GLib.idle_add(self._restore_detail_scroll, at_bottom, old_value)
        except Exception as error:
            if initial:
                self._clear_detail()
                self.detail.pack_start(self._simple_card(str(error), "error-card"), False, False, 0)
                self.detail.show_all()

    def _append_event(self, event):
        event_type = event.get("type", "")
        if event_type == "run_started":
            self.heartbeat_header = None
        if event_type in HIDDEN_EVENTS:
            return
        if event_type == "progress_snapshot":
            if self.heartbeat_header is None:
                self.heartbeat_header = self._append_generic(event, "progress", self.t("heartbeat"))
            else:
                self.heartbeat_header.time_label.set_text(self._stamp(event))
            return
        self.heartbeat_header = None
        data = event.get("data", {})
        text = data.get("text") or data.get("prompt") or data.get("output") or data.get("result") or data.get("error") or data.get("summary") or data.get("status") or ""
        if event_type in {"external_message", "text_delta", "assistant_message"}:
            if not text:
                return
            text = str(text)
            mode = "stream" if event_type == "text_delta" else "message"
            if self.last_output_label is not None and self.last_output_mode == "stream":
                if mode == "stream":
                    self.last_output_text += text
                elif text == self.last_output_text:
                    return
                elif text.startswith(self.last_output_text):
                    self.last_output_text = text
                else:
                    self._append_answer(event, text, mode)
                    return
                self.last_output_label.set_markup(markdown_to_pango(self.last_output_text))
                return
            if text == self.last_output_text:
                return
            self._append_answer(event, text, mode)
            return
        self.last_output_label = None
        self.last_output_mode = ""
        if event_type == "external_prompt":
            self._append_prompt(event, data.get("prompt") or text or data.get("summary"))
            return
        if event_type == "tool_started":
            self._append_tool(event)
            return
        if event_type == "tool_completed":
            self._complete_tool(event)
            return
        if event_type in {"model_error", "run_failed", "external_turn_failed"}:
            self._append_generic(event, "error", text or self.t("failed_text"), "error-card")
            return
        if event_type == "run_cancelled":
            self._append_generic(event, "status", self.t("cancelled_text"))
            return
        if text:
            self._append_generic(event, "event", text)

    def _append_prompt(self, event, text):
        card, box = self._card("prompt-card")
        box.pack_start(self._header("🗣", "instruction", self._stamp(event), show_badge=False), False, False, 0)
        label = self._markdown_label(text)
        label.set_lines(5)
        label.set_ellipsize(Pango.EllipsizeMode.END)
        box.pack_start(label, False, False, 0)
        card.expanded = False

        def toggle(*_):
            card.expanded = not card.expanded
            label.set_lines(-1 if card.expanded else 5)
            label.set_ellipsize(Pango.EllipsizeMode.NONE if card.expanded else Pango.EllipsizeMode.END)
            return True

        card.connect("button-press-event", toggle)
        self.detail.pack_start(card, False, False, 0)

    def _append_answer(self, event, text, mode):
        card, box = self._card()
        box.pack_start(self._header("📄", "", self._stamp(event), show_badge=False), False, False, 0)
        label = self._markdown_label(text)
        box.pack_start(label, False, False, 0)
        self.detail.pack_start(card, False, False, 0)
        self.last_output_label = label
        self.last_output_text = text
        self.last_output_mode = mode

    def _append_tool(self, event):
        data = event.get("data", {})
        existing = self.tool_cards.get(data.get("toolUseId"))
        if existing is not None:
            tool = data.get("tool") or existing["tool"]
            summary = data.get("summary")
            if summary and summary != tool and not existing["detail"]:
                existing["tool"] = tool
                existing["detail"] = str(summary)
                existing["summary_label"].set_text(f"{tool} · {summary}")
            return
        self.tool_counter += 1
        tool_id = data.get("toolUseId") or f"tool-{self.tool_counter}"
        tool = data.get("tool") or self.t("tool")
        summary = data.get("summary")
        detail = str(summary) if summary and summary != tool else ""
        summary_text = tool + (f" · {detail}" if detail else "")
        card, box = self._card("tool-card")
        header = self._header("🔧", "tool", self._stamp(event), summary=summary_text, show_badge=False)
        box.pack_start(header, False, False, 0)
        result = Gtk.EventBox()
        result.set_no_show_all(True)
        result.set_tooltip_text(self.t("result"))
        result_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5)
        result_box.get_style_context().add_class("tool-result")
        result.add(result_box)
        result_header = self._header("📌", "result", self._stamp(event), show_badge=False)
        result_box.pack_start(result_header, False, False, 0)
        result_label = self._markdown_label("")
        result_box.pack_start(result_label, False, False, 0)
        box.pack_start(result, False, False, 0)
        record = {"card": card, "result": result, "result_header": result_header, "label": result_label, "summary_label": header.summary_label, "tool": tool, "detail": detail, "expanded": False, "completed": False}

        def toggle(*_):
            record["expanded"] = not record["expanded"]
            record["summary_label"].set_lines(-1 if record["expanded"] else 1)
            record["summary_label"].set_line_wrap(record["expanded"])
            record["summary_label"].set_ellipsize(Pango.EllipsizeMode.NONE if record["expanded"] else Pango.EllipsizeMode.END)
            result.show_all() if record["expanded"] else result.hide()
            return True

        header.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
        header.connect("button-press-event", toggle)
        result.connect("button-press-event", toggle)
        self.tool_cards[tool_id] = record
        self.pending_tools.append(record)
        self.detail.pack_start(card, False, False, 0)

    def _complete_tool(self, event):
        data = event.get("data", {})
        record = self.tool_cards.get(data.get("toolUseId"))
        if record is None:
            record = next((item for item in reversed(self.pending_tools) if not item["completed"]), None)
        if record is None:
            self._append_tool({**event, "data": {"tool": data.get("tool") or self.t("tool"), "toolUseId": data.get("toolUseId")}})
            record = self.pending_tools[-1]
        record["completed"] = True
        self.pending_tools = [item for item in self.pending_tools if item is not record]
        if data.get("isError"):
            record["card"].get_style_context().add_class("error-card")
        output = data.get("output") or data.get("error") or ""
        if isinstance(output, str) and output.lstrip().startswith("{"):
            path_match = re.search(r'"(?:filePath|file_path|path)"\s*:\s*"([^"\n]+)"', output)
            if path_match:
                output = path_match.group(1)
            try:
                if isinstance(output, str) and output.lstrip().startswith("{"):
                    output = json.loads(output)
            except json.JSONDecodeError:
                pass
        if isinstance(output, dict):
            output = output.get("filePath") or output.get("file_path") or output.get("path") or output.get("message") or output.get("result") or output.get("text") or str(output)
        output = str(output)
        if len(output) > 1600:
            output = output[:1600] + "…"
        record["label"].set_markup(markdown_to_pango(output or self.t("finished")))
        time_label = record["result_header"].time_label
        time_label.set_text(self._stamp(event))

    def _append_generic(self, event, key, text, css_class=""):
        card, box = self._card(css_class)
        header = self._header("", key, self._stamp(event))
        box.pack_start(header, False, False, 0)
        box.pack_start(self._markdown_label(text), False, False, 0)
        self.detail.pack_start(card, False, False, 0)
        return header

    def _card(self, css_class=""):
        card = Gtk.EventBox()
        card.get_style_context().add_class("message-card")
        if css_class:
            card.get_style_context().add_class(css_class)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5)
        card.add(box)
        return card, box

    def _simple_card(self, text, css_class=""):
        card, box = self._card(css_class)
        box.pack_start(self._markdown_label(text), False, False, 0)
        return card

    def _header(self, icon, key, stamp, badge_class="badge", summary="", show_badge=True, reserve_icon=False):
        box = Gtk.Box(spacing=6)
        if icon or reserve_icon:
            icon_label = Gtk.Label(label=icon)
            icon_label.set_size_request(18, -1)
            box.pack_start(icon_label, False, False, 0)
        badge = None
        if show_badge:
            badge = Gtk.Label(label=self.t(key))
            badge.set_line_wrap(False)
            badge.set_single_line_mode(True)
            badge.get_style_context().add_class("badge")
            if badge_class != "badge":
                badge.get_style_context().add_class(badge_class)
            box.pack_start(badge, False, False, 0)
        summary_label = None
        if summary:
            summary_label = Gtk.Label(label=summary, xalign=0)
            summary_label.set_lines(1)
            summary_label.set_line_wrap(False)
            summary_label.set_ellipsize(Pango.EllipsizeMode.END)
            summary_label.set_hexpand(True)
            box.pack_start(summary_label, True, True, 0)
        time_label = Gtk.Label(label=stamp)
        time_label.get_style_context().add_class("event-time")
        box.pack_end(time_label, False, False, 0)
        box.badge_label = badge
        box.summary_label = summary_label
        box.time_label = time_label
        return box

    @staticmethod
    def _markdown_label(text):
        label = Gtk.Label(xalign=0)
        label.set_line_wrap(True)
        label.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        label.set_selectable(True)
        label.set_markup(markdown_to_pango(text))
        return label

    @staticmethod
    def _stamp(event):
        return datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")

    def _clear_detail(self):
        for child in self.detail.get_children():
            self.detail.remove(child)

    def _reset_detail_state(self):
        self.tool_cards = {}
        self.pending_tools = []
        self.tool_counter = 0
        self.last_output_label = None
        self.last_output_text = ""
        self.last_output_mode = ""
        self.heartbeat_header = None

    def _rebuild_detail(self):
        self._clear_detail()
        self._reset_detail_state()
        for event in self.detail_events:
            self._append_event(event)
        self.detail.show_all()
        for record in self.tool_cards.values():
            if not record["expanded"]:
                record["result"].hide()

    def _restore_detail_scroll(self, at_bottom, old_value):
        adjustment = self.detail_scroll.get_vadjustment()
        if at_bottom:
            adjustment.set_value(max(adjustment.get_lower(), adjustment.get_upper() - adjustment.get_page_size()))
        else:
            maximum = max(adjustment.get_lower(), adjustment.get_upper() - adjustment.get_page_size())
            adjustment.set_value(min(old_value, maximum))
        return False

    def _update_buttons(self):
        session = next((item for item in self.sessions if item["sessionId"] == self.selected_id), None)
        status = session.get("status") if session else ""
        self.cancel_button.set_sensitive(status in ACTIVE)
        self.dismiss_button.set_sensitive(status in TERMINAL)

    def _update_activity(self, session):
        if not session:
            self.activity_label.hide()
            return
        if session.get("activeTool"):
            value = session.get("activeTool") or self.t("tool")
            if session.get("activeToolSummary"):
                value += f" · {session['activeToolSummary']}"
        elif session.get("status") == "generating":
            updated = datetime.fromisoformat(session["updatedAt"].replace("Z", "+00:00")).timestamp()
            seconds = max(0, int(time.time() - updated))
            value = f"{self.t('thinking')} · {seconds // 60:02}:{seconds % 60:02} · {self.t('waiting_output')}"
        elif session.get("status") == "waiting_permission":
            value = self.t("waiting_permission")
            if session.get("activeToolSummary"):
                value += f" · {session['activeToolSummary']}"
        else:
            self.activity_label.hide()
            return
        self.activity_label.set_text(value)
        self.activity_label.show()

    def _cancel(self, *_):
        if self.selected_id:
            self.client.cancel(self.selected_id)
            self.refresh()

    def _dismiss(self, *_):
        if self.selected_id:
            self.client.dismiss(self.selected_id)
            self.selected_id = None
            self.refresh()

    def _hide(self, *_):
        self.hide()
        return True

    def _focus_out(self, *_):
        GLib.timeout_add(220, self._hide_if_unfocused)
        return False

    def _hide_if_unfocused(self):
        if not self.is_active():
            self.hide()
        return False


class TrayApplication:
    def __init__(self, data_dir: Path, plugin_root: Path):
        self.data_dir = data_dir
        self.client = MonitorClient(data_dir)
        self.language = "en"
        self.updating_language = False
        self.assets = plugin_root / "assets"
        self.window = MonitorWindow(self.client)
        self.indicator = AppIndicator3.Indicator.new(
            "cc-session-monitor",
            str(self.assets / "tray-idle.svg"),
            AppIndicator3.IndicatorCategory.APPLICATION_STATUS,
        )
        self.indicator.set_status(AppIndicator3.IndicatorStatus.ACTIVE)
        self.menu = Gtk.Menu()
        self.open_item = Gtk.MenuItem()
        self.open_item.connect("activate", lambda *_: self.window.present_top_right())
        self.menu.append(self.open_item)
        self.menu.append(Gtk.SeparatorMenuItem())
        self.session_items = {}
        self.session_separator = Gtk.SeparatorMenuItem()
        self.menu.append(self.session_separator)
        self.dashboard_item = Gtk.MenuItem()
        self.dashboard_item.connect("activate", lambda *_: webbrowser.open(self.client.dashboard_url()))
        self.menu.append(self.dashboard_item)
        self.language_item = Gtk.MenuItem()
        language_menu = Gtk.Menu()
        self.en_item = Gtk.RadioMenuItem.new_with_label(None, "English")
        self.zh_item = Gtk.RadioMenuItem.new_with_label_from_widget(self.en_item, "简体中文")
        self.zh_item.connect("toggled", self._language_changed, "zh-CN")
        self.en_item.connect("toggled", self._language_changed, "en")
        language_menu.append(self.en_item)
        language_menu.append(self.zh_item)
        self.language_item.set_submenu(language_menu)
        self.menu.append(self.language_item)
        self.quit_item = Gtk.MenuItem()
        self.quit_item.connect("activate", lambda *_: Gtk.main_quit())
        self.menu.append(self.quit_item)
        self.set_language("en")
        self.menu.show_all()
        self.indicator.set_menu(self.menu)
        GLib.timeout_add_seconds(1, self.refresh)
        self.refresh()

    def refresh(self):
        try:
            snapshot = self.client.sessions()
            self.set_language(snapshot.get("settings", {}).get("language", "en"))
            sessions = snapshot.get("sessions", [])
        except Exception:
            self.indicator.set_icon_full(str(self.assets / "tray-error.svg"), self.t("connection_failed"))
            return True
        ids = {session["sessionId"] for session in sessions}
        if ids != set(self.session_items):
            for item in self.session_items.values():
                self.menu.remove(item)
            self.session_items.clear()
            insert_at = 2
            for session in sessions:
                item = Gtk.MenuItem()
                item.session_id = session["sessionId"]
                item.connect("activate", self._open_session)
                item.set_tooltip_text(session["sessionId"])
                self.menu.insert(item, insert_at)
                insert_at += 1
                self.session_items[session["sessionId"]] = item
            self.menu.show_all()
        for session in sessions:
            item = self.session_items[session["sessionId"]]
            item.set_label(f"{status_mark(session['status'])} {session['summary']}   {format_elapsed(session)}")
        has_active = bool(sessions)
        has_error = any(session.get("status") in {"failed", "orphaned"} for session in sessions)
        icon = "tray-error.svg" if has_error else "tray-active.svg" if has_active else "tray-idle.svg"
        self.indicator.set_icon_full(str(self.assets / icon), self.t("tooltip"))
        if self.window.get_visible():
            self.window.refresh()
        return True

    def _open_session(self, item):
        self.window.present_top_right(item.session_id)

    def t(self, key):
        return TEXT.get(self.language, TEXT["en"]).get(key, key)

    def set_language(self, language):
        language = language if language in TEXT else "en"
        self.language = language
        self.open_item.set_label(self.t("open"))
        self.dashboard_item.set_label(self.t("dashboard"))
        self.language_item.set_label(self.t("language"))
        self.quit_item.set_label(self.t("quit"))
        self.window.set_language(language)
        self.updating_language = True
        (self.zh_item if language == "zh-CN" else self.en_item).set_active(True)
        self.updating_language = False

    def _language_changed(self, item, language):
        if self.updating_language or not item.get_active():
            return
        try:
            self.client.update_settings(language)
            self.set_language(language)
        except Exception:
            pass


def status_mark(status: str) -> str:
    return "●" if status in ACTIVE else "✓" if status == "completed" else "!"


def format_elapsed(session: dict) -> str:
    start = datetime.fromisoformat(session["startedAt"].replace("Z", "+00:00")).timestamp()
    end = datetime.fromisoformat(session["completedAt"].replace("Z", "+00:00")).timestamp() if session.get("completedAt") else time.time()
    seconds = max(0, int(end - start))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours}:{minutes:02}:{seconds:02}" if hours else f"{minutes:02}:{seconds:02}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--plugin-root", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        print("linux-tray dependencies: OK")
        return 0
    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    lock_handle = (data_dir / "tray-linux.lock").open("a+", encoding="utf-8")
    try:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        # Another tray already owns this data directory. Exiting avoids a
        # duplicate indicator when hooks and systemd start concurrently.
        return 0
    pid_path = data_dir / "tray-linux.pid"
    pid_path.write_text(str(os.getpid()), encoding="utf-8")
    signal.signal(signal.SIGTERM, lambda *_: Gtk.main_quit())
    TrayApplication(data_dir, Path(args.plugin_root))
    Gtk.main()
    pid_path.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
