#!/usr/bin/env node
import readline from "node:readline";
import { DaemonClient } from "./daemon-client.js";
import { renderMonitorHtml } from "./ui.js";

const UI_URI = "ui://cc-session-monitor/monitor.html";
const client = new DaemonClient();

const tools = [
  tool("cc_dispatch", "下发 Claude Code 任务", "启动新的 Claude Code 会话并立即返回 session ID。后续进度由监视器异步展示。", {
    prompt: stringProp("交给 Claude Code 的完整任务"),
    summary: stringProp("20 个汉字以内的任务概述"),
    cwd: stringProp("任务工作目录的绝对路径"),
    permission_mode: enumProp(["acceptEdits", "auto", "dontAsk", "manual", "plan"], "acceptEdits")
  }, ["prompt", "summary", "cwd"], true),
  tool("cc_resume", "续接 Claude Code 会话", "使用已有 session ID 继续工作；未关闭的监视行会复用而不会新增。", {
    session_id: stringProp("Claude Code session ID"),
    prompt: stringProp("新的执行指令"),
    summary: stringProp("可选的新概述"),
    cwd: stringProp("可选工作目录"),
    permission_mode: enumProp(["acceptEdits", "auto", "dontAsk", "manual", "plan"], "acceptEdits")
  }, ["session_id", "prompt"], true),
  tool("cc_get_sessions", "读取 CC 会话状态", "读取所有未隐藏会话的当前状态。", {
    include_dismissed: { type: "boolean", description: "是否包含已经关闭的行" }
  }, [], false),
  tool("cc_get_events", "读取 CC 会话事件", "读取指定 session 的文本、工具调用和状态历史。", {
    session_id: stringProp("Claude Code session ID"),
    after_seq: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 2000, default: 500 }
  }, ["session_id"], false),
  tool("cc_cancel", "取消 CC 任务", "终止正在执行的 Claude Code 会话。", {
    session_id: stringProp("Claude Code session ID")
  }, ["session_id"], false),
  tool("cc_dismiss", "关闭已完成任务行", "隐藏已经完成、失败、取消或失联的会话行。", {
    session_id: stringProp("Claude Code session ID")
  }, ["session_id"], false),
  tool("cc_update_settings", "更新监视器设置", "更新浏览器面板和桌面托盘共享的界面设置。", {
    language: enumProp(["zh-CN", "en"], "zh-CN")
  }, ["language"], false),
  tool("cc_render_monitor", "显示 CC 任务监视器", "显示可交互的 Claude Code 会话监视卡片。", {}, [], true)
];

function tool(name, title, description, properties, required, withUi) {
  return {
    name,
    title,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    ...(withUi ? { _meta: { ui: { resourceUri: UI_URI }, "openai/outputTemplate": UI_URI } } : {})
  };
}

function stringProp(description) {
  return { type: "string", description };
}

function enumProp(values, defaultValue) {
  return { type: "string", enum: values, default: defaultValue };
}

export async function handleRequest(message, daemonClient = client) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    return success(id, {
      protocolVersion: params.protocolVersion || "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "cc-session-monitor", version: "0.1.0" }
    });
  }
  if (method === "ping") return success(id, {});
  if (method === "tools/list") return success(id, { tools });
  if (method === "resources/list") {
    return success(id, { resources: [{ uri: UI_URI, name: "CC Session Monitor", title: "CC Session Monitor", description: "Live Claude Code session monitor", mimeType: "text/html;profile=mcp-app" }] });
  }
  if (method === "resources/read") {
    if (params.uri !== UI_URI) return failure(id, -32002, "Resource not found");
    return success(id, { contents: [{ uri: UI_URI, mimeType: "text/html;profile=mcp-app", text: renderMonitorHtml({ mode: "mcp" }), _meta: { ui: { prefersBorder: true } } }] });
  }
  if (method === "tools/call") {
    const name = params.name;
    if (!tools.some((item) => item.name === name)) return failure(id, -32602, `Unknown tool: ${name}`);
    try {
      const result = await daemonClient.call(name, params.arguments || {});
      const text = formatToolText(name, result);
      return success(id, { content: [{ type: "text", text }], structuredContent: result, ...(name === "cc_dispatch" || name === "cc_resume" || name === "cc_render_monitor" ? { _meta: { ui: { resourceUri: UI_URI } } } : {}) });
    } catch (error) {
      return success(id, { isError: true, content: [{ type: "text", text: error?.message || String(error) }] });
    }
  }
  if (method?.startsWith("notifications/")) return null;
  return failure(id, -32601, `Method not found: ${method}`);
}

function formatToolText(name, result) {
  if (name === "cc_dispatch" || name === "cc_resume") {
    return `Claude Code 任务已启动：${result.summary}\nsession_id: ${result.sessionId}\n监视面板：${result.dashboard_url}`;
  }
  if (name === "cc_render_monitor") return `CC Session Monitor 已打开。备用本地面板：${result.dashboard_url}`;
  return JSON.stringify(result);
}

function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function main() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(failure(null, -32700, "Parse error"))}\n`);
      continue;
    }
    try {
      const response = await handleRequest(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify(failure(message.id ?? null, -32603, error?.message || String(error)))}\n`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`cc-session-monitor MCP server failed: ${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
