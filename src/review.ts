// Diff review inside VS Code: proposals are virtual documents shown in the native diff editor,
// with per-hunk Accept / Reject as CodeLens, title-bar buttons, and commands.
import * as vscode from "vscode";
import { applyHunks, previewLineOf } from "./core/hunks";
import { Proposal, ProposalStore } from "./core/proposals";

export const SCHEME = "tesla-forge-proposal";

type Side = "left" | "right";

export class ReviewManager implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private pending = new Map<string, { proposal: Proposal; resolve: () => void }>();
  private docChange = new vscode.EventEmitter<vscode.Uri>();
  private lensChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this.docChange.event;
  readonly onDidChangeCodeLenses = this.lensChange.event;

  constructor(
    private store: ProposalStore,
    private changed: () => void,
  ) {}

  private uri(kind: "p" | "staged", key: string, relPath: string, side: Side): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: "/" + relPath, query: `${kind}=${encodeURIComponent(key)}&side=${side}` });
  }

  private parse(uri: vscode.Uri): { proposalId?: string; staged?: string; side: Side } {
    const q = new URLSearchParams(uri.query);
    return { proposalId: q.get("p") ?? undefined, staged: q.get("staged") ?? undefined, side: (q.get("side") as Side) ?? "right" };
  }

  /** Hunks still in effect in the preview: everything the user has not rejected. */
  private kept(p: Proposal): Set<number> {
    return new Set(p.hunks.filter((h) => p.decisions.get(h.id) !== false).map((h) => h.id));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const { proposalId, staged, side } = this.parse(uri);
    if (staged) {
      const f = this.store.stagedFiles().find((x) => x.path === staged);
      return f ? (side === "left" ? f.baseText : f.stagedText) : "";
    }
    const p = proposalId ? (this.pending.get(proposalId)?.proposal ?? this.store.get(proposalId)) : undefined;
    if (!p) return "";
    return side === "left" ? p.baseText : applyHunks(p.baseText, p.hunks, this.kept(p));
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const { proposalId, side } = this.parse(document.uri);
    const p = proposalId ? this.pending.get(proposalId)?.proposal : undefined;
    if (!p || side !== "right" || p.state !== "reviewing") return [];
    const lines = previewLineOf(p.hunks, this.kept(p));
    const at = (line: number) => new vscode.Range(Math.min(line, document.lineCount - 1), 0, Math.min(line, document.lineCount - 1), 0);
    const lenses: vscode.CodeLens[] = [
      new vscode.CodeLens(at(0), { title: "$(check-all) Accept all hunks", command: "teslaForge.acceptAll", arguments: [p.id] }),
      new vscode.CodeLens(at(0), { title: "$(close-all) Reject all", command: "teslaForge.rejectAll", arguments: [p.id] }),
    ];
    p.hunks.forEach((h, i) => {
      const label = `hunk ${i + 1}/${p.hunks.length}`;
      const decision = p.decisions.get(h.id);
      const range = at(lines.get(h.id) ?? 0);
      if (decision !== true) lenses.push(new vscode.CodeLens(range, { title: `$(check) Accept ${label}`, command: "teslaForge.acceptHunk", arguments: [p.id, h.id] }));
      if (decision !== false) lenses.push(new vscode.CodeLens(range, { title: `$(close) Reject ${label}`, command: "teslaForge.rejectHunk", arguments: [p.id, h.id] }));
      if (decision !== undefined) lenses.push(new vscode.CodeLens(range, { title: decision ? "accepted" : "rejected (reverted in this preview)", command: "" }));
    });
    return lenses;
  }

  /** Start (or refresh) the review of a proposal. Resolves when every hunk has a decision or the review is closed. */
  review(p: Proposal): Promise<void> {
    const existing = this.pending.get(p.id);
    if (existing) {
      this.refresh(p);
      if (p.state === "stale") this.finish(p.id);
      else void this.openDiff(p);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pending.set(p.id, { proposal: p, resolve });
      this.updateContext();
      void this.openDiff(p);
    });
  }

  async openDiff(p: Proposal): Promise<void> {
    const title = `${p.path} — proposed change (${p.hunks.length} hunk${p.hunks.length === 1 ? "" : "s"})`;
    await vscode.commands.executeCommand("vscode.diff", this.uri("p", p.id, p.path, "left"), this.uri("p", p.id, p.path, "right"), title, { preview: false, preserveFocus: false });
  }

  async openStagedDiff(relPath: string): Promise<void> {
    await vscode.commands.executeCommand("vscode.diff", this.uri("staged", relPath, relPath, "left"), this.uri("staged", relPath, relPath, "right"), `${relPath} — accepted, not yet applied`, { preview: true });
  }

  private refresh(p: Proposal): void {
    this.docChange.fire(this.uri("p", p.id, p.path, "left"));
    this.docChange.fire(this.uri("p", p.id, p.path, "right"));
    this.lensChange.fire();
    this.changed();
  }

  private updateContext(): void {
    void vscode.commands.executeCommand("setContext", "teslaForge.reviewing", this.pending.size > 0);
  }

  private finish(proposalId: string): void {
    const entry = this.pending.get(proposalId);
    if (!entry) return;
    this.pending.delete(proposalId);
    this.updateContext();
    this.lensChange.fire();
    entry.resolve();
    void this.closeTabs((q) => q.get("p") === proposalId);
  }

  decide(proposalId: string, hunkId: number, accept: boolean): void {
    const p = this.pending.get(proposalId)?.proposal;
    if (!p || p.state !== "reviewing" || !p.hunks.some((h) => h.id === hunkId)) return;
    p.decisions.set(hunkId, accept);
    this.refresh(p);
    if (p.hunks.every((h) => p.decisions.has(h.id))) this.finish(proposalId);
  }

  decideAll(proposalId: string | undefined, accept: boolean): void {
    const p = this.pending.get(proposalId ?? this.activeProposalId() ?? "")?.proposal;
    if (!p || p.state !== "reviewing") return;
    for (const h of p.hunks) p.decisions.set(h.id, accept);
    this.refresh(p);
    this.finish(p.id);
  }

  /** Finish the review now; undecided hunks count as rejected. */
  submit(proposalId?: string): void {
    const p = this.pending.get(proposalId ?? this.activeProposalId() ?? "")?.proposal;
    if (!p) return;
    for (const h of p.hunks) if (!p.decisions.has(h.id)) p.decisions.set(h.id, false);
    this.finish(p.id);
  }

  /** Accept or reject the hunk under the cursor in the active proposal diff (title-bar buttons, keybindings). */
  decideAtCursor(accept: boolean): void {
    const editor = vscode.window.activeTextEditor;
    const id = this.activeProposalId();
    const p = id ? this.pending.get(id)?.proposal : undefined;
    if (!editor || !p) return;
    const lines = previewLineOf(p.hunks, this.kept(p));
    const cursor = editor.selection.active.line;
    let best = p.hunks[0];
    for (const h of p.hunks) if ((lines.get(h.id) ?? 0) <= cursor) best = h;
    const undecided = p.hunks.find((h) => !p.decisions.has(h.id));
    this.decide(p.id, (p.decisions.has(best.id) && undecided ? undecided : best).id, accept);
  }

  private activeProposalId(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const fromEditor = uri?.scheme === SCHEME ? this.parse(uri).proposalId : undefined;
    return fromEditor ?? (this.pending.size === 1 ? [...this.pending.keys()][0] : undefined);
  }

  pendingProposals(): Proposal[] {
    return [...this.pending.values()].map((e) => e.proposal);
  }

  /** The run ended or was stopped: release every waiting review and remove the previews. */
  closeAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id);
    void this.closeTabs(() => true);
  }

  private async closeTabs(match: (query: URLSearchParams) => boolean): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => {
      const input = t.input;
      return input instanceof vscode.TabInputTextDiff && input.modified.scheme === SCHEME && match(new URLSearchParams(input.modified.query));
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }
}
