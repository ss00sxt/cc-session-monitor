import { stat } from "node:fs/promises";
import { join } from "node:path";
import { EventStore } from "./store.js";
import { ClaudeRunner } from "./runner.js";
import { atomicWriteJson, readJson } from "./utils.js";

const PERMISSION_MODES = new Set(["acceptEdits", "auto", "dontAsk", "manual", "plan"]);
const LANGUAGES = new Set(["en", "zh-CN"]);

export class MonitorService {
  constructor({ dataDir, runnerOptions = {} }) {
    this.store = new EventStore(dataDir);
    this.settingsPath = join(dataDir, "settings.json");
    this.settings = { language: "en" };
    this.runnerOptions = runnerOptions;
    this.runner = null;
  }

  async init() {
    await this.store.init();
    const saved = await readJson(this.settingsPath, {});
    if (LANGUAGES.has(saved?.language)) this.settings.language = saved.language;
    this.runner = new ClaudeRunner({ store: this.store, ...this.runnerOptions });
    return this;
  }

  async call(method, params = {}) {
    switch (method) {
      case "cc_dispatch":
        return this.dispatch(params, false);
      case "cc_resume":
        return this.dispatch(params, true);
      case "cc_get_sessions":
        return { snapshot: this.snapshot(Boolean(params.include_dismissed)) };
      case "cc_get_events":
        return { events: await this.store.events({ sessionId: params.session_id, afterSeq: Number(params.after_seq || 0), limit: Number(params.limit || 500) }) };
      case "cc_cancel":
        return this.runner.cancel(required(params.session_id, "session_id"));
      case "cc_dismiss":
        return { session: await this.store.dismiss(required(params.session_id, "session_id")) };
      case "cc_render_monitor":
        return { snapshot: this.snapshot() };
      case "cc_update_settings":
        return this.updateSettings(params);
      case "cc_external_event":
        return this.externalEvent(params);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  snapshot(includeDismissed = false) {
    return { ...this.store.snapshot({ includeDismissed }), settings: { ...this.settings } };
  }

  async updateSettings(params) {
    if (!LANGUAGES.has(params.language)) throw new Error("language must be en or zh-CN");
    this.settings = { ...this.settings, language: params.language };
    await atomicWriteJson(this.settingsPath, this.settings);
    return { settings: { ...this.settings } };
  }

  async externalEvent(params) {
    const sessionId = required(params.session_id, "session_id");
    const eventName = required(params.event_name, "event_name");
    const data = { ...(params.data || {}), source: "local", cwd: params.cwd || params.data?.cwd };
    const mapping = {
      SessionStart: "external_session_started",
      UserPromptSubmit: "external_prompt",
      MessageDisplay: "external_message",
      PreToolUse: "tool_started",
      PostToolUse: "tool_completed",
      PostToolUseFailure: "tool_completed",
      Stop: "external_turn_completed",
      StopFailure: "external_turn_failed",
      SessionEnd: "external_session_ended"
    };
    const type = mapping[eventName];
    if (!type) throw new Error(`Unsupported external event: ${eventName}`);
    await this.store.append(sessionId, params.run_id || null, type, data);
    return { accepted: true, sessionId, type };
  }

  async dispatch(params, resume) {
    const prompt = required(params.prompt, "prompt");
    const sessionId = resume ? required(params.session_id, "session_id") : undefined;
    const previous = sessionId ? this.store.getSession(sessionId) : null;
    if (resume && !previous) throw new Error(`Unknown session: ${sessionId}`);
    const cwd = params.cwd || previous?.cwd || process.cwd();
    const info = await stat(cwd).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
    const permissionMode = params.permission_mode || "acceptEdits";
    if (!PERMISSION_MODES.has(permissionMode)) throw new Error(`Unsupported permission mode: ${permissionMode}`);
    return this.runner.dispatch({
      prompt,
      summary: params.summary || previous?.summary,
      cwd,
      sessionId,
      permissionMode,
      resume
    });
  }
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}
