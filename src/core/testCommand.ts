import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * The run_tests tool only runs explicit local test commands: an allow-listed prefix,
 * no shell operators, no paths that leave the workspace.
 */
export function validateTestCommand(command: string, allowedPrefixes: string[]): { ok: true; argv: string[] } | { ok: false; error: string } {
  const cmd = (command ?? "").trim();
  if (!cmd) return { ok: false, error: "Empty command." };
  if (/[;&|><`$\n\r^%!(){}\\]/.test(cmd)) return { ok: false, error: "Shell operators, variables, backslashes and redirection are not allowed. Pass a plain test command with forward-slash paths." };
  const argv = cmd.match(/"[^"]*"|\S+/g)?.map((t) => t.replace(/^"|"$/g, "")) ?? [];
  const prefix = allowedPrefixes.map((p) => p.trim().split(/\s+/)).find((p) => p.length && p.every((tok, i) => argv[i] === tok));
  if (!prefix) return { ok: false, error: `Only these test commands may be run: ${allowedPrefixes.join(", ")}.` };
  const interactive = argv.slice(prefix.length).find((a) => /^--(pdb|trace|pdbcls)\b|^--(watch|looponfail)\b|^-i$/.test(a));
  if (interactive) return { ok: false, error: `"${interactive}" starts an interactive session and cannot be used here.` };
  const bad = argv.slice(prefix.length).find((a) => a.split(/[=,]/).some((part) => part.startsWith("/") || /^[A-Za-z]:/.test(part) || part.split("/").includes("..")));
  if (bad) return { ok: false, error: `Argument "${bad}" points outside the workspace.` };
  return { ok: true, argv };
}

export interface TestResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export function runTestCommand(argv: string[], cwd: string, timeoutMs: number, capChars: number, signal?: AbortSignal): Promise<TestResult> {
  return new Promise((resolve) => {
    // shell:true is needed on Windows for .cmd shims (npm, pytest.exe wrappers); metacharacters were rejected above.
    const quoted = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    const env = withWorkspaceVenv(cwd);
    const child = process.platform === "win32" ? spawn(quoted, { cwd, shell: true, windowsHide: true, env }) : spawn(argv[0], argv.slice(1), { cwd, env });
    let out = "";
    let timedOut = false;
    const kill = () => {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    const take = (d: Buffer) => {
      if (out.length < capChars * 4) out += d.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      const half = Math.floor(capChars / 2);
      const output = out.length > capChars ? `${out.slice(0, half)}\n… [${out.length - capChars} characters omitted] …\n${out.slice(-half)}` : out;
      resolve({ exitCode, timedOut, output });
    };
    child.on("error", (err) => {
      out += `\n${err.message}`;
      finish(null);
    });
    child.on("close", finish);
  });
}

/**
 * Run tests with the workspace's own Python virtual environment when it has one
 * (.venv, venv, env), the way an activated terminal would, so the right test runner is used.
 */
export function withWorkspaceVenv(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const bin = process.platform === "win32" ? "Scripts" : "bin";
  for (const name of [".venv", "venv", "env"]) {
    const dir = path.join(root, name, bin);
    if (!fs.existsSync(path.join(dir, process.platform === "win32" ? "python.exe" : "python"))) continue;
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[key] = `${dir}${path.delimiter}${env[key] ?? ""}`;
    env.VIRTUAL_ENV = path.join(root, name);
    delete env.PYTHONHOME;
    break;
  }
  return env;
}
