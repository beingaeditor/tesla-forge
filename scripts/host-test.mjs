// Launches a real VS Code extension host with this extension on a throwaway workspace and runs
// test/host/suite.ts in it. Needs TrueForge running (npm run trueforge). Uses the scripted mock model.
//   npm run test:host            (set VSCODE_EXE to use a specific VS Code binary)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.TRUEFORGE_URL ?? "http://localhost:8790";
const MOCK_PORT = 8897;

const build = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs"), "--tests"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

// ---- Fixture workspace ---------------------------------------------------------------------
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-host-"));
const files = {
  "src/calc.py": 'def add(a, b):\n    """Return a + b."""\n    return a + b\n\n\ndef sub(a, b):\n    """Return a - b."""\n    return a - b\n\n\ndef mul(a, b):\n    """Return a * b."""\n    return a * b\n',
  "tests/test_calc.py": "from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n",
  "docs/usage.md": "# Usage\n\n- add(a, b): addition\n",
  ".vscode/settings.json": JSON.stringify({ "teslaForge.trueforgeUrl": BASE, "teslaForge.agent": "hosttest-inline", "teslaForge.fallbackAgent": "", "teslaForge.mcpPort": 8796, "teslaForge.maxRetries": 0 }, null, 2),
};
for (const [rel, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
}

// ---- Mock model + TrueForge agents -----------------------------------------------------------
const edit = (p, edits) => ({ tool: "propose_edit", args: { path: p, edits } });
const script = {
  "ht-inline": [{ text: "Updating the docstring. ", toolCalls: [edit("src/calc.py", [{ old_text: '    """Return a - b."""', new_text: '    """Return the difference a - b."""' }])] }, { text: "Docstring updated." }],
  "ht-multi": [
    { text: "Looking for the code. ", toolCalls: [{ tool: "search_workspace", args: { query: "add calc tests docs" } }] },
    { toolCalls: [edit("src/calc.py", [{ old_text: '    """Return a + b."""', new_text: '    """Return the sum."""' }, { old_text: "    return a * b", new_text: "    return a * b\n\n\ndef div(a, b):\n    return a / b" }])] },
    { toolCalls: [edit("tests/test_calc.py", [{ old_text: "    assert add(1, 2) == 3", new_text: "    assert add(1, 2) == 3\n\n\ndef test_div():\n    assert div(4, 2) == 2" }])] },
    { toolCalls: [edit("docs/usage.md", [{ old_text: "- add(a, b): addition", new_text: "- add(a, b): addition\n- div(a, b): division" }])] },
    { text: "Added div, a test and docs." },
  ],
};
const scriptFile = path.join(ws, "..", `forge-host-script-${process.pid}.json`);
fs.writeFileSync(scriptFile, JSON.stringify(script));
const mock = spawn(process.execPath, [path.join(root, "scripts", "mock-model.mjs"), "--port", String(MOCK_PORT), "--script", scriptFile], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => mock.stdout.once("data", resolve));

const client = new TrueForge({ baseUrl: BASE, timeoutInSeconds: 30 });
const models = ["mock-chat", "ht-inline", "ht-multi"].map((id) => ({ name: id, modelId: id, properties: { contextLength: 32000 } }));
const providers = [
  { type: "custom", name: "hosttest", baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, auth: { apiKey: "mock-key" }, models },
  { type: "custom", name: "hosttestbad", baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, auth: { apiKey: "wrong-key" }, models },
];
const def = JSON.parse(fs.readFileSync(path.join(root, "agent", "tesla-forge.agent.json"), "utf8"));
const agentIds = [];
let previous;
try {
  for (const manifest of providers) await client.settings.modelProviders.createOrUpdate({ manifest });
  const servers = (await client.settings.mcpServers.list()).data;
  previous = servers.find((s) => s.name === "forge-workspace")?.manifest;
  if (!previous) await client.settings.mcpServers.createOrUpdate({ manifest: { type: "remote", name: "forge-workspace", description: "placeholder", url: "http://127.0.0.1:8796/mcp/placeholder" } });
  for (const [name, model] of [["hosttest-inline", "hosttest/ht-inline"], ["hosttest-multi", "hosttest/ht-multi"], ["hosttest-chat", "hosttest/mock-chat"], ["hosttest-badkey", "hosttestbad/mock-chat"]]) {
    let existing;
    for await (const a of await client.agents.list({ agentName: name })) if (a.name === name) existing = a;
    const body = { description: "extension host test agent", manifest: { ...def.manifest, model: { name: model } } };
    agentIds.push((existing ? await client.agents.update(existing.id, body) : await client.agents.create({ name, ...body })).data.id);
  }
} catch (e) {
  console.error(`Cannot configure TrueForge at ${BASE}: ${e?.body?.error?.message ?? e.message}\nStart it first with: npm run trueforge`);
  mock.kill();
  process.exit(2);
}

// ---- Run VS Code -----------------------------------------------------------------------------
const localCode = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe");
const vscodeExecutablePath = process.env.VSCODE_EXE ?? (fs.existsSync(localCode) ? localCode : undefined);
let code = 0;
try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "dist-test", "host-suite.js"),
    launchArgs: [ws, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--user-data-dir", path.join(ws, "..", `forge-host-profile-${process.pid}`)],
  });
} catch (e) {
  console.error(String(e?.message ?? e));
  code = 1;
}

for (const id of agentIds) await client.agents.delete(id).catch(() => {});
for (const p of providers) await client.settings.modelProviders.delete(p.name).catch(() => {});
if (previous) await client.settings.mcpServers.createOrUpdate({ manifest: previous }).catch(() => {});
mock.kill();
process.exit(code);
