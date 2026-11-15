import { diffArrays } from "diff";

/** One contiguous change, in 0-based line coordinates of the text it was computed against. */
export interface Hunk {
  id: number;
  oldStart: number;
  oldLines: string[];
  newLines: string[];
  /** Up to CONTEXT unchanged lines either side, used to re-locate the hunk if the file moved. */
  before: string[];
  after: string[];
}

export interface SearchReplace {
  old_text: string;
  new_text: string;
}

export interface LineEdit {
  hunkId: number;
  start: number;
  /** Exclusive end line. */
  end: number;
  newLines: string[];
}

const CONTEXT = 3;

export const detectEol = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");
export const splitLines = (text: string): string[] => text.split(/\r?\n/);
const sameLines = (a: string[], b: string[]): boolean => a.length === b.length && a.every((l, i) => l === b[i]);

/**
 * Apply model-authored search/replace edits. Every old_text must identify exactly one place
 * and the edits must not overlap, otherwise nothing is applied and the reason is returned
 * so the model can re-read and retry.
 */
export function applySearchReplace(text: string, edits: SearchReplace[]): { ok: true; text: string } | { ok: false; error: string } {
  if (!edits.length) return { ok: false, error: "No edits were provided." };
  const eol = detectEol(text);
  const lines = splitLines(text);
  const loose = lines.map((l) => l.trimEnd());
  const ranges: LineEdit[] = [];
  for (const [i, edit] of edits.entries()) {
    const label = `edit #${i + 1}`;
    if (typeof edit?.old_text !== "string" || typeof edit?.new_text !== "string") return { ok: false, error: `${label}: old_text and new_text must be strings.` };
    const want = trimBlankEdges(splitLines(edit.old_text).map((l) => l.trimEnd()));
    if (!want.length) return { ok: false, error: `${label}: old_text is empty. Quote the existing lines you are replacing (or the line you are inserting next to).` };
    const hits: number[] = [];
    for (let at = 0; at + want.length <= loose.length; at++) {
      if (want.every((l, k) => loose[at + k] === l)) hits.push(at);
    }
    if (hits.length === 0) return { ok: false, error: `${label}: old_text was not found. It must match whole existing lines exactly; read the file again and copy them.` };
    if (hits.length > 1) return { ok: false, error: `${label}: old_text matches ${hits.length} places (lines ${hits.map((h) => h + 1).join(", ")}). Include more surrounding lines to make it unique.` };
    const newLines = edit.new_text === "" ? [] : trimTrailingBlank(splitLines(edit.new_text), splitLines(edit.old_text));
    ranges.push({ hunkId: i, start: hits[0], end: hits[0] + want.length, newLines });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) return { ok: false, error: `Edits overlap around line ${ranges[i].start + 1}. Merge them into one edit.` };
  }
  return { ok: true, text: applyLineEdits(lines, ranges).join(eol) };
}

function trimBlankEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a] === "") a++;
  while (b > a && lines[b - 1] === "") b--;
  return lines.slice(a, b);
}

/** old_text is matched without its blank edges, so drop the same edges from new_text to keep spacing stable. */
function trimTrailingBlank(newLines: string[], oldLines: string[]): string[] {
  let lead = 0;
  while (lead < oldLines.length && oldLines[lead].trim() === "") lead++;
  let trail = 0;
  while (trail < oldLines.length - lead && oldLines[oldLines.length - 1 - trail].trim() === "") trail++;
  let a = 0;
  let b = newLines.length;
  while (lead-- > 0 && a < b && newLines[a].trim() === "") a++;
  while (trail-- > 0 && b > a && newLines[b - 1].trim() === "") b--;
  return newLines.slice(a, b);
}

function applyLineEdits(lines: string[], edits: LineEdit[]): string[] {
  const out: string[] = [];
  let pos = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    out.push(...lines.slice(pos, e.start), ...e.newLines);
    pos = e.end;
  }
  out.push(...lines.slice(pos));
  return out;
}

/** Line diff split into independent hunks: any unchanged line between two changes separates them. */
export function computeHunks(oldText: string, newText: string): Hunk[] {
  const oldLines = splitLines(oldText);
  const hunks: Hunk[] = [];
  let pos = 0;
  let cur: Hunk | undefined;
  const flush = () => {
    if (!cur) return;
    const end = cur.oldStart + cur.oldLines.length;
    cur.before = oldLines.slice(Math.max(0, cur.oldStart - CONTEXT), cur.oldStart);
    cur.after = oldLines.slice(end, end + CONTEXT);
    hunks.push(cur);
    cur = undefined;
  };
  for (const part of diffArrays(oldLines, splitLines(newText))) {
    if (!part.added && !part.removed) {
      flush();
      pos += part.value.length;
      continue;
    }
    cur ??= { id: hunks.length, oldStart: pos, oldLines: [], newLines: [], before: [], after: [] };
    if (part.removed) {
      cur.oldLines.push(...part.value);
      pos += part.value.length;
    } else {
      cur.newLines.push(...part.value);
    }
  }
  flush();
  return hunks;
}

/** Apply only the accepted hunks to the text they were computed against. */
export function applyHunks(oldText: string, hunks: Hunk[], accepted: ReadonlySet<number>): string {
  const edits = hunks.filter((h) => accepted.has(h.id)).map((h) => ({ hunkId: h.id, start: h.oldStart, end: h.oldStart + h.oldLines.length, newLines: h.newLines }));
  return applyLineEdits(splitLines(oldText), edits).join(detectEol(oldText));
}

/**
 * Verified rebase: place each hunk on text that may have changed since the hunk was computed.
 * A hunk is placed only where its old lines plus surrounding context are found unchanged
 * (at the original position, or at exactly one other position, trying less context if the
 * neighbouring lines were edited). Anything else is a conflict.
 */
export function rebaseHunks(currentText: string, hunks: Hunk[]): { edits: LineEdit[]; conflicts: number[] } {
  const lines = splitLines(currentText);
  const edits: LineEdit[] = [];
  const conflicts: number[] = [];
  const findAll = (block: string[]): number[] => {
    const hits: number[] = [];
    for (let i = 0; i + block.length <= lines.length && hits.length < 2; i++) {
      if (sameLines(lines.slice(i, i + block.length), block)) hits.push(i);
    }
    return hits;
  };
  for (const h of hunks) {
    // Anchors from most to least context. Each is [lines to find, how many of them precede the hunk].
    const anchors: Array<[string[], number]> = [
      [[...h.before, ...h.oldLines, ...h.after], h.before.length],
      [[...h.before, ...h.oldLines], h.before.length],
      [[...h.oldLines, ...h.after], 0],
      [h.oldLines, 0],
    ];
    let start = -1;
    const full = anchors[0];
    const expected = h.oldStart - full[1];
    if (full[0].length && sameLines(lines.slice(expected, expected + full[0].length), full[0])) start = h.oldStart;
    for (const [block, lead] of anchors) {
      if (start >= 0) break;
      if (!block.length) continue;
      const hits = findAll(block);
      if (hits.length === 1) start = hits[0] + lead;
    }
    if (start < 0) conflicts.push(h.id);
    else edits.push({ hunkId: h.id, start, end: start + h.oldLines.length, newLines: h.newLines });
  }
  edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].start < edits[i - 1].end) {
      conflicts.push(edits[i].hunkId);
      edits.splice(i--, 1);
    }
  }
  return { edits, conflicts };
}

export const applyEditsToText = (text: string, edits: LineEdit[]): string => applyLineEdits(splitLines(text), edits).join(detectEol(text));

/** The hunks that turn `to` back into `from`; used for undo. */
export const invertHunks = (from: string, to: string): Hunk[] => computeHunks(to, from);

/** Where each hunk starts in a preview where only `applied` hunks are in effect. */
export function previewLineOf(hunks: Hunk[], applied: ReadonlySet<number>): Map<number, number> {
  const map = new Map<number, number>();
  let offset = 0;
  for (const h of hunks) {
    map.set(h.id, h.oldStart + offset);
    if (applied.has(h.id)) offset += h.newLines.length - h.oldLines.length;
  }
  return map;
}

/**
 * Convert line edits into character-offset replacements on the real text (which may mix
 * line endings), so an editor can apply each hunk as its own minimal text edit.
 */
export function toOffsetEdits(text: string, edits: LineEdit[]): Array<{ start: number; end: number; text: string }> {
  const eol = detectEol(text);
  const starts = [0];
  for (const m of text.matchAll(/\r?\n/g)) starts.push(m.index! + m[0].length);
  const lineCount = starts.length;
  return [...edits]
    .sort((a, b) => a.start - b.start)
    .map((e) => {
      const toEnd = e.end >= lineCount;
      let start = e.start < lineCount ? starts[e.start] : text.length;
      const end = toEnd ? text.length : starts[e.end];
      let replacement = e.newLines.join(eol);
      if (!toEnd) replacement += e.newLines.length ? eol : "";
      else if (!e.newLines.length && e.start > 0) start = lineEnd(text, starts[e.start - 1]); // deleting the tail: drop the newline before it
      else if (e.start >= lineCount) replacement = eol + replacement;
      return { start, end, text: replacement };
    });
}

function lineEnd(text: string, from: number): number {
  const m = /\r?\n/.exec(text.slice(from));
  return m ? from + m.index : text.length;
}
