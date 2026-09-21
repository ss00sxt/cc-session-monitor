import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ACTIVE_STATES, TERMINAL_STATES, atomicWriteJson, bounded, nowIso, readJson, truncateSummary } from "./utils.js";

function emptyState() {
  return { schemaVersion: 1, revision: 0, lastSeq: 0, sessions: {}, workerEventSeq: {} };
}

export class EventStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.eventsPath = join(dataDir, "events.jsonl");
    this.statePath = join(dataDir, "state.json");
    this.state = emptyState();
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    this.state = await readJson(this.statePath, emptyState());
    this.state.workerEventSeq ??= {};
    // The process can die after appending an event but before checkpointing
    // state.json. Rebuild that tail first so worker replay cannot duplicate it.
    let log = "";
    try { log = await readFile(this.eventsPath, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    for (const line of log.split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.seq <= this.state.lastSeq) continue;
      this.reduce(event);
      this.state.lastSeq = event.seq;
      this.state.revision += 1;
      if (event.workerEventSeq != null) this.state.workerEventSeq[event.runId] = event.workerEventSeq;
    }
    await this.persist();
    return this;
  }

  append(sessionId, runId, type, data = {}, workerEventSeq = null) {
    const operation = async () => {
      if (workerEventSeq !== null && workerEventSeq <= (this.state.workerEventSeq[runId] ?? 0)) return null;
      const event = {
        seq: ++this.state.lastSeq,
        timestamp: nowIso(),
        sessionId,
        runId: runId ?? null,
        type,
        data: sanitizeData(data),
        ...(workerEventSeq === null ? {} : { workerEventSeq })
      };
      await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      this.reduce(event);
      if (workerEventSeq !== null) this.state.workerEventSeq[runId] = workerEventSeq;
      this.state.revision += 1;
      await this.persist();
      return event;
    };
    this.queue = this.queue.then(operation, operation);
    return this.queue;
  }

  reduce(event) {
    const { sessionId, runId, type, data, timestamp } = event;
    let session = this.state.sessions[sessionId];
    if (!session) {
      session = this.state.sessions[sessionId] = {
        sessionId,
        summary: truncateSummary(data.summary),
        source: data.source ?? "managed",
        cwd: data.cwd ?? null,
        status: "starting",
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        lastOutput: "",
        activeTool: null,
        activeToolSummary: null,
        heartbeatAt: timestamp,
        dismissed: false,
        currentRunId: runId,
        runs: []
      };
    }

    session.updatedAt = timestamp;
    session.heartbeatAt = timestamp;
    session.currentRunId = runId ?? session.currentRunId;
    if (data.cwd) session.cwd = data.cwd;

    let run = session.runs.find((item) => item.runId === runId);
    if (runId && !run) {
      run = { runId, startedAt: timestamp, completedAt: null, status: "starting", exitCode: null };
      session.runs.push(run);
    }

    switch (type) {
      case "run_started":
        if (data.summary) session.summary = truncateSummary(data.summary);
        session.source = data.source ?? session.source ?? "managed";
        session.dismissed = false;
        session.status = "running";
        session.completedAt = null;
        if (run) run.status = "running";
        break;
      case "external_session_started":
        session.source = "local";
        session.dismissed = false;
        session.status = "running";
        session.completedAt = null;
        if (data.summary) session.summary = truncateSummary(data.summary);
        if (run) run.status = "running";
        break;
      case "external_prompt":
        session.source = "local";
        session.dismissed = false;
        session.status = "generating";
        session.completedAt = null;
        if (data.summary) session.summary = truncateSummary(data.summary);
        if (run) run.status = "running";
        break;
      case "external_message":
        session.source = "local";
        session.status = data.final ? "running" : "generating";
        if (data.text) session.lastOutput = bounded(data.text, 4_000);
        break;
      case "external_turn_completed":
        session.source = "local";
        session.status = "idle";
        if (data.output) session.lastOutput = bounded(data.output, 4_000);
        if (run) {
          run.status = "completed";
          run.completedAt = timestamp;
          run.exitCode = 0;
        }
        break;
      case "external_turn_failed":
        session.source = "local";
        session.status = "idle_error";
        if (data.error) session.lastOutput = bounded(data.error, 4_000);
        if (run) {
          run.status = "failed";
          run.completedAt = timestamp;
          run.exitCode = 1;
        }
        break;
      case "external_session_ended":
        session.source = "local";
        session.status = "completed";
        session.completedAt = timestamp;
        session.activeTool = null;
        session.activeToolSummary = null;
        if (data.output) session.lastOutput = bounded(data.output, 4_000);
        if (run && !run.completedAt) {
          run.status = "completed";
          run.completedAt = timestamp;
          run.exitCode = 0;
        }
        break;
      case "model_status":
        session.status = mapModelStatus(data.status);
        break;
      case "text_delta":
      case "assistant_message":
      case "stderr":
        session.lastOutput = bounded(data.text ?? data.output ?? "", 4_000);
        if (!session.activeTool) session.status = "generating";
        break;
      case "tool_started":
        session.status = "tool_running";
        session.activeTool = data.tool ?? "tool";
        session.activeToolSummary = bounded(data.summary ?? data.input ?? "", 500);
        break;
      case "tool_completed":
        session.status = "running";
        session.activeTool = null;
        session.activeToolSummary = null;
        if (data.output) session.lastOutput = bounded(data.output, 4_000);
        break;
      case "permission_requested":
        session.status = "waiting_permission";
        session.activeToolSummary = bounded(data.summary ?? "Waiting for permission", 500);
        break;
      case "progress_snapshot":
        if (data.output) session.lastOutput = bounded(data.output, 4_000);
        break;
      case "run_completed":
        session.status = "completed";
        session.completedAt = timestamp;
        session.activeTool = null;
        session.activeToolSummary = null;
        if (data.result) session.lastOutput = bounded(data.result, 4_000);
        if (run) Object.assign(run, { status: "completed", completedAt: timestamp, exitCode: data.exitCode ?? 0 });
        break;
      case "run_failed":
        session.status = "failed";
        session.completedAt = timestamp;
        session.activeTool = null;
        session.activeToolSummary = null;
        if (data.error) session.lastOutput = bounded(data.error, 4_000);
        if (run) Object.assign(run, { status: "failed", completedAt: timestamp, exitCode: data.exitCode ?? 1 });
        break;
      case "run_cancelled":
        session.status = "cancelled";
        session.completedAt = timestamp;
        session.activeTool = null;
        session.activeToolSummary = null;
        if (run) Object.assign(run, { status: "cancelled", completedAt: timestamp, exitCode: data.exitCode ?? null });
        break;
      case "session_dismissed":
        session.dismissed = true;
        break;
      default:
        break;
    }
    if (!TERMINAL_STATES.has(session.status)) session.completedAt = null;
  }

  async persist() {
    await atomicWriteJson(this.statePath, this.state);
  }

  snapshot({ includeDismissed = false } = {}) {
    const sessions = Object.values(this.state.sessions)
      .filter((session) => includeDismissed || !session.dismissed)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { schemaVersion: 1, revision: this.state.revision, lastSeq: this.state.lastSeq, sessions };
  }

  getSession(sessionId) {
    return this.state.sessions[sessionId] ?? null;
  }

  async orphanUnattached(activeSessionIds) {
    for (const session of Object.values(this.state.sessions)) {
      if (session.source !== "managed" || !ACTIVE_STATES.has(session.status) || activeSessionIds.has(session.sessionId)) continue;
      session.status = "orphaned";
      session.updatedAt = nowIso();
      session.completedAt = session.updatedAt;
      session.lastOutput = "Monitor restarted without an attachable executor";
    }
    await this.persist();
  }

  async events({ sessionId, afterSeq = 0, limit = 500 } = {}) {
    let content;
    try {
      content = await readFile(this.eventsPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return content.split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.seq > afterSeq && (!sessionId || event.sessionId === sessionId))
      .slice(-Math.min(Math.max(limit, 1), 2_000));
  }

  async dismiss(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (!TERMINAL_STATES.has(session.status)) throw new Error("Only finished sessions can be dismissed");
    await this.append(sessionId, session.currentRunId, "session_dismissed");
    return this.getSession(sessionId);
  }
}

function mapModelStatus(status) {
  if (status === "requesting" || status === "thinking") return "generating";
  if (status === "waiting_for_permission") return "waiting_permission";
  return "running";
}

function sanitizeData(data) {
  const result = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      result[key] = bounded(value);
      continue;
    }
    if (value && typeof value === "object") {
      const serialized = bounded(value);
      try {
        result[key] = JSON.parse(serialized);
      } catch {
        result[key] = serialized;
      }
      continue;
    }
    result[key] = value;
  }
  return result;
}
