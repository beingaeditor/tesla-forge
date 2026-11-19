# Verification results

Recorded 15 November 2026 on Windows 11 with Node 24.14.0, VS Code 1.144.0, TrueForge 0.185.1 (local mode), `@truefoundry/trueforge-sdk` 0.185.0, `@modelcontextprotocol/sdk` 1.32.2.

## Real model runs on Flask 3.1.3 (20 November 2026)

Model: Google Gemini through TrueForge's `google-gemini` catalog provider, free tier (Google AI Studio key), cost $0. Runs used `npm run task`, which drives the same extension core headless against the real TrueForge agent and accepts every hunk. Fixture: `pallets/flask` tag 3.1.3, commit 22d92470, editable install in `.venv`.

| Task | Agent model | Outcome | Verification |
| --- | --- | --- | --- |
| A inline edit | gemini-flash-lite-latest | 1 propose_edit, 2 hunks, done in about 5 s | `FLASK_DEBUG=off` prints `False`; `OFF`, `n`, `N` also False; `1`, `yes`, `on` still True; docstring lists 0, false, no, off, n |
| B agent mode | gemini-flash-lite-latest | Agent found and changed `src/flask/cli.py` (2 hunks), `tests/test_cli.py` and `docs/cli.rst` with no files named, and ran the tests itself with its staged edits; about 225 s | `pytest tests/test_cli.py -q`: 56 passed, 3 skipped; `config` listed in `flask --help`; a synthetic app prints SECRET_KEY, DB_PASSWORD and API_TOKEN as `"***"` and SITE_NAME as `"Demo"` |
| C resilience | primary on an unreachable endpoint, fallback gemini-flash-lite-latest | Cannot connect, one retry, automatic fallback in a fresh session, diff left in preview; about 5 s | `git status` clean |
| C, no working fallback | fallback model out of quota | Clear error after bounded retries | `git status` clean, "No files were changed" |

Not every Task B run passed. Two earlier runs produced the right command, help entry and docs but a failing test (a wrong expected value once, a missing import once), because the agent could not test its staged edits. That led to the test change below, after which the run passed. One later run was disrupted by free-tier rate limits. Model quality and free-tier limits are the main risk for the recording.

Changes made because of the real-model runs:
- Inline edits tell the model not to search, because the selection is given. Task A went from 240 s and 12 tool calls to 5 s and 1 call.
- The agent calls deferred tools directly from their documented signatures instead of discovering them first.
- `run_tests` uses the workspace's own `.venv`. An approved test run puts the edits accepted in this turn in place temporarily and restores the exact previous bytes afterwards (also on Stop or timeout). Interactive flags such as `--pdb` are refused.
- On a provider rate limit ("429 ... retry in 41s") the run waits as asked and continues the same TrueForge session, so no work is lost. Without a retry hint (a daily cap) it gives up after one attempt.
- The agent proposes file by file, so the first diff appears sooner.

## Automated checks

**What these results are and are not.** The checks below ran against a real local TrueForge with the scripted mock in `scripts/mock-model.mjs` as the model, so they cover the extension's behaviour, not model quality.

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
| Tasks A, B, C recorded inside VS Code | The real-model runs above used the headless runner. The same core runs inside VS Code (host suite), but the recording is still to do. |
| Reading the panel in a live VS Code window by eye | The host tests drive the extension through commands and state. The panel's rendering was checked separately in a browser with sample data. |
| macOS and Linux | Not tested. |
| Demo video, final PDF, public links, portal submission | For the team. See `docs/DEMO_SCRIPT.md` and `docs/WRITEUP.md`. |

## TrueForge findings worth knowing

- Local mode blocks loopback URLs by default ("Outbound URL blocked for host 127.0.0.1"). `npm run trueforge` sets `OUTBOUND_URL_ALLOWED_HOSTS` so the workspace MCP server and local models are reachable.
- TrueForge listens on `localhost` (IPv6 `::1` on this machine), so use `http://localhost:8790`, not `127.0.0.1`.
- The SDK's CommonJS build does not load under Node 24; the extension is bundled from the ESM build with esbuild.
- A model failure arrives as `turn.done` with status `error` and a message such as `[Model Error] Request failed (401): Incorrect API key provided.` TrueForge does not retry it, so retry and fallback are done by the extension by opening a fresh session.
- Deferred tools are invoked as `call_tool` with arguments `mcp_server`, `tool_name`, `input`.
