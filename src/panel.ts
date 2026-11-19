// The agent panel: a webview that renders controller state and sends user actions back.
import * as vscode from "vscode";
import { ForgeController } from "./core/controller";
import { ReviewManager } from "./review";

export class AgentPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private extensionUri: vscode.Uri,
    private controller: ForgeController,
    private reviews: ReviewManager,
    private sessionUrl: (id: string) => string,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<div id="top"><span id="status"></span><span id="session"></span></div>
<div id="log"></div>
<div id="review"></div>
<div id="actions"></div>
<div id="composer">
<textarea id="input" rows="3" placeholder="Ask the agent to change this workspace. @file:path and @symbol:name add explicit context."></textarea>
<div id="buttons"><button id="send">Send</button><button id="stop" class="secondary">Stop</button><button id="new" class="secondary" title="Start a new TrueForge session">New chat</button></div>
</div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidDispose(() => (this.view = undefined));
    this.render();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onMessage(m: any): void {
    switch (m?.type) {
      case "ready":
        return this.render();
      case "send":
        return void this.controller.send(String(m.text ?? ""));
      case "stop":
        return void this.controller.stop();
      case "new":
        return this.controller.newChat();
      case "apply":
        return void this.controller.apply();
      case "undo":
        return void this.controller.undo();
      case "discard":
        return this.controller.discard();
      case "hunk":
        return this.reviews.decide(String(m.proposal), Number(m.hunk), Boolean(m.accept));
      case "all":
        return this.reviews.decideAll(String(m.proposal), Boolean(m.accept));
      case "openDiff": {
        const p = this.reviews.pendingProposals().find((x) => x.id === m.proposal);
        return void (p ? this.reviews.openDiff(p) : undefined);
      }
      case "openStaged":
        return void this.reviews.openStagedDiff(String(m.path));
      case "openSession":
        return void vscode.commands.executeCommand("teslaForge.openSession");
    }
  }

  /** Coalesce bursts of streamed tokens into one repaint per frame. */
  /** For the recorded demo: type the text into the panel's input box visibly, then send it. */
  async typeAndSend(text: string): Promise<void> {
    if (!this.view) throw new Error("The agent panel is not open.");
    await this.view.webview.postMessage({ type: "demoType", text });
    await new Promise((r) => setTimeout(r, text.length * 18 + 900));
  }

  render(): void {
    if (!this.view || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.view?.webview.postMessage({ type: "state", state: this.snapshot() });
    }, 40);
  }

  snapshot(): unknown {
    const c = this.controller;
    const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n) + " …" : s);
    return {
      running: c.running,
      status: c.status,
      canApply: c.canApply,
      canUndo: c.canUndo,
      session: c.lastSession ? { ...c.lastSession, url: this.sessionUrl(c.lastSession.id) } : undefined,
      transcript: c.transcript.map((t) => {
        if (t.kind === "context") {
          const files = new Map<string, { path: string; reason: string; lines: string[]; chars: number }>();
          for (const s of t.pack.snippets) {
            const f = files.get(s.path) ?? { path: s.path, reason: s.reason, lines: [], chars: 0 };
            f.lines.push(`${s.startLine}-${s.endLine}`);
            f.chars += s.text.length;
            files.set(s.path, f);
          }
          return { kind: "context", used: t.pack.usedChars, budget: t.pack.budgetChars, candidates: t.pack.candidates, notes: t.pack.notes, files: [...files.values()] };
        }
        if (t.kind === "tool") return { kind: "tool", id: t.id, tool: t.call.tool, via: t.call.via, state: t.state, args: clip(JSON.stringify(t.call.tool === "propose_edit" ? { path: t.call.args.path, summary: t.call.args.summary } : t.call.args), 300), result: clip(t.result?.split("--- excerpts")[0], 1400) };
        return t;
      }),
      proposals: this.reviews.pendingProposals().filter((p) => p.state === "reviewing").map((p) => ({
        id: p.id,
        path: p.path,
        summary: p.summary,
        hunks: p.hunks.map((h) => ({ id: h.id, line: h.oldStart + 1, oldLines: h.oldLines, newLines: h.newLines, decision: p.decisions.get(h.id) })),
      })),
      staged: c.store.stagedFiles().map((f) => ({ path: f.path, hunks: f.hunks.length })),
    };
  }
}
