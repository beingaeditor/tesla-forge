// Runs inside a real VS Code extension host (see scripts/host-test.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { ForgeController } from "../../src/core/controller";
import type { ReviewManager } from "../../src/review";

interface Api {
  controller: ForgeController;
  reviews: ReviewManager;
  mcpUrl: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | undefined | false, ms = 20000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const file = (rel: string) => vscode.Uri.file(path.join(root, rel));
  const disk = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  const original = { calc: disk("src/calc.py"), tests: disk("tests/test_calc.py"), docs: disk("docs/usage.md") };
  const ext = vscode.extensions.getExtension<Api>("team-tesla.tesla-forge")!;
  const api = await ext.activate();
  const { controller, reviews } = api;
  const setAgent = (name: string) => vscode.workspace.getConfiguration("teslaForge").update("agent", name, vscode.ConfigurationTarget.Workspace);
  const proposalTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === "tesla-forge-proposal");
  const notices = () => controller.transcript.filter((t) => t.kind === "notice").map((t) => (t as { text: string }).text).join("\n");
  const results: string[] = [];
  let failed = 0;
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await controller.stop();
      controller.discard();
      controller.newChat();
      await fn();
      results.push(`PASS  ${name}`);
    } catch (err) {
      failed++;
      results.push(`FAIL  ${name}\n      ${(err as Error).stack?.split("\n").slice(0, 5).join("\n      ")}\n      notices: ${notices()}`);
    }
  };

  await check("commands and keybinding are contributed", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const c of ["inlineEdit", "stop", "acceptHunk", "rejectHunk", "apply", "undoApply", "openSession"]) assert.ok(commands.includes(`teslaForge.${c}`), c);
    const bindings = ext.packageJSON.contributes.keybindings as Array<{ command: string; key: string }>;
    assert.ok(bindings.some((k) => k.command === "teslaForge.inlineEdit" && k.key));
  });

  await check("inline edit: selection -> streamed turn -> native diff with per-hunk lenses -> accept -> apply -> undo", async () => {
    const doc = await vscode.workspace.openTextDocument(file("src/calc.py"));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(5, 0, 8, 0); // def sub ... return a - b
    void vscode.commands.executeCommand("teslaForge.inlineEdit", { instruction: "Clarify the docstring" });
    const p = await until("a proposal under review", () => reviews.pendingProposals()[0]);
    const tab = await until("the diff tab", () => proposalTabs()[0]);
    const modified = (tab.input as vscode.TabInputTextDiff).modified;
    const preview = await vscode.workspace.openTextDocument(modified);
    assert.ok(preview.getText().includes("Return the difference a - b."), "diff right side shows the proposed text");
    let titles: string[] = [];
    for (let i = 0; i < 100 && !titles.length; i++) {
      const found = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", modified, 50);
      titles = (found ?? []).map((l) => l.command?.title ?? "");
      if (!titles.length) await sleep(50);
    }
    assert.ok(titles.some((t) => /Accept hunk 1\/1/.test(t)) && titles.some((t) => /Reject hunk 1\/1/.test(t)), titles.join(" | "));
    assert.equal(controller.running, true, "turn is paused in TrueForge while the user reviews");
    assert.equal(doc.getText(), original.calc, "nothing written during review");

    await vscode.commands.executeCommand("teslaForge.acceptHunk", p.id, p.hunks[0].id);
    await until("the turn to finish", () => !controller.running);
    assert.equal(controller.canApply, true);
    assert.ok(controller.transcript.some((t) => t.kind === "assistant" && t.text.includes("Docstring updated")), "assistant text streamed into the transcript");
    assert.equal(disk("src/calc.py"), original.calc, "still nothing on disk before Apply");

    await vscode.commands.executeCommand("teslaForge.apply");
    const applied = original.calc.replace("Return a - b.", "Return the difference a - b.");
    assert.equal(doc.getText(), applied);
    assert.equal(doc.isDirty, false, "applied edit is saved");
    assert.equal(disk("src/calc.py"), applied);

    // An unrelated manual edit, then the extension's undo: only the applied hunk is reverted.
    const manual = new vscode.WorkspaceEdit();
    manual.insert(doc.uri, new vscode.Position(0, 0), "# my own note\n");
    await vscode.workspace.applyEdit(manual);
    await doc.save();
    await vscode.commands.executeCommand("teslaForge.undoApply");
    assert.equal(doc.getText(), "# my own note\n" + original.calc);

    // Put the fixture back for the next checks.
    const reset = new vscode.WorkspaceEdit();
    reset.delete(doc.uri, new vscode.Range(0, 0, 1, 0));
    await vscode.workspace.applyEdit(reset);
    await doc.save();
  });

  await check("native Ctrl+Z also undoes an applied edit", async () => {
    const doc = await vscode.workspace.openTextDocument(file("src/calc.py"));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(5, 0, 8, 0);
    void vscode.commands.executeCommand("teslaForge.inlineEdit", { instruction: "Clarify the docstring" });
    const p = await until("a proposal", () => reviews.pendingProposals()[0]);
    await vscode.commands.executeCommand("teslaForge.acceptAll", p.id);
    await until("the turn to finish", () => !controller.running);
    await vscode.commands.executeCommand("teslaForge.apply");
    assert.notEqual(doc.getText(), original.calc);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("undo");
    assert.equal(doc.getText(), original.calc);
    await doc.save();
  });

  await check("agent mode: 3 files proposed, one hunk rejected, single apply across files", async () => {
    await setAgent("hosttest-multi");
    controller.newChat();
    const done = controller.send("Add a div function with a test and docs");
    const first = await until("calc.py proposal", () => reviews.pendingProposals().find((p) => p.path === "src/calc.py"));
    assert.equal(first.hunks.length, 2);
    await vscode.commands.executeCommand("teslaForge.rejectHunk", first.id, first.hunks[0].id);
    assert.equal(controller.running, true, "still paused: one hunk undecided");
    await vscode.commands.executeCommand("teslaForge.acceptHunk", first.id, first.hunks[1].id);
    for (const rel of ["tests/test_calc.py", "docs/usage.md"]) {
      const p = await until(`${rel} proposal`, () => reviews.pendingProposals().find((x) => x.path === rel));
      await vscode.commands.executeCommand("teslaForge.acceptAll", p.id);
    }
    const result = await done;
    assert.equal(result?.status, "done");
    await until("review tabs to close once decided", () => proposalTabs().length === 0);
    assert.deepEqual(controller.store.stagedFiles().map((f) => f.path).sort(), ["docs/usage.md", "src/calc.py", "tests/test_calc.py"]);
    assert.equal(disk("src/calc.py") + disk("tests/test_calc.py") + disk("docs/usage.md"), original.calc + original.tests + original.docs);
    const ctx = controller.transcript.find((t) => t.kind === "context");
    assert.ok(ctx && ctx.kind === "context" && ctx.pack.snippets.length > 0, "context selection is recorded for the panel");

    await vscode.commands.executeCommand("teslaForge.apply");
    assert.ok(disk("src/calc.py").includes("def div(a, b)") && disk("src/calc.py").includes('"""Return a + b."""'));
    assert.ok(disk("tests/test_calc.py").includes("test_div") && disk("docs/usage.md").includes("division"));
    await vscode.commands.executeCommand("teslaForge.undoApply");
    assert.equal(disk("src/calc.py") + disk("tests/test_calc.py") + disk("docs/usage.md"), original.calc + original.tests + original.docs);
  });

  await check("file edited during review: preview regenerates, then goes stale and is rejected", async () => {
    await setAgent("hosttest-inline");
    const doc = await vscode.workspace.openTextDocument(file("src/calc.py"));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(5, 0, 8, 0);
    void vscode.commands.executeCommand("teslaForge.inlineEdit", { instruction: "Clarify the docstring" });
    const p = await until("a proposal", () => reviews.pendingProposals()[0]);
    const line = p.hunks[0].oldStart;
    const clobber = new vscode.WorkspaceEdit();
    clobber.replace(doc.uri, new vscode.Range(6, 0, 6, doc.lineAt(6).text.length), '    """Something else entirely."""');
    await vscode.workspace.applyEdit(clobber);
    await until("the proposal to go stale", () => p.state === "stale");
    assert.equal(line, 6);
    await until("the turn to finish", () => !controller.running);
    assert.equal(controller.canApply, false);
    assert.match(notices(), /no longer applies/);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    assert.equal(disk("src/calc.py"), original.calc);
  });

  await check("Stop mid-stream: immediate, editor responsive, nothing changed", async () => {
    await setAgent("hosttest-chat");
    controller.newChat();
    const done = controller.send("Write a long explanation");
    await until("streamed tokens", () => controller.transcript.some((t) => t.kind === "assistant" && t.text.length > 20));
    const t0 = Date.now();
    await vscode.commands.executeCommand("teslaForge.stop");
    assert.equal(controller.running, false);
    assert.ok(Date.now() - t0 < 3000, `stop took ${Date.now() - t0} ms`);
    assert.equal((await done)?.status, "cancelled");
    assert.equal(controller.canApply, false);
    assert.equal(disk("src/calc.py") + disk("tests/test_calc.py") + disk("docs/usage.md"), original.calc + original.tests + original.docs);
  });

  await check("model failure (invalid key): clear error, editor responsive, workspace unchanged", async () => {
    await setAgent("hosttest-badkey");
    const doc = await vscode.workspace.openTextDocument(file("src/calc.py"));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(5, 0, 8, 0);
    const t0 = Date.now();
    void vscode.commands.executeCommand("teslaForge.inlineEdit", { instruction: "Clarify the docstring" });
    await until("the error notice", () => /No files were changed/.test(notices()) && !controller.running);
    assert.ok(Date.now() - t0 < 10000);
    assert.match(notices(), /401|API key/i);
    assert.equal(doc.getText(), original.calc);
    assert.equal(doc.isDirty, false);
    assert.equal(controller.canApply, false);
    await until("review tabs to close", () => proposalTabs().length === 0);
    // The editor still responds to commands after the failure.
    assert.ok((await vscode.commands.getCommands(true)).length > 0);
  });

  const report = results.join("\n") + `\n\n${results.length - failed}/${results.length} extension-host checks passed (VS Code ${vscode.version})`;
  console.log(report);
  fs.writeFileSync(path.join(root, "..", "forge-host-report.txt"), report);
  if (failed) throw new Error(`${failed} extension-host check(s) failed`);
}
