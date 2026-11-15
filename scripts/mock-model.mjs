// Scripted OpenAI-compatible model for automated tests ONLY.
// It never thinks: each model id replays a fixed list of steps from a JSON script, so tests
// can exercise streaming, tool calls, approvals, cancellation and provider failure offline.
// It is not used for the demo and is not evidence of agent quality.
//
//   node scripts/mock-model.mjs [--port 8899] [--script path.json] [--log path.jsonl]
//
// Script format: { "<model id>": [ step, ... ] }. The step used is indexed by the number of
// assistant messages since the last user message. A step is:
//   { "text": "...", "toolCalls": [{ "tool": "read_file", "args": {...} }],
//     "chunkDelayMs": 30, "status": 500, "hang": true }
import http from "node:http";
import fs from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("port", process.env.MOCK_PORT ?? 8899));
const scriptPath = arg("script", process.env.MOCK_SCRIPT);
const logPath = arg("log", process.env.MOCK_LOG);
const API_KEY = "mock-key";

const builtin = {
  "mock-chat": [{ text: "This is the scripted mock model streaming a reply token by token. ".repeat(12), chunkDelayMs: 60 }],
  "mock-down": [{ status: 503 }],
};
const loadScript = () => ({ ...builtin, ...(scriptPath && fs.existsSync(scriptPath) ? JSON.parse(fs.readFileSync(scriptPath, "utf8")) : {}) });
const log = (entry) => logPath && fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Map a script tool name onto what the harness actually offered (direct, or deferred via call_tool). */
function resolveToolCall(call, tools) {
  const names = (tools ?? []).map((t) => t.function?.name ?? t.name);
  const direct = names.find((n) => n === call.tool) ?? names.find((n) => n?.endsWith(call.tool));
  if (direct) return { name: direct, args: call.args ?? {} };
  const meta = names.find((n) => n === "call_tool") ?? names.find((n) => n?.endsWith("call_tool"));
  if (meta) return { name: meta, args: { mcp_server: call.server ?? "forge-workspace", tool_name: call.tool, input: call.args ?? {} } };
  return { name: call.tool, args: call.args ?? {} };
}

function pickStep(body) {
  const steps = loadScript()[body.model];
  if (!steps) return { status: 404, error: `unknown mock model ${body.model}` };
  const msgs = body.messages ?? [];
  let lastUser = -1;
  msgs.forEach((m, i) => { if (m.role === "user") lastUser = i; });
  const idx = msgs.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
  return steps[Math.min(idx, steps.length - 1)];
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (req.method === "GET" && req.url.endsWith("/models")) {
    return json(200, { object: "list", data: Object.keys(loadScript()).map((id) => ({ id, object: "model" })) });
  }
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    log({ url: req.url, rejected: "bad key" });
    return json(401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } });
  }
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    log({ url: req.url, method: req.method, rejected: "unsupported route" });
    return json(404, { error: { message: `mock model does not implement ${req.method} ${req.url}` } });
  }
  const body = JSON.parse(raw || "{}");
  const step = pickStep(body);
  log({ url: req.url, model: body.model, stream: body.stream, tools: (body.tools ?? []).map((t) => t.function?.name), messages: body.messages, step });
  if (step.status) return json(step.status, { error: { message: step.error ?? "mock upstream failure", type: "server_error" } });

  const id = `chatcmpl-mock-${Date.now()}`;
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
  const calls = (step.toolCalls ?? []).map((c, i) => ({ index: i, id: `call_${Date.now()}_${i}`, ...resolveToolCall(c, body.tools) }));
  const finish = calls.length ? "tool_calls" : "stop";

  if (!body.stream) {
    return json(200, {
      ...base, object: "chat.completion",
      choices: [{ index: 0, finish_reason: finish, message: {
        role: "assistant", content: step.text ?? null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
      } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  let open = true;
  res.on("close", () => { open = false; });
  const send = (delta, finish_reason = null) => open && res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  send({ role: "assistant", content: "" });
  if (step.hang) return; // keep the stream open forever; the client must cancel
  for (const piece of (step.text ?? "").match(/\S+\s*/g) ?? []) {
    if (!open) return;
    send({ content: piece });
    if (step.chunkDelayMs) await sleep(step.chunkDelayMs);
  }
  for (const c of calls) {
    send({ tool_calls: [{ index: c.index, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] });
    const argText = JSON.stringify(c.args);
    for (let i = 0; i < argText.length; i += 400) send({ tool_calls: [{ index: c.index, function: { arguments: argText.slice(i, i + 400) } }] });
  }
  send({}, finish);
  if (open) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  }
});

server.listen(port, "127.0.0.1", () => console.log(`mock model listening on http://127.0.0.1:${port}/v1 (key: ${API_KEY})`));
