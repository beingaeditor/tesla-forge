// The editor's capabilities, exposed to the TrueForge agent as MCP tools over local HTTP.
// TrueForge decides when to call them; this server only answers for the active workspace.
import http from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PathError, resolveInWorkspace } from "./paths";
import { ProposalError, ProposalStore } from "./proposals";
import { WorkspaceIndex } from "./retrieval";
import { runTestCommand, validateTestCommand } from "./testCommand";

export const MCP_SERVER_NAME = "forge-workspace";
export const GATED_TOOLS = ["propose_edit", "run_tests"];

export interface ToolHost {
  root(): string | undefined;
  index(): WorkspaceIndex;
  store: ProposalStore;
  toolCapChars(): number;
  testConfig(): { allowed: string[]; timeoutMs: number };
  /** Aborted when the user stops the run, so a running test command is killed. */
  runSignal(): AbortSignal | undefined;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export function buildTools(host: ToolHost): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
  const guard = (fn: (root: string) => Promise<ToolResult> | ToolResult) => async (): Promise<ToolResult> => {
    const root = host.root();
    if (!root) return fail("No workspace folder is open in the editor.");
    if (!host.store.activeRunId) return fail("No agent run is active in the editor (it was stopped or has finished), so this call was ignored.");
    try {
      return await fn(root);
    } catch (err) {
      if (err instanceof PathError || err instanceof ProposalError) return fail(err.message);
      return fail(`Tool failed: ${(err as Error).message}`);
    }
  };

  server.registerTool(
    "search_workspace",
    {
      description:
        "Search the open workspace. Give identifiers, file names or plain words; an exact phrase also works. Returns the best-matching files ranked with the reason each was chosen, plus numbered excerpts, within a fixed size cap. Use it to find where something is defined, used, tested or documented before reading or editing.",
      inputSchema: {
        query: z.string().describe("Identifiers, file names, words or an exact phrase to look for."),
        path_prefix: z.string().optional().describe("Only search under this workspace-relative folder, e.g. `tests/`."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guard(() => {
        const cap = host.toolCapChars();
        const pack = host.index().search(args.query, { capChars: Math.floor(cap * 0.8), pathPrefix: args.path_prefix, maxFiles: 6 });
        if (!pack.snippets.length) return ok(`No matches for "${args.query}"${args.path_prefix ? ` under ${args.path_prefix}` : ""}. Try different words or a broader query.`);
        const files = [...new Map(pack.snippets.map((s) => [s.path, s])).values()];
        const head = files.map((s, i) => `${i + 1}. ${s.path} — ${s.reason}`).join("\n");
        const body = pack.snippets.map((s) => `### ${s.path} lines ${s.startLine}-${s.endLine}\n${s.text}`).join("\n\n");
        return ok(`Top matches for "${args.query}" (${files.length} of ${pack.candidates} matching files, ${pack.usedChars}/${cap} chars):\n${head}\n${pack.notes.map((n) => `Note: ${n}\n`).join("")}--- excerpts (the "NN| " prefixes are line numbers, not file content) ---\n${body}`);
      })(),
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read a text file from the open workspace with line numbers. Large files are returned in pieces: pass start_line/end_line to read a specific range. Content already accepted by the user in this run is included.",
      inputSchema: {
        path: z.string().describe("Workspace-relative path."),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guard((root) => {
        const { rel } = resolveInWorkspace(root, args.path);
        const got = host.index().read(rel, args.start_line, args.end_line, host.toolCapChars());
        if (!got) return fail(`${rel} was not found, is not a text file, or is in an excluded folder.`);
        const more = got.endLine < (args.end_line ?? got.totalLines) ? `\n… stopped at the size cap. Continue with start_line=${got.endLine + 1}.` : "";
        return ok(`${rel} lines ${got.startLine}-${got.endLine} of ${got.totalLines} (the "NN| " prefixes are line numbers, not file content)\n${got.text}${more}`);
      })(),
  );

  server.registerTool(
    "propose_edit",
    {
      description:
        "Propose a change to one existing text file in the workspace. Nothing is written: the user reviews the change hunk by hunk in the editor and may accept only some hunks. Each edit replaces `old_text` (whole existing lines, copied exactly, without line-number prefixes, matching exactly one place) with `new_text`. To insert, quote an adjacent line in old_text and repeat it in new_text. Call once per file. The result says which hunks were accepted.",
      inputSchema: {
        path: z.string().describe("Workspace-relative path of an existing file."),
        edits: z.array(z.object({ old_text: z.string(), new_text: z.string() })).min(1),
        summary: z.string().optional().describe("One line describing the change, shown to the user."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      guard(() => {
        const r = host.store.stage(args);
        const rejected = r.rejected ? ` The user rejected ${r.rejected} hunk(s); do not propose those changes again unless asked.` : "";
        return ok(`${r.proposal.path}: ${r.staged} of ${r.proposal.hunks.length} hunk(s) accepted by the user and staged.${rejected} Staged changes are visible to read_file but are not on disk until the user applies them after this turn.`);
      })(),
  );

  server.registerTool(
    "run_tests",
    {
      description:
        "Run a local test command in the workspace root after the user approves it (for example `python -m pytest tests/test_x.py -q`). Only allow-listed test runners, no shell operators. Runs against files on disk, so edits staged in this turn are not included until the user applies them.",
      inputSchema: { command: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      guard(async (root) => {
        const cfg = host.testConfig();
        const v = validateTestCommand(args.command, cfg.allowed);
        if (!v.ok) return fail(v.error);
        if (!host.store.consumeCommand(args.command)) return fail("This command was not approved in the editor, so it was not run.");
        const r = await runTestCommand(v.argv, root, cfg.timeoutMs, Math.floor(host.toolCapChars() * 0.8), host.runSignal());
        const status = r.timedOut ? `timed out after ${cfg.timeoutMs / 1000}s` : `exit code ${r.exitCode}`;
        return ok(`$ ${args.command}\n[${status}; ran against files on disk]\n${r.output}`);
      })(),
  );

  return server;
}

/** Serve the tools on 127.0.0.1. The random token in the path keeps other local processes out. */
export async function startMcpServer(host: ToolHost, port: number, token: string): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const route = `/mcp/${token}`;
  const server = http.createServer(async (req, res) => {
    try {
      if ((req.url ?? "").split("?")[0] !== route) {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const tools = buildTools(host);
      res.on("close", () => {
        void transport.close();
        void tools.close();
      });
      await tools.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: (err as Error).message }, id: null }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actual = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${actual}${route}`,
    port: actual,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
