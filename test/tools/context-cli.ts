// Prints what the extension would put in the first message for a prompt, without any model:
//   npm run context -- <workspace folder> "<prompt>" [budgetChars]
import path from "node:path";
import { WorkspaceIndex, assembleContext } from "../../src/core/retrieval";

const [, , folder, prompt, budget] = process.argv;
if (!folder || !prompt) {
  console.error('usage: npm run context -- <workspace folder> "<prompt>" [budgetChars]');
  process.exit(1);
}
const index = new WorkspaceIndex(path.resolve(folder));
const t0 = Date.now();
const pack = assembleContext(index, prompt, Number(budget ?? 24000));
console.log(`${index.fileCount()} files indexed, ${pack.candidates} matched, ${pack.usedChars}/${pack.budgetChars} chars used, ${Date.now() - t0} ms`);
const files = new Map<string, { lines: string[]; chars: number; reason: string; score?: number }>();
for (const s of pack.snippets) {
  const f = files.get(s.path) ?? { lines: [], chars: 0, reason: s.reason, score: s.score };
  f.lines.push(`${s.startLine}-${s.endLine}`);
  f.chars += s.text.length;
  files.set(s.path, f);
}
for (const [p, f] of files) console.log(`  ${p}  [${f.lines.join(", ")}]  ${f.chars} chars  score ${f.score ?? "-"}\n      why: ${f.reason}`);
for (const n of pack.notes) console.log(`  note: ${n}`);
if (process.argv.includes("--full")) console.log("\n" + pack.snippets.map((s) => `### ${s.path} ${s.startLine}-${s.endLine}\n${s.text}`).join("\n\n"));
