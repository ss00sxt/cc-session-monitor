import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { bounded, safeJsonParse, truncateSummary } from "./utils.js";

export class ClaudeRunner {
  constructor({ store, executable, baseArgs = [], envFile, settingsFile, configDir, snapshotIntervalMs = 30_000, spawnImpl = spawn } = {}) {
    this.store = store;
    this.executable = executable ?? process.env.CC_MONITOR_CLAUDE_PATH ?? "claude";
    this.baseArgs = baseArgs;
    this.envFile = envFile ?? discoverEnvFile();
    this.settingsFile = settingsFile ?? discoverSettingsFile();
    this.configDir = configDir ?? join(store.dataDir, "claude");
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.spawnImpl = spawnImpl;
    this.active = new Map();
  }

  async dispatch({ prompt, summary, cwd, sessionId, permissionMode = "acceptEdits", resume = false }) {
    if (!prompt?.trim()) throw new Error("prompt is required");
    if (!cwd?.trim()) throw new Error("cwd is required");
    if (resume && !sessionId) throw new Error("sessionId is required when resuming");
    if (sessionId && this.active.has(sessionId)) throw new Error(`Session is already running: ${sessionId}`);

    const finalSessionId = sessionId ?? randomUUID();
    const runId = randomUUID();
    const finalSummary = truncateSummary(summary || prompt);
    await this.store.append(finalSessionId, runId, "run_started", { summary: finalSummary, cwd, resume });

    const args = [
      ...this.baseArgs,
      "-p", prompt,
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--include-hook-events",
      "--verbose",
      "--permission-mode", permissionMode,
      "--permission-prompts", "none",
      "--name", finalSummary,
      ...(this.settingsFile && existsSync(this.settingsFile) ? ["--settings", this.settingsFile] : []),
      ...(resume ? ["--resume", finalSessionId] : ["--session-id", finalSessionId])
    ];

    const child = this.spawnClaude(args, cwd);
    const record = {
      child,
      runId,
      sessionId: finalSessionId,
      pendingResult: null,
      terminalRecorded: false,
      lastOutput: "",
      chain: Promise.resolve(),
      resolveDone: null,
      done: null,
      snapshotTimer: null,
      snapshotGeneration: 0,
      cancelled: false
    };
    record.done = new Promise((resolve) => { record.resolveDone = resolve; });
    this.active.set(finalSessionId, record);

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      record.chain = record.chain.then(() => this.handleLine(record, line));
    });
    const stderr = readline.createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      this.scheduleIdleSnapshot(record);
      record.chain = record.chain.then(async () => {
        record.lastOutput = bounded(line, 4_000);
        await this.store.append(finalSessionId, runId, "stderr", { text: line });
      });
    });

    this.scheduleIdleSnapshot(record);

    child.once("error", (error) => {
      record.chain = record.chain.then(() => this.finishSpawnError(record, error));
    });
    child.once("close", (code, signal) => {
      record.chain = record.chain.then(() => this.finishProcess(record, code, signal));
    });

    return { sessionId: finalSessionId, runId, summary: finalSummary, pid: child.pid ?? null };
  }

  spawnClaude(args, cwd) {
    const common = { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: this.configDir, CC_SESSION_MONITOR_MANAGED: "1" }, stdio: ["ignore", "pipe", "pipe"] };
    if (this.envFile && existsSync(this.envFile)) {
      return this.spawnImpl("/bin/bash", [
        "-c",
        "source \"$1\"; shift; exec \"$@\"",
        "cc-session-monitor",
        this.envFile,
        this.executable,
        ...args
      ], common);
    }
    return this.spawnImpl(this.executable, args, common);
  }

  async handleLine(record, line) {
    const message = safeJsonParse(line);
    if (!message) {
      this.scheduleIdleSnapshot(record);
      record.lastOutput = bounded(line, 4_000);
      await this.store.append(record.sessionId, record.runId, "stdout", { text: line });
      return;
    }

    const events = normalizeClaudeMessage(message);
    for (const event of events) {
      if (["text_delta", "assistant_message", "tool_started", "tool_completed", "stderr"].includes(event.type)) {
        this.scheduleIdleSnapshot(record);
      }
      if (event.data?.text || event.data?.output || event.data?.result) {
        record.lastOutput = bounded(event.data.text ?? event.data.output ?? event.data.result, 4_000);
      }
      if (event.type === "run_completed" || event.type === "run_failed") {
        // A streamed result can precede more output or tool calls. The process
        // exit, not the first result message, is the terminal boundary.
        record.pendingResult = event;
        continue;
      }
      await this.store.append(record.sessionId, record.runId, event.type, event.data);
    }
  }

  async finishSpawnError(record, error) {
    if (!record.terminalRecorded) {
      record.terminalRecorded = true;
      await this.store.append(record.sessionId, record.runId, "run_failed", { error: error.message, exitCode: 1 });
    }
  }

  async finishProcess(record, code, signal) {
    clearTimeout(record.snapshotTimer);
    if (!record.terminalRecorded) {
      const type = record.cancelled ? "run_cancelled" : code === 0 && record.pendingResult?.type !== "run_failed" ? "run_completed" : "run_failed";
      const result = record.pendingResult?.data || {};
      await this.store.append(record.sessionId, record.runId, type, {
        exitCode: code,
        signal,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
        usage: result.usage,
        result: type === "run_completed" ? result.result ?? record.lastOutput : undefined,
        error: type === "run_failed" ? result.error || record.lastOutput || `Claude Code exited with code ${code}` : undefined
      });
      record.terminalRecorded = true;
    }
    this.active.delete(record.sessionId);
    record.resolveDone?.({ code, signal });
  }

  async cancel(sessionId) {
    const record = this.active.get(sessionId);
    if (!record) throw new Error(`Session is not running: ${sessionId}`);
    record.cancelled = true;
    record.child.kill("SIGTERM");
    const timer = setTimeout(() => record.child.kill("SIGKILL"), 3_000);
    timer.unref?.();
    return { sessionId, status: "cancelling" };
  }

  waitFor(sessionId) {
    return this.active.get(sessionId)?.done ?? Promise.resolve(null);
  }

  scheduleIdleSnapshot(record) {
    clearTimeout(record.snapshotTimer);
    const generation = ++record.snapshotGeneration;
    record.snapshotTimer = setTimeout(() => {
      record.chain = record.chain.then(async () => {
        if (generation !== record.snapshotGeneration || !this.active.has(record.sessionId) || record.terminalRecorded) return;
        await this.store.append(record.sessionId, record.runId, "progress_snapshot", { processId: record.child.pid });
        this.scheduleIdleSnapshot(record);
      });
    }, this.snapshotIntervalMs);
    record.snapshotTimer.unref?.();
  }
}

export function normalizeClaudeMessage(message) {
  const events = [];
  if (message.type === "system" && message.subtype === "init") {
    events.push({ type: "session_initialized", data: { model: message.model, cwd: message.cwd, claudeVersion: message.claude_code_version } });
  } else if (message.type === "system" && message.subtype === "status") {
    events.push({ type: "model_status", data: { status: message.status } });
  } else if (message.type === "stream_event") {
    normalizeStreamEvent(message.event, events);
  } else if (message.type === "assistant") {
    for (const block of message.message?.content ?? []) normalizeContentBlock(block, events);
    if (message.error) events.push({ type: "model_error", data: { error: message.error } });
  } else if (message.type === "user") {
    for (const block of message.message?.content ?? []) {
      if (block.type === "tool_result") {
        events.push({ type: "tool_completed", data: { toolUseId: block.tool_use_id, output: extractText(block.content), isError: block.is_error } });
      }
    }
  } else if (message.type === "result") {
    const failed = Boolean(message.is_error) || message.terminal_reason === "api_error";
    events.push({
      type: failed ? "run_failed" : "run_completed",
      data: {
        result: message.result,
        error: failed ? message.result || message.terminal_reason : undefined,
        durationMs: message.duration_ms,
        costUsd: message.total_cost_usd,
        usage: message.usage,
        exitCode: failed ? 1 : 0
      }
    });
  } else if (String(message.type).includes("hook")) {
    events.push({ type: "hook_event", data: { hook: message.type, payload: bounded(message) } });
  }
  return events;
}

function normalizeStreamEvent(event, events) {
  if (!event) return;
  if (event.type === "content_block_start") {
    normalizeContentBlock(event.content_block, events);
  } else if (event.type === "content_block_delta") {
    if (event.delta?.type === "text_delta") events.push({ type: "text_delta", data: { text: event.delta.text } });
    if (event.delta?.type === "thinking_delta") events.push({ type: "model_status", data: { status: "thinking" } });
  }
}

function normalizeContentBlock(block, events) {
  if (!block) return;
  if (block.type === "text") events.push({ type: "assistant_message", data: { text: block.text } });
  if (block.type === "tool_use") {
    events.push({ type: "tool_started", data: {
      tool: block.name,
      toolUseId: block.id,
      summary: summarizeToolInput(block.name, block.input),
      input: bounded(block.input, 2_000)
    } });
  }
  if (block.type === "thinking") events.push({ type: "model_status", data: { status: "thinking" } });
}

function summarizeToolInput(name, input) {
  if (!input) return name;
  const candidate = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.description;
  return bounded(candidate ?? name, 300);
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return bounded(content ?? "", 4_000);
  return content.map((item) => item?.text ?? bounded(item)).join("\n");
}

function discoverEnvFile() {
  if (process.env.CC_MONITOR_ENV_FILE === "none") return null;
  if (process.env.CC_MONITOR_ENV_FILE) return process.env.CC_MONITOR_ENV_FILE;
  const deepseek = join(homedir(), ".claude", "deepseek-key.sh");
  return existsSync(deepseek) ? deepseek : null;
}

function discoverSettingsFile() {
  if (process.env.CC_MONITOR_CLAUDE_SETTINGS === "none") return null;
  if (process.env.CC_MONITOR_CLAUDE_SETTINGS) return process.env.CC_MONITOR_CLAUDE_SETTINGS;
  const settings = join(homedir(), ".claude", "settings.json");
  return existsSync(settings) ? settings : null;
}
