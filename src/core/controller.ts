// Editor-independent orchestration: one run at a time, review decisions, cancellation, apply and undo.
// The VS Code layer (and the headless integration test) plug in through the Host interface.
import path from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { GATED_TOOLS, MCP_SERVER_NAME, ToolHost } from "./mcpServer";
import { ApplyPlan, Proposal, ProposalError, ProposalStore, Scope, TextSource } from "./proposals";
import { ContextPack, Snippet, WorkspaceIndex, assembleContext, renderContext } from "./retrieval";
import { AgentRun, ApprovalDecision, Attempt, RunResult, ToolCallInfo } from "./runner";
import { validateTestCommand } from "./testCommand";

export interface ForgeConfig {
  baseUrl: string;
  agent: string;
  fallbackAgent: string;
  contextBudgetChars: number;
  toolResponseCapChars: number;
  maxRetries: number;
  backoffMs?: number;
  testCommands: string[];
  testTimeoutSeconds: number;
}

export interface Host {
  config(): ForgeConfig;
  root(): string | undefined;
  source: TextSource;
  /** Show the proposal for per-hunk review; resolve once the user has decided (decisions live on the proposal). */
  review(p: Proposal): Promise<void>;
  /** A run ended or was stopped: resolve pending reviews and remove their previews. */
  closeReviews(): void;
  confirmCommand(command: string): Promise<boolean>;
  /** Apply every file's line edits as one undoable editor edit and save. Returns false if the editor refused. */
  applyEdits(plan: ApplyPlan): Promise<boolean>;
  changed(): void;
}

export type TranscriptItem =
  | { kind: "user"; text: string; inline?: string }
  | { kind: "context"; pack: ContextPack }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "tool"; id: string; call: ToolCallInfo; result?: string; state: "called" | "awaiting review" | "done" | "denied" }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string };

export interface InlineRequest {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export class ForgeController implements ToolHost {
  readonly store: ProposalStore;
  transcript: TranscriptItem[] = [];
  running = false;
  status = "Idle";
  sessionId: string | undefined;
  lastSession: { id: string; agent: string } | undefined;
  private run: AgentRun | undefined;
  private scope: Scope | undefined;
  private idx: WorkspaceIndex | undefined;
  private idxRoot: string | undefined;
  private idle: Array<() => void> = [];

  constructor(private host: Host) {
    this.store = new ProposalStore(() => host.root() ?? "", host.source);
  }

  // ---- ToolHost -------------------------------------------------------------------------
  root(): string | undefined {
    return this.host.root();
  }
  index(): WorkspaceIndex {
    const root = this.host.root() ?? "";
    if (!this.idx || this.idxRoot !== root) {
      this.idxRoot = root;
      // Staged hunks win over unsaved editor content, which wins over disk.
      this.idx = new WorkspaceIndex(root, (rel) => this.store.overlay(rel) ?? this.host.source.current(rel));
    }
    return this.idx;
  }
  toolCapChars(): number {
    return this.host.config().toolResponseCapChars;
  }
  testConfig(): { allowed: string[]; timeoutMs: number } {
    const c = this.host.config();
    return { allowed: c.testCommands, timeoutMs: c.testTimeoutSeconds * 1000 };
  }
  runSignal(): AbortSignal | undefined {
    return this.run?.signal;
  }

  // ---- State helpers --------------------------------------------------------------------
  get canApply(): boolean {
    return !this.running && this.store.stagedFiles().length > 0;
  }
  get canUndo(): boolean {
    return !this.running && this.store.canUndo();
  }
  private note(level: "info" | "warn" | "error", text: string): void {
    this.transcript.push({ kind: "notice", level, text });
    this.host.changed();
  }
  /** Resolves when no run is active (used by tests). */
  whenIdle(): Promise<void> {
    return this.running ? new Promise((resolve) => this.idle.push(resolve)) : Promise.resolve();
  }

  newChat(): void {
    if (this.running) return;
    this.sessionId = undefined;
    this.transcript = [];
    this.status = "Idle";
    this.host.changed();
  }

  // ---- Running a request ----------------------------------------------------------------
  async send(prompt: string, inline?: InlineRequest): Promise<RunResult | undefined> {
    const text = prompt.trim();
    if (!text || this.running) return undefined;
    const cfg = this.host.config();
    if (!this.host.root()) {
      this.note("error", "Open a folder first: the agent works on the active workspace.");
      return undefined;
    }
    this.running = true;
    this.status = "Selecting context…";
    this.transcript.push({ kind: "user", text, inline: inline ? `${inline.path}:${inline.startLine}-${inline.endLine}` : undefined });
    this.host.changed();

    let content: string;
    try {
      this.index().invalidate();
      const pinned: Snippet[] = inline
        ? [{ path: inline.path, startLine: inline.startLine, endLine: inline.endLine, reason: "the user's selection", text: inline.text.split(/\r?\n/).map((l, i) => `${String(inline.startLine + i).padStart(4)}| ${l}`).join("\n") }]
        : [];
      // Inline edits are about the selection: only explicit @mentions are added to it.
      const pack = assembleContext(this.index(), inline ? (text.match(/(?:^|\s)@\S+/g) ?? []).join(" ") : text, cfg.contextBudgetChars, pinned);
      this.transcript.push({ kind: "context", pack });
      const request = inline
        ? `Inline edit of ${inline.path} lines ${inline.startLine}-${inline.endLine}: ${text}\n\n<inline-edit file="${inline.path}" selected_lines="${inline.startLine}-${inline.endLine}">\nThe user selected lines ${inline.startLine}-${inline.endLine} of ${inline.path} (shown below) and gave this instruction:\n${text}\n\nMake the change with one propose_edit call on ${inline.path}. Every changed line must be inside the selected lines. Do not edit other files and do not run tests.\n</inline-edit>`
        : text;
      // The request goes first so the TrueForge session is titled by what the user asked.
      content = [request, renderContext(pack)].filter(Boolean).join("\n\n");
    } catch (err) {
      this.running = false;
      this.note("error", `Could not read the workspace: ${(err as Error).message}`);
      return undefined;
    }

    this.scope = inline ? { path: inline.path, startLine: inline.startLine, endLine: inline.endLine } : undefined;
    const client = new TrueForge({ baseUrl: cfg.baseUrl, timeoutInSeconds: 600 });
    const run = new AgentRun(
      client,
      cfg.baseUrl,
      {
        agent: cfg.agent,
        fallbackAgent: cfg.fallbackAgent || undefined,
        sessionId: inline ? undefined : this.sessionId,
        prompt: content,
        maxRetries: cfg.maxRetries,
        backoffMs: cfg.backoffMs,
        metadata: { source: "tesla-forge-vscode", mode: inline ? "inline-edit" : "agent", workspace: path.basename(this.host.root()!) },
      },
      {
        attemptStarted: (a) => {
          this.store.activeRunId = a.runId;
          if (a.kind === "fallback") this.note("warn", `Primary agent failed. Automatically falling back to agent "${a.agent}" in a fresh TrueForge session.`);
          if (a.kind === "retry") this.note("info", `Retrying with agent "${a.agent}" in a fresh TrueForge session.`);
        },
        attemptFailed: (a, next) => {
          // Nothing proposed or staged by a failed attempt may leak into the next one.
          this.host.closeReviews();
          this.store.discardRun(a.runId);
          this.store.activeRunId = undefined;
          if (next) this.note("warn", `Model call failed (${a.error}); ${next}.`);
        },
        status: (s) => {
          this.status = s;
          this.host.changed();
        },
        textDelta: (id, delta) => {
          const last = this.transcript[this.transcript.length - 1];
          if (last?.kind === "assistant" && last.id === id) last.text += delta;
          else this.transcript.push({ kind: "assistant", id, text: delta });
          this.host.changed();
        },
        toolCall: (call) => {
          this.transcript.push({ kind: "tool", id: call.id, call, state: "called" });
          this.host.changed();
        },
        toolResult: (id, result) => {
          const item = this.findTool(id);
          if (item) {
            item.result = result;
            if (item.state !== "denied") item.state = "done";
          }
          this.host.changed();
        },
        approval: (attempt, call) => this.decide(attempt, call),
      },
    );
    this.run = run;
    const result = await run.start();
    if (this.run !== run) return result; // stopped: stop() already cleaned up

    const final = result.final;
    this.run = undefined;
    this.running = false;
    this.store.activeRunId = undefined;
    this.host.closeReviews();
    if (final?.sessionId) this.lastSession = { id: final.sessionId, agent: final.agent };
    if (result.status === "done") {
      if (!inline) this.sessionId = final?.sessionId;
      const staged = this.store.stagedFiles();
      const hunks = staged.reduce((n, f) => n + f.hunks.length, 0);
      this.status = staged.length ? `Done. ${hunks} accepted hunk(s) in ${staged.length} file(s) ready to apply.` : "Done.";
      if (final?.kind === "fallback") this.note("info", `Completed by fallback agent "${final.agent}".`);
    } else if (result.status === "error") {
      for (const a of result.attempts) this.store.discardRun(a.runId);
      if (!inline) this.sessionId = undefined;
      this.status = "Failed. No files were changed.";
      this.note("error", `The agent could not complete this request. No files were changed.\n${result.error}`);
    }
    this.finish();
    return result;
  }

  private findTool(id: string): Extract<TranscriptItem, { kind: "tool" }> | undefined {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const t = this.transcript[i];
      if (t.kind === "tool" && t.id === id) return t;
    }
    return undefined;
  }

  private finish(): void {
    this.scope = undefined;
    this.host.changed();
    this.idle.splice(0).forEach((resolve) => resolve());
  }

  /** TrueForge paused the turn on a gated tool call; the answer is the user's review. */
  private async decide(attempt: Attempt, call: ToolCallInfo): Promise<ApprovalDecision> {
    const item = this.findTool(call.id);
    const deny = (reason: string): ApprovalDecision => {
      if (item) item.state = "denied";
      this.host.changed();
      return { allow: false, reason };
    };
    if (call.server !== MCP_SERVER_NAME || !GATED_TOOLS.includes(call.tool)) {
      return call.server === MCP_SERVER_NAME ? { allow: true } : deny("Only the editor's workspace tools can be approved from VS Code.");
    }
    if (item) item.state = "awaiting review";
    this.host.changed();

    if (call.tool === "run_tests") {
      const command = String(call.args.command ?? "");
      if (this.scope) return deny("Tests are not run during an inline edit.");
      const v = validateTestCommand(command, this.host.config().testCommands);
      if (!v.ok) return deny(v.error);
      if (!(await this.host.confirmCommand(command))) return deny("The user declined to run this command.");
      this.store.approveCommand(attempt.runId, command);
      return { allow: true };
    }

    let proposal: Proposal;
    try {
      proposal = this.store.propose(attempt.runId, call.id, call.args, this.scope);
    } catch (err) {
      if (err instanceof ProposalError) return deny(err.message);
      throw err;
    }
    this.host.changed();
    await this.host.review(proposal);
    if (proposal.state === "stale") return deny(`${proposal.path} was edited while the change was under review and the edit no longer applies. Read the file again and propose a fresh edit.`);
    if (proposal.state !== "reviewing") return deny("The review was closed.");
    if (!this.store.accepted(proposal).size) {
      proposal.state = "denied";
      return deny("The user reviewed this change and rejected every hunk. Do not propose it again unless asked.");
    }
    proposal.state = "approved";
    this.host.changed();
    return { allow: true };
  }

  /** Stop: the editor state is settled synchronously, then TrueForge is told to cancel. */
  async stop(): Promise<void> {
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    this.running = false;
    this.store.activeRunId = undefined;
    for (const a of run.attempts) this.store.discardRun(a.runId);
    this.host.closeReviews();
    this.status = "Stopped. Nothing from this run was applied.";
    this.transcript.push({ kind: "notice", level: "info", text: "Stopped. Proposals from this run were discarded; no files were changed." });
    const last = run.attempts[run.attempts.length - 1];
    if (last?.sessionId) this.lastSession = { id: last.sessionId, agent: last.agent };
    this.finish();
    await run.cancel();
  }

  // ---- Apply / undo ---------------------------------------------------------------------
  async apply(): Promise<boolean> {
    if (!this.canApply) return false;
    const plan = this.store.planApply();
    if (plan.conflicts.length) {
      this.note("warn", `Not applied: ${plan.conflicts.map((c) => `${c.path} (${c.hunks} hunk(s))`).join(", ")} changed since the review and the accepted hunks no longer fit. Discard the staged edits and ask again.`);
      return false;
    }
    if (!(await this.host.applyEdits(plan))) {
      this.note("error", "The editor refused the edit; nothing was applied.");
      return false;
    }
    this.store.commitApplied(plan, (rel) => this.host.source.current(rel) ?? "");
    this.host.closeReviews();
    this.index().invalidate();
    this.status = "Applied.";
    this.note("info", `Applied ${plan.files.reduce((n, f) => n + f.edits.length, 0)} hunk(s) to ${plan.files.map((f) => f.path).join(", ")}. Use Undo to revert.`);
    return true;
  }

  async undo(): Promise<boolean> {
    if (!this.canUndo) return false;
    const plan = this.store.planUndo();
    if (!plan.files.length) {
      this.note("warn", "Nothing could be undone: the applied lines have since been changed by hand.");
      return false;
    }
    if (!(await this.host.applyEdits(plan))) return false;
    this.store.commitUndone();
    this.index().invalidate();
    const skipped = plan.conflicts.length ? ` ${plan.conflicts.map((c) => c.path).join(", ")} had hunks edited by hand since; those were left alone.` : "";
    this.status = "Undone.";
    this.note("info", `Reverted the applied hunks in ${plan.files.map((f) => f.path).join(", ")}; other edits were kept.${skipped}`);
    return true;
  }

  discard(): void {
    if (this.running) return;
    this.store.discardAll();
    this.host.closeReviews();
    this.status = "Staged edits discarded.";
    this.host.changed();
  }

  /** A document changed: re-validate proposals under review against it. */
  documentChanged(rel: string): void {
    for (const p of this.store.all()) {
      if (p.path !== rel || p.state !== "reviewing") continue;
      const r = this.store.refresh(p);
      if (r === "regenerated") this.note("warn", `${rel} changed during review; the preview was regenerated against the new content. Please review it again.`);
      if (r === "stale") this.note("warn", `${rel} changed during review and the proposed edit no longer applies. It was rejected as stale.`);
      if (r !== "unchanged") void this.host.review(p);
    }
  }
}
