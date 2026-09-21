#!/usr/bin/env node
// A Claude Code run lives in its own user service, never in the monitor unit.
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import readline from "node:readline";
import { redact } from "./utils.js";

const specPath = process.argv[2];
if (!specPath) throw new Error("worker spec path is required");
const spec = JSON.parse(readFileSync(specPath, "utf8"));
unlinkSync(specPath);
writeFileSync(spec.pidPath, `${process.pid}\n`, { mode: 0o600 });
let seq = 0;
let lastActivityAt = Date.now();
let child;
let done = false;
const write = (stream, payload = {}) => {
  appendFileSync(spec.spoolPath, `${JSON.stringify({ seq: ++seq, stream, ...payload })}\n`, { mode: 0o600 });
};
const activity = () => { lastActivityAt = Date.now(); };
const interval = setInterval(() => {
  if (!done && Date.now() - lastActivityAt >= spec.snapshotIntervalMs) {
    write("heartbeat", { pid: child?.pid ?? null });
    activity();
  }
}, Math.min(spec.snapshotIntervalMs, 1000));

const env = { ...process.env, CLAUDE_CONFIG_DIR: spec.configDir, CC_SESSION_MONITOR_MANAGED: "1" };
const common = { cwd: spec.cwd, env, stdio: ["ignore", "pipe", "pipe"] };
if (spec.envFile) {
  child = spawn("/bin/bash", ["-c", 'source "$1"; shift; exec "$@"', "cc-session-monitor", spec.envFile, spec.executable, ...spec.args], common);
} else {
  child = spawn(spec.executable, spec.args, common);
}
for (const [stream, input] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
  const lines = readline.createInterface({ input });
  lines.on("line", (line) => {
    write(stream, { line: redact(line) });
    if (stream === "stderr" || /"(?:text_delta|tool_use|tool_result|assistant|user)"/.test(line)) activity();
  });
}
child.once("error", (error) => write("spawn_error", { error: error.message }));
child.once("close", (code, signal) => {
  done = true;
  clearInterval(interval);
  write("exit", { code, signal });
  process.exitCode = code ?? 1;
});
process.on("SIGTERM", () => child?.kill("SIGTERM"));
