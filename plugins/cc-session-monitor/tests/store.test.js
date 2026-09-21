import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventStore } from "../src/store.js";

test("event log reduces to a session snapshot and supports dismissal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-monitor-store-"));
  const store = await new EventStore(dir).init();
  await store.append("s1", "r1", "run_started", { summary: "这是一个超过二十个汉字的任务概述用于测试截断行为", cwd: dir });
  await store.append("s1", "r1", "tool_started", { tool: "Bash", summary: "npm test" });
  await store.append("s1", "r1", "tool_completed", { output: "all good" });
  await store.append("s1", "r1", "run_completed", { result: "done", exitCode: 0 });

  const session = store.getSession("s1");
  assert.equal(Array.from(session.summary).length, 20);
  assert.equal(Array.from(session.summary).at(-1), "…");
  assert.equal(session.status, "completed");
  assert.equal(session.runs.length, 1);
  assert.equal((await store.events({ sessionId: "s1" })).length, 4);

  await store.dismiss("s1");
  assert.equal(store.snapshot().sessions.length, 0);
  assert.equal(store.snapshot({ includeDismissed: true }).sessions.length, 1);

  await store.append("s1", "local-s1", "external_prompt", { summary: "继续同一会话" });
  assert.equal(store.snapshot().sessions.length, 1);
  assert.equal(store.getSession("s1").dismissed, false);
  assert.equal(store.getSession("s1").status, "generating");
});

test("restart preserves active sessions until the executor can be reattached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-monitor-recover-"));
  const first = await new EventStore(dir).init();
  await first.append("s2", "r2", "run_started", { summary: "长任务", cwd: dir });
  const second = await new EventStore(dir).init();
  assert.equal(second.getSession("s2").status, "running");
  await second.orphanUnattached(new Set(["s2"]));
  assert.equal(second.getSession("s2").status, "running");
  await second.orphanUnattached(new Set());
  assert.equal(second.getSession("s2").status, "orphaned");
});

test("resumed activity clears a stale completion timestamp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-monitor-stale-time-"));
  const store = await new EventStore(dir).init();
  await store.append("s3", "r3", "run_started", { summary: "task", cwd: dir });
  await store.append("s3", "r3", "run_completed", { result: "intermediate", exitCode: 0 });
  assert.ok(store.getSession("s3").completedAt);
  await store.append("s3", "r3", "tool_started", { tool: "Bash", summary: "echo later" });
  assert.equal(store.getSession("s3").status, "tool_running");
  assert.equal(store.getSession("s3").completedAt, null);
});

test("restart recovers events written before a state checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-monitor-checkpoint-"));
  const first = await new EventStore(dir).init();
  await first.append("s4", "r4", "run_started", { summary: "recover" });
  const checkpoint = await readFile(join(dir, "state.json"), "utf8");
  await first.append("s4", "r4", "assistant_message", { text: "late output" }, 1000);
  await writeFile(join(dir, "state.json"), checkpoint);
  const second = await new EventStore(dir).init();
  assert.equal(second.getSession("s4").lastOutput, "late output");
  assert.equal(second.state.workerEventSeq.r4, 1000);
  assert.equal(await second.append("s4", "r4", "assistant_message", { text: "late output" }, 1000), null);
  assert.equal((await second.events({ sessionId: "s4" })).length, 2);
});
