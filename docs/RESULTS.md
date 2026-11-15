# Verification results

Recorded 15 November 2026 on Windows 11 with Node 24.14.0, VS Code 1.144.0, TrueForge 0.185.1 (local mode), `@truefoundry/trueforge-sdk` 0.185.0, `@modelcontextprotocol/sdk` 1.32.2.

**What these results are and are not.** Every check below ran against a real local TrueForge. The model behind TrueForge was the scripted mock in `scripts/mock-model.mjs`, which replays fixed responses. So the results prove what the extension and the TrueForge integration do. They say nothing about how well any real model performs the three fixed tasks. **No real model has been run yet, and Tasks A, B and C have not been performed on Flask.**

## Commands

```bash
npm install && npm run build
npm test                    # 11/11
npm run trueforge           # separate terminal
npm run test:integration    # 12/12
npm run test:host           # 7/7
```

## Results

| Check | How | Result |
| --- | --- | --- |
| Clean clone installs and builds | `git clone`, `npm ci`, `npm run build`, `npm test` in a fresh folder | Pass |
| Extension host launches from the clean clone | `npm run test:host` in that folder | Pass, 7/7 |
| Streamed turn with a workspace MCP tool call | integration check 1 | Pass |
| Deferred tool loading visible in the session | integration check 1: `call_tool` present in the session's events | Pass |
| Gated call pauses, editor decision reaches TrueForge, turn resumes | integration check 1; host check 2 | Pass |
| Accept one hunk, reject another | integration check 1; host check 4 | Pass: only the accepted hunk is applied |
| Reject all hunks of a file | integration check 2 | Pass: call denied, nothing staged |
| Nothing on disk before Apply | integration checks 1, 2, 7; host checks 2, 4 | Pass |
| Apply across three files as one edit, saved | host check 4 | Pass |
| Undo keeps unrelated edits | integration check 1; host check 2 | Pass |
| Native `Ctrl+Z` undoes an applied edit | host check 3 | Pass |
| Stop during streaming | integration check 3 (under 3 s, turn `cancelled` in TrueForge, late tokens ignored); host check 6 | Pass |
| Stop while paused for approval | integration check 4 | Pass: proposal discarded, late call refused |
| File edited during review (stale proposal) | integration check 9; host check 5 | Pass: rejected, not staged |
| Invalid API key | integration check 5; host check 7 | Pass: clear error, one attempt, workspace unchanged |
| Unreachable endpoint, no fallback | integration check 6 | Pass: one retry with backoff, then a clear error |
| Unreachable endpoint with fallback agent | integration check 7 | Pass: primary, retry, automatic fallback; result left in preview |
| Model fails after a hunk was staged | integration check 8 | Pass: staged hunk discarded |
| Path escapes (traversal, absolute, `.git`, symlink or junction) | unit tests; integration check 10 | Pass |
| `run_tests` allow-list and approval | unit tests; integration check 11 | Pass |
| Inline edit confined to the selection | integration check 12 | Pass |
| Context selection on Flask 3.1.3 for the exact Task B prompt | `npm run context -- <flask> "<prompt>"` | 229 files indexed in about 0.2 s; 8 files chosen using 21,571 of 24,000 chars, including `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst` |
| Flask fixture baseline | tag 3.1.3, commit 22d92470, `pip install -e . pytest==9.0.2` | `pytest tests/test_cli.py -q`: 55 passed, 3 skipped. `FLASK_DEBUG=off` currently prints `True`. `git status` clean |
| TrueForge session page opens from the extension's link | `http://localhost:8790/sessions/<id>` in a browser | Pass: shows the turn and its tool calls |

One defect was found and fixed during this testing: a diff tab could be left open when a hunk was decided before the tab had finished opening. After the fix the host suite passed four consecutive runs.

## Pending

| Item | Why it is pending |
| --- | --- |
| Task A, B, C on Flask with a real model | No model is configured in TrueForge. Needs a provider key entered in TrueForge by the team. |
| Fallback with two real models | Needs a second working model. Verified with mock providers only. |
| Reading the panel in a live VS Code window by eye | The host tests drive the extension through commands and state. The panel's rendering was checked separately in a browser with sample data. |
| `run_tests` with pytest on Flask | Verified with `node --version` as the allow-listed command; not yet with pytest. |
| macOS and Linux | Not tested. |
| Demo video, final PDF, public links, portal submission | For the team. See `docs/DEMO_SCRIPT.md` and `docs/WRITEUP.md`. |

## TrueForge findings worth knowing

- Local mode blocks loopback URLs by default ("Outbound URL blocked for host 127.0.0.1"). `npm run trueforge` sets `OUTBOUND_URL_ALLOWED_HOSTS` so the workspace MCP server and local models are reachable.
- TrueForge listens on `localhost` (IPv6 `::1` on this machine), so use `http://localhost:8790`, not `127.0.0.1`.
- The SDK's CommonJS build does not load under Node 24; the extension is bundled from the ESM build with esbuild.
- A model failure arrives as `turn.done` with status `error` and a message such as `[Model Error] Request failed (401): Incorrect API key provided.` TrueForge does not retry it, so retry and fallback are done by the extension by opening a fresh session.
- Deferred tools are invoked as `call_tool` with arguments `mcp_server`, `tool_name`, `input`.
