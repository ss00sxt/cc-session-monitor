const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const sessionId = value("--session-id") || value("--resume") || "fake-session";
const prompt = value("-p") || "";
const emit = (value) => process.stdout.write(`${JSON.stringify({ ...value, session_id: value.session_id || sessionId })}\n`);

emit({ type: "system", subtype: "init", cwd: process.cwd(), model: "fake-model", claude_code_version: "test" });
emit({ type: "system", subtype: "status", status: "requesting" });
if (prompt.includes("PERSIST_WORKER")) await new Promise((resolve) => setTimeout(resolve, 1800));
await new Promise((resolve) => setTimeout(resolve, 15));
emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "正在分析" } } });
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }] } });
emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file contents" }] } });

if (prompt.includes("IDLE_HEARTBEAT") || prompt.includes("ACTIVE_NO_HEARTBEAT")) {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `update ${index}` } } });
  }
  if (prompt.includes("IDLE_HEARTBEAT")) await new Promise((resolve) => setTimeout(resolve, 70));
}

if (prompt.includes("EARLY_RESULT")) {
  emit({ type: "result", is_error: false, terminal_reason: "success", result: "intermediate result", duration_ms: 20 });
  await new Promise((resolve) => setTimeout(resolve, 45));
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "late-tool", name: "Bash", input: { command: "echo later" } }] } });
  await new Promise((resolve) => setTimeout(resolve, 45));
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "late-tool", content: "later" }] } });
} else if (prompt.includes("FAIL")) {
  emit({ type: "result", is_error: true, terminal_reason: "api_error", result: "simulated failure", duration_ms: 20, total_cost_usd: 0 });
  process.exitCode = 1;
} else {
  emit({ type: "assistant", message: { content: [{ type: "text", text: `完成：${prompt}` }] } });
  emit({ type: "result", is_error: false, terminal_reason: "success", result: `完成：${prompt}`, duration_ms: 20, total_cost_usd: 0 });
}
