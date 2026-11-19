import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { ForgeConfig, ForgeController, Host, InlineRequest } from "./core/controller";
import { toOffsetEdits } from "./core/hunks";
import { MCP_SERVER_NAME, startMcpServer } from "./core/mcpServer";
import { ApplyPlan } from "./core/proposals";
import { describeError } from "./core/runner";
import { AgentPanel } from "./panel";
import { ReviewManager, SCHEME } from "./review";

const MAX_TEXT_BYTES = 2_000_000;

export async function activate(context: vscode.ExtensionContext) {
  const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const relOf = (uri: vscode.Uri): string | undefined => {
    const r = root();
    if (!r || uri.scheme !== "file") return undefined;
    const rel = path.relative(r, uri.fsPath);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : undefined;
  };
  const config = (): ForgeConfig => {
    const c = vscode.workspace.getConfiguration("teslaForge");
    return {
      baseUrl: c.get<string>("trueforgeUrl", "http://localhost:8790").replace(/\/+$/, ""),
      agent: c.get<string>("agent", "tesla-forge"),
      fallbackAgent: c.get<string>("fallbackAgent", "tesla-forge-fallback"),
      contextBudgetChars: c.get<number>("contextBudgetChars", 24000),
      toolResponseCapChars: c.get<number>("toolResponseCapChars", 6000),
      maxRetries: c.get<number>("maxRetries", 1),
      testCommands: c.get<string[]>("testCommands", []),
      testTimeoutSeconds: c.get<number>("testTimeoutSeconds", 120),
    };
  };

  let confirmCommand = async (command: string): Promise<boolean> =>
    (await vscode.window.showWarningMessage(`Tesla Forge: the agent wants to run a test command in this workspace:\n\n${command}\n\nEdits you accepted in this turn are put in place for the run and restored afterwards.`, { modal: true }, "Run")) === "Run";
  // eslint-disable-next-line prefer-const
  let panel: AgentPanel | undefined;
  // eslint-disable-next-line prefer-const
  let reviews: ReviewManager;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "teslaForge.panel.focus";
  context.subscriptions.push(status);

  const host: Host = {
    config,
    root,
    source: {
      /** Unsaved editor content wins over disk, so proposals are always made against what the user sees. */
      current(rel) {
        const r = root();
        if (!r) return undefined;
        const abs = path.join(r, rel);
        const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && path.normalize(d.uri.fsPath).toLowerCase() === path.normalize(abs).toLowerCase());
        if (open) return open.getText();
        try {
          if (fs.statSync(abs).size > MAX_TEXT_BYTES) return undefined;
          const text = fs.readFileSync(abs, "utf8");
          return text.includes("\0") ? undefined : text;
        } catch {
          return undefined;
        }
      },
    },
    review: (p) => reviews.review(p),
    closeReviews: () => reviews.closeAll(),
    confirmCommand: (command) => confirmCommand(command),
    applyEdits,
    changed: () => {
      panel?.render();
      void vscode.commands.executeCommand("setContext", "teslaForge.running", controller.running);
      void vscode.commands.executeCommand("setContext", "teslaForge.canApply", controller.canApply);
      status.text = `${controller.running ? "$(sync~spin)" : "$(zap)"} Forge: ${controller.status.split("\n")[0].slice(0, 60)}`;
      status.show();
    },
  };
  const controller = new ForgeController(host);
  reviews = new ReviewManager(controller.store, () => host.changed());

  /** One text-only WorkspaceEdit for the whole accepted batch, then save. Undoable with Ctrl+Z. */
  async function applyEdits(plan: ApplyPlan): Promise<boolean> {
    const r = root();
    if (!r) return false;
    const edit = new vscode.WorkspaceEdit();
    const docs: vscode.TextDocument[] = [];
    for (const file of plan.files) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(r, file.path)));
      if (doc.getText() !== file.before) return false; // changed between planning and applying
      for (const e of toOffsetEdits(file.before, file.edits)) edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
      docs.push(doc);
    }
    if (!(await vscode.workspace.applyEdit(edit))) return false;
    for (const doc of docs) await doc.save();
    return true;
  }

  // ---- Workspace MCP server, registered with TrueForge as a connector --------------------
  let token = context.globalState.get<string>("mcpToken");
  if (!token) {
    token = randomBytes(18).toString("hex");
    await context.globalState.update("mcpToken", token);
  }
  const wantedPort = vscode.workspace.getConfiguration("teslaForge").get<number>("mcpPort", 8795);
  let mcp: Awaited<ReturnType<typeof startMcpServer>>;
  try {
    mcp = await startMcpServer(controller, wantedPort, token);
  } catch {
    mcp = await startMcpServer(controller, 0, token); // port taken (another window): use a free one
  }
  context.subscriptions.push({ dispose: () => void mcp.close() });

  let registeredFor: string | undefined;
  async function registerTools(force = false): Promise<string | undefined> {
    const cfg = config();
    const key = `${cfg.baseUrl}|${mcp.url}`;
    try {
      const client = new TrueForge({ baseUrl: cfg.baseUrl, timeoutInSeconds: 10 });
      await client.settings.mcpServers.createOrUpdate(
        { manifest: { type: "remote", name: MCP_SERVER_NAME, description: "The open VS Code workspace: ranked code search, bounded file reads, reviewed edit proposals, and approved local test runs.", url: mcp.url } },
        { maxRetries: 0 },
      );
      registeredFor = key;
      return undefined;
    } catch (err) {
      const message = describeError(err, cfg.baseUrl).message;
      return /Outbound URL blocked/i.test(message) ? `${message}. Start TrueForge with \`npm run trueforge\` from this repository so loopback tools are allowed.` : message;
    }
  }
  void registerTools();

  // Every request (panel or inline) first makes sure TrueForge knows where the workspace tools live.
  const sendCore = controller.send.bind(controller);
  controller.send = async (prompt: string, inline?: InlineRequest) => {
    const problem = await registerTools();
    if (problem) {
      controller.transcript.push({ kind: "user", text: prompt.trim() }, { kind: "notice", level: "error", text: `Could not reach TrueForge to register the workspace tools. No files were changed.\n${problem}` });
      controller.status = "Failed. No files were changed.";
      host.changed();
      return { status: "error" as const, error: problem, attempts: [] };
    }
    return sendCore(prompt, inline);
  };

  // ---- Inline edit -------------------------------------------------------------------------
  async function inlineEdit(arg?: { instruction?: string }) {
    const editor = vscode.window.activeTextEditor;
    const rel = editor ? relOf(editor.document.uri) : undefined;
    if (!editor || !rel) return void vscode.window.showWarningMessage("Tesla Forge: open a file from the workspace and select the code to edit.");
    if (editor.selection.isEmpty) return void vscode.window.showWarningMessage("Tesla Forge: select the code you want changed first.");
    if (controller.running) return void vscode.window.showWarningMessage("Tesla Forge: a run is already active. Stop it first.");
    const sel = editor.selection;
    const startLine = sel.start.line + 1;
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    const text = editor.document.getText(new vscode.Range(startLine - 1, 0, endLine - 1, editor.document.lineAt(endLine - 1).text.length));
    const instruction = arg?.instruction ?? (await vscode.window.showInputBox({ title: `Tesla Forge inline edit · ${rel}:${startLine}-${endLine}`, prompt: "Describe the change for the selected lines", ignoreFocusOut: true }));
    if (!instruction?.trim()) return;

    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Tesla Forge", cancellable: true }, async (progress, cancel) => {
      cancel.onCancellationRequested(() => void controller.stop());
      const tick = setInterval(() => progress.report({ message: controller.status }), 200);
      try {
        return await controller.send(instruction, { path: rel, startLine, endLine, text });
      } finally {
        clearInterval(tick);
      }
    });
    if (result?.status === "error") void vscode.window.showErrorMessage(`Tesla Forge: the edit could not be generated. No files were changed. ${result.error ?? ""}`);
    if (result?.status === "done" && controller.canApply) {
      const n = controller.store.stagedFiles().reduce((sum, f) => sum + f.hunks.length, 0);
      const choice = await vscode.window.showInformationMessage(`Tesla Forge: ${n} accepted hunk(s) ready for ${rel}.`, "Apply", "Discard");
      if (choice === "Apply") await controller.apply();
      if (choice === "Discard") controller.discard();
    }
    return result;
  }

  // ---- Registrations -----------------------------------------------------------------------
  panel = new AgentPanel(context.extensionUri, controller, reviews, (id) => `${config().baseUrl}/sessions/${id}`);
  const cmd = (name: string, fn: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("teslaForge.panel", panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, reviews),
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, reviews),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const rel = e.contentChanges.length ? relOf(e.document.uri) : undefined;
      if (rel) controller.documentChanged(rel);
    }),
  );
  cmd("teslaForge.inlineEdit", inlineEdit);
  cmd("teslaForge.stop", () => controller.stop());
  cmd("teslaForge.acceptHunk", (proposalId: string, hunkId: number) => (proposalId === undefined ? reviews.decideAtCursor(true) : reviews.decide(proposalId, hunkId, true)));
  cmd("teslaForge.rejectHunk", (proposalId: string, hunkId: number) => (proposalId === undefined ? reviews.decideAtCursor(false) : reviews.decide(proposalId, hunkId, false)));
  cmd("teslaForge.acceptAll", (proposalId?: string) => reviews.decideAll(proposalId, true));
  cmd("teslaForge.rejectAll", (proposalId?: string) => reviews.decideAll(proposalId, false));
  cmd("teslaForge.submitReview", () => reviews.submit());
  cmd("teslaForge.apply", () => controller.apply());
  cmd("teslaForge.undoApply", () => controller.undo());
  cmd("teslaForge.discard", () => controller.discard());
  cmd("teslaForge.newChat", () => controller.newChat());
  cmd("teslaForge.openSession", () => {
    if (!controller.lastSession) return void vscode.window.showInformationMessage("Tesla Forge: no TrueForge session yet. Send a request first.");
    return vscode.env.openExternal(vscode.Uri.parse(`${config().baseUrl}/sessions/${controller.lastSession.id}`));
  });
  cmd("teslaForge.registerTools", async () => {
    const problem = await registerTools(true);
    void (problem ? vscode.window.showErrorMessage(`Tesla Forge: ${problem}`) : vscode.window.showInformationMessage(`Tesla Forge: workspace tools registered with TrueForge as "${MCP_SERVER_NAME}".`));
  });
  host.changed();

  // Handle used by the extension-host test suite.
  return { controller, reviews, mcpUrl: mcp.url, registerTools, setConfirmCommand: (fn: (command: string) => Promise<boolean>) => (confirmCommand = fn) };
}

export function deactivate() {}
