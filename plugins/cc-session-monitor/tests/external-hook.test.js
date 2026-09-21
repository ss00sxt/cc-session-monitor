import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../src/daemon.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hook = join(root, "clients", "claude_hook.py");
const installer = join(root, "scripts", "install_claude_hooks.py");

async function sendHook(dataDir, payload) {
  await new Promise((resolve, reject) => {
    const child = spawn("python3", [hook], { env: { ...process.env, CC_MONITOR_DATA_DIR: dataDir }, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `hook exited ${code}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("Claude Code hooks register manual sessions without duplicating managed runs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cc-monitor-hook-"));
  const daemon = await startDaemon({ dataDir: dir, port: 0, startTray: false });
  t.after(() => daemon.close());

  const base = { session_id: "manual-session", cwd: dir, transcript_path: join(dir, "transcript.jsonl") };
  await sendHook(dir, { ...base, hook_event_name: "SessionStart", source: "startup", model: "deepseek-flash" });
  await sendHook(dir, { ...base, hook_event_name: "UserPromptSubmit", prompt: "实现登录功能并补充完整测试，然后更新文档和发布说明" });
  await sendHook(dir, { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: "README.md" } });
  await sendHook(dir, { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: "README.md" }, tool_response: "contents" });
  await sendHook(dir, { ...base, hook_event_name: "MessageDisplay", turn_id: "turn-1", message_id: "m1", index: 0, final: true, delta: "完成登录功能" });
  await sendHook(dir, { ...base, hook_event_name: "Stop", turn_id: "turn-1", last_assistant_message: "完成登录功能" });
  await sendHook(dir, { ...base, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });

  const session = daemon.service.store.getSession("manual-session");
  assert.equal(session.source, "local");
  assert.equal(session.status, "completed");
  assert.equal(Array.from(session.summary).length, 20);
  assert.equal(Array.from(session.summary).at(-1), "…");
  assert.equal(session.lastOutput, "完成登录功能");

  await sendHook(dir, { ...base, hook_event_name: "SessionStart" , source: "startup" });
  const before = daemon.service.store.state.lastSeq;
  const managed = spawnSync("python3", [hook], {
    input: JSON.stringify({ ...base, session_id: "managed-session", hook_event_name: "SessionStart" }),
    encoding: "utf8",
    env: { ...process.env, CC_MONITOR_DATA_DIR: dir, CC_SESSION_MONITOR_MANAGED: "1" }
  });
  assert.equal(managed.status, 0);
  assert.equal(daemon.service.store.state.lastSeq, before);
});

test("hook installer preserves existing hooks and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-monitor-settings-"));
  const settings = join(dir, "settings.json");
  await writeFile(settings, JSON.stringify({ env: { EXAMPLE: "1" }, hooks: { Notification: [{ matcher: "", hooks: [{ type: "command", command: "notify-send test" }] }] } }));
  for (let index = 0; index < 2; index += 1) {
    const result = spawnSync("python3", [installer, "--settings", settings], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const parsed = JSON.parse(await readFile(settings, "utf8"));
  assert.equal(parsed.env.EXAMPLE, "1");
  assert.equal(parsed.hooks.Notification.length, 1);
  assert.equal(parsed.hooks.SessionStart.length, 1);
  assert.equal(parsed.hooks.MessageDisplay[0].hooks[0].async, undefined);
  assert.equal(parsed.hooks.PreToolUse[0].hooks[0].async, true);
});

test("manual Claude Code hooks reconnect to the same session after monitor restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cc-monitor-hook-restart-"));
  let daemon = await startDaemon({ dataDir: dir, port: 0, startTray: false });
  t.after(async () => { await daemon?.close(); });
  const base = { session_id: "still-running-manual", cwd: dir, transcript_path: join(dir, "transcript.jsonl") };
  await sendHook(dir, { ...base, hook_event_name: "SessionStart", source: "startup" });
  await sendHook(dir, { ...base, hook_event_name: "UserPromptSubmit", prompt: "Keep working across monitor restart" });
  const before = daemon.service.store.state.lastSeq;
  await daemon.close();
  daemon = null;
  daemon = await startDaemon({ dataDir: dir, port: 0, startTray: false });
  assert.equal(daemon.service.store.getSession(base.session_id).status, "generating");
  await sendHook(dir, { ...base, hook_event_name: "MessageDisplay", turn_id: "turn-1", message_id: "m1", index: 0, final: true, delta: "Task continues" });
  assert.equal(daemon.service.store.state.lastSeq, before + 1);
  assert.equal(daemon.service.store.getSession(base.session_id).lastOutput, "Task continues");
  assert.equal(daemon.service.store.snapshot().sessions.filter((session) => session.sessionId === base.session_id).length, 1);
});
