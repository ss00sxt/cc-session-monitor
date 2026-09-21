import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeClaudeMessage } from "./runner.js";
import { atomicWriteJson, bounded, readJson, safeJsonParse, truncateSummary } from "./utils.js";

const WORKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "durable-worker.js");

export class DurableClaudeRunner {
  constructor({ store, executable = process.env.CC_MONITOR_CLAUDE_PATH || "claude", baseArgs = [], envFile, settingsFile, configDir, snapshotIntervalMs = 30_000, launchMode = "systemd" } = {}) {
    this.store = store;
    this.executable = executable;
    this.baseArgs = baseArgs;
    this.envFile = envFile ?? defaultEnvFile();
    this.settingsFile = settingsFile ?? defaultSettingsFile();
    this.configDir = configDir ?? join(store.dataDir, "claude");
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.launchMode = launchMode;
    this.workersDir = join(store.dataDir, "workers");
    this.active = new Map();
    this.pollTimer = null;
  }

  async init() {
    await mkdir(this.workersDir, { recursive: true, mode: 0o700 });
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    for (const runId of await readdir(this.workersDir)) {
      const manifest = await readJson(join(this.workersDir, runId, "manifest.json"), null);
      if (!manifest || manifest.completed) continue;
      const record = this.makeRecord(manifest);
      this.active.set(record.sessionId, record);
      await this.poll(record);
      if (this.active.has(record.sessionId) && Date.now() - Date.parse(manifest.createdAt) > 10_000 && !await this.workerAlive(record)) {
        await this.finish(record, "run_failed", { error: "Executor exited without an exit record", exitCode: 1 }, Number.MAX_SAFE_INTEGER);
      }
    }
    await this.store.orphanUnattached(new Set(this.active.keys()));
    this.pollTimer = setInterval(() => {
      for (const record of this.active.values()) this.poll(record).then(async () => {
        if (!this.active.has(record.sessionId) || Date.now() - Date.parse(record.createdAt) < 10_000 || Date.now() - (record.lastLivenessCheck ?? 0) < 5_000) return;
        record.lastLivenessCheck = Date.now();
        if (!await this.workerAlive(record)) {
          await this.finish(record, "run_failed", { error: "Executor exited without an exit record", exitCode: 1 }, Number.MAX_SAFE_INTEGER);
        }
      }).catch(() => {});
    }, 500);
    this.pollTimer.unref?.();
    return this;
  }

  async dispatch({ prompt, summary, cwd, sessionId, permissionMode = "acceptEdits", resume = false }) {
    if (!prompt?.trim() || !cwd?.trim()) throw new Error("prompt and cwd are required");
    if (resume && !sessionId) throw new Error("sessionId is required when resuming");
    if (sessionId && this.active.has(sessionId)) throw new Error(`Session is already running: ${sessionId}`);
    const finalSessionId = sessionId ?? randomUUID();
    const runId = randomUUID();
    const finalSummary = truncateSummary(summary || prompt);
    const runDir = join(this.workersDir, runId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const manifest = { sessionId: finalSessionId, runId, runDir, unitName: `cc-session-worker-${runId}.service`, createdAt: new Date().toISOString(), completed: false };
    const spec = {
      executable: this.executable, envFile: this.envFile, configDir: this.configDir, cwd,
      spoolPath: join(runDir, "raw.jsonl"), pidPath: join(runDir, "worker.pid"), snapshotIntervalMs: this.snapshotIntervalMs,
      args: [...this.baseArgs, "-p", prompt, "--output-format", "stream-json", "--include-partial-messages", "--include-hook-events", "--verbose", "--permission-mode", permissionMode, "--permission-prompts", "none", "--name", finalSummary,
        ...(this.settingsFile && existsSync(this.settingsFile) ? ["--settings", this.settingsFile] : []),
        ...(resume ? ["--resume", finalSessionId] : ["--session-id", finalSessionId])]
    };
    await atomicWriteJson(join(runDir, "manifest.json"), manifest);
    await atomicWriteJson(join(runDir, "spec.json"), spec);
    await this.store.append(finalSessionId, runId, "run_started", { summary: finalSummary, cwd, resume });
    const record = this.makeRecord(manifest);
    this.active.set(finalSessionId, record);
    try {
      if (this.launchMode === "systemd") {
        const result = spawnSync("systemd-run", ["--user", "--quiet", "--collect", `--unit=${manifest.unitName}`, `--working-directory=${cwd}`, process.execPath, WORKER_SCRIPT, join(runDir, "spec.json")], { encoding: "utf8", timeout: 10_000 });
        if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || `systemd-run exited ${result.status}`);
      } else {
        const child = spawn(process.execPath, [WORKER_SCRIPT, join(runDir, "spec.json")], { detached: true, stdio: "ignore" });
        child.unref();
      }
    } catch (error) {
      await this.finish(record, "run_failed", { error: `Could not start executor: ${error.message}`, exitCode: 1 }, Number.MAX_SAFE_INTEGER);
      throw error;
    }
    return { sessionId: finalSessionId, runId, summary: finalSummary, pid: null };
  }

  makeRecord(manifest) {
    const record = { ...manifest, offset: 0, pending: Buffer.alloc(0), polling: false, lastOutput: "", pendingResult: null, cancelRequested: false, done: null, resolveDone: null };
    record.done = new Promise((resolve) => { record.resolveDone = resolve; });
    return record;
  }

  async poll(record) {
    if (record.polling || !this.active.has(record.sessionId)) return;
    record.polling = true;
    try {
      const path = join(record.runDir, "raw.jsonl");
      let file;
      try { file = await open(path, "r"); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      try {
        const chunk = Buffer.allocUnsafe(64 * 1024);
        while (true) {
          const { bytesRead } = await file.read(chunk, 0, chunk.length, record.offset);
          if (!bytesRead) break;
          record.offset += bytesRead;
          record.pending = Buffer.concat([record.pending, chunk.subarray(0, bytesRead)]);
          let newline;
          while ((newline = record.pending.indexOf(10)) >= 0) {
            const line = record.pending.subarray(0, newline).toString("utf8");
            record.pending = record.pending.subarray(newline + 1);
            const entry = safeJsonParse(line);
            if (entry) await this.processEntry(record, entry);
          }
        }
      } finally { await file.close(); }
    } finally { record.polling = false; }
  }

  async processEntry(record, entry) {
    const eventSeq = (index = 0) => entry.seq * 1000 + index;
    if (entry.stream === "exit") {
      const type = record.cancelRequested ? "run_cancelled" : entry.code === 0 && record.pendingResult?.type !== "run_failed" ? "run_completed" : "run_failed";
      const result = record.pendingResult?.data || {};
      await this.finish(record, type, {
        exitCode: entry.code, signal: entry.signal,
        durationMs: result.durationMs, costUsd: result.costUsd, usage: result.usage,
        result: type === "run_completed" ? result.result ?? record.lastOutput : undefined,
        error: type === "run_failed" ? result.error || record.lastOutput || `Claude Code exited with code ${entry.code}` : undefined
      }, eventSeq());
      return;
    }
    if (entry.stream === "heartbeat") {
      await this.store.append(record.sessionId, record.runId, "progress_snapshot", { processId: entry.pid }, eventSeq());
      return;
    }
    if (entry.stream === "spawn_error") {
      record.pendingResult = { type: "run_failed", data: { error: entry.error } };
      return;
    }
    if (entry.stream === "stderr") {
      record.lastOutput = bounded(entry.line, 4_000);
      await this.store.append(record.sessionId, record.runId, "stderr", { text: entry.line }, eventSeq());
      return;
    }
    const message = safeJsonParse(entry.line);
    const events = message ? normalizeClaudeMessage(message) : [{ type: "stdout", data: { text: entry.line } }];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.data?.text || event.data?.output || event.data?.result) record.lastOutput = bounded(event.data.text ?? event.data.output ?? event.data.result, 4_000);
      if (event.type === "run_completed" || event.type === "run_failed") record.pendingResult = event;
      else await this.store.append(record.sessionId, record.runId, event.type, event.data, eventSeq(index));
    }
  }

  async finish(record, type, data, workerEventSeq) {
    await this.store.append(record.sessionId, record.runId, type, data, workerEventSeq);
    await atomicWriteJson(join(record.runDir, "manifest.json"), { sessionId: record.sessionId, runId: record.runId, runDir: record.runDir, unitName: record.unitName, createdAt: record.createdAt, completed: true });
    this.active.delete(record.sessionId);
    record.resolveDone?.({ status: type });
  }

  async workerAlive(record) {
    try { const pid = Number((await readFile(join(record.runDir, "worker.pid"), "utf8")).trim()); process.kill(pid, 0); return true; } catch { return false; }
  }

  async cancel(sessionId) {
    const record = this.active.get(sessionId);
    if (!record) throw new Error(`Session is not running: ${sessionId}`);
    record.cancelRequested = true;
    if (this.launchMode === "systemd") {
      const result = spawnSync("systemctl", ["--user", "stop", record.unitName], { encoding: "utf8", timeout: 10_000 });
      if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim());
    } else {
      const pid = Number((await readFile(join(record.runDir, "worker.pid"), "utf8")).trim());
      process.kill(pid, "SIGTERM");
    }
    await this.poll(record);
    if (this.active.has(sessionId)) await this.finish(record, "run_cancelled", {}, Number.MAX_SAFE_INTEGER);
    return { sessionId, status: "cancelled" };
  }

  waitFor(sessionId) { return this.active.get(sessionId)?.done ?? Promise.resolve(null); }
  stop() { clearInterval(this.pollTimer); }
}

function defaultEnvFile() {
  if (process.env.CC_MONITOR_ENV_FILE === "none") return null;
  if (process.env.CC_MONITOR_ENV_FILE) return process.env.CC_MONITOR_ENV_FILE;
  const candidate = join(homedir(), ".claude", "deepseek-key.sh");
  return existsSync(candidate) ? candidate : null;
}

function defaultSettingsFile() {
  const candidate = process.env.CC_MONITOR_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json");
  return existsSync(candidate) ? candidate : null;
}
