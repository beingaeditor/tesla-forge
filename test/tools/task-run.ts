// Runs one request through the real extension core against a real TrueForge agent, headless,
// on a real workspace folder. Every hunk is accepted, then applied. Used to rehearse the
// fixed tasks before recording them in VS Code.
//   npm run task -- <workspace> <agent|-> "<prompt>" [--inline path:start-end] [--no-apply] [--fallback agent]
import fs from "node:fs";
import path from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { ForgeConfig, ForgeController, Host } from "../../src/core/controller";
import { applyEditsToText } from "../../src/core/hunks";
import { MCP_SERVER_NAME, startMcpServer } from "../../src/core/mcpServer";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args.splice(i, 2)[1] : undefined;
};
const noApply = args.includes("--no-apply") && !!args.splice(args.indexOf("--no-apply"), 1);
const inlineSpec = flag("inline");
const fallback = flag("fallback") ?? "tesla-forge-fallback";
const [ws, agentArg, prompt] = args;
if (!ws || !prompt) {
  console.error('usage: npm run task -- <workspace> <agent> "<prompt>" [--inline path:start-end] [--no-apply] [--fallback agent]');
  process.exit(1);
}
const root = path.resolve(ws);
const BASE = process.env.TRUEFORGE_URL ?? "http://localhost:8790";
const cfg: ForgeConfig = {
  baseUrl: BASE, agent: agentArg === "-" ? "tesla-forge" : agentArg, fallbackAgent: fallback === "none" ? "" : fallback,
  contextBudgetChars: 24000, toolResponseCapChars: 6000, maxRetries: 1, testCommands: ["python -m pytest", "pytest"], testTimeoutSeconds: 180,
};
const read = (rel: string) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf8") : undefined);
const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;

let lastLen = 0;
const host: Host = {
  config: () => cfg,
  root: () => root,
  source: { current: read },
  review: async (p) => {
    console.log(`${ts()} REVIEW ${p.path}: ${p.hunks.length} hunk(s)${p.summary ? " — " + p.summary : ""}`);
    for (const h of p.hunks) {
      console.log(`         hunk @${h.oldStart + 1}:`);
      for (const l of h.oldLines) console.log(`         - ${l}`);
      for (const l of h.newLines) console.log(`         + ${l}`);
      p.decisions.set(h.id, true);
    }
  },
  closeReviews: () => {},
  confirmCommand: async (c) => (console.log(`${ts()} RUN ${c} (approved)`), true),
  applyEdits: async (plan) => {
    for (const f of plan.files) fs.writeFileSync(path.join(root, f.path), applyEditsToText(f.before, f.edits));
    return true;
  },
  changed: () => {
    const t = controller.transcript;
    for (const item of t.slice(lastLen)) {
      if (item.kind === "context") {
        console.log(`${ts()} CONTEXT ${item.pack.usedChars}/${item.pack.budgetChars} chars`);
        for (const s of item.pack.snippets) console.log(`         ${s.path}:${s.startLine}-${s.endLine} — ${s.reason}`);
      } else if (item.kind === "notice") console.log(`${ts()} NOTICE [${item.level}] ${item.text}`);
    }
    lastLen = t.length;
  },
};
const controller = new ForgeController(host);

async function main() {
  const mcp = await startMcpServer(controller, 0, "task-run");
  const client = new TrueForge({ baseUrl: BASE, timeoutInSeconds: 30 });
  await client.settings.mcpServers.createOrUpdate({ manifest: { type: "remote", name: MCP_SERVER_NAME, description: "The open VS Code workspace: ranked code search, bounded file reads, reviewed edit proposals, and approved local test runs.", url: mcp.url } });
  let inline;
  if (inlineSpec) {
    const m = /^(.+):(\d+)-(\d+)$/.exec(inlineSpec)!;
    const lines = read(m[1])!.split(/\r?\n/);
    inline = { path: m[1], startLine: +m[2], endLine: +m[3], text: lines.slice(+m[2] - 1, +m[3]).join("\n") };
  }
  const result = await controller.send(prompt, inline);
  for (const t of controller.transcript) {
    if (t.kind === "tool") console.log(`TOOL ${t.call.tool}${t.call.via ? " (via " + t.call.via + ")" : ""} [${t.state}] ${JSON.stringify(t.call.tool === "propose_edit" ? { path: t.call.args.path } : t.call.args).slice(0, 160)}\n     -> ${(t.result ?? "").split("\n")[0].slice(0, 200)}`);
  }
  const text = controller.transcript.filter((t) => t.kind === "assistant").map((t) => (t as { text: string }).text).join("\n");
  console.log(`\n${ts()} RESULT ${result?.status} attempts=${result?.attempts.map((a) => `${a.kind}:${a.agent}`).join(",")}${result?.error ? "\n  error: " + result.error : ""}`);
  console.log(`session: ${controller.lastSession?.id} (${BASE}/sessions/${controller.lastSession?.id})`);
  console.log(`assistant: ${text.slice(-1200)}`);
  console.log(`staged: ${controller.store.stagedFiles().map((f) => `${f.path}(${f.hunks.length})`).join(", ") || "none"}`);
  if (!noApply && controller.canApply) console.log(`apply: ${await controller.apply()}`);
  await mcp.close();
  process.exit(result?.status === "done" ? 0 : 1);
}
void main();
