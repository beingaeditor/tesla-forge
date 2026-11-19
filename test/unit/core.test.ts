import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyEditsToText, applyHunks, applySearchReplace, computeHunks, rebaseHunks, toOffsetEdits } from "../../src/core/hunks";
import { PathError, resolveInWorkspace } from "../../src/core/paths";
import { ProposalError, ProposalStore } from "../../src/core/proposals";
import { WorkspaceIndex, assembleContext, extractTerms, parseMentions } from "../../src/core/retrieval";
import { validateTestCommand } from "../../src/core/testCommand";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "forge-unit-"));
const FILE = ["def a():", "    return 1", "", "def b():", "    return 2", "", "def c():", "    return 3", ""].join("\n");

test("search/replace: unique match applies, ambiguity and misses are reported", () => {
  const ok = applySearchReplace(FILE, [{ old_text: "    return 2", new_text: "    return 22" }]);
  assert.ok(ok.ok && ok.text.includes("return 22"));
  const miss = applySearchReplace(FILE, [{ old_text: "return 9", new_text: "x" }]);
  assert.ok(!miss.ok && /not found/.test(miss.error));
  const dup = applySearchReplace("x\nx\n", [{ old_text: "x", new_text: "y" }]);
  assert.ok(!dup.ok && /matches 2 places/.test(dup.error));
  const overlap = applySearchReplace(FILE, [{ old_text: "def b():\n    return 2", new_text: "q" }, { old_text: "    return 2", new_text: "z" }]);
  assert.ok(!overlap.ok && /overlap/.test(overlap.error));
});

test("search/replace tolerates trailing whitespace and keeps CRLF", () => {
  const crlf = FILE.replace(/\n/g, "\r\n");
  const r = applySearchReplace(crlf, [{ old_text: "def b():   \n    return 2\n", new_text: "def b():\n    return 5\n" }]);
  assert.ok(r.ok);
  assert.ok(r.ok && r.text.includes("return 5\r\n") && !/[^\r]\n/.test(r.text));
});

test("hunks: separate changes become separate hunks and can be accepted individually", () => {
  const next = FILE.replace("return 1", "return 10").replace("return 3", "return 30");
  const hunks = computeHunks(FILE, next);
  assert.equal(hunks.length, 2);
  assert.equal(applyHunks(FILE, hunks, new Set([0, 1])), next);
  const onlySecond = applyHunks(FILE, hunks, new Set([1]));
  assert.ok(onlySecond.includes("return 1\n") && onlySecond.includes("return 30"));
  assert.equal(applyHunks(FILE, hunks, new Set()), FILE);
});

test("rebase: hunks follow unrelated edits, and conflict when their lines changed", () => {
  const hunks = computeHunks(FILE, FILE.replace("return 3", "return 30"));
  const shifted = "# new header\n# another\n" + FILE;
  const moved = rebaseHunks(shifted, hunks);
  assert.deepEqual(moved.conflicts, []);
  assert.equal(applyEditsToText(shifted, moved.edits), shifted.replace("return 3", "return 30"));
  const clobbered = rebaseHunks(FILE.replace("return 3", "return 333"), hunks);
  assert.deepEqual(clobbered.conflicts, [0]);
});

test("offset edits equal line edits, including insert/delete at end of file and CRLF", () => {
  const cases: Array<[string, string]> = [
    [FILE, FILE.replace("return 2", "return 2\n    # more")],
    [FILE, FILE + "tail = 1\n"],
    ["a\nb\nc", "a\nb"],
    ["a\nb\nc", "a\nb\nc\nd"],
    ["a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\nd\r\n"],
    ["a\nb\nc\n", "b\nc\n"],
  ];
  for (const [before, after] of cases) {
    const { edits } = rebaseHunks(before, computeHunks(before, after));
    let out = before;
    for (const e of toOffsetEdits(before, edits).reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    assert.equal(out, after, JSON.stringify([before, after]));
  }
});

test("paths: traversal, absolute escapes, .git and symlink escapes are rejected", () => {
  const root = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.py"), "x");
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
  assert.equal(resolveInWorkspace(root, "src/a.py").rel, "src/a.py");
  assert.equal(resolveInWorkspace(root, path.join(root, "src", "a.py")).rel, "src/a.py");
  for (const bad of ["../x", "src/../../x", path.join(outside, "secret.txt"), ".git/config", "", "."]) assert.throws(() => resolveInWorkspace(root, bad), PathError, bad);
  try {
    fs.symlinkSync(outside, path.join(root, "link"), "junction");
  } catch {
    return; // cannot create links here; the remaining assertions need one
  }
  assert.throws(() => resolveInWorkspace(root, "link/secret.txt"), /through a link/);
  const idx = new WorkspaceIndex(root);
  assert.equal(idx.search("secret", { capChars: 2000 }).snippets.length, 0, "search must not follow links out of the workspace");
});

function fixture() {
  const root = tmp();
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("src/app/billing.py", "class Invoice:\n    def total(self):\n        return sum(self.lines)\n\n\ndef format_currency(amount):\n    return f'${amount:.2f}'\n");
  write("src/app/cli.py", "import click\n\n@click.command('report')\ndef report_command():\n    '''Print the billing report.'''\n    click.echo('report')\n");
  write("tests/test_billing.py", "from app.billing import format_currency\n\ndef test_format_currency():\n    assert format_currency(1) == '$1.00'\n");
  write("docs/cli.rst", "Commands\n========\n\nThe ``report`` command prints the billing report.\n");
  write("node_modules/junk/index.js", "function format_currency() {}\n");
  write("README.md", "# Demo\n" + "filler line\n".repeat(400));
  return { root, write };
}

test("retrieval: ranks definitions first, explains why, skips dependency folders, respects the budget", () => {
  const { root } = fixture();
  const idx = new WorkspaceIndex(root);
  const pack = idx.search("where is format_currency defined and tested", { capChars: 1500 });
  assert.equal(pack.snippets[0].path, "src/app/billing.py");
  assert.match(pack.snippets[0].reason, /defines `format_currency`/);
  assert.ok(pack.snippets.some((s) => s.path === "tests/test_billing.py"));
  assert.ok(!pack.snippets.some((s) => s.path.startsWith("node_modules")));
  assert.ok(pack.usedChars <= 1500, `used ${pack.usedChars}`);
  const tiny = idx.search("billing report command", { capChars: 400 });
  assert.ok(tiny.usedChars <= 400 + 200, `used ${tiny.usedChars}`);
});

test("context assembly: @file and @symbol mentions come first, automatic retrieval fills the rest", () => {
  const { root } = fixture();
  const idx = new WorkspaceIndex(root);
  assert.deepEqual(parseMentions("fix @file:src/app/cli.py and @symbol:Invoice, also @format_currency."), [
    { kind: "file", value: "src/app/cli.py" },
    { kind: "symbol", value: "Invoice" },
    { kind: "auto", value: "format_currency" },
  ]);
  const pack = assembleContext(idx, "Add a refund command documented with the other commands @symbol:Invoice @file:tests/test_billing.py", 3000);
  assert.equal(pack.snippets[0].path, "src/app/billing.py");
  assert.match(pack.snippets[0].reason, /@symbol Invoice/);
  assert.equal(pack.snippets[1].path, "tests/test_billing.py");
  assert.ok(pack.snippets.some((s) => s.path === "docs/cli.rst" || s.path === "src/app/cli.py"), "auto retrieval should add unmentioned files");
  assert.ok(pack.usedChars <= 3000);
  assert.ok(extractTerms("Treat get_debug_flag and 'off' as false").some((t) => t.text === "get_debug_flag" && t.weight === 2));
});

test("proposals: partial acceptance stages only accepted hunks; apply and undo keep unrelated edits", () => {
  const root = tmp();
  const file = path.join(root, "m.py");
  fs.writeFileSync(file, FILE);
  let live: string | undefined;
  const store = new ProposalStore(() => root, { current: (rel) => live ?? fs.readFileSync(path.join(root, rel), "utf8") });
  store.activeRunId = "r1";
  const args = { path: "m.py", edits: [{ old_text: "    return 1", new_text: "    return 10" }, { old_text: "    return 3", new_text: "    return 30" }] };
  const p = store.propose("r1", "call1", args);
  assert.equal(p.hunks.length, 2);
  assert.throws(() => store.stage(args), ProposalError, "unreviewed proposals cannot be staged");
  p.decisions.set(0, true);
  p.decisions.set(1, false);
  p.state = "approved";
  assert.deepEqual(store.stage(args).staged, 1);
  assert.equal(fs.readFileSync(file, "utf8"), FILE, "staging must not touch disk");
  assert.ok(store.overlay("m.py")!.includes("return 10") && store.overlay("m.py")!.includes("return 3\n"));

  // The user adds an unrelated line before applying: the accepted hunk is rebased onto it.
  live = "# note\n" + FILE;
  const plan = store.planApply();
  assert.deepEqual(plan.conflicts, []);
  live = applyEditsToText(live, plan.files[0].edits);
  assert.equal(live, "# note\n" + FILE.replace("return 1", "return 10"));
  store.commitApplied(plan, () => live!);

  // Another unrelated edit after applying; undo reverts only the applied hunk.
  live = live.replace("return 2", "return 2  # mine");
  const undo = store.planUndo();
  live = applyEditsToText(live, undo.files[0].edits);
  assert.equal(live, "# note\n" + FILE.replace("return 2", "return 2  # mine"));
});

test("proposals: stale files, selection scope, path escapes and discarded runs", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "m.py"), FILE);
  let text = FILE;
  const store = new ProposalStore(() => root, { current: (rel) => (rel === "m.py" ? text : undefined) });
  store.activeRunId = "r1";
  const args = { path: "m.py", edits: [{ old_text: "    return 2", new_text: "    return 20" }] };

  assert.throws(() => store.propose("r1", "c", { path: "../evil.py", edits: args.edits }), /outside the workspace/);
  assert.throws(() => store.propose("r1", "c", { path: "missing.py", edits: args.edits }), /does not exist/);
  assert.throws(() => store.propose("r1", "c", args, { path: "m.py", startLine: 1, endLine: 2 }), /outside the selected lines/);
  assert.ok(store.propose("r1", "c", args, { path: "m.py", startLine: 4, endLine: 5 }));

  // File edited during review, edit still applies: preview regenerated. Edit target gone: stale.
  const p = store.propose("r1", "c2", args);
  text = "# header\n" + FILE;
  assert.equal(store.refresh(p), "regenerated");
  assert.equal(p.hunks[0].oldStart, 5);
  text = FILE.replace("return 2", "return 222");
  assert.equal(store.refresh(p), "stale");

  // Approved, then the file changes before TrueForge delivers the call: rejected, nothing staged.
  text = FILE;
  const q = store.propose("r1", "c3", args);
  q.decisions.set(0, true);
  q.state = "approved";
  text = FILE + "# changed\n";
  assert.throws(() => store.stage(args), /changed after this edit was proposed/);
  assert.equal(store.stagedFiles().length, 0);

  // A stopped or failed run leaves nothing behind, and its approvals cannot be reused.
  text = FILE;
  const r = store.propose("r1", "c4", args);
  r.decisions.set(0, true);
  r.state = "approved";
  store.stage(args);
  assert.equal(store.stagedFiles().length, 1);
  store.discardRun("r1");
  assert.equal(store.stagedFiles().length, 0);
  store.activeRunId = "r2";
  assert.throws(() => store.stage(args), /not been reviewed/);
});

test("run_tests only accepts allow-listed test commands without shell operators", () => {
  const allowed = ["python -m pytest", "pytest", "npm test"];
  assert.ok(validateTestCommand("pytest tests/test_cli.py -q", allowed).ok);
  assert.ok(validateTestCommand("python -m pytest tests/test_cli.py::test_x -k name", allowed).ok);
  for (const bad of ["pytest --pdb", "pytest tests -i", "rm -rf .", "pytest; rm -rf .", "pytest && curl x", "pytest > out.txt", "pytest $(whoami)", "pytest ../other", "pytest /etc/passwd", "pytest --rootdir=C:/Windows", "python -c print(1)", "pytestx"]) {
    assert.ok(!validateTestCommand(bad, allowed).ok, bad);
  }
});
