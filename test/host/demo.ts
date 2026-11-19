// Scripted demo for the Round 1 video. Runs inside a real VS Code window (scripts/record-demo.mjs)
// on the Flask fixture with the REAL TrueForge agent. It types the exact rulebook prompts into the
// extension's own input boxes, reviews hunks with the extension's own commands, and runs the
// verification commands in VS Code's terminal. It logs which stretches of the recording to keep;
// everything between them is model waiting time and is cut. The stretch from each prompt to its
// first diff is always kept whole.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import type { ForgeController } from "../../src/core/controller";
import type { Proposal } from "../../src/core/proposals";
import type { ReviewManager } from "../../src/review";
import type { AgentPanel } from "../../src/panel";

interface Api {
  controller: ForgeController;
  reviews: ReviewManager;
  panel: AgentPanel;
  setConfirmCommand(fn: (command: string) => Promise<boolean>): void;
}

const PROMPT_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const PROMPT_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
const PROMPT_STOP = "Without using any tools, write a very detailed 1500-word explanation of how get_debug_flag decides whether debug mode is on, with many examples.";

const LOG = process.env.DEMO_LOG!;
const REPO = process.env.DEMO_REPO!;
const DEMOAPP = process.env.DEMO_APP!;
const BASE = process.env.TRUEFORGE_URL ?? "http://localhost:8790";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (kind: string, label = "") => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), kind, label }) + "\n");
let keeping = false;
const keepStart = (label: string) => {
  if (keeping) return;
  keeping = true;
  log("keep-start", label);
};
const keepEnd = () => {
  if (!keeping) return;
  keeping = false;
  log("keep-end");
};

async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms: number): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

async function caption(text: string) {
  await vscode.commands.executeCommand("notifications.clearAll");
  void vscode.window.showInformationMessage(text);
}

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const ext = vscode.extensions.getExtension<Api>("team-tesla.tesla-forge")!;
  const api = await ext.activate();
  const { controller, reviews, panel } = api;
  const seen = new Set<string>();
  const nextProposal = () => reviews.pendingProposals().find((p) => p.state === "reviewing" && !seen.has(p.id));

  // ---- Layout -----------------------------------------------------------------------------
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(undefined, () => undefined);
  await vscode.commands.executeCommand("teslaForge.panel.focus");
  const term = vscode.window.createTerminal({ name: "verify", cwd: root, shellPath: "cmd.exe" });
  term.show(true);
  const sh = async (cmd: string, waitMs: number) => {
    term.show(true);
    term.sendText(cmd, true);
    await sleep(waitMs);
  };
  await sh("cls", 800);
  const helpers = vscode.Uri.file(path.join(root, "src", "flask", "helpers.py"));
  const selectDebugFlag = async () => {
    const doc = await vscode.workspace.openTextDocument(helpers);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(27, 0, 33, 0); // lines 28-33: get_debug_flag
    editor.revealRange(new vscode.Range(20, 0, 40, 0), vscode.TextEditorRevealType.AtTop);
    return editor;
  };
  await selectDebugFlag();
  await sleep(6000); // window settles; cut
  // Widen the agent panel once the window has focus.
  await vscode.commands.executeCommand("teslaForge.panel.focus");
  await vscode.commands.executeCommand("workbench.action.focusSideBar");
  for (let i = 0; i < 18; i++) {
    await vscode.commands.executeCommand("workbench.action.increaseViewWidth");
    await sleep(60);
  }
  await selectDebugFlag();
  await sleep(1500);
  log("ready");

  // ---- Task A: inline edit ------------------------------------------------------------------
  keepStart("A1");
  await caption("Task A · Inline edit. get_debug_flag is selected in src/flask/helpers.py. Pressing Ctrl+Alt+K and typing the instruction.");
  await sleep(2500);
  void vscode.commands.executeCommand("teslaForge.inlineEdit", { instruction: PROMPT_A, typeInstruction: true });
  const pa = await until("Task A proposal", nextProposal, 240_000);
  seen.add(pa.id);
  log("mark", "A-first-diff");
  await caption("Proposed diff in VS Code's diff editor, with Accept / Reject on every hunk. Nothing is written to disk yet.");
  await sleep(3500);
  await caption("Per-hunk review: reject hunk 1 (the preview reverts it), accept it again, then accept hunk 2.");
  await sleep(1500);
  reviews.decide(pa.id, pa.hunks[0].id, false);
  await sleep(1800);
  reviews.decide(pa.id, pa.hunks[0].id, true);
  await sleep(1200);
  for (const h of pa.hunks.slice(1)) {
    reviews.decide(pa.id, h.id, true);
    await sleep(900);
  }
  await until("Task A turn to finish", () => !controller.running, 120_000);
  await vscode.commands.executeCommand("notifications.clearAll");
  await caption("Apply accepted edits: one undoable WorkspaceEdit, then saved.");
  await controller.apply();
  await selectDebugFlag();
  await sleep(2500);
  await caption("Verify: FLASK_DEBUG=off now gives False.");
  await sh('cls && set FLASK_DEBUG=off&& .venv\\Scripts\\python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"', 4000);
  await caption("Undo the applied edit (Tesla Forge: Undo Last Applied Edit). Only the applied hunks are reverted.");
  await sleep(1200);
  await vscode.commands.executeCommand("teslaForge.undoApply");
  await selectDebugFlag();
  await sh("cls && git status --short && echo (undo restored the original file)", 3000);
  keepEnd();

  // ---- Task B: agent mode -------------------------------------------------------------------
  let shownRun = false;
  let confirmHook = async (command: string) => {
    if (shownRun) return true;
    shownRun = true;
    keepStart("B-run-tests");
    await caption(`The agent asks to run "${command}" (approved). Accepted edits are put in place for the run, then restored.`);
    await sleep(3000);
    keepEnd();
    return true;
  };
  api.setConfirmCommand((c) => confirmHook(c));
  controller.newChat();
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.commands.executeCommand("teslaForge.panel.focus");
  await sleep(800);
  keepStart("A2");
  await caption("Task B · Agent mode. The exact prompt, with no files named.");
  await sleep(2000);
  await panel.typeAndSend(PROMPT_B);
  let first = true;
  for (;;) {
    const p = await until("Task B proposal or end", () => nextProposal() ?? (!controller.running ? ("done" as const) : undefined), 600_000);
    if (p === "done") break;
    seen.add(p.id);
    if (first) {
      log("mark", "B-first-diff");
    } else keepStart(`B-review-${p.path}`);
    await caption(`Review ${p.path}: ${p.hunks.length} hunk(s). The panel shows the context it selected and every tool call.`);
    await sleep(first ? 4500 : 1200);
    for (const h of p.hunks) {
      reviews.decide(p.id, h.id, true);
      await sleep(first ? 900 : 300);
    }
    keepEnd();
    first = false;
  }
  keepStart("B4");
  await caption("Agent finished. Files it chose and why are listed in the panel. Opening the TrueForge session for this run.");
  await sleep(4000);
  if (controller.lastSession) {
    // A separate Edge app window with a fresh, empty profile (no tabs, history or sign-ins).
    const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
    const prof = path.join(os.tmpdir(), "forge-demo-edge-profile");
    const win = spawn(edge, [`--app=${BASE}/sessions/${controller.lastSession.id}`, `--user-data-dir=${prof}`, "--start-maximized", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--inprivate"], { stdio: "ignore" });
    await sleep(9000);
    if (win.pid) spawnSync("taskkill", ["/PID", String(win.pid), "/T", "/F"]);
    await sleep(1200);
  }
  await caption("Apply all accepted hunks across the files.");
  await controller.apply();
  await sleep(1500);
  await caption("Verify: changed files, tests, flask --help, and masked JSON from a synthetic app.");
  await sh("cls && git status --short", 2500);
  await sh(".venv\\Scripts\\python -m pytest tests/test_cli.py -q", 6000);
  await sh("cls && .venv\\Scripts\\flask --help", 3500);
  await sh(`cls && type "${DEMOAPP}" && .venv\\Scripts\\flask --app "${DEMOAPP}" config | .venv\\Scripts\\python -m json.tool`, 7000);
  keepEnd();

  // ---- Task C: resilience -------------------------------------------------------------------
  confirmHook = async () => false;
  await sh("git checkout -q . && cls", 2500); // clean fixture (cut)
  keepStart("B3");
  await caption("Task C · Resilience. Point the primary agent at an unreachable endpoint in TrueForge.");
  await sh(`npm --prefix "${REPO}" run -s setup:agent -- --add-unreachable-provider --model unreachable/model --fallback-model google-gemini/gemini-flash-lite-latest`, 1000);
  await until("agent to use the unreachable model", async () => {
    const r = (await fetch(`${BASE}/api/v1/agents?agent_name=tesla-forge`).then((x) => x.json()).catch(() => undefined)) as { data?: Array<{ name: string; manifest: { model: { name: string } } }> } | undefined;
    return (r?.data ?? []).some((a: { name: string; manifest: { model: { name: string } } }) => a.name === "tesla-forge" && a.manifest.model.name === "unreachable/model");
  }, 60_000);
  await sleep(2500);
  keepEnd();
  controller.newChat();
  keepStart("B3-run");
  await caption("Repeat Task A with the broken primary model.");
  const editorC = await selectDebugFlag();
  await sleep(1500);
  void vscode.commands.executeCommand("teslaForge.inlineEdit", { instruction: PROMPT_A, typeInstruction: true });
  await sleep(4000);
  await caption("The editor stays responsive while the agent recovers.");
  editorC.revealRange(new vscode.Range(0, 0, 10, 0), vscode.TextEditorRevealType.AtTop);
  await sleep(800);
  editorC.revealRange(new vscode.Range(20, 0, 40, 0), vscode.TextEditorRevealType.AtTop);
  const pc = await until("Task C proposal", nextProposal, 240_000);
  seen.add(pc.id);
  await vscode.commands.executeCommand("teslaForge.panel.focus");
  await caption("Primary failed (cannot connect), one retry, then automatic fallback to a second configured model. The result stays in preview.");
  await sleep(5500);
  reviews.decideAll(pc.id, false);
  await until("Task C turn to finish", () => !controller.running, 120_000);
  controller.discard();
  await vscode.commands.executeCommand("notifications.clearAll");
  await caption("Not applied. git status shows no files changed.");
  await sh("cls && git status", 3500);
  keepEnd();

  // ---- Stop during generation ---------------------------------------------------------------
  controller.newChat();
  keepStart("A3");
  await caption("Stop during an active generation.");
  await vscode.commands.executeCommand("teslaForge.panel.focus");
  await panel.typeAndSend(PROMPT_STOP);
  await until("streamed text", () => controller.transcript.some((t) => t.kind === "assistant" && t.text.length > 25) || !controller.running, 90_000).catch(() => undefined);
  await sleep(250);
  await vscode.commands.executeCommand("teslaForge.stop");
  await caption("Stopped immediately. The turn is cancelled in TrueForge and nothing was applied.");
  await sleep(2500);
  await sh("cls && git status", 3500);
  keepEnd();
  log("transcript", JSON.stringify(controller.transcript.filter((t) => t.kind === "notice").map((t) => (t as { text: string }).text)));
  log("done");
}
