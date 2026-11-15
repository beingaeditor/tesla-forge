import fs from "node:fs";
import path from "node:path";

export class PathError extends Error {}

const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
const isInside = (root: string, target: string): boolean => {
  const rel = path.relative(fold(root), fold(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Resolve a tool-supplied path to a file inside the workspace.
 * Rejects traversal, absolute paths outside the root, VCS internals, and anything whose
 * real location (after following symlinks or junctions) is outside the workspace.
 */
export function resolveInWorkspace(root: string, requested: string): { abs: string; rel: string } {
  if (typeof requested !== "string" || !requested.trim() || requested.includes("\0")) throw new PathError("Path is empty or invalid.");
  const abs = path.resolve(root, requested.trim());
  if (!isInside(root, abs)) throw new PathError(`Path "${requested}" is outside the workspace.`);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (!rel) throw new PathError("Path is the workspace root, not a file.");
  if (rel.split("/").some((seg) => fold(seg) === ".git")) throw new PathError("Paths inside .git are not accessible.");

  // Symlink check: the nearest existing ancestor must really live inside the real root.
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realRoot = fs.realpathSync.native(root);
  const realProbe = fs.realpathSync.native(probe);
  if (!isInside(realRoot, realProbe)) throw new PathError(`Path "${requested}" resolves outside the workspace through a link.`);
  return { abs, rel };
}
