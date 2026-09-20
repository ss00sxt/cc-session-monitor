#!/usr/bin/env node
import readline from "node:readline";
import { DaemonClient } from "./daemon-client.js";
import { renderMonitorHtml } from "./ui.js";

const UI_URI = "ui://cc-session-monitor/monitor.html";
const client = new DaemonClient();

const tools = [
  tool("cc_dispatch", "Dispatch a Claude Code task", "Start a new Claude Code session and immediately return its session ID. The monitor displays subsequent progress asynchronously.", {
    prompt: stringProp("The complete task for Claude Code"),
    summary: stringProp("Task summary, no longer than 20 Unicode characters"),
    cwd: stringProp("Absolute path to the task working directory"),
    permission_mode: enumProp(["acceptEdits", "auto", "dontAsk", "manual", "plan"], "acceptEdits")
  }, ["prompt", "summary", "cwd"], true),
  tool("cc_resume", "Resume a Claude Code session", "Continue an existing session by ID. If its monitor row has not been dismissed, that row is reused.", {
    session_id: stringProp("Claude Code session ID"),
    prompt: stringProp("New execution instructions"),
    summary: stringProp("Optional updated task summary"),
    cwd: stringProp("Optional working directory"),
    permission_mode: enumProp(["acceptEdits", "auto", "dontAsk", "manual", "plan"], "acceptEdits")
  }, ["session_id", "prompt"], true),
  tool("cc_get_sessions", "Get Claude Code session status", "Read the current state of all sessions that have not been dismissed.", {
    include_dismissed: { type: "boolean", description: "Include dismissed session rows" }
  }, [], false),
  tool("cc_get_events", "Get Claude Code session events", "Read text, tool calls, and status history for a session.", {
    session_id: stringProp("Claude Code session ID"),
    after_seq: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 2000, default: 500 }
  }, ["session_id"], false),
  tool("cc_cancel", "Cancel a Claude Code task", "Terminate a running Claude Code session.", {
    session_id: stringProp("Claude Code session ID")
  }, ["session_id"], false),
  tool("cc_dismiss", "Dismiss a finished task", "Hide a session row after it has completed, failed, been cancelled, or disconnected.", {
    session_id: stringProp("Claude Code session ID")
  }, ["session_id"], false),
  tool("cc_update_settings", "Update monitor settings", "Update interface settings shared by the browser dashboard and desktop tray.", {
    language: enumProp(["en", "zh-CN"], "en")
  }, ["language"], false),
  tool("cc_render_monitor", "Show CC Session Monitor", "Display interactive Claude Code session cards.", {}, [], true)
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
    return `Claude Code task started: ${result.summary}\nsession_id: ${result.sessionId}\nMonitor: ${result.dashboard_url}`;
  }
  if (name === "cc_render_monitor") return `CC Session Monitor is open. Local dashboard: ${result.dashboard_url}`;
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
