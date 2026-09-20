import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./utils.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function defaultDataDir() {
  return resolve(process.env.PLUGIN_DATA || process.env.CC_MONITOR_DATA_DIR || join(homedir(), ".local", "state", "cc-session-monitor"));
}

export class DaemonClient {
  constructor({ dataDir = defaultDataDir(), startTimeoutMs = 10_000 } = {}) {
    this.dataDir = dataDir;
    this.startTimeoutMs = startTimeoutMs;
    this.connection = null;
  }

  async ensure() {
    if (this.connection && await this.health(this.connection)) return this.connection;
    const existing = await this.readConnection();
    if (existing && await this.health(existing)) {
      this.connection = existing;
      return existing;
    }

    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, [join(MODULE_DIR, "daemon.js"), "--data-dir", this.dataDir], {
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const candidate = await this.readConnection();
      if (candidate && await this.health(candidate)) {
        this.connection = candidate;
        return candidate;
      }
    }
    throw new Error("CC Session Monitor daemon did not start within 10 seconds");
  }

  async call(method, params = {}) {
    const connection = await this.ensure();
    const response = await fetch(`${connection.baseUrl}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ method, params })
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error?.message || response.statusText);
    return body.result;
  }

  async readConnection() {
    try {
      const [info, token] = await Promise.all([
        readJson(join(this.dataDir, "daemon.json")),
        readFile(join(this.dataDir, "token"), "utf8")
      ]);
      if (!info?.port || !token.trim()) return null;
      return { ...info, token: token.trim(), baseUrl: `http://${info.host || "127.0.0.1"}:${info.port}` };
    } catch {
      return null;
    }
  }

  async health(connection) {
    try {
      const response = await fetch(`${connection.baseUrl}/health`, {
        headers: { authorization: `Bearer ${connection.token}` },
        signal: AbortSignal.timeout(800)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
