// Bundles the extension (and, with --tests, the test suites) with esbuild.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const common = { bundle: true, platform: "node", target: "node20", format: "cjs", sourcemap: true, logLevel: "warning", absWorkingDir: root };

await build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] });

if (process.argv.includes("--tests")) {
  fs.rmSync(path.join(root, "dist-test"), { recursive: true, force: true });
  const unit = fs.readdirSync(path.join(root, "test/unit")).filter((f) => f.endsWith(".test.ts")).map((f) => `test/unit/${f}`);
  await build({ ...common, entryPoints: unit, outdir: "dist-test/unit" });
  await build({ ...common, entryPoints: ["test/integration/integration.ts"], outfile: "dist-test/integration.js" });
  await build({ ...common, entryPoints: ["test/tools/task-run.ts"], outfile: "dist-test/task-run.js" });
  await build({ ...common, entryPoints: ["test/tools/context-cli.ts"], outfile: "dist-test/context-cli.js" });
  await build({ ...common, entryPoints: ["test/host/suite.ts"], outfile: "dist-test/host-suite.js", external: ["vscode"] });
}
console.log("build ok");
