# Tesla Forge

An editor-native coding agent for VS Code whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge). Built by Team Tesla for the Techfest 2026-27 TrueFoundry Forge-a-thon.

- **Inline edit**: select code, press `Ctrl+Alt+K` (`Cmd+Alt+K` on macOS), type an instruction, and review the proposed change in VS Code's diff editor.
- **Agent mode**: one request in the panel drives a TrueForge agent through search, read, propose-edit and run-tests tools until the task is done. It finds the files itself.
- **Context assembly**: `@file:` and `@symbol:` mentions plus automatic ranked retrieval inside a fixed size budget. The panel shows which files were chosen and why.
- **Diff review**: every change is reviewed hunk by hunk. Nothing is written until you press Apply, and an applied change can be undone.
- **Streaming and cancellation**: tokens stream into the panel; Stop is immediate and leaves no partial edit.
- **Model failure**: bounded retry with backoff, then automatic fallback to a second TrueForge agent, or a clear error. The workspace is never touched.

**Starting point:** written from scratch. No upstream project was forked.

## How it works

```
VS Code extension  ──HTTP (TypeScript SDK)──▶  TrueForge (local)  ──▶  your model
   │  sessions, turns, streamed events,           runs the model call
   │  approvals, cancel                           and the MCP tool loop
   │
   └─ workspace MCP server on 127.0.0.1  ◀──MCP──  TrueForge calls the tools
        search_workspace · read_file · propose_edit · run_tests
```

- The extension is only a client of TrueForge. It never calls a model provider. The model is chosen on the TrueForge agent.
- The editor's capabilities are MCP tools. The agent decides what to read and change.
- `propose_edit` and `run_tests` require approval in TrueForge. When the agent calls `propose_edit`, TrueForge pauses the turn and the extension shows the diff. Your per-hunk decision is the approval: accepting at least one hunk answers `allow`, rejecting all answers `deny`. The tool then stages only the accepted hunks, in memory.
- `search_workspace` and `read_file` use TrueForge **deferred tool loading**: their schemas are not in the prompt until the agent discovers them (`list_tools`, `get_tool_info`, `call_tool`). You can see this in the TrueForge session.

Source layout: `src/core/` has no VS Code dependency (diffing, proposals, retrieval, the MCP server, the TrueForge run loop, the controller). `src/extension.ts`, `src/review.ts` and `src/panel.ts` are the VS Code layer. `agent/` holds the agent definition and an example model configuration.

## Requirements

- Node.js 22.14 or newer, VS Code 1.90 or newer, Git.
- Tested with TrueForge **0.185.1**, `@truefoundry/trueforge-sdk` **0.185.0**, VS Code **1.144.0**, Node **24.14.0**, on Windows 11. Versions are pinned in `package.json`.

## Setup from a clean clone

```bash
git clone <this repository> tesla-forge
cd tesla-forge
npm install
npm run build
```

### 1. Start TrueForge locally

```bash
npm run trueforge
```

This runs the pinned TrueForge in local mode on http://localhost:8790, with its database in `.trueforge/`. It also sets `OUTBOUND_URL_ALLOWED_HOSTS` to allow `127.0.0.1` and `localhost`. TrueForge blocks loopback URLs by default, and the workspace MCP server (and any local model) lives on loopback. If you start TrueForge yourself with `npx @truefoundry/trueforge`, set that variable too:

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost","::1"]' npx @truefoundry/trueforge@0.185.1
```

### 2. Configure a model in TrueForge

Any model TrueForge can reach works: a catalog provider, a free tier, a gateway, or a local OpenAI-compatible endpoint. Either:

- open http://localhost:8790, go to **Settings → Models**, and add a provider with your key; or
- copy `agent/model-providers.example.json` to `agent/model-providers.local.json` (git-ignored), fill in the placeholders, and pass it to the setup script below.

Keys are stored by TrueForge. The extension never sees them and none belong in this repository.

### 3. Load the agent definition

```bash
npm run setup:agent -- --list
npm run setup:agent -- --model <provider>/<model> --fallback-model <provider>/<other-model>
```

This saves `agent/tesla-forge.agent.json` into TrueForge as the agent `tesla-forge`, and again as `tesla-forge-fallback` on the second model. `--fallback-model` is optional; without it a model failure ends in a clear error instead of a fallback. To switch models later, rerun the command or change the model on the agent in the TrueForge UI. Nothing in the extension changes.

### 4. Run the extension

Open this folder in VS Code and press `F5` ("Run Tesla Forge"), then open the project you want to work on in the window that appears. Or from a terminal:

```bash
code --extensionDevelopmentPath="$PWD" /path/to/your/project
```

On start the extension launches its MCP server on `127.0.0.1:8795` and registers it with TrueForge as the connector `forge-workspace`. Open the **Tesla Forge** view in the activity bar.

## Using it

| Action | How |
| --- | --- |
| Inline edit | Select code, `Ctrl+Alt+K`, type the instruction. Rebind `teslaForge.inlineEdit` in Keyboard Shortcuts. |
| Agent request | Type in the panel and press Enter. Add `@file:path` or `@symbol:name` for explicit context. |
| Review a hunk | In the diff editor use the **Accept hunk / Reject hunk** lenses, the title-bar buttons, `Ctrl+Alt+Y` / `Ctrl+Alt+N`, or the buttons in the panel. |
| Apply | **Apply accepted edits** in the panel, enabled once the run has finished successfully. One undoable edit across all files, then saved. |
| Undo | **Undo last apply** reverts only the applied hunks and keeps other edits. `Ctrl+Z` also works. |
| Stop | **Stop** in the panel or `Ctrl+Alt+Backspace`. Proposals from that run are discarded. |
| See the session | Click the session link in the panel, or run **Tesla Forge: Open TrueForge Session**. |

Settings (`teslaForge.*`): `trueforgeUrl`, `agent`, `fallbackAgent`, `mcpPort`, `contextBudgetChars` (default 24000), `toolResponseCapChars` (default 6000), `testCommands`, `testTimeoutSeconds`, `maxRetries`.

## Safety properties

- File access is limited to the open workspace. Traversal, absolute paths outside it, `.git`, and paths that leave it through a symlink or junction are refused. Search does not follow links.
- A proposal is validated against the current editor content. If the file changes during review, the preview is regenerated when the edit still applies and rejected as stale when it does not.
- Accepted hunks live in memory until Apply. A stopped or failed run discards what it proposed and staged, and late events or tool calls from it are ignored.
- `run_tests` only runs allow-listed test commands with no shell operators or interactive flags, after a modal confirmation, with a time limit and capped output. It uses the workspace's `.venv` if there is one. Edits accepted in the current turn are put in place for the run and the exact previous bytes are restored afterwards, also on Stop.
- On a provider rate limit the run waits as long as the provider asks and continues the same TrueForge session. Other model failures retry once, then fall back or stop with a clear error.
- The MCP server binds to `127.0.0.1` and requires a random token in its URL.

## Tests

```bash
npm test                  # unit tests, no services needed
npm run trueforge         # in another terminal
npm run test:integration  # core against a real TrueForge, with a scripted mock model
npm run test:host         # the extension inside a real VS Code window
npm run context -- /path/to/repo "your prompt"   # preview the selected context, no model needed
npm run task -- /path/to/repo tesla-forge "your prompt"   # run a request headless against the real agent (accepts and applies every hunk)
```

The mock model (`scripts/mock-model.mjs`) replays scripted responses so that streaming, approvals, cancellation and provider failure can be tested offline. It is test tooling only and is not used for the demo.

## The Forge-a-thon fixture

```bash
git clone --depth 1 --branch 3.1.3 https://github.com/pallets/flask.git flask-fixture
cd flask-fixture                      # commit 22d92470
python -m venv .venv
.venv/Scripts/python -m pip install -e . "pytest==9.0.2"    # bin/ instead of Scripts/ on macOS and Linux
echo ".venv/" >> .git/info/exclude
```

`pytest==9.0.2` is the version in Flask's lock file; the newest pytest fails to import Flask 3.1.3's tests. On Windows keep the checkout at a short path, because deep paths break `pip` and `git`.

## Known limitations

See the write-up in `docs/`. In short: retrieval is lexical with no embeddings; only existing text files can be edited (no create, delete or rename); one run at a time and one VS Code window per TrueForge; `.gitignore` is not read, a fixed list of dependency and build folders is skipped instead.

## Licence

MIT. See `LICENSE`. Dependencies keep their own licences (TrueForge and its SDK: MIT; Model Context Protocol SDK: MIT; `diff`: BSD-3-Clause; `zod`: MIT).
