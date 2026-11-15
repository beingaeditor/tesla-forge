// In-memory edit proposals. Nothing in this file writes to disk: proposals are reviewed,
// accepted hunks are staged, and the editor applies the staged result only when the user says so.
import { createHash } from "node:crypto";
import { Hunk, LineEdit, SearchReplace, applyHunks, applySearchReplace, computeHunks, rebaseHunks } from "./hunks";
import { resolveInWorkspace } from "./paths";

export class ProposalError extends Error {}

export interface TextSource {
  /** Current editor content (unsaved changes included) or disk content; undefined if the file is missing or not text. */
  current(rel: string): string | undefined;
}

export interface Scope {
  path: string;
  /** 1-based inclusive line range of the user's selection. */
  startLine: number;
  endLine: number;
}

export interface Proposal {
  id: string;
  runId: string;
  toolCallId: string;
  path: string;
  summary: string;
  key: string;
  edits: SearchReplace[];
  /** Text the hunks are relative to: the staged text for this file if any, otherwise the editor text. */
  baseText: string;
  proposedText: string;
  hunks: Hunk[];
  decisions: Map<number, boolean>;
  state: "reviewing" | "approved" | "denied" | "staged" | "stale";
  scope?: Scope;
}

interface StagedFile {
  path: string;
  /** Editor text when the first hunk for this file was staged. */
  baseText: string;
  stagedText: string;
  journal: Array<{ runId: string; previous: string | undefined }>;
}

export interface ApplyPlan {
  files: Array<{ path: string; edits: LineEdit[]; before: string }>;
  conflicts: Array<{ path: string; hunks: number }>;
}

interface AppliedFile {
  path: string;
  before: string;
  after: string;
}

const stripLineNumbers = (text: string): string => {
  const lines = text.split(/\r?\n/);
  const body = lines.filter((l) => l.trim());
  if (!body.length || !body.every((l) => /^\s*\d+\| ?/.test(l))) return text;
  return lines.map((l) => l.replace(/^\s*\d+\| ?/, "")).join("\n");
};

export class ProposalStore {
  private proposals = new Map<string, Proposal>();
  private staged = new Map<string, StagedFile>();
  private approvedCommands = new Set<string>();
  private lastApplied: AppliedFile[] = [];
  private seq = 0;
  activeRunId: string | undefined;

  constructor(
    private root: () => string,
    private source: TextSource,
  ) {}

  private key(rel: string, edits: SearchReplace[]): string {
    return createHash("sha256").update(JSON.stringify([rel, edits.map((e) => [e.old_text, e.new_text])])).digest("hex");
  }

  private parse(args: unknown): { rel: string; edits: SearchReplace[]; summary: string } {
    const a = (args ?? {}) as { path?: unknown; edits?: unknown; summary?: unknown };
    if (typeof a.path !== "string") throw new ProposalError("propose_edit needs a `path` string.");
    if (!Array.isArray(a.edits) || !a.edits.length) throw new ProposalError("propose_edit needs a non-empty `edits` array of {old_text, new_text}.");
    const edits = a.edits.map((e: { old_text?: unknown; new_text?: unknown }) => {
      if (typeof e?.old_text !== "string" || typeof e?.new_text !== "string") throw new ProposalError("Every edit needs string `old_text` and `new_text`.");
      return { old_text: stripLineNumbers(e.old_text), new_text: stripLineNumbers(e.new_text) };
    });
    let rel: string;
    try {
      rel = resolveInWorkspace(this.root(), a.path).rel;
    } catch (err) {
      throw new ProposalError((err as Error).message);
    }
    return { rel, edits, summary: typeof a.summary === "string" ? a.summary : "" };
  }

  /** Validate a model-proposed edit and turn it into reviewable hunks. Throws ProposalError with a message for the model. */
  propose(runId: string, toolCallId: string, args: unknown, scope?: Scope): Proposal {
    const { rel, edits, summary } = this.parse(args);
    if (scope && scope.path !== rel) throw new ProposalError(`This is an inline edit of ${scope.path}; only that file may be changed.`);
    const current = this.source.current(rel);
    if (current === undefined) throw new ProposalError(`${rel} does not exist or is not a text file. Only existing text files can be edited.`);
    const baseText = this.staged.get(rel)?.stagedText ?? current;
    const result = applySearchReplace(baseText, edits);
    if (!result.ok) throw new ProposalError(`${rel}: ${result.error}`);
    const hunks = computeHunks(baseText, result.text);
    if (!hunks.length) throw new ProposalError(`${rel}: the edit does not change the file.`);
    if (scope) {
      const outside = hunks.find((h) => h.oldStart < scope.startLine - 1 || h.oldStart + h.oldLines.length > scope.endLine);
      if (outside) throw new ProposalError(`The edit changes line ${outside.oldStart + 1}, outside the selected lines ${scope.startLine}-${scope.endLine}. Keep every change inside the selection.`);
    }
    const proposal: Proposal = {
      id: `p${++this.seq}`, runId, toolCallId, path: rel, summary, key: this.key(rel, edits), edits,
      baseText, proposedText: result.text, hunks, decisions: new Map(), state: "reviewing", scope,
    };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  all(): Proposal[] {
    return [...this.proposals.values()];
  }

  accepted(p: Proposal): Set<number> {
    return new Set(p.hunks.filter((h) => p.decisions.get(h.id) === true).map((h) => h.id));
  }

  /**
   * The file changed while its proposal was under review. Re-run the proposal's edits on the new
   * text; if they still apply unambiguously the preview is regenerated, otherwise it is stale.
   */
  refresh(p: Proposal): "unchanged" | "regenerated" | "stale" {
    if (p.state !== "reviewing") return "unchanged";
    const current = this.source.current(p.path);
    const base = this.staged.get(p.path)?.stagedText ?? current;
    if (base === p.baseText) return "unchanged";
    const result = base === undefined ? undefined : applySearchReplace(base, p.edits);
    const hunks = result?.ok ? computeHunks(base!, result.text) : [];
    const inScope = !p.scope || hunks.every((h) => h.oldStart >= p.scope!.startLine - 1);
    if (!result?.ok || !hunks.length || !inScope) {
      p.state = "stale";
      return "stale";
    }
    Object.assign(p, { baseText: base, proposedText: result.text, hunks, decisions: new Map() });
    return "regenerated";
  }

  /** Called by the propose_edit tool once TrueForge has delivered the approved call. */
  stage(args: unknown): { proposal: Proposal; staged: number; rejected: number } {
    const { rel, edits } = this.parse(args);
    const key = this.key(rel, edits);
    const p = this.all().find((x) => x.key === key && x.state === "approved" && x.runId === this.activeRunId);
    if (!p) throw new ProposalError("This exact edit has not been reviewed and approved in the editor, so nothing was changed.");
    const existing = this.staged.get(rel);
    const live = existing?.stagedText ?? this.source.current(rel);
    if (live !== p.baseText) {
      p.state = "stale";
      throw new ProposalError(`${rel} changed after this edit was proposed, so it was not staged. Read the file again and propose a fresh edit.`);
    }
    const accepted = this.accepted(p);
    this.staged.set(rel, {
      path: rel,
      baseText: existing?.baseText ?? p.baseText,
      stagedText: applyHunks(p.baseText, p.hunks, accepted),
      journal: [...(existing?.journal ?? []), { runId: p.runId, previous: existing?.stagedText }],
    });
    p.state = "staged";
    return { proposal: p, staged: accepted.size, rejected: p.hunks.length - accepted.size };
  }

  /** Forget everything a run produced: its proposals, and any hunks it staged. */
  discardRun(runId: string): void {
    for (const [id, p] of this.proposals) if (p.runId === runId) this.proposals.delete(id);
    for (const [rel, file] of this.staged) {
      const first = file.journal.findIndex((j) => j.runId === runId);
      if (first < 0) continue;
      const previous = file.journal[first].previous;
      if (previous === undefined) this.staged.delete(rel);
      else this.staged.set(rel, { ...file, stagedText: previous, journal: file.journal.slice(0, first) });
    }
    for (const c of [...this.approvedCommands]) if (c.startsWith(runId + "\n")) this.approvedCommands.delete(c);
  }

  discardAll(): void {
    this.proposals.clear();
    this.staged.clear();
    this.approvedCommands.clear();
  }

  /** Staged (accepted but not yet applied) content, so later reads and edits in the run see it. */
  overlay(rel: string): string | undefined {
    return this.staged.get(rel)?.stagedText;
  }

  stagedFiles(): Array<{ path: string; hunks: Hunk[]; baseText: string; stagedText: string }> {
    return [...this.staged.values()].map((f) => ({ path: f.path, hunks: computeHunks(f.baseText, f.stagedText), baseText: f.baseText, stagedText: f.stagedText })).filter((f) => f.hunks.length);
  }

  /** Line edits that put every staged hunk onto the current editor text, or the conflicts that prevent it. */
  planApply(): ApplyPlan {
    const plan: ApplyPlan = { files: [], conflicts: [] };
    for (const f of this.stagedFiles()) {
      const before = this.source.current(f.path);
      if (before === undefined) {
        plan.conflicts.push({ path: f.path, hunks: f.hunks.length });
        continue;
      }
      const { edits, conflicts } = rebaseHunks(before, f.hunks);
      if (conflicts.length) plan.conflicts.push({ path: f.path, hunks: conflicts.length });
      else plan.files.push({ path: f.path, edits, before });
    }
    return plan;
  }

  commitApplied(plan: ApplyPlan, after: (rel: string) => string): void {
    this.lastApplied = plan.files.map((f) => ({ path: f.path, before: f.before, after: after(f.path) }));
    this.proposals.clear();
    this.staged.clear();
  }

  canUndo(): boolean {
    return this.lastApplied.length > 0;
  }

  /** Reverse only the hunks that were applied; edits made elsewhere in the file since then are kept. */
  planUndo(): ApplyPlan {
    const plan: ApplyPlan = { files: [], conflicts: [] };
    for (const f of this.lastApplied) {
      const now = this.source.current(f.path);
      const inverse = computeHunks(f.after, f.before);
      if (now === undefined) {
        plan.conflicts.push({ path: f.path, hunks: inverse.length });
        continue;
      }
      const { edits, conflicts } = rebaseHunks(now, inverse);
      if (conflicts.length) plan.conflicts.push({ path: f.path, hunks: conflicts.length });
      if (edits.length) plan.files.push({ path: f.path, edits, before: now });
    }
    return plan;
  }

  commitUndone(): void {
    this.lastApplied = [];
  }

  approveCommand(runId: string, command: string): void {
    this.approvedCommands.add(`${runId}\n${command.trim()}`);
  }

  consumeCommand(command: string): boolean {
    return this.activeRunId !== undefined && this.approvedCommands.delete(`${this.activeRunId}\n${command.trim()}`);
  }
}
