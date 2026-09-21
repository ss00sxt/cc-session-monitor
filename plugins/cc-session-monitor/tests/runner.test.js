import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { EventStore } from "../src/store.js";
import { ClaudeRunner, normalizeClaudeMessage } from "../src/runner.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cc-monitor-runner-"));
  const store = await new EventStore(dir).init();
  const runner = new ClaudeRunner({ store, executable: process.execPath, baseArgs: [fixture], envFile: false, snapshotIntervalMs: 10 });
  return { dir, store, runner };
}

test("runner captures text, tools, result, and reuses a resumed session row", async () => {
  const { dir, store, runner } = await setup();
  const first = await runner.dispatch({ prompt: "first", summary: "第一次执行", cwd: dir });
  await runner.waitFor(first.sessionId);
  assert.equal(store.getSession(first.sessionId).status, "completed");

  const second = await runner.dispatch({ prompt: "second", summary: "第二次执行", cwd: dir, sessionId: first.sessionId, resume: true });
  await runner.waitFor(second.sessionId);
  const session = store.getSession(first.sessionId);
  assert.equal(store.snapshot().sessions.length, 1);
  assert.equal(session.runs.length, 2);
  assert.equal(session.summary, "第二次执行");
  assert.match(session.lastOutput, /完成：second/);
  const types = (await store.events({ sessionId: first.sessionId })).map((event) => event.type);
  assert.ok(types.includes("tool_started"));
  assert.ok(types.includes("tool_completed"));
  assert.ok(types.includes("progress_snapshot"));
});

test("runner reports a failed result", async () => {
  const { dir, store, runner } = await setup();
  const run = await runner.dispatch({ prompt: "FAIL", summary: "失败测试", cwd: dir });
  await runner.waitFor(run.sessionId);
  assert.equal(store.getSession(run.sessionId).status, "failed");
  assert.match(store.getSession(run.sessionId).lastOutput, /simulated failure/);
});

test("progress heartbeat appears only after inactivity and does not repeat output", async () => {
  const { dir, store, runner } = await setup();
  runner.snapshotIntervalMs = 40;
  const active = await runner.dispatch({ prompt: "ACTIVE_NO_HEARTBEAT", summary: "active", cwd: dir });
  await runner.waitFor(active.sessionId);
  assert.equal((await store.events({ sessionId: active.sessionId })).filter((event) => event.type === "progress_snapshot").length, 0);

  const idle = await runner.dispatch({ prompt: "IDLE_HEARTBEAT", summary: "idle", cwd: dir });
  await runner.waitFor(idle.sessionId);
  const snapshots = (await store.events({ sessionId: idle.sessionId })).filter((event) => event.type === "progress_snapshot");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].data.output, undefined);
  assert.ok(snapshots[0].data.processId);
});

test("message normalizer never exposes thinking text", () => {
  const events = normalizeClaudeMessage({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private reasoning" } } });
  assert.deepEqual(events, [{ type: "model_status", data: { status: "thinking" } }]);
});
