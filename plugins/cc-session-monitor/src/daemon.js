#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MonitorService } from "./service.js";
import { atomicWriteJson, createToken } from "./utils.js";
import { renderMonitorHtml } from "./ui.js";

const DEFAULT_DATA_DIR = resolve(join(homedir(), ".local", "state", "cc-session-monitor"));
const DATA_DIR = resolve(argValue("--data-dir") || process.env.PLUGIN_DATA || process.env.CC_MONITOR_DATA_DIR || DEFAULT_DATA_DIR);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(MODULE_DIR);

export async function startDaemon({ dataDir = DATA_DIR, port = process.env.CC_MONITOR_PORT ? Number(process.env.CC_MONITOR_PORT) : undefined, host = "127.0.0.1", runnerOptions = {}, startTray = process.env.CC_MONITOR_TRAY !== "0" } = {}) {
  port ??= resolve(dataDir) === DEFAULT_DATA_DIR ? 47653 : 0;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const token = await loadOrCreateToken(join(dataDir, "token"));
  const service = await new MonitorService({ dataDir, runnerOptions }).init();
  let dashboardUrl = null;

  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
        response.end(renderMonitorHtml({ mode: "dashboard", token }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        requireAuth(request, token);
        json(response, 200, { ok: true, pid: process.pid });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/rpc") {
        requireAuth(request, token);
        const body = await readBody(request);
        const result = await service.call(body.method, body.params || {});
        json(response, 200, { result: { ...result, dashboard_url: dashboardUrl } });
        return;
      }
      json(response, 404, { error: { message: "Not found" } });
    } catch (error) {
      json(response, error?.statusCode || 400, { error: { message: error?.message || String(error) } });
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  dashboardUrl = `http://${host}:${actualPort}/`;
  await atomicWriteJson(join(dataDir, "daemon.json"), { pid: process.pid, host, port: actualPort, startedAt: new Date().toISOString() });
  if (startTray) await maybeStartLinuxTray(dataDir);

  const close = async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
  };
  return { server, service, token, host, port: actualPort, dashboardUrl, close };
}

function requireAuth(request, token) {
  if (request.headers.authorization !== `Bearer ${token}`) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function loadOrCreateToken(path) {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const token = createToken();
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return token;
}

async function maybeStartLinuxTray(dataDir) {
  if (process.platform !== "linux" || !process.env.DISPLAY) return;
  const pidPath = join(dataDir, "tray-linux.pid");
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    if (pid > 0) {
      process.kill(pid, 0);
      const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (commandLine.includes("linux_tray.py") && commandLine.includes(dataDir)) return;
    }
  } catch {
    // Missing or stale PID: start a new platform shell.
  }
  const child = spawn("python3", [
    join(PLUGIN_ROOT, "clients", "linux_tray.py"),
    "--data-dir", dataDir,
    "--plugin-root", PLUGIN_ROOT
  ], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startDaemon().catch((error) => {
    process.stderr.write(`cc-session-monitor daemon failed: ${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
