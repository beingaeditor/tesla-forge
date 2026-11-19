// Records the Round 1 demo video: launches VS Code on the Flask fixture with this extension,
// runs test/host/demo.ts (real TrueForge agent), screen-records with ffmpeg, then keeps only the
// stretches the demo marked (prompt-to-first-diff is never cut) and writes recordings/demo.mp4.
//
//   node scripts/record-demo.mjs --flask C:\path\to\flask --ffmpeg C:\path\to\ffmpeg.exe
//
// Needs TrueForge running with a working model. Records the whole primary screen: do not use the
// computer while it runs.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const flask = path.resolve(arg("flask", path.join(os.homedir(), "forge-flask")));
const ffmpeg = arg("ffmpeg", "ffmpeg");
const out = path.join(root, "recordings");
fs.mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const raw = path.join(out, `raw-${stamp}.mp4`);
const final = path.join(out, `demo-${stamp}.mp4`);
const logFile = path.join(out, `events-${stamp}.jsonl`);
const demoApp = path.join(os.tmpdir(), "demoapp.py");
fs.writeFileSync(demoApp, 'from flask import Flask\n\napp = Flask(__name__)\napp.config.update(SECRET_KEY="dev-not-real", DB_PASSWORD="not-real", API_TOKEN="tok-not-real", SITE_NAME="Demo")\n');

const git = spawnSync("git", ["-C", flask, "status", "--porcelain"], { encoding: "utf8" });
if (git.status !== 0 || git.stdout.trim()) {
  console.error(`The Flask fixture at ${flask} must be a clean git checkout:\n${git.stdout}${git.stderr}`);
  process.exit(1);
}
if (spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs"), "--tests"], { stdio: "inherit" }).status !== 0) process.exit(1);
// Tasks A and B run on the normal primary model; the demo itself switches to the broken endpoint for Task C.
const primary = arg("model", "google-gemini/gemini-flash-lite-latest");
const fallbackModel = arg("fallback-model", "google-gemini/gemma-4-31b-it");
if (spawnSync(process.execPath, [path.join(root, "scripts", "setup-trueforge.mjs"), "--model", primary, "--fallback-model", fallbackModel], { stdio: "inherit" }).status !== 0) process.exit(1);
const closeDemoWindows = () => spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'forge-demo-(edge-)?profile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"]);
closeDemoWindows();

// A clean VS Code profile, maximized, readable at 1080p.
const profile = path.join(os.tmpdir(), `forge-demo-profile-${process.pid}`);
fs.mkdirSync(path.join(profile, "User"), { recursive: true });
fs.writeFileSync(path.join(profile, "User", "settings.json"), JSON.stringify({
  "window.newWindowDimensions": "maximized",
  "window.zoomLevel": 0.5,
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.tips.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.commandCenter.enabled": false,
  "editor.minimap.enabled": false,
  "editor.fontSize": 14,
  "terminal.integrated.fontSize": 14,
  "diffEditor.renderSideBySide": false,
  "diffEditor.codeLens": true,
  "security.workspace.trust.enabled": false,
  "git.openRepositoryInParentFolders": "never",
  "extensions.ignoreRecommendations": true,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
}, null, 2));

// Bring the VS Code window to the front once it exists.
const focusScript = `Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W { public delegate bool E(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(E e, IntPtr l);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
for ($i = 0; $i -lt 40; $i++) { $found = $false
  [W]::EnumWindows({ param($h, $l) $sb = New-Object System.Text.StringBuilder 512; [void][W]::GetWindowText($h, $sb, 512)
    if ([W]::IsWindowVisible($h) -and $sb.ToString() -like '*Extension Development Host*') { [void][W]::ShowWindow($h, 3); [void][W]::SetForegroundWindow($h); $script:found = $true }; return $true }, [IntPtr]::Zero) | Out-Null
  if ($found) { break }; Start-Sleep -Milliseconds 500 }`;

const rec = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "gdigrab", "-framerate", "15", "-draw_mouse", "0", "-i", "desktop",
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p", raw], { stdio: ["pipe", "inherit", "inherit"] });
const recStart = Date.now() + 400; // ffmpeg start-up latency, approximately
setTimeout(() => spawn("powershell", ["-NoProfile", "-Command", focusScript], { stdio: "ignore" }), 4000);

// Privacy guard: from 15 s in, check every 3 s that the VS Code demo window is in front. If anything
// else is, stop recording and delete the raw file immediately.
const fgScript = `Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class F { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); }
"@
$sb = New-Object System.Text.StringBuilder 512; [void][F]::GetWindowText([F]::GetForegroundWindow(), $sb, 512); $sb.ToString()`;
let aborted = false;
let guard;
const check = () => {
  // The demo has finished once it logs "done"; VS Code then closes, which is expected.
  if (fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("\"kind\":\"done\"")) return clearInterval(guard);
  const title = spawnSync("powershell", ["-NoProfile", "-Command", fgScript], { encoding: "utf8" }).stdout.trim();
  if (/Extension Development Host|Visual Studio Code|TrueForge|localhost:8790/.test(title) || title === "") return;
  aborted = true;
  clearInterval(guard);
  void aborted;
  rec.stdin.write("q");
  rec.on("exit", () => {
    fs.rmSync(raw, { force: true });
    closeDemoWindows();
    console.error("ABORTED: another window came to the front, so the recording was stopped and deleted.");
    process.exit(3);
  });
};
setTimeout(() => {
  guard = setInterval(check, 3000);
  guard.unref();
}, 15000).unref();

const localCode = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe");
let failed = false;
try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXE ?? (fs.existsSync(localCode) ? localCode : undefined),
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "dist-test", "demo.js"),
    extensionTestsEnv: { DEMO_LOG: logFile, DEMO_REPO: root, DEMO_APP: demoApp },
    launchArgs: [flask, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--user-data-dir", profile],
  });
} catch (e) {
  failed = true;
  console.error(`demo run failed: ${e?.message ?? e}`);
}
clearInterval(guard);
rec.stdin.write("q");
await new Promise((r) => rec.on("exit", r));

// ---- Edit: keep the marked stretches ------------------------------------------------------
const events = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const segs = [];
let open;
for (const e of events) {
  if (e.kind === "keep-start") open = { label: e.label, a: (e.t - recStart) / 1000 - 0.3 };
  if (e.kind === "keep-end" && open) {
    segs.push({ ...open, b: (e.t - recStart) / 1000 + 0.4 });
    open = undefined;
  }
}
if (open) segs.push({ ...open, b: (Date.now() - recStart) / 1000 });
if (!segs.length) {
  console.error(`No segments were recorded. Raw video: ${raw}`);
  process.exit(1);
}
const parts = segs.map((s, i) => `[0:v]trim=start=${Math.max(0, s.a).toFixed(2)}:end=${s.b.toFixed(2)},setpts=PTS-STARTPTS[v${i}]`);
const filter = `${parts.join(";")};${segs.map((_, i) => `[v${i}]`).join("")}concat=n=${segs.length}:v=1:a=0,scale=1920:-2:flags=lanczos[out]`;
const ed = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", final], { stdio: "inherit" });
if (ed.status !== 0) process.exit(1);
fs.rmSync(raw, { force: true }); // the raw take includes the seconds before VS Code opened

let t = 0;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
console.log("\nSegments in the final video:");
for (const s of segs) {
  const len = s.b - Math.max(0, s.a);
  console.log(`  ${fmt(t).padStart(5)}  ${s.label.padEnd(28)} ${len.toFixed(1)} s`);
  t += len;
}
const firstDiffs = events.filter((e) => e.kind === "mark").map((e) => e.label).join(", ");
console.log(`Total ${fmt(t)} (${t.toFixed(1)} s). Marks seen: ${firstDiffs || "none"}${failed ? "  [demo run reported a failure]" : ""}`);
console.log(`Final: ${final}\nRaw:   ${raw}`);
fs.rmSync(profile, { recursive: true, force: true });
