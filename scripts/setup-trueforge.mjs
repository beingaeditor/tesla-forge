// Loads the agent definition in agent/tesla-forge.agent.json into a running local TrueForge.
//
//   npm run setup:agent -- --model <provider>/<model> [--fallback-model <provider>/<model>]
//                          [--providers agent/model-providers.local.json] [--url http://localhost:8790]
//   npm run setup:agent -- --list        # show the models TrueForge has configured
//
// The model lives on the TrueForge agent, never in the extension. The same definition is saved
// twice when a fallback model is given: "tesla-forge" and "tesla-forge-fallback".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const client = new TrueForge({ baseUrl: arg("url") ?? "http://localhost:8790", timeoutInSeconds: 30 });
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const reason = (e) => e?.body?.error?.message ?? e?.message ?? String(e);

let models;
try {
  if (arg("providers")) {
    const file = JSON.parse(fs.readFileSync(path.resolve(arg("providers")), "utf8"));
    for (const manifest of file.providers ?? []) {
      await client.settings.modelProviders.createOrUpdate({ manifest });
      console.log(`provider "${manifest.name}" configured (${manifest.models?.length ?? 0} model(s))`);
    }
  }
  models = (await client.models.list()).data.map((m) => m.name);
} catch (e) {
  fail(`Could not talk to TrueForge: ${reason(e)}\nIs it running? Start it with: npm run trueforge`);
}

const primary = arg("model");
const fallback = arg("fallback-model");
if (process.argv.includes("--list") || !primary) {
  console.log(models.length ? `Models configured in TrueForge:\n  ${models.join("\n  ")}` : "No models are configured in TrueForge yet. Add a provider in the TrueForge UI (Settings > Models) or pass --providers.");
  if (!primary) console.log("\nPass --model <provider>/<model> to create the agent.");
  process.exit(0);
}
for (const m of [primary, fallback].filter(Boolean)) {
  if (!models.includes(m)) fail(`Model "${m}" is not configured in TrueForge. Configured: ${models.join(", ") || "none"}`);
}

// The agent references the workspace MCP server by name, so it must exist. The extension
// replaces this placeholder with its real local URL every time it starts.
const servers = (await client.settings.mcpServers.list()).data.map((s) => s.name);
if (!servers.includes("forge-workspace")) {
  await client.settings.mcpServers.createOrUpdate({
    manifest: { type: "remote", name: "forge-workspace", description: "The open VS Code workspace (registered by the Tesla Forge extension).", url: "http://127.0.0.1:8795/mcp/placeholder" },
  });
}

const def = JSON.parse(fs.readFileSync(path.join(root, "agent", "tesla-forge.agent.json"), "utf8"));
async function save(name, model, description) {
  const manifest = { ...def.manifest, model: { name: model } };
  try {
    let existing;
    for await (const a of await client.agents.list({ agentName: name })) if (a.name === name) existing = a;
    if (existing) await client.agents.update(existing.id, { description, manifest });
    else await client.agents.create({ name, description, manifest });
    console.log(`agent "${name}" ${existing ? "updated" : "created"} on model ${model}`);
  } catch (e) {
    fail(`Could not save agent "${name}": ${reason(e)}`);
  }
}
await save(def.name, primary, def.description);
if (fallback) await save(`${def.name}-fallback`, fallback, `${def.description} Fallback model.`);
else console.log('No --fallback-model given: automatic fallback stays off until an agent named "tesla-forge-fallback" exists.');
