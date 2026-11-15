// Context assembly: a small lexical index over the workspace, with ranking and size budgets.
// Nothing here is specific to any repository or language beyond generic definition patterns.
import fs from "node:fs";
import path from "node:path";

export const EXCLUDED_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", ".venv", "venv", "env", "__pycache__", "site-packages",
  "dist", "dist-test", "build", "out", "target", ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".cache",
  ".idea", ".vscode", ".vscode-test", "coverage", "htmlcov", ".next", ".turbo", "vendor", ".trueforge", ".gradle",
]);
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|bmp|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|exe|dll|so|dylib|bin|o|a|class|pyc|pyo|woff2?|ttf|otf|eot|mp[34]|mov|avi|wav|sqlite|db|lock|map|min\.js|min\.css)$/i;
const MAX_FILE_BYTES = 400_000;
const CODE_EXT = /\.(py|pyi|js|jsx|mjs|cjs|ts|tsx|go|rs|java|kt|kts|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|sh|bash|lua|dart|ex|exs|m|mm|pl|r|jl|vue|svelte)$/i;
const DOC_EXT = /\.(md|mdx|rst|txt|adoc)$/i;
const LOW_SIGNAL = /^(changes|changelog|history|news|releases?|license|licence|copying|authors|contributors|notice)(\.[a-z]+)?$/i;

type Role = "test" | "doc" | "source" | "other";
function roleOf(relLower: string): Role {
  if (/(^|\/)(tests?|specs?|__tests__|testing)\//.test(relLower) || /(^|\/)(test_[^/]*|[^/]*_test|[^/]*\.(test|spec))\.[a-z]+$/.test(relLower)) return "test";
  if (DOC_EXT.test(relLower) || /(^|\/)docs?\//.test(relLower)) return "doc";
  return CODE_EXT.test(relLower) ? "source" : "other";
}

/** Query words that are next to each other, as patterns that also match snake_case, kebab-case and dotted forms. */
function adjacentPairs(query: string): Array<[string, string, RegExp]> {
  const words = query.toLowerCase().match(/[a-z0-9_]+|[^a-z0-9_\s]+/g) ?? [];
  const out: Array<[string, string, RegExp]> = [];
  for (let i = 0; i + 1 < words.length && out.length < 12; i++) {
    const [x, y] = [words[i], words[i + 1]];
    if (!/^[a-z0-9_]{3,}$/.test(x) || !/^[a-z0-9_]{3,}$/.test(y) || STOPWORDS.has(x) || STOPWORDS.has(y)) continue;
    out.push([x, y, new RegExp("\\b" + x + "[\\s_.\\-]+" + y)]);
  }
  return out;
}

export interface SymbolDef {
  name: string;
  kind: string;
  line: number;
}
interface FileEntry {
  rel: string;
  size: number;
  mtimeMs: number;
  lines: string[];
  lower: string[];
  symbols: SymbolDef[];
}
export interface Snippet {
  path: string;
  startLine: number; // 1-based, inclusive
  endLine: number;
  text: string;
  reason: string;
  score?: number;
}
export interface ContextPack {
  snippets: Snippet[];
  usedChars: number;
  budgetChars: number;
  notes: string[];
  candidates: number;
}

const DEF_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/, ""],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/, ""],
  [/^\s*(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, ""],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(fn|func|struct|trait|impl|mod)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, ""],
  [/^(\s{0})([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*\S/, "assignment"],
];

function findSymbols(lines: string[]): SymbolDef[] {
  const out: SymbolDef[] = [];
  lines.forEach((line, i) => {
    if (line.length > 400) return;
    for (const [re, kind] of DEF_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        out.push({ name: m[2], kind: kind || m[1], line: i });
        return;
      }
    }
  });
  return out;
}

const STOPWORDS = new Set(
  ("a an the and or but not no nor of to in on at by for from with without into onto as is are was were be been being it its this that these those " +
    "there here then than so such if else when while do does did done can could should would may might must shall will just also too very any all " +
    "each every some more most other another same new add adds added adding make makes made use uses used using get gets set sets put need needs " +
    "want wants please how what which who whom whose why where you your we our i me my they them their he she his her well way thing things " +
    "have has had having let lets like only own out over under up down off again further once both few many much per via etc eg ie " +
    "should change changes changed update updates updated treat treats treated value values file files code line lines one two three").split(" "),
);

export interface Term {
  text: string;
  weight: number;
}

/** Turn free text into weighted search terms. Identifiers and quoted strings count double. */
export function extractTerms(query: string): Term[] {
  const terms = new Map<string, number>();
  const add = (raw: string, weight: number) => {
    const t = raw.toLowerCase().replace(/^[^a-z0-9_]+|[^a-z0-9_]+$/g, "");
    if (t.length < 2 || STOPWORDS.has(t) || /^\d+$/.test(t)) return;
    terms.set(t, Math.max(terms.get(t) ?? 0, weight));
  };
  for (const m of query.matchAll(/[`'"]([^`'"\n]{2,60})[`'"]/g)) {
    for (const w of m[1].split(/[^A-Za-z0-9_]+/)) add(w, 2);
  }
  for (const m of query.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const w = m[0];
    const isIdentifier = /_/.test(w) || /[a-z][A-Z]/.test(w);
    const isConstant = /^[A-Z0-9]{3,}$/.test(w);
    add(w, isIdentifier ? 2 : isConstant ? 1.2 : 1);
    if (isIdentifier) {
      for (const part of w.split(/_|(?<=[a-z])(?=[A-Z])/)) if (part.length >= 3) add(part, 0.6);
    } else if (w.length > 4) {
      const stem = w.toLowerCase().replace(/(ing|ed|(?<=[^s])s)$/, "");
      if (stem.length >= 4 && stem !== w.toLowerCase() && !STOPWORDS.has(w.toLowerCase())) add(stem, 0.7);
    }
  }
  return [...terms].map(([text, weight]) => ({ text, weight }));
}

interface Mention {
  kind: "file" | "symbol" | "auto";
  value: string;
}

/** `@file:path`, `@symbol:Name`, or a bare `@token` that is resolved as a path first and a symbol second. */
export function parseMentions(prompt: string): Mention[] {
  const out: Mention[] = [];
  for (const m of prompt.matchAll(/(?:^|[\s(])@(?:(file|symbol):)?([A-Za-z0-9_.\-/\\$]+)/g)) {
    const value = m[2].replace(/[.,;:]+$/, "");
    if (value) out.push({ kind: (m[1] as "file" | "symbol" | undefined) ?? "auto", value });
  }
  return out;
}

export class WorkspaceIndex {
  private cache = new Map<string, FileEntry>();
  private lastScan = 0;

  constructor(
    readonly root: string,
    /** Unsaved or staged content that should be seen instead of what is on disk. */
    private overlay: (rel: string) => string | undefined = () => undefined,
  ) {}

  private scan(): FileEntry[] {
    if (Date.now() - this.lastScan < 1500 && this.cache.size) return this.withOverlay();
    const seen = new Set<string>();
    const walk = (dir: string, depth: number) => {
      if (depth > 12) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue; // never follow links out of the workspace
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!EXCLUDED_DIRS.has(e.name) && !e.name.endsWith(".egg-info")) walk(abs, depth + 1);
          continue;
        }
        if (!e.isFile() || BINARY_EXT.test(e.name)) continue;
        const rel = path.relative(this.root, abs).split(path.sep).join("/");
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.size > MAX_FILE_BYTES) continue;
        seen.add(rel);
        const hit = this.cache.get(rel);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) continue;
        let text: string;
        try {
          text = fs.readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\0")) {
          seen.delete(rel);
          continue;
        }
        this.cache.set(rel, makeEntry(rel, text, st.size, st.mtimeMs));
      }
    };
    walk(this.root, 0);
    for (const rel of [...this.cache.keys()]) if (!seen.has(rel)) this.cache.delete(rel);
    this.lastScan = Date.now();
    return this.withOverlay();
  }

  private withOverlay(): FileEntry[] {
    return [...this.cache.values()].map((f) => {
      const text = this.overlay(f.rel);
      return text === undefined ? f : makeEntry(f.rel, text, text.length, f.mtimeMs);
    });
  }

  invalidate(): void {
    this.lastScan = 0;
  }

  fileCount(): number {
    return this.scan().length;
  }

  /** Rank files for a query and return the best excerpts that fit in `capChars`. */
  search(query: string, opts: { capChars: number; maxFiles?: number; pathPrefix?: string; exclude?: Set<string> }): ContextPack {
    const files = this.scan().filter((f) => (!opts.pathPrefix || f.rel.startsWith(opts.pathPrefix.replace(/\\/g, "/"))) && !opts.exclude?.has(f.rel));
    const terms = extractTerms(query);
    const phrase = query.trim().toLowerCase();
    const usePhrase = phrase.length >= 4 && phrase.length <= 120 && /\W/.test(phrase);
    const notes: string[] = [];
    if (!terms.length && !usePhrase) return { snippets: [], usedChars: 0, budgetChars: opts.capChars, notes: ["No searchable terms in the query."], candidates: 0 };

    // Pass 1: per-file term statistics.
    const df = new Map<string, number>();
    const stats = files.map((f) => {
      const hits = new Map<string, number[]>();
      const phraseLines: number[] = [];
      f.lower.forEach((line, i) => {
        if (usePhrase && line.includes(phrase)) phraseLines.push(i);
        for (const t of terms) {
          if (line.includes(t.text)) {
            let arr = hits.get(t.text);
            if (!arr) hits.set(t.text, (arr = []));
            arr.push(i);
          }
        }
      });
      for (const t of hits.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      return { f, hits, phraseLines };
    });

    // Pass 2: score each file. Three kinds of evidence, strongest first:
    //   definitions (a symbol named like a query term), the path (file or folder named like a term),
    //   and text (BM25: rarer terms count more, long files do not win just by being long).
    const n = Math.max(1, files.length);
    const avgLen = files.reduce((sum, f) => sum + f.lines.length, 0) / n || 1;
    const pairs = adjacentPairs(query);
    const scored = stats
      .map(({ f, hits, phraseLines }) => {
        const relLower = f.rel.toLowerCase();
        const stem = path.posix.basename(relLower).replace(/\.[^.]+$/, "");
        const segments = relLower.split(/[/._\-]/);
        const reasons: Array<[number, string]> = [];
        const lineScore = new Map<number, number>();
        let score = 0;
        const bump = (line: number, by: number) => lineScore.set(line, (lineScore.get(line) ?? 0) + by);
        const lengthNorm = 0.25 + 0.75 * (f.lines.length / avgLen);
        for (const t of terms) {
          const exact = f.symbols.filter((d) => d.name.toLowerCase() === t.text);
          const partial = exact.length || t.text.length < 4 ? [] : f.symbols.filter((d) => d.name.toLowerCase().split(/_|(?<=[a-z])(?=[A-Z])/).includes(t.text));
          if (exact.length) {
            score += 8 * t.weight;
            reasons.push([8 * t.weight, "defines `" + exact[0].name + "`"]);
            exact.forEach((d) => bump(d.line, 8 * t.weight));
          } else if (partial.length) {
            const part = Math.min(3, partial.length) * 2 * t.weight;
            score += part;
            reasons.push([part, "defines `" + partial[0].name + "`" + (partial.length > 1 ? " and " + (partial.length - 1) + ' more "' + t.text + '" symbols' : "")]);
            partial.slice(0, 6).forEach((d) => bump(d.line, 3 * t.weight));
          }
          if (stem === t.text) {
            score += 7 * t.weight;
            reasons.push([7 * t.weight, 'file is named "' + t.text + '"']);
          } else if (segments.includes(t.text)) {
            score += 4 * t.weight;
            reasons.push([4 * t.weight, 'path contains "' + t.text + '"']);
          }
          const lines = hits.get(t.text);
          if (lines) {
            const d = df.get(t.text) ?? 0;
            const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
            const part = ((idf * lines.length * 2.5) / (lines.length + 1.5 * lengthNorm)) * t.weight;
            score += part;
            reasons.push([part, 'mentions "' + t.text + '" ×' + lines.length]);
            lines.forEach((l) => bump(l, idf * t.weight));
          }
        }
        for (const [x, y, re] of pairs) {
          const lines: number[] = [];
          f.lower.forEach((line, i) => {
            if (re.test(line)) lines.push(i);
          });
          if (!lines.length) continue;
          const part = 4 * Math.min(2, 1 + Math.log(lines.length));
          score += part;
          reasons.push([part, 'has "' + x + " " + y + '" together ×' + lines.length]);
          lines.forEach((l) => bump(l, 6));
        }
        if (phraseLines.length) {
          score += 15;
          reasons.push([15, "contains the exact phrase ×" + phraseLines.length]);
          phraseLines.forEach((l) => bump(l, 20));
        }
        if (LOW_SIGNAL.test(path.posix.basename(relLower))) score *= 0.3; // changelogs, licences: mention everything, explain nothing
        reasons.sort((p, q) => q[0] - p[0]);
        return { f, score, lineScore, role: roleOf(relLower), reason: reasons.slice(0, 3).map((r) => r[1]).join("; ") };
      })
      .filter((x) => x.score > 0)
      .sort((p, q) => q.score - p.score || p.f.rel.localeCompare(q.f.rel));

    // A change usually spans implementation, tests and docs. If the best test file or doc file is a
    // real match (at least a third of the top score) but fell outside the cut, it replaces the weakest pick.
    const maxFiles = opts.maxFiles ?? 8;
    const top = scored.slice(0, maxFiles);
    for (const role of ["test", "doc", "source"] as const) {
      if (top.length < maxFiles || top.some((x) => x.role === role)) continue;
      const best = scored.find((x) => x.role === role);
      if (!best || best.score < scored[0].score / 3) continue;
      const counts = new Map<string, number>();
      top.forEach((x) => counts.set(x.role, (counts.get(x.role) ?? 0) + 1));
      for (let i = top.length - 1; i >= 0; i--) {
        if ((counts.get(top[i].role) ?? 0) > 1) {
          top[i] = { ...best, reason: best.reason + "; best matching " + role + " file" };
          break;
        }
      }
    }
    top.sort((p, q) => q.score - p.score);

    // Pass 3: spend the budget, best file first, proportional to score.
    const totalScore = top.reduce((s, x) => s + x.score, 0) || 1;
    const snippets: Snippet[] = [];
    let used = 0;
    for (const item of top) {
      const remaining = opts.capChars - used;
      if (remaining < 200) break;
      const share = Math.min(remaining, Math.max(500, Math.floor(opts.capChars * Math.min(0.4, item.score / totalScore))));
      for (const sn of pickWindows(item.f, item.lineScore, share)) {
        snippets.push({ ...sn, reason: item.reason, score: Math.round(item.score * 10) / 10 });
        used += sn.text.length;
      }
    }
    if (scored.length > top.length) notes.push(`${scored.length - top.length} lower-ranked matching files not shown: ${scored.slice(top.length, top.length + 12).map((x) => x.f.rel).join(", ")}`);
    return { snippets, usedChars: used, budgetChars: opts.capChars, notes, candidates: scored.length };
  }

  findSymbol(name: string): Array<{ rel: string; def: SymbolDef }> {
    const want = name.toLowerCase();
    const out: Array<{ rel: string; def: SymbolDef }> = [];
    for (const f of this.scan()) for (const def of f.symbols) if (def.name.toLowerCase() === want && def.kind !== "assignment") out.push({ rel: f.rel, def });
    if (!out.length) for (const f of this.scan()) for (const def of f.symbols) if (def.name.toLowerCase() === want) out.push({ rel: f.rel, def });
    return out;
  }

  findFile(value: string): string[] {
    const want = value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    const files = this.scan();
    const exact = files.filter((f) => f.rel.toLowerCase() === want);
    if (exact.length) return exact.map((f) => f.rel);
    return files.filter((f) => f.rel.toLowerCase().endsWith("/" + want) || path.posix.basename(f.rel).toLowerCase() === want).map((f) => f.rel);
  }

  private entry(rel: string): FileEntry | undefined {
    return this.scan().find((f) => f.rel === rel);
  }

  /** Whole-block excerpt for a definition: runs until the next line at the same or lower indentation. */
  symbolSnippet(rel: string, def: SymbolDef, maxChars: number): Snippet | undefined {
    const f = this.entry(rel);
    if (!f) return undefined;
    const indent = /^\s*/.exec(f.lines[def.line])![0].length;
    let start = def.line;
    while (start > 0 && /^\s*(@|#|\/\/|\/\*|\*)/.test(f.lines[start - 1]) && /^\s*/.exec(f.lines[start - 1])![0].length === indent) start--;
    let end = def.line + 1;
    while (end < f.lines.length && end - def.line < 200) {
      const l = f.lines[end];
      if (l.trim() && /^\s*/.exec(l)![0].length <= indent && !/^\s*[)\]}]/.test(l)) break;
      end++;
    }
    while (end > def.line + 1 && !f.lines[end - 1].trim()) end--;
    return clip(f, start, end, maxChars, `@symbol ${def.name} (${def.kind}) defined here`);
  }

  fileSnippet(rel: string, maxChars: number, reason: string): Snippet | undefined {
    const f = this.entry(rel);
    if (!f) return undefined;
    const sn = clip(f, 0, f.lines.length, maxChars, reason);
    if (sn.endLine < f.lines.length && f.symbols.length) {
      const outline = f.symbols.filter((s) => s.kind !== "assignment" && s.line >= sn.endLine).slice(0, 60).map((s) => `L${s.line + 1} ${s.kind} ${s.name}`).join("\n");
      if (outline) sn.text += `\n… file continues (${f.lines.length} lines). Remaining definitions:\n${outline}`;
    }
    return sn;
  }

  /** Numbered lines for the read_file tool. */
  read(rel: string, startLine: number | undefined, endLine: number | undefined, maxChars: number): { text: string; startLine: number; endLine: number; totalLines: number } | undefined {
    const f = this.entry(rel);
    if (!f) return undefined;
    const start = Math.max(0, (startLine ?? 1) - 1);
    const end = Math.min(f.lines.length, endLine ?? f.lines.length);
    const sn = clip(f, start, Math.max(start, end), maxChars, "");
    return { text: sn.text, startLine: sn.startLine, endLine: sn.endLine, totalLines: f.lines.length };
  }
}

function makeEntry(rel: string, text: string, size: number, mtimeMs: number): FileEntry {
  const lines = text.split(/\r?\n/);
  return { rel, size, mtimeMs, lines, lower: lines.map((l) => l.toLowerCase()), symbols: CODE_EXT.test(rel) ? findSymbols(lines) : [] };
}

const numbered = (f: FileEntry, start: number, end: number): string => {
  const out: string[] = [];
  for (let i = start; i < end; i++) out.push(`${String(i + 1).padStart(4)}| ${f.lines[i].length > 300 ? f.lines[i].slice(0, 300) + " …" : f.lines[i]}`);
  return out.join("\n");
};

function clip(f: FileEntry, start: number, end: number, maxChars: number, reason: string): Snippet {
  let stop = start;
  let size = 0;
  while (stop < end) {
    size += Math.min(f.lines[stop].length, 302) + 7;
    if (size > maxChars && stop > start) break;
    stop++;
  }
  return { path: f.rel, startLine: start + 1, endLine: stop, text: numbered(f, start, stop), reason };
}

/** Choose the highest-scoring line windows of a file that fit in `budget` characters. */
function pickWindows(f: FileEntry, lineScore: Map<number, number>, budget: number): Snippet[] {
  const defLines = new Set(f.symbols.map((s) => s.line));
  const ranked = [...lineScore].map(([line, score]) => ({ line, score: score * (defLines.has(line) ? 1.5 : 1) })).sort((a, b) => b.score - a.score || a.line - b.line);
  if (!ranked.length) return [clip(f, 0, Math.min(f.lines.length, 30), budget, "")];
  const windows: Array<[number, number]> = [];
  let used = 0;
  for (const { line } of ranked) {
    if (windows.some(([a, b]) => line >= a && line < b)) continue;
    const start = Math.max(0, line - 2);
    const end = Math.min(f.lines.length, line + (defLines.has(line) ? 14 : 5));
    let cost = 0;
    for (let i = start; i < end; i++) cost += Math.min(f.lines[i].length, 302) + 7;
    if (used + cost > budget) {
      if (!windows.length) windows.push([start, end]);
      break;
    }
    windows.push([start, end]);
    used += cost;
  }
  windows.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1] + 1) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  let left = budget;
  const out: Snippet[] = [];
  for (const [a, b] of merged) {
    if (left < 80 && out.length) break;
    const sn = clip(f, a, b, Math.max(left, 200), "");
    out.push(sn);
    left -= sn.text.length;
  }
  return out;
}

/**
 * Build the context sent with the first message of a session:
 * explicit @mentions first, then automatically retrieved excerpts, all inside one budget.
 */
export function assembleContext(index: WorkspaceIndex, prompt: string, budgetChars: number, pinned: Snippet[] = []): ContextPack {
  const snippets: Snippet[] = [];
  const notes: string[] = [];
  let used = 0;
  const push = (sn: Snippet | undefined) => {
    if (!sn) return;
    snippets.push(sn);
    used += sn.text.length;
  };
  pinned.forEach(push);
  const mentionCap = Math.floor(budgetChars * 0.4);
  const mentionedFiles = new Set<string>(pinned.map((p) => p.path));
  for (const m of parseMentions(prompt)) {
    const room = Math.min(mentionCap, budgetChars - used);
    if (room < 200) {
      notes.push(`@${m.value} skipped: context budget exhausted.`);
      continue;
    }
    const files = m.kind === "symbol" ? [] : index.findFile(m.value);
    if (files.length === 1) {
      push(index.fileSnippet(files[0], room, `@file mention`));
      mentionedFiles.add(files[0]);
      continue;
    }
    if (files.length > 1 && m.kind === "file") {
      notes.push(`@${m.value} is ambiguous: ${files.slice(0, 5).join(", ")}`);
      continue;
    }
    const defs = m.kind === "file" ? [] : index.findSymbol(m.value);
    if (!defs.length) {
      notes.push(`@${m.value} did not match a file or a defined symbol.`);
      continue;
    }
    const each = Math.floor(room / Math.min(defs.length, 3));
    for (const d of defs.slice(0, 3)) {
      push(index.symbolSnippet(d.rel, d.def, each));
      mentionedFiles.add(d.rel);
    }
    if (defs.length > 3) notes.push(`@${m.value} has ${defs.length} definitions; showing 3.`);
  }
  const auto = index.search(prompt.replace(/@(?:file:|symbol:)?[A-Za-z0-9_.\-/\\$]+/g, " "), { capChars: Math.max(0, budgetChars - used), exclude: mentionedFiles });
  snippets.push(...auto.snippets);
  used += auto.usedChars;
  notes.push(...auto.notes);
  return { snippets, usedChars: used, budgetChars, notes, candidates: auto.candidates };
}

export function renderContext(pack: ContextPack): string {
  if (!pack.snippets.length) return "";
  const body = pack.snippets.map((s) => `### ${s.path} lines ${s.startLine}-${s.endLine}${s.reason ? ` — selected because: ${s.reason}` : ""}\n${s.text}`).join("\n\n");
  return `<workspace-context budget_chars="${pack.budgetChars}" used_chars="${pack.usedChars}">\nExcerpts the editor selected for this request (line numbers are prefixes, not file content). They are a starting point, not the whole repository: use the workspace tools to search and read anything else you need.\n\n${body}\n</workspace-context>`;
}
