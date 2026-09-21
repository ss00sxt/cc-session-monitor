import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../src/daemon.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");
const waitUntil = async (condition, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for worker state");
};

test("a systemd worker survives monitor shutdown and its output is replayed exactly once", { timeout: 12_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "cc-monitor-durable-"));
  const runnerOptions = { executable: process.execPath, baseArgs: [fixture], envFile: false, settingsFile: false, snapshotIntervalMs: 100 };
  let daemon = await startDaemon({ dataDir, port: 0, startTray: false, runnerOptions });
  t.after(async () => { await daemon?.close(); });
  const { sessionId, runId } = await daemon.service.dispatch({ prompt: "PERSIST_WORKER", cwd: dataDir });
  const workerPid = await waitUntil(async () => {
    try { return Number((await readFile(join(dataDir, "workers", runId, "worker.pid"), "utf8")).trim()); } catch { return null; }
  });
  const cgroup = await readFile(`/proc/${workerPid}/cgroup`, "utf8");
  assert.match(cgroup, new RegExp(`cc-session-worker-${runId}`));
  await daemon.close();
  daemon = null;
  process.kill(workerPid, 0);
  await new Promise((resolve) => setTimeout(resolve, 250));
  daemon = await startDaemon({ dataDir, port: 0, startTray: false, runnerOptions });
  assert.notEqual(daemon.service.store.getSession(sessionId).status, "orphaned");
  await waitUntil(() => daemon.service.store.getSession(sessionId).status === "completed", 5000);
  const events = await daemon.service.store.events({ sessionId });
  assert.equal(events.filter((event) => event.type === "run_completed").length, 1);
  assert.equal(events.filter((event) => event.type === "run_started").length, 1);
  assert.ok(events.some((event) => event.type === "assistant_message"));
  await daemon.close();
  daemon = await startDaemon({ dataDir, port: 0, startTray: false, runnerOptions });
  const replayed = await daemon.service.store.events({ sessionId });
  assert.equal(replayed.length, events.length);
});
