// End-to-end checks of the editor-independent core against a REAL local TrueForge, with the
// scripted mock model standing in for a provider. Needs TrueForge running (npm run trueforge).
//   npm run test:integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { ForgeConfig, ForgeController, Host } from "../../src/core/controller";
import { applyEditsToText } from "../../src/core/hunks";
import { MCP_SERVER_NAME, startMcpServer } from "../../src/core/mcpServer";
import { Proposal } from "../../src/core/proposals";

const BASE = process.env.TRUEFORGE_URL ?? "http://localhost:8790";
const MOCK_PORT = 8898;
const repo = path.resolve(__dirname, "..");
const client = new TrueForge({ baseUrl: BASE, timeoutInSeconds: 60 });

const CALC = `def add(a, b):
    """Return a + b."""
    return a + b


def sub(a, b):
    """Return a - b."""
    return a - b


def mul(a, b):
    """Return a * b."""
    return a * b
`;
const TESTS = `from calc import add


def test_add():
    assert add(1, 2) == 3
`;
const DOCS = `# Usage

- add(a, b): addition
`;

const editCalc = { tool: "propose_edit", args: { path: "src/calc.py", summary: "add div, document add", edits: [
  { old_text: '    """Return a + b."""', new_text: '    """Return the sum of a and b."""' },
  { old_text: "    return a * b", new_text: "    return a * b\n\n\ndef div(a, b):\n    return a / b" },
] } };
const editTests = { tool: "propose_edit", args: { path: "tests/test_calc.py", edits: [{ old_text: "    assert add(1, 2) == 3", new_text: "    assert add(1, 2) == 3\n\n\ndef test_div():\n    assert div(4, 2) == 2" }] } };
const editDocs = { tool: "propose_edit", args: { path: "docs/usage.md", edits: [{ old_text: "- add(a, b): addition", new_text: "- add(a, b): addition\n- div(a, b): division" }] } };

const SCRIPT = {
  "it-multi": [
    { text: "Searching the workspace. ", toolCalls: [{ tool: "search_workspace", args: { query: "add function calc tests docs" } }] },
    { toolCalls: [{ tool: "read_file", args: { path: "src/calc.py" } }] },
    { text: "Proposing the implementation. ", toolCalls: [editCalc] },
    { toolCalls: [editTests] },
    { toolCalls: [editDocs] },
    { text: "Added div with a test and docs.", chunkDelayMs: 5 },
  ],
  "it-failmid": [{ toolCalls: [editDocs] }, { status: 500 }],
  "it-escape": [
    { toolCalls: [{ tool: "propose_edit", args: { path: "../outside.txt", edits: [{ old_text: "secret", new_text: "pwned" }] } }] },
    { toolCalls: [{ tool: "read_file", args: { path: "../outside.txt" } }] },
    { text: "I could not access that path." },
  ],
  "it-tests": [
    { toolCalls: [{ tool: "run_tests", args: { command: "node --version" } }] },
    { toolCalls: [{ tool: "run_tests", args: { command: "node --version; echo pwned" } }] },
    { text: "Tests ran." },
  ],
  "it-inline": [
    { toolCalls: [{ tool: "propose_edit", args: { path: "src/calc.py", edits: [{ old_text: "    return a * b", new_text: "    return b * a" }] } }] },
    { toolCalls: [{ tool: "propose_edit", args: { path: "src/calc.py", edits: [{ old_text: '    """Return a - b."""', new_text: '    """Return the difference a - b."""' }] } }] },
    { text: "Docstring updated." },
  ],
};

type Policy = (p: Proposal, ctl: ForgeController, env: Env) => void | Promise<void>;
interface Env {
  root: string;
  live: Map<string, string>;
  controller: ForgeController;
  cfg: ForgeConfig;
  policy: Policy;
  confirm: (command: string) => boolean;
  reviewed: Proposal[];
  read(rel: string): string;
}

function makeEnv(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-it-"));
  for (const [rel, text] of Object.entries({ "src/calc.py": CALC, "tests/test_calc.py": TESTS, "docs/usage.md": DOCS })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  fs.writeFileSync(path.join(root, "..", "outside.txt"), "secret");
  const waiting: Array<() => void> = [];
  const env = {
    root,
    live: new Map<string, string>(),
    policy: ((p) => p.hunks.forEach((h) => p.decisions.set(h.id, true))) as Policy,
    confirm: () => true,
    reviewed: [] as Proposal[],
    read: (rel: string) => fs.readFileSync(path.join(root, rel), "utf8"),
    cfg: { baseUrl: BASE, agent: "itest-it-multi", fallbackAgent: "", contextBudgetChars: 3000, toolResponseCapChars: 2500, maxRetries: 1, backoffMs: 150, testCommands: ["node --version"], testTimeoutSeconds: 20 },
  } as unknown as Env;
  const host: Host = {
    config: () => env.cfg,
    root: () => root,
    source: { current: (rel) => env.live.get(rel) ?? (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf8") : undefined) },
    review: async (p) => {
      env.reviewed.push(p);
      await Promise.race([Promise.resolve(env.policy(p, env.controller, env)), new Promise<void>((r) => waiting.push(r))]);
    },
    closeReviews: () => waiting.splice(0).forEach((r) => r()),
    confirmCommand: async (c) => env.confirm(c),
    applyEdits: async (plan) => {
      for (const f of plan.files) {
        fs.writeFileSync(path.join(root, f.path), applyEditsToText(f.before, f.edits));
        env.live.delete(f.path);
      }
      return true;
    },
    changed: () => {},
  };
  env.controller = new ForgeController(host);
  return env;
}

const tools = (env: Env) => env.controller.transcript.filter((t) => t.kind === "tool") as Array<Extract<ForgeController["transcript"][number], { kind: "tool" }>>;
const notices = (env: Env) => env.controller.transcript.filter((t) => t.kind === "notice").map((t) => (t as { text: string }).text).join("\n");
const disk = (env: Env) => ["src/calc.py", "tests/test_calc.py", "docs/usage.md"].map(env.read).join("\u0000");
const CLEAN = [CALC, TESTS, DOCS].join("\u0000");
const turnState = async (env: Env) => {
  const s = env.controller.lastSession!;
  const turns = [];
  for await (const t of await client.sessions.listTurns(s.id, {})) turns.push(t);
  return turns[turns.length - 1].state.status;
};

const results: Array<[string, string]> = [];
async function check(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    results.push([name, "PASS"]);
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push([name, "FAIL"]);
    console.log(`FAIL  ${name}\n      ${(err as Error).stack?.split("\n").slice(0, 6).join("\n      ")}`);
  }
}

async function main() {
  // ---- Arrange: mock model, providers, agents, MCP registration ---------------------------
  const scriptFile = path.join(os.tmpdir(), `forge-it-script-${process.pid}.json`);
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  const mock = spawn(process.execPath, [path.join(repo, "scripts", "mock-model.mjs"), "--port", String(MOCK_PORT), "--script", scriptFile], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => mock.stdout.once("data", () => resolve()));

  const modelIds = ["mock-chat", ...Object.keys(SCRIPT)];
  const models = modelIds.map((id) => ({ name: id, modelId: id, properties: { contextLength: 32000 } }));
  const providers = [
    { type: "custom" as const, name: "itest", baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, auth: { apiKey: "mock-key" }, models },
    { type: "custom" as const, name: "itestbad", baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, auth: { apiKey: "wrong-key" }, models },
    { type: "custom" as const, name: "itestdead", baseUrl: "http://127.0.0.1:9/v1", auth: { apiKey: "x" }, models },
  ];
  try {
    for (const manifest of providers) await client.settings.modelProviders.createOrUpdate({ manifest });
  } catch (err) {
    console.error(`Cannot configure TrueForge at ${BASE}: ${(err as Error).message}\nStart it first with: npm run trueforge`);
    mock.kill();
    process.exit(2);
  }
  const previous = (await client.settings.mcpServers.list()).data.find((s) => s.name === MCP_SERVER_NAME)?.manifest;
  const def = JSON.parse(fs.readFileSync(path.join(repo, "agent", "tesla-forge.agent.json"), "utf8"));
  const agentIds: string[] = [];
  const agents: Array<[string, string]> = [...modelIds.map((m): [string, string] => [`itest-${m}`, `itest/${m}`]), ["itest-badkey", "itestbad/mock-chat"], ["itest-dead", "itestdead/it-multi"]];

  let env = makeEnv();
  let mcp = await startMcpServer(env.controller, 0, "itest-token");
  /** Fresh workspace + controller, with the workspace tools re-pointed at it. */
  const fresh = async (over: Partial<ForgeConfig> = {}) => {
    await mcp.close();
    env = makeEnv();
    Object.assign(env.cfg, over);
    mcp = await startMcpServer(env.controller, 0, "itest-token");
    await client.settings.mcpServers.createOrUpdate({ manifest: { type: "remote", name: MCP_SERVER_NAME, description: "integration test workspace", url: mcp.url } });
    return env;
  };
  await fresh();
  for (const [name, model] of agents) {
    let existing;
    for await (const a of await client.agents.list({ agentName: name })) if (a.name === name) existing = a;
    const body = { description: "integration test agent", manifest: { ...def.manifest, model: { name: model } } };
    const saved = existing ? await client.agents.update(existing.id, body) : await client.agents.create({ name, ...body });
    agentIds.push(saved.data.id);
  }

  // ---- Checks ---------------------------------------------------------------------------
  await check("agent discovers and edits 3 files; one hunk accepted and one rejected; nothing on disk until Apply", async () => {
    const e = await fresh();
    e.policy = (p) => p.hunks.forEach((h) => p.decisions.set(h.id, !(p.path === "src/calc.py" && h.id === 0)));
    const r = await e.controller.send("Add a div function with a test and docs");
    assert.equal(r?.status, "done", notices(e));
    const ctx = e.controller.transcript.find((t) => t.kind === "context") as { pack: { snippets: Array<{ path: string; reason: string }>; usedChars: number; budgetChars: number } };
    assert.ok(ctx.pack.snippets.length > 0 && ctx.pack.usedChars <= ctx.pack.budgetChars, "context selected within budget");
    assert.ok(ctx.pack.snippets.every((s) => s.reason), "every selected file has a reason");
    const calls = tools(e);
    assert.deepEqual(calls.map((t) => t.call.tool), ["search_workspace", "read_file", "propose_edit", "propose_edit", "propose_edit"]);
    assert.equal(calls[0].call.via, "call_tool", "search goes through TrueForge deferred tool loading");
    assert.match(calls[0].result ?? "", /Top matches[\s\S]*src\/calc\.py — /, "search result explains why files were chosen");
    assert.ok((calls[0].result ?? "").length <= 2500 + 300, "tool response capped");
    assert.match(calls[2].result ?? "", /1 of 2 hunk\(s\) accepted/);
    assert.equal(disk(e), CLEAN, "no write before Apply");
    assert.equal(e.controller.store.stagedFiles().length, 3);
    assert.equal(e.controller.canApply, true);

    assert.equal(await e.controller.apply(), true);
    assert.ok(e.read("src/calc.py").includes("def div(a, b)") && e.read("src/calc.py").includes('"""Return a + b."""'), "accepted hunk applied, rejected hunk not");
    assert.ok(e.read("tests/test_calc.py").includes("test_div") && e.read("docs/usage.md").includes("division"));

    // Unrelated manual edit, then undo: only the applied hunks are reverted.
    fs.writeFileSync(path.join(e.root, "src/calc.py"), e.read("src/calc.py").replace("return a - b", "return a - b  # mine"));
    assert.equal(await e.controller.undo(), true);
    assert.equal(e.read("src/calc.py"), CALC.replace("return a - b", "return a - b  # mine"));
    assert.equal(e.read("tests/test_calc.py"), TESTS);

    // The TrueForge session holds the turns and tool calls (what the demo shows for Task B).
    const events = [];
    const s = e.controller.lastSession!;
    for await (const t of await client.sessions.listTurns(s.id, {})) for await (const ev of await client.sessions.listTurnEvents(s.id, t.id, {})) events.push(ev);
    const types = events.map((ev) => (ev as { type: string }).type);
    assert.ok(types.includes("tool.approval_required") && types.includes("user.tool_approval") && types.includes("tool.response"));
    assert.ok(JSON.stringify(events).includes("call_tool"), "deferred call_tool visible in the session");
  });

  await check("rejecting every hunk of a file denies that tool call and stages nothing for it", async () => {
    const e = await fresh();
    e.policy = (p) => p.hunks.forEach((h) => p.decisions.set(h.id, p.path !== "src/calc.py"));
    const r = await e.controller.send("Add a div function with a test and docs");
    assert.equal(r?.status, "done", notices(e));
    assert.equal(tools(e).find((t) => t.call.tool === "propose_edit" && t.call.args.path === "src/calc.py")?.state, "denied");
    assert.deepEqual(e.controller.store.stagedFiles().map((f) => f.path).sort(), ["docs/usage.md", "tests/test_calc.py"]);
    assert.equal(disk(e), CLEAN);
  });

  await check("Stop during streaming is immediate, cancels the TrueForge turn, leaves the workspace clean", async () => {
    const e = await fresh({ agent: "itest-mock-chat" });
    const started = e.controller.send("say something long");
    const t0 = Date.now();
    while (!e.controller.transcript.some((t) => t.kind === "assistant") && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 20));
    assert.ok(e.controller.transcript.some((t) => t.kind === "assistant"), "tokens streamed before cancel");
    const before = (e.controller.transcript.find((t) => t.kind === "assistant") as { text: string }).text.length;
    const t1 = Date.now();
    const stopping = e.controller.stop();
    assert.equal(e.controller.running, false, "UI state settles synchronously");
    await stopping;
    assert.ok(Date.now() - t1 < 3000, `cancel took ${Date.now() - t1} ms`);
    const r = await started;
    assert.equal(r?.status, "cancelled");
    await new Promise((res) => setTimeout(res, 400));
    const after = (e.controller.transcript.find((t) => t.kind === "assistant") as { text: string }).text.length;
    assert.ok(after - before < 80, "late tokens are ignored after Stop");
    assert.equal(await turnState(e), "cancelled");
    assert.equal(disk(e), CLEAN);
    assert.equal(e.controller.canApply, false);
  });

  await check("Stop while paused for review discards the proposal; late tool calls are refused", async () => {
    const e = await fresh();
    let stopped: Promise<void> | undefined;
    e.policy = (p, ctl) => {
      if (p.path !== "src/calc.py") return;
      p.hunks.forEach((h) => p.decisions.set(h.id, true)); // user had accepted, then hit Stop
      stopped = ctl.stop();
      return new Promise<void>(() => {});
    };
    const r = await e.controller.send("Add a div function with a test and docs");
    await stopped;
    assert.equal(r?.status, "cancelled");
    assert.equal(e.controller.store.stagedFiles().length, 0);
    assert.equal(e.controller.store.all().length, 0);
    assert.equal(e.controller.canApply, false);
    assert.equal(await turnState(e), "cancelled");
    assert.throws(() => e.controller.store.stage(editCalc.args), /not been reviewed/);
    assert.equal(disk(e), CLEAN);
  });

  await check("invalid API key: clear error, no retry storm, workspace unchanged", async () => {
    const e = await fresh({ agent: "itest-badkey" });
    const r = await e.controller.send("Add a div function");
    assert.equal(r?.status, "error");
    assert.match(r?.error ?? "", /401|API key/i);
    assert.equal(r?.attempts.length, 1, "an auth failure is not retried");
    assert.match(notices(e), /No files were changed/);
    assert.equal(e.controller.running, false);
    assert.equal(disk(e), CLEAN);
  });

  await check("unreachable endpoint: retry with backoff, then a clear error", async () => {
    const e = await fresh({ agent: "itest-dead" });
    const r = await e.controller.send("Add a div function");
    assert.equal(r?.status, "error");
    assert.deepEqual(r?.attempts.map((a) => a.kind), ["primary", "retry"]);
    assert.match(r?.error ?? "", /connect/i);
    assert.equal(disk(e), CLEAN);
  });

  await check("unreachable endpoint with a fallback agent: automatic fallback completes the task", async () => {
    const e = await fresh({ agent: "itest-dead", fallbackAgent: "itest-it-multi" });
    const r = await e.controller.send("Add a div function with a test and docs");
    assert.equal(r?.status, "done", notices(e));
    assert.deepEqual(r?.attempts.map((a) => a.kind), ["primary", "retry", "fallback"]);
    assert.equal(r?.final?.agent, "itest-it-multi");
    assert.match(notices(e), /falling back to agent "itest-it-multi"/i);
    assert.equal(e.controller.store.stagedFiles().length, 3, "fallback result stays in preview");
    assert.equal(disk(e), CLEAN, "fallback does not write by itself");
  });

  await check("model failure after a hunk was staged discards that hunk", async () => {
    const e = await fresh({ agent: "itest-it-failmid", maxRetries: 0 });
    const r = await e.controller.send("Document div");
    assert.equal(r?.status, "error");
    assert.equal(e.reviewed.length, 1, "the proposal was reviewed and accepted before the failure");
    assert.equal(e.controller.store.stagedFiles().length, 0);
    assert.equal(e.controller.canApply, false);
    assert.equal(disk(e), CLEAN);
  });

  await check("file edited during review: stale proposal is rejected, not staged", async () => {
    const e = await fresh();
    e.policy = (p, ctl, env2) => {
      if (p.path !== "src/calc.py") return void p.hunks.forEach((h) => p.decisions.set(h.id, true));
      p.hunks.forEach((h) => p.decisions.set(h.id, true));
      env2.live.set("src/calc.py", CALC.replace("return a * b", "return a * b * 1"));
      ctl.documentChanged("src/calc.py");
    };
    const r = await e.controller.send("Add a div function with a test and docs");
    assert.equal(r?.status, "done", notices(e));
    assert.equal(tools(e).find((t) => t.call.tool === "propose_edit" && t.call.args.path === "src/calc.py")?.state, "denied");
    assert.match(notices(e), /no longer applies/);
    assert.ok(!e.controller.store.stagedFiles().some((f) => f.path === "src/calc.py"));
  });

  await check("paths outside the workspace are refused for both edits and reads", async () => {
    const e = await fresh({ agent: "itest-it-escape" });
    const r = await e.controller.send("Edit the file above the workspace");
    assert.equal(r?.status, "done", notices(e));
    const calls = tools(e);
    assert.equal(calls[0].state, "denied");
    assert.match(calls[1].result ?? "", /outside the workspace/);
    assert.equal(fs.readFileSync(path.join(e.root, "..", "outside.txt"), "utf8"), "secret");
    assert.equal(e.reviewed.length, 0);
  });

  await check("run_tests: approved allow-listed command runs; shell operators are refused before asking", async () => {
    const e = await fresh({ agent: "itest-it-tests" });
    const asked: string[] = [];
    e.confirm = (c) => (asked.push(c), true);
    const r = await e.controller.send("Run the tests");
    assert.equal(r?.status, "done", notices(e));
    const calls = tools(e);
    assert.match(calls[0].result ?? "", /exit code 0[\s\S]*v\d+\./);
    assert.equal(calls[1].state, "denied");
    assert.deepEqual(asked, ["node --version"]);
  });

  await check("inline edit: changes outside the selection are refused, inside are reviewable", async () => {
    const e = await fresh({ agent: "itest-it-inline" });
    const r = await e.controller.send("Clarify the docstring", { path: "src/calc.py", startLine: 6, endLine: 8, text: CALC.split("\n").slice(5, 8).join("\n") });
    assert.equal(r?.status, "done", notices(e));
    const calls = tools(e);
    assert.equal(calls[0].state, "denied");
    assert.match(calls[1].result ?? "", /1 of 1 hunk\(s\) accepted/);
    assert.equal(await e.controller.apply(), true);
    assert.equal(e.read("src/calc.py"), CALC.replace("Return a - b.", "Return the difference a - b."));
  });

  // ---- Cleanup ----------------------------------------------------------------------------
  await mcp.close();
  for (const id of agentIds) await client.agents.delete(id).catch(() => {});
  for (const p of providers) await client.settings.modelProviders.delete(p.name).catch(() => {});
  if (previous) await client.settings.mcpServers.createOrUpdate({ manifest: previous as never }).catch(() => {});
  mock.kill();
  fs.rmSync(scriptFile, { force: true });
  const failed = results.filter(([, r]) => r === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} integration checks passed against TrueForge at ${BASE}`);
  process.exit(failed ? 1 : 0);
}

void main();
