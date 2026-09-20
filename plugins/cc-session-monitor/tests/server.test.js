import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/server.js";
import { renderMonitorHtml } from "../src/ui.js";

test("MCP server advertises monitor tools and UI resource", async () => {
  const initialized = await handleRequest({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(initialized.result.serverInfo.name, "cc-session-monitor");

  const listed = await handleRequest({ id: 2, method: "tools/list" });
  assert.ok(listed.result.tools.some((tool) => tool.name === "cc_dispatch"));
  assert.equal(listed.result.tools.find((tool) => tool.name === "cc_dispatch")._meta.ui.resourceUri, "ui://cc-session-monitor/monitor.html");

  const resource = await handleRequest({ id: 3, method: "resources/read", params: { uri: "ui://cc-session-monitor/monitor.html" } });
  assert.equal(resource.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.result.contents[0].text, /CC Session Monitor/);
  assert.match(resource.result.contents[0].text, /after_seq:state\.lastSeq/);
  assert.match(resource.result.contents[0].text, /模型思考中/);
  assert.match(resource.result.contents[0].text, /English/);
  assert.match(resource.result.contents[0].text, /function renderMarkdown/);
  assert.match(resource.result.contents[0].text, /toolUseId/);
  assert.match(resource.result.contents[0].text, /tool-group/);
  assert.match(resource.result.contents[0].text, /prompt collapsed/);
  assert.match(resource.result.contents[0].text, /<svg class="icon"/);
  assert.match(resource.result.contents[0].text, /const answerIcon=/);
  assert.match(resource.result.contents[0].text, /const resultIcon=/);
  assert.match(resource.result.contents[0].text, /resultTime\.textContent=stamp\(e\)/);
  assert.match(resource.result.contents[0].text, /cubic-bezier\(\.16,1,\.3,1\)/);
  assert.match(resource.result.contents[0].text, /translateY\(-8px\)/);
  assert.match(resource.result.contents[0].text, /details::-webkit-scrollbar-track\{margin-block:2px 4px\}/);
  assert.match(resource.result.contents[0].text, /M9\.6 7h4\.8M9\.8 9\.5h4\.4/);
  assert.match(resource.result.contents[0].text, /-webkit-line-clamp:5/);
  assert.match(resource.result.contents[0].text, /d\.prompt\|\|text\|\|d\.summary/);
  assert.match(resource.result.contents[0].text, /tool-group\.expanded \.tool-summary/);
  assert.match(resource.result.contents[0].text, /class="session-card"/);
  assert.match(resource.result.contents[0].text, /class="session-id"/);
  assert.doesNotMatch(resource.result.contents[0].text, /createBadge\('(?:instruction|tool|result)'\)/);
  assert.doesNotMatch(resource.result.contents[0].text, /m5 4 15 15/);
  assert.doesNotMatch(resource.result.contents[0].text, /状态每秒更新|Status updates every second/);
  assert.doesNotMatch(resource.result.contents[0].text, /setInterval\(render/);
  assert.doesNotMatch(resource.result.contents[0].text, /grid-template-columns:64px 105px/);
  assert.doesNotMatch(resource.result.contents[0].text, /class="event /);
});

test("browser dashboard script is valid JavaScript", () => {
  const html = renderMonitorHtml({ mode: "dashboard", token: "test" });
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("MCP tool calls are proxied without exposing daemon credentials", async () => {
  const daemon = { call: async () => ({ sessionId: "s1", runId: "r1", summary: "测试", dashboard_url: "http://127.0.0.1:1/" }) };
  const result = await handleRequest({ id: 4, method: "tools/call", params: { name: "cc_dispatch", arguments: { prompt: "x", summary: "测试", cwd: "/tmp" } } }, daemon);
  assert.equal(result.result.structuredContent.sessionId, "s1");
  assert.doesNotMatch(result.result.content[0].text, /Bearer|token=/i);
});
