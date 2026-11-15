// Starts the pinned TrueForge in local (standalone) mode for this project.
//   node scripts/start-trueforge.mjs [--port 8790]
// TrueForge blocks outbound calls to loopback addresses by default. The workspace MCP server
// (and any local OpenAI-compatible model) lives on 127.0.0.1, so loopback is allow-listed here.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, ".trueforge");
fs.mkdirSync(dataDir, { recursive: true });
const pkgJson = createRequire(import.meta.url).resolve("@truefoundry/trueforge/package.json");
const cli = path.join(path.dirname(pkgJson), "dist", "cli.js");

const env = {
  ...process.env,
  SQLITE_PATH: process.env.SQLITE_PATH ?? path.join(dataDir, "db.sqlite"),
  OUTBOUND_URL_ALLOWED_HOSTS: process.env.OUTBOUND_URL_ALLOWED_HOSTS ?? JSON.stringify(["127.0.0.1", "localhost", "::1"]),
};
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
