// One user request = one AgentRun. The run is a thin client of TrueForge: it creates a session,
// sends a turn, relays streamed events, answers tool-approval pauses, and cancels.
// TrueForge owns the model call and the tool loop; this file never talks to a model provider.
import { TrueForge, TrueForgeError, isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

export interface ToolCallInfo {
  id: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  /** Set when the call went through TrueForge's deferred-tool meta tools. */
  via?: string;
}

export type ApprovalDecision = { allow: true } | { allow: false; reason: string };

export interface Attempt {
  runId: string;
  kind: "primary" | "retry" | "fallback";
  agent: string;
  sessionId?: string;
  turnId?: string;
  error?: string;
}

export interface RunCallbacks {
  attemptStarted(attempt: Attempt): void;
  /** The attempt failed and another one may follow; anything it proposed must be thrown away. */
  attemptFailed(attempt: Attempt, willContinue: string | undefined): void;
  status(text: string): void;
  textDelta(messageId: string, text: string): void;
  toolCall(call: ToolCallInfo): void;
  toolResult(toolCallId: string, content: string): void;
  approval(attempt: Attempt, call: ToolCallInfo): Promise<ApprovalDecision>;
}

export interface RunOptions {
  agent: string;
  fallbackAgent?: string;
  /** Continue this TrueForge session on the first attempt instead of creating one. */
  sessionId?: string;
  prompt: string;
  maxRetries: number;
  backoffMs?: number;
  metadata?: Record<string, string>;
}

export interface RunResult {
  status: "done" | "cancelled" | "error";
  error?: string;
  attempts: Attempt[];
  final?: Attempt;
}

const TRANSIENT = /\b(408|409|425|429|5\d\d)\b|time[d ]?out|ECONN|ENOTFOUND|EAI_AGAIN|cannot connect|fetch failed|socket|overloaded|rate.?limit|temporar|unavailable|terminated/i;

let runSeq = 0;

export function normalizeToolCall(tc: { id: string; function?: { name?: string; arguments?: string }; toolInfo?: { type?: string; name?: string; serverName?: string } }): ToolCallInfo {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.function?.arguments || "{}");
  } catch {
    args = { _unparsed: tc.function?.arguments };
  }
  const name = tc.function?.name ?? "";
  if (name === "call_tool" && typeof args.tool_name === "string") {
    return { id: tc.id, server: String(args.mcp_server ?? ""), tool: args.tool_name, args: (args.input as Record<string, unknown>) ?? {}, via: "call_tool" };
  }
  if (tc.toolInfo?.type === "mcp") return { id: tc.id, server: tc.toolInfo.serverName ?? "", tool: tc.toolInfo.name ?? name, args };
  return { id: tc.id, server: "", tool: name, args };
}

export function describeError(err: unknown, baseUrl: string): { message: string; transient: boolean; harnessDown: boolean } {
  if (err instanceof TrueForgeError && err.statusCode) {
    const body = (err.body as { error?: { message?: string } } | undefined)?.error?.message;
    return { message: body ?? `TrueForge returned HTTP ${err.statusCode}.`, transient: err.statusCode >= 500 || err.statusCode === 429, harnessDown: false };
  }
  const text = `${(err as Error)?.message ?? err} ${((err as { cause?: Error })?.cause as Error | undefined)?.message ?? ""}`;
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return { message: `Cannot reach TrueForge at ${baseUrl}. Start it with \`npm run trueforge\` (or check the teslaForge.trueforgeUrl setting).`, transient: false, harnessDown: true };
  }
  return { message: text.trim(), transient: TRANSIENT.test(text), harnessDown: false };
}

export class AgentRun {
  private cancelled = false;
  private abort = new AbortController();
  private current: Attempt | undefined;
  private wakeBackoff: (() => void) | undefined;
  readonly attempts: Attempt[] = [];

  constructor(
    private client: TrueForge,
    private baseUrl: string,
    private opts: RunOptions,
    private cb: RunCallbacks,
  ) {}

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Stop now. After this returns no callback fires again, whatever TrueForge still sends. */
  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.wakeBackoff?.();
    const sessionId = this.current?.sessionId;
    try {
      if (sessionId) await this.client.sessions.cancel(sessionId, {}, { timeoutInSeconds: 10, maxRetries: 0 });
    } catch {
      // The local run is already dead; TrueForge will time the turn out on its own.
    }
    this.abort.abort();
  }

  async start(): Promise<RunResult> {
    let retriesLeft = Math.max(0, this.opts.maxRetries);
    let kind: Attempt["kind"] = "primary";
    let agent = this.opts.agent;
    let reuseSession = this.opts.sessionId;
    const errors: string[] = [];
    for (;;) {
      const attempt: Attempt = { runId: `run${++runSeq}`, kind, agent };
      this.attempts.push(attempt);
      this.current = attempt;
      this.cb.attemptStarted(attempt);
      const outcome = await this.runAttempt(attempt, reuseSession);
      reuseSession = undefined;
      if (this.cancelled || outcome.status === "cancelled") return { status: "cancelled", attempts: this.attempts, final: attempt };
      if (outcome.status !== "error") return { status: "done", attempts: this.attempts, final: attempt };

      attempt.error = outcome.message;
      errors.push(`${agent}: ${outcome.message}`);
      const fallback = this.opts.fallbackAgent && this.opts.fallbackAgent !== this.opts.agent ? this.opts.fallbackAgent : undefined;
      let next: { kind: Attempt["kind"]; agent: string; waitMs: number; note: string } | undefined;
      if (outcome.harnessDown) next = undefined;
      else if (kind !== "fallback" && outcome.transient && retriesLeft > 0) {
        const waitMs = (this.opts.backoffMs ?? 1000) * 2 ** (this.opts.maxRetries - retriesLeft);
        retriesLeft--;
        next = { kind: "retry", agent, waitMs, note: `retrying in ${(waitMs / 1000).toFixed(1)}s` };
      } else if (kind !== "fallback" && fallback) {
        next = { kind: "fallback", agent: fallback, waitMs: 0, note: `falling back to agent "${fallback}"` };
      }
      this.cb.attemptFailed(attempt, next?.note);
      if (!next) return { status: "error", error: errors.join("\n"), attempts: this.attempts, final: attempt };
      if (next.waitMs) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, next!.waitMs);
          this.wakeBackoff = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wakeBackoff = undefined;
        if (this.cancelled) return { status: "cancelled", attempts: this.attempts, final: attempt };
      }
      kind = next.kind;
      agent = next.agent;
    }
  }

  private async runAttempt(attempt: Attempt, reuseSession: string | undefined): Promise<{ status: "done" | "cancelled" } | { status: "error"; message: string; transient: boolean; harnessDown: boolean }> {
    const live = () => !this.cancelled && this.current === attempt;
    try {
      if (reuseSession) {
        attempt.sessionId = reuseSession;
      } else {
        this.cb.status(`Creating TrueForge session with agent "${attempt.agent}"…`);
        const created = await this.client.sessions.create({ agent: { name: attempt.agent }, metadata: this.opts.metadata }, { maxRetries: 0, abortSignal: this.abort.signal });
        attempt.sessionId = created.data.id;
      }
      if (!live()) return { status: "cancelled" };
      const sessionId = attempt.sessionId!;
      const stream = await this.client.sessions.createTurnStream(
        sessionId,
        { input: [{ type: "user.message", content: this.opts.prompt }] },
        { timeoutInSeconds: 3600, maxRetries: 0, abortSignal: this.abort.signal },
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages = new Map<string, any>();
      const announced = new Set<string>();
      const announce = (messageId: string) => {
        for (const tc of messages.get(messageId)?.toolCalls ?? []) {
          if (!tc?.id || announced.has(tc.id)) continue;
          announced.add(tc.id);
          this.cb.toolCall(normalizeToolCall(tc));
        }
      };
      let done: { status: string; message?: string } | undefined;

      for await (const ev of stream) {
        if (!live()) return { status: "cancelled" };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = ev as any;
        if (isEventDelta(e)) {
          const base = messages.get(e.id);
          if (base) mergeEventDelta(base, e);
          else messages.set(e.id, { ...e, type: "model.message" });
          if (typeof e.content === "string" && e.content) this.cb.textDelta(e.id, e.content);
          if (e.finishReason) announce(e.id);
          continue;
        }
        switch (e.type) {
          case "turn.created":
            attempt.turnId = e.turnId;
            this.cb.status("Waiting for the model…");
            break;
          case "mcp.initialize":
            this.cb.status(`Tools connected: ${(e.mcpServers ?? []).map((s: { name: string }) => s.name).join(", ")}`);
            break;
          case "model.message":
            if (!messages.has(e.id)) messages.set(e.id, e);
            if (e.finishReason) announce(e.id);
            break;
          case "tool.response":
            for (const id of messages.keys()) announce(id);
            this.cb.toolResult(e.toolCallId, typeof e.content === "string" ? e.content : JSON.stringify(e.content));
            break;
          case "tool.approval_required":
            // Not awaited: the turn is paused server-side, and Stop must stay responsive meanwhile.
            void this.answerApprovals(attempt, e, messages, announce, live);
            break;
          case "turn.update":
            this.cb.status(e.state?.status === "paused" ? "Paused: waiting for your review" : "Running…");
            break;
          case "turn.done":
            done = { status: e.state?.status, message: e.state?.message };
            break;
        }
      }
      if (!live()) return { status: "cancelled" };
      if (done?.status === "done") return { status: "done" };
      if (done?.status === "cancelled") return { status: "cancelled" };
      const message = done?.message ?? "The TrueForge event stream ended before the turn finished.";
      return { status: "error", message, transient: TRANSIENT.test(message), harnessDown: false };
    } catch (err) {
      if (!live()) return { status: "cancelled" };
      return { status: "error", ...describeError(err, this.baseUrl) };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async answerApprovals(attempt: Attempt, ev: any, messages: Map<string, any>, announce: (id: string) => void, live: () => boolean): Promise<void> {
    for (const ref of ev.toolCalls ?? []) {
      announce(ref.sourceEventId);
      const raw = (messages.get(ref.sourceEventId)?.toolCalls ?? []).find((t: { id: string }) => t.id === ref.id);
      let decision: ApprovalDecision;
      try {
        decision = raw ? await this.cb.approval(attempt, normalizeToolCall(raw)) : { allow: false, reason: "The editor could not find this tool call." };
      } catch (err) {
        decision = { allow: false, reason: (err as Error).message };
      }
      if (!live()) return; // cancelled or superseded while the user was reviewing: never answer late
      try {
        await this.client.sessions.createTurnEvents(attempt.sessionId!, attempt.turnId!, {
          events: [{ type: "user.tool_approval", threadId: ev.threadId ?? "main", toolCallId: ref.id, approval: decision.allow ? { status: "allow" } : { status: "deny", reason: decision.reason } }],
        });
      } catch (err) {
        if (live()) this.cb.status(`Could not send the review decision to TrueForge: ${describeError(err, this.baseUrl).message}`);
      }
    }
  }
}
