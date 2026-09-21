import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../src/daemon.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");

test("daemon authenticates RPC, dispatches work, and serves dashboard", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cc-monitor-daemon-"));
  const daemon = await startDaemon({ dataDir: dir, port: 0, startTray: false, runnerOptions: { mode: "direct", executable: process.execPath, baseArgs: [fixture], envFile: false, snapshotIntervalMs: 10 } });
  t.after(() => daemon.close());

  const unauthorized = await fetch(`http://${daemon.host}:${daemon.port}/api/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unauthorized.status, 401);

  const dashboard = await fetch(daemon.dashboardUrl);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /CC Session Monitor/);

  const rpc = async (method, params = {}) => {
    const response = await fetch(`http://${daemon.host}:${daemon.port}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ method, params })
    });
    return (await response.json()).result;
  };
  const started = await rpc("cc_dispatch", { prompt: "daemon test", summary: "Daemon test", cwd: dir });
  await daemon.service.runner.waitFor(started.sessionId);
  const sessions = await rpc("cc_get_sessions");
  assert.equal(sessions.snapshot.sessions[0].status, "completed");
  assert.equal(sessions.snapshot.settings.language, "en");
  await rpc("cc_update_settings", { language: "en" });
  assert.equal((await rpc("cc_get_sessions")).snapshot.settings.language, "en");
  assert.equal(sessions.dashboard_url, daemon.dashboardUrl);
});
