# Tesla Forge: Round 1 write-up

> Draft. Items marked **[FILL]** need real values from the recorded demo or from the team before this is exported to PDF (target: 3 pages).

## 1. Team

Team Tesla · Techfest Team ID TM-DC7A5C65F5C · Repository: https://github.com/beingaeditor/tesla-forge

| Member | College or employer | GitHub |
| --- | --- | --- |
| Sameer Verma | IIIT Delhi (IIITD) | [beingaeditor](https://github.com/beingaeditor) |
| Sampoorn | IIIT Delhi (IIITD) | — |
| Vinayak | IIIT Delhi (IIITD) | — |

## 2. Starting point

From scratch. No upstream project was forked; every file in the repository was written for this competition. Runtime dependencies are ordinary libraries: the TrueForge TypeScript SDK, the Model Context Protocol SDK, `diff`, and `zod`.

## 3. Architecture on TrueForge

The extension is a client of a TrueForge agent and nothing else. It creates a session from the saved agent `tesla-forge`, sends each request as a turn with `sessions.createTurnStream`, renders the streamed events in the panel, answers tool-approval pauses with `sessions.createTurnEvents`, and stops with `sessions.cancel`. It never calls a model provider. TrueForge 0.185.1 runs in local mode.

**Editor capabilities as MCP tools.** The extension hosts a small MCP server on `127.0.0.1` and registers it with TrueForge as the connector `forge-workspace`. It exposes four tools: `search_workspace` (ranked search with reasons), `read_file` (bounded, line-numbered), `propose_edit` (search-and-replace edits to one existing file), and `run_tests` (allow-listed local test commands). The agent decides what to read and change.

**TrueForge approval drives diff review.** `propose_edit` and `run_tests` are listed in the agent's `requireApprovalForTools`. When the agent calls `propose_edit`, TrueForge pauses the turn and emits `tool.approval_required`. The extension validates the edit against the current editor content, splits it into hunks, and opens VS Code's native diff editor with Accept and Reject on every hunk. The user's decision is the approval: one or more accepted hunks sends `allow`, none sends `deny` with a reason the model can read. Only then does TrueForge deliver the call to the MCP server, which stages exactly the accepted hunks of that exact reviewed proposal (matched by a hash of its arguments) in memory. We chose this over a private side channel so that the review is part of the session record and so that the harness, not our code, enforces that no edit proceeds unreviewed.

**Harness feature: deferred tool loading.** `forge-workspace` is attached with `preload: false` and `preloadTools: ["propose_edit", "run_tests"]`. The two gated tools are always in context; the search and read tools are discovered on demand through TrueForge's `list_tools`, `get_tool_info` and `call_tool`. This keeps tool definitions out of the prompt for inline edits, which need no search at all, and it is visible in the Task B session as `call_tool` entries. Context compaction is left on for long agent runs. Subagents, the sandbox, generative UI and web search are turned off in the agent definition because no fixed task needs them and each adds prompt weight for small models.

**Safety of edits.** Accepted hunks are staged in memory and reach disk only when the user presses Apply, which is enabled after the turn completes successfully. Apply is one text-only `WorkspaceEdit` across all files, then a save. Hunks are re-located on the current text by their surrounding lines, so an unrelated edit made during review does not block Apply, and a conflicting one stops it with a message. Undo reverses only the applied hunks and keeps later manual edits; `Ctrl+Z` also works. Stop settles the editor state first (Apply disabled, proposals and staged hunks from that run discarded), then cancels the turn in TrueForge; late events and tool calls from the cancelled run are ignored.

## 4. How context is selected

Two layers, both with a hard size limit.

**Initial context (budget 24,000 characters, about 6,000 tokens, configurable).** Before the first model call the extension builds a context block:

1. Explicit mentions first. `@file:path` adds the file (or its head plus an outline of remaining definitions if it is large). `@symbol:name` adds the whole definition block. Mentions may use up to 40% of the budget each.
2. Automatic retrieval fills the rest. The prompt is turned into weighted terms (identifiers and quoted strings count double, stop words are dropped, simple stems are added). Every text file in the workspace is scored on three kinds of evidence, strongest first: a symbol definition named like a term; a file or folder named like a term; and BM25 text relevance, so rare terms count more and long files do not win by length. Adjacent query words found together ("cli command") add a bonus. Changelog and licence files are down-weighted. If the best test file or the best documentation file is a real match but fell outside the top eight, it replaces the weakest pick, because a change usually spans code, tests and docs.
3. The budget is split across the top eight files in proportion to score, and within each file the highest-scoring line windows are taken, preferring definitions.

**Later tool responses (cap 6,000 characters each, configurable).** `search_workspace` uses the same ranking and returns the top files with the reason each was chosen plus excerpts. `read_file` returns numbered lines in bounded pieces.

The panel shows the selected files, line ranges, reasons, and budget used for every request, and every search result lists its reasons, so the choice is visible in Task B. There are no repository-specific rules. Dependency, build and VCS folders are skipped, and links are not followed. We chose a lexical index over embeddings because it needs no second model, builds in about 0.2 s on Flask, is explainable line by line, and behaves the same with whatever model the judges pick. On the exact Task B prompt it selects `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst` among its eight files, using 21,571 of 24,000 characters. With Gemini Flash-Lite the agent then changed exactly those three files.

## 5. Model setup

| Model | Where it ran | Role | Approximate cost |
| --- | --- | --- | --- |
| Gemini Flash-Lite (`google-gemini/gemini-flash-lite-latest`) | Google AI Studio API, free tier, through TrueForge's catalog provider | primary for Tasks A and B; fallback in Task C | $0 |
| Gemma 4 31B (`google-gemini/gemma-4-31b-it`) | same provider, free tier | fallback for Tasks A and B | $0 |
| Gemini 3.6 Flash and 3.5 Flash | same provider, free tier | early trials; free daily request cap reached | $0 |

For Task C the primary agent is pointed at a provider whose endpoint is unreachable: `npm run setup:agent -- --add-unreachable-provider --model unreachable/model --fallback-model google-gemini/gemini-flash-lite-latest`.

Models are configured only in TrueForge, as a catalog provider or an OpenAI-compatible endpoint. To switch, change the model on the agent in the TrueForge UI or rerun `npm run setup:agent -- --model <provider>/<model>`. The extension has no model setting. A scripted mock endpoint was used for automated tests only; it is not a model and is not shown in the demo.

## 6. Scorecard

| Criterion | Video time | Claim |
| --- | --- | --- |
| A1 Inline edit | **[FILL]** | Selection, keybinding, instruction; diff rendered in the editor with per-hunk accept and reject. |
| A2 Agent mode | **[FILL]** | Task B: the agent discovers and edits three or more files that the prompt does not name. |
| A3 Streaming and cancellation | **[FILL]** | Tokens stream from TrueForge events; Stop is immediate and `git status` is clean afterwards. |
| B1 Context assembly | **[FILL]** | Budgeted retrieval; the panel lists the chosen files and why during Task B. |
| B2 Diff safety | **[FILL]** | Per-hunk review, nothing written before Apply, and a working undo shown on screen. |
| B3 Resilience | **[FILL]** | Unreachable endpoint: one retry, then automatic fallback to a second configured model with no user action; workspace unchanged. |
| B4 TrueForge integration depth | **[FILL]** | MCP tools, TrueForge approval driving diff review, and deferred tool loading visible in the session. |
| C1 Video | whole video | Tasks A, B, C in order, each verified on screen. |
| C2 Write-up | this document | Architecture, context strategy, model setup, trade-offs, scorecard, limitations. |

## 7. Tools used

- Claude Fable 5.2 and Claude Opus 5.5 through Claude Code (AI coding assistants) for implementation, tests, real-model verification and drafting this document. No other AI assistants were used.
- TrueForge 0.185.1 and its TypeScript SDK 0.185.0; Model Context Protocol TypeScript SDK 1.32.2; VS Code 1.144; Node.js 24; esbuild; TypeScript; `@vscode/test-electron`.

## 8. Known limitations and what we would do with another month

- **Lexical retrieval only.** It can miss code that uses different words from the request. Next: use the editor's language servers for definitions and references, and add an optional embedding index behind the same budget.
- **Existing text files only.** The agent cannot create, delete or rename files, so a task that needs a new file must extend an existing one. Next: reviewed file creation.
- **Testing staged edits writes files briefly.** So the agent can check its work, an approved test run puts the accepted edits in place and restores the exact bytes afterwards, also on Stop. A crash of VS Code during that window could leave them in place. Next: run tests in a temporary copy of the workspace.
- **Free-tier limits.** Gemini's free tier limits tokens per minute and caps some models at 20 requests a day. The extension waits and continues the same session on a rate limit, but a long Task B can take several minutes.
- **One run and one window at a time.** The MCP connector name is shared, so a second VS Code window would take over the registration.
- **Fallback restarts the request.** A fallback opens a fresh session on the second agent and repeats the request; work the first model had done is discarded by design, which costs time.
- **Ignore rules.** `.gitignore` is not read; a fixed list of dependency and build folders is skipped instead.
- **Tested on Windows 11 only.** The code avoids platform-specific paths except for process handling in `run_tests`, but macOS and Linux were not exercised.
- **Model quality varies.** The edit format (exact-line search and replace) is forgiving of trailing whitespace and of copied line-number prefixes, and errors are returned to the model so it can retry, but a small model may still need more than one attempt. With Gemini Flash-Lite, Task A succeeded every time; Task B produced the right command and docs every time, but twice wrote a failing test before the agent could run tests on its staged edits.
