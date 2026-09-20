import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);
export const ACTIVE_STATES = new Set(["starting", "running", "generating", "tool_running", "waiting_permission", "cancelling"]);

export function nowIso() {
  return new Date().toISOString();
}

export function truncateSummary(value, max = 20) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim() || "Claude Code task";
  const chars = Array.from(normalized);
  if (chars.length <= max) return normalized;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  return `${chars.slice(0, max - 1).join("")}…`;
}

export function redact(value) {
  return String(value ?? "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api|auth)[_-]?key\s*[:=]\s*)[^\s"']+/gi, "$1[REDACTED]");
}

export function bounded(value, max = 32_000) {
  const text = redact(typeof value === "string" ? value : JSON.stringify(value));
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

export function createToken() {
  return randomBytes(24).toString("base64url");
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
