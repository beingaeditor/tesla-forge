# Demo recording script (4:00 maximum)

Rules from the rulebook: tasks A, B, C in that order; each followed by its on-screen verification; show the TrueForge session during B; you may cut model waiting time, but **never cut between giving an instruction and the diff appearing**.

## Before recording

1. `npm run trueforge` is running, with the Gemini key saved in TrueForge.
2. Set the agents for Tasks A and B:
   ```bash
   npm run setup:agent -- --model google-gemini/gemini-flash-lite-latest --fallback-model google-gemini/gemma-4-31b-it
   ```
3. The Flask fixture is at `C:\Users\samee\forge-flask` (tag 3.1.3, venv in `.venv`). Check `git status` is clean, then `.venv\Scripts\python -m pytest tests/test_cli.py -q` (55 passed at baseline).
4. Launch the extension on the fixture: `code --extensionDevelopmentPath=<repo> C:\Users\samee\forge-flask`. Open the Tesla Forge panel. Open a VS Code terminal and run `.venv\Scripts\activate`.
5. **Free-tier quota.** Gemini's free tier limits tokens per minute. Wait a few minutes after any rehearsal before recording Task B. If the panel says "rate limiting… waiting Ns", that wait is model waiting time; the rules let you cut model waiting, but **not** the stretch from sending the prompt to the first diff appearing. In testing, the first Task B diff appeared after 90–160 s.
6. Task B is not deterministic. If the model's new test fails when the agent runs it, it usually fixes it in the same turn. If the final run still fails, reset with `git checkout .` and record again.
7. During Task B the agent asks to run `python -m pytest tests/test_cli.py -q`. Click **Run**: your accepted edits are put in place for that run and restored afterwards.
4. Create a synthetic app outside the repo for Task B verification, for example `%TEMP%\demoapp.py`:
   ```python
   from flask import Flask
   app = Flask(__name__)
   app.config.update(SECRET_KEY="dev-not-real", DB_PASSWORD="hunter2-not-real", API_TOKEN="tok-not-real", SITE_NAME="Demo")
   ```
5. Rehearse each task at least twice with the model you will record with. Copy the three prompts below into a notes file so you paste them exactly.
6. Zoom the editor (`Ctrl+=` twice) so text is legible at 1080p. Record the whole VS Code window.

## Timeline

| Time | Task | What to do | What must be visible |
| --- | --- | --- | --- |
| 0:00 | A | Open `src/flask/helpers.py`. Select the whole `get_debug_flag` function. Press `Ctrl+Alt+K`. Paste the prompt. | Selection, the input box, the pasted prompt. |
| 0:15 | A | Wait. Do not cut. | Progress notification, then the diff editor with Accept/Reject lenses on each hunk. |
| 0:30 | A | Accept the hunks one at a time. Click **Apply** in the notification. | Per-hunk accept; file updated and saved. |
| 0:40 | A | Terminal: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` (PowerShell: `$env:FLASK_DEBUG='off'; python -c "..."`). | `False`. |
| 0:50 | A | Panel: **Undo last apply**, show the file reverted, then `Ctrl+Shift+Z` or re-run and apply so the edit is back. Keep this to a few seconds. | Undo of an applied change (criterion B2). |
| 1:05 | B | Panel: **New chat**. Paste the Task B prompt. Press Enter. | The prompt with no files named. |
| 1:15 | B | Wait. Do not cut until the first diff appears. Point at the **Context selected** block. | Files chosen with reasons and budget used; streamed text; tool calls marked "deferred, via call_tool". |
| 1:40 | B | Review hunks for each file as the diffs appear: accept them (reject one cosmetic hunk if the model offers one, to show per-hunk control). | At least three files proposed: `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`. |
| 2:10 | B | Click the session link in the panel. In the browser show the TrueForge session: turns, `call_tool`, approvals. Return to VS Code. | The TrueForge session for this run. |
| 2:25 | B | **Apply accepted edits**. Terminal: `git status --short`. | Three or more changed files. |
| 2:35 | B | `python -m pytest tests/test_cli.py -q` | All passing. |
| 2:45 | B | `flask --help`, then `flask --app <path>\demoapp.py config` | `config` in the command list; JSON with `"***"` for SECRET_KEY, DB_PASSWORD, API_TOKEN and the real SITE_NAME. |
| 3:00 | C | `git checkout .` to return to a clean fixture (may be cut). Run `npm run setup:agent -- --add-unreachable-provider --model unreachable/model --fallback-model google-gemini/gemini-flash-lite-latest`, then show the agent `tesla-forge` on model `unreachable/model` in the TrueForge UI (Agents). | The broken configuration. |
| 3:10 | C | Repeat Task A exactly: select `get_debug_flag`, `Ctrl+Alt+K`, paste the Task A prompt. | Editor stays usable (scroll or type in another file while waiting). |
| 3:20 | C | The panel shows "Primary agent failed. Automatically falling back to agent tesla-forge-fallback", then the diff appears. Do not apply. | The automatic fallback. |
| 3:35 | C | Terminal: `git status` | Nothing changed. |
| 3:42 | C+ | Send any agent request, press **Stop** while tokens are streaming. Then `git status`. | Immediate stop; clean workspace. |
| 3:55 | | End. | |

## Exact prompts

Task A and Task C:

```
Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
```

Task B:

```
Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
```

## After recording

- Note the timestamp of each scorecard row and fill `docs/WRITEUP.md` section 6.
- Check the video is 4:00 or shorter and the three verifications are legible.
- Upload as unlisted YouTube or Google Drive "anyone with the link can view", and open the link in a private window to confirm it is public.
