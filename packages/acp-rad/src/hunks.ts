/**
 * Line-level hunks (ADR 0002): the unit the radiologist accepts or discards.
 *
 * A proposal's diff (`oldText` → `newText`, both canonical Markdown fragments) is split into
 * hunks = contiguous runs of changed lines. Anchoring is by line equality, never by offsets, so
 * the radiologist can keep typing elsewhere while a proposal is pending (INV-2).
 */
import { canonicalLines } from "./markdown.ts";

export type Hunk = {
  id: string;
  /** Lines removed (struck in the overlay). Empty for a pure insertion. */
  oldLines: string[];
  /** Lines inserted after `oldLines` (or after `contextBefore` when `oldLines` is empty). */
  newLines: string[];
  /** The unchanged line immediately before the hunk in the old text, if any (anchor for inserts). */
  contextBefore?: string;
};

export type LineEdit = { type: "equal" | "delete" | "insert"; line: string };

/** Minimal LCS line diff (inputs are short: one section or one edit snippet). */
export function lineDiff(a: string[], b: string[]): LineEdit[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: LineEdit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "equal", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "delete", line: a[i]! });
      i++;
    } else {
      out.push({ type: "insert", line: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "delete", line: a[i++]! });
  while (j < m) out.push({ type: "insert", line: b[j++]! });
  return out;
}

/** Group a diff into hunks. Ids are `${prefix}${n}` in document order. */
export function buildHunks(oldText: string, newText: string, prefix = "h"): Hunk[] {
  const edits = lineDiff(canonicalLines(oldText), canonicalLines(newText));
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let lastEqual: string | undefined;
  for (const e of edits) {
    if (e.type === "equal") {
      current = undefined;
      lastEqual = e.line;
      continue;
    }
    if (!current) {
      current = { id: `${prefix}${hunks.length + 1}`, oldLines: [], newLines: [] };
      if (lastEqual !== undefined) current.contextBefore = lastEqual;
      hunks.push(current);
    }
    (e.type === "delete" ? current.oldLines : current.newLines).push(e.line);
  }
  return hunks;
}

export type ApplyResult = { text: string; conflicts: string[] };

/**
 * Apply the accepted hunks to `text` (a section file), anchoring each by its old lines.
 * Hunks whose anchor cannot be found are reported in `conflicts` and skipped.
 */
export function applyHunks(
  text: string,
  hunks: Hunk[],
  accepted: (hunk: Hunk) => boolean = () => true,
): ApplyResult {
  let lines = canonicalLines(text);
  const conflicts: string[] = [];
  let cursor = 0; // hunks are in document order; search forward from the last anchor
  for (const h of hunks) {
    if (!accepted(h)) {
      // Still advance the cursor past this hunk's anchor so later hunks anchor after it.
      const at = h.oldLines.length ? findRun(lines, h.oldLines, cursor) : -1;
      if (at >= 0) cursor = at + h.oldLines.length;
      continue;
    }
    if (h.oldLines.length > 0) {
      const at = findRun(lines, h.oldLines, cursor);
      if (at < 0) {
        conflicts.push(h.id);
        continue;
      }
      lines = [...lines.slice(0, at), ...h.newLines, ...lines.slice(at + h.oldLines.length)];
      cursor = at + h.newLines.length;
    } else {
      const anchor = h.contextBefore !== undefined ? lines.indexOf(h.contextBefore, cursor) : -1;
      const at = anchor >= 0 ? anchor + 1 : lines.length;
      lines = [...lines.slice(0, at), ...h.newLines, ...lines.slice(at)];
      cursor = at + h.newLines.length;
    }
  }
  return { text: lines.length ? `${lines.join("\n")}\n` : "\n", conflicts };
}

/** The section as it would read if every hunk were accepted — the grant's expected content. */
export function expectedAfterAll(text: string, hunks: Hunk[]): string {
  return applyHunks(text, hunks).text;
}

/** Index of the first occurrence of `run` as consecutive lines at or after `from`; -1 if absent. */
export function findRun(lines: string[], run: string[], from = 0): number {
  if (run.length === 0) return -1;
  outer: for (let i = from; i + run.length <= lines.length; i++) {
    for (let k = 0; k < run.length; k++) if (lines[i + k] !== run[k]) continue outer;
    return i;
  }
  return -1;
}
