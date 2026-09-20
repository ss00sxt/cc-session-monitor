import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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

test("active sessions become orphaned after monitor restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-monitor-recover-"));
  const first = await new EventStore(dir).init();
  await first.append("s2", "r2", "run_started", { summary: "长任务", cwd: dir });
  const second = await new EventStore(dir).init();
  assert.equal(second.getSession("s2").status, "orphaned");
});
