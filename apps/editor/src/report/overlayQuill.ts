/**
 * The thin Quill adapter over the pure overlay functions. Every change reaches Quill as a
 * minimal `updateContents(diff, "api")`, so the radiologist's selection is transformed rather
 * than reset (INV-2) and nothing lands in the user's undo stack (`history.userOnly`).
 */
import Quill, { Delta } from "quill";
import type { Op } from "quill";
import { AI_DELETE, AI_DRAFT, AI_INSERT, lineIndex, lineLength, splitLines, touchedLines } from "./overlay.ts";

export function currentOps(quill: Quill): Op[] {
  return quill.getContents().ops;
}

/** Replace the document with `next` via a minimal diff (selection-preserving). */
export function applyOps(quill: Quill, next: Op[]): void {
  const change = quill.getContents().diff(new Delta(next));
  if (change.ops.length > 0) quill.updateContents(change, "api");
}

const NO_MARKS = { [AI_INSERT]: false, [AI_DELETE]: false, [AI_DRAFT]: false } as const;

/**
 * After a user edit: typed text must not inherit overlay/draft marks from its neighbours, and
 * any line the radiologist touched loses its `ai-draft` mark (per-line review rule).
 * Runs with source "silent" so it neither re-triggers `text-change` nor enters undo history.
 */
export function afterUserChange(quill: Quill, change: Delta): void {
  let pos = 0;
  for (const op of change.ops) {
    if (op.retain !== undefined) {
      pos += typeof op.retain === "number" ? op.retain : 1;
    } else if (typeof op.insert === "string") {
      quill.formatText(pos, op.insert.length, NO_MARKS, "silent");
      pos += op.insert.length;
    } else if (op.insert !== undefined) {
      pos += 1;
    }
  }
  const ops = currentOps(quill);
  const lines = splitLines(ops);
  for (const i of touchedLines(ops, change.ops)) {
    const line = lines[i];
    if (!line || !line.runs.some((r) => r.attributes?.[AI_DRAFT] !== undefined)) continue;
    quill.formatText(lineIndex(lines, i), lineLength(line) - 1, AI_DRAFT, false, "silent");
  }
}
