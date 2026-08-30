/**
 * Proposal overlays over plain Quill ops — pure functions, no DOM (ADR 0002, design §5.7).
 *
 * The overlay lives in the Delta as inline attributes (`ai-insert` / `ai-delete` keyed by hunk
 * id, `ai-unreviewed` keyed by proposal id, `ai-flag` keyed by flag id). `stripOverlays` is what
 * the ReportStore reads through, so a pending proposal is rendered but never in the canonical
 * buffer (INV-1). A flag mark is a plain attribute on a buffer line: it moves with the line and
 * disappears with it; it is never in the canonical Markdown (`deltaToMarkdown` ignores it).
 */
import type { AttributeMap, Op } from "quill";
import {
  deltaToMarkdown,
  eachLine,
  markdownToDelta,
  sectionIdOfLine,
  type Hunk,
  type SectionId,
} from "acp-rad";

export const AI_INSERT = "ai-insert";
export const AI_DELETE = "ai-delete";
export const AI_UNREVIEWED = "ai-unreviewed";
export const AI_FLAG = "ai-flag";

export type Line = { runs: Op[]; attrs: AttributeMap };

// ---------------------------------------------------------------------------
// Lines ⇄ ops
// ---------------------------------------------------------------------------

export function splitLines(ops: Op[]): Line[] {
  return [...eachLine(ops)].map(({ runs, attrs }) => ({ runs: runs.map(cloneOp), attrs: { ...attrs } }));
}

export function joinLines(lines: Line[]): Op[] {
  const out: Op[] = [];
  for (const line of lines) {
    for (const r of line.runs) pushOp(out, r);
    pushOp(out, Object.keys(line.attrs).length ? { insert: "\n", attributes: line.attrs } : { insert: "\n" });
  }
  if (out.length === 0) out.push({ insert: "\n" });
  return out;
}

/** Canonical Markdown text of one line (no trailing newline), overlays ignored. */
export function lineText(line: Line): string {
  const ops: Op[] = [...line.runs.map(withoutOverlayAttrs), { insert: "\n", attributes: line.attrs }];
  return deltaToMarkdown(ops).replace(/\n$/, "");
}

export const isInsertLine = (line: Line): boolean =>
  line.runs.length > 0 && line.runs.every((r) => r.attributes?.[AI_INSERT] !== undefined);
export const isDeleteLine = (line: Line): boolean =>
  line.runs.length > 0 && line.runs.every((r) => r.attributes?.[AI_DELETE] !== undefined);
const hunkOf = (line: Line, key: string): string | undefined => {
  const v = line.runs[0]?.attributes?.[key];
  return typeof v === "string" ? v : undefined;
};

/** Character offset of the start of line `i` (Quill index). */
export function lineIndex(lines: Line[], i: number): number {
  let idx = 0;
  for (let k = 0; k < i && k < lines.length; k++) idx += lineLength(lines[k]!);
  return idx;
}
export function lineLength(line: Line): number {
  return line.runs.reduce((n, r) => n + (typeof r.insert === "string" ? r.insert.length : 1), 0) + 1;
}

// ---------------------------------------------------------------------------
// Buffer view (INV-1)
// ---------------------------------------------------------------------------

/** What the agent and the audit see: inserted overlay lines dropped, deletions kept as text, no marks. */
export function stripOverlays(ops: Op[]): Op[] {
  const kept = splitLines(ops)
    .filter((l) => !isInsertLine(l))
    .map((l) => ({ attrs: l.attrs, runs: l.runs.filter((r) => r.attributes?.[AI_INSERT] === undefined).map((r) => dropAttr(withoutOverlayAttrs(r), AI_FLAG)) }));
  return joinLines(kept);
}

// ---------------------------------------------------------------------------
// Locating and rendering a proposal
// ---------------------------------------------------------------------------

/** Line-index range `[start, end)` of a section (label line included), overlays excluded from matching. */
export function sectionRange(lines: Line[], section: SectionId | null): { start: number; end: number } {
  if (section === null) return { start: 0, end: lines.length };
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isInsertLine(lines[i]!)) continue;
    const id = sectionIdOfLine(lineText(lines[i]!));
    if (id === undefined) continue;
    if (start >= 0) return { start, end: i };
    if (id === section) start = i;
  }
  return start >= 0 ? { start, end: lines.length } : { start: -1, end: -1 };
}

export type Located = { start: number; count: number } | null;

/** Find the hunk's old lines (or its insertion point) as a line range; `null` ⇒ conflict. */
export function locateHunk(lines: Line[], section: SectionId | null, hunk: Hunk, from = 0): Located {
  const range = sectionRange(lines, section);
  if (range.start < 0) return null;
  const lo = Math.max(range.start, from);
  const matchable = (i: number) => !isInsertLine(lines[i]!);
  if (hunk.oldLines.length > 0) {
    outer: for (let i = lo; i + hunk.oldLines.length <= range.end; i++) {
      for (let k = 0; k < hunk.oldLines.length; k++) {
        const line = lines[i + k]!;
        if (!matchable(i + k) || lineText(line) !== hunk.oldLines[k]) continue outer;
      }
      return { start: i, count: hunk.oldLines.length };
    }
    return null;
  }
  if (hunk.contextBefore !== undefined) {
    for (let i = lo; i < range.end; i++) {
      if (matchable(i) && lineText(lines[i]!) === hunk.contextBefore) return { start: i + 1, count: 0 };
    }
    return null;
  }
  // No anchor at all: append at the section end, before its trailing blank lines.
  let end = range.end;
  while (end > range.start + 1 && lineText(lines[end - 1]!) === "" ) end--;
  return { start: end, count: 0 };
}

export type OverlayResult = { ops: Op[]; conflicts: string[] };

/** Render every hunk of a proposal as tracked changes. Conflicting hunks are skipped and reported. */
export function overlayOps(ops: Op[], section: SectionId | null, hunks: Hunk[]): OverlayResult {
  const lines = splitLines(ops);
  const conflicts: string[] = [];
  let cursor = 0;
  for (const h of hunks) {
    const at = locateHunk(lines, section, h, cursor);
    if (!at) {
      conflicts.push(h.id);
      continue;
    }
    for (let i = at.start; i < at.start + at.count; i++) markRuns(lines[i]!, AI_DELETE, h.id);
    const inserted = newLinesFor(h);
    lines.splice(at.start + at.count, 0, ...inserted);
    cursor = at.start + at.count + inserted.length;
  }
  return { ops: joinLines(lines), conflicts };
}

function newLinesFor(hunk: Hunk): Line[] {
  const md = hunk.newLines.map((l) => (l === "" ? " " : l)).join("\n");
  return splitLines(markdownToDelta(`${md}\n`)).map((line) => {
    const runs = line.runs.length ? line.runs : [{ insert: " " }];
    return { attrs: line.attrs, runs: runs.map((r) => ({ ...r, attributes: { ...r.attributes, [AI_INSERT]: hunk.id } })) };
  });
}

export type Verb = "accept" | "accept_edit" | "reject";

/** Resolve one hunk: accept keeps the insertion (optionally marked unreviewed) and drops the deletion; reject the inverse. */
export function decideHunkOps(ops: Op[], hunkId: string, verb: Verb, proposalId: string): Op[] {
  const out: Line[] = [];
  for (const line of splitLines(ops)) {
    const ins = hunkOf(line, AI_INSERT) === hunkId && isInsertLine(line);
    const del = hunkOf(line, AI_DELETE) === hunkId && isDeleteLine(line);
    if (ins) {
      if (verb === "reject") continue;
      out.push({
        attrs: line.attrs,
        runs: line.runs.map((r) => {
          const { [AI_INSERT]: _i, ...rest } = r.attributes ?? {};
          const attrs = verb === "accept_edit" ? { ...rest, [AI_UNREVIEWED]: proposalId } : rest;
          return Object.keys(attrs).length ? { insert: r.insert, attributes: attrs } : { insert: r.insert };
        }),
      });
      continue;
    }
    if (del) {
      if (verb !== "reject") continue;
      out.push({ attrs: line.attrs, runs: line.runs.map(withoutOverlayAttrs) });
      continue;
    }
    out.push(line);
  }
  return joinLines(out);
}

/** Remove all overlay marks of a proposal's hunks as if every hunk were rejected (cancel / conflict cleanup). */
export function discardHunksOps(ops: Op[], hunkIds: string[]): Op[] {
  return hunkIds.reduce((acc, id) => decideHunkOps(acc, id, "reject", ""), ops);
}

// ---------------------------------------------------------------------------
// Unreviewed text (accepted for review, not yet touched by the radiologist)
// ---------------------------------------------------------------------------

export function clearUnreviewedOnLines(ops: Op[], lineNumbers: Set<number>): Op[] {
  const lines = splitLines(ops).map((line, i) =>
    lineNumbers.has(i) ? { attrs: line.attrs, runs: line.runs.map((r) => dropAttr(r, AI_UNREVIEWED)) } : line,
  );
  return joinLines(lines);
}

export function clearAllUnreviewed(ops: Op[]): Op[] {
  return joinLines(splitLines(ops).map((l) => ({ attrs: l.attrs, runs: l.runs.map((r) => dropAttr(r, AI_UNREVIEWED)) })));
}

export function unreviewedLineCount(ops: Op[]): number {
  return splitLines(ops).filter((l) => l.runs.some((r) => r.attributes?.[AI_UNREVIEWED] !== undefined)).length;
}

export function pendingHunkIds(ops: Op[]): string[] {
  const ids = new Set<string>();
  for (const l of splitLines(ops)) {
    const a = hunkOf(l, AI_INSERT);
    const b = hunkOf(l, AI_DELETE);
    if (a) ids.add(a);
    if (b) ids.add(b);
  }
  return [...ids];
}

/** First line index carrying a hunk's marks (for anchoring the floating control). */
export function hunkLineIndex(ops: Op[], hunkId: string): number {
  const lines = splitLines(ops);
  const i = lines.findIndex((l) => hunkOf(l, AI_INSERT) === hunkId || hunkOf(l, AI_DELETE) === hunkId);
  return i < 0 ? -1 : lineIndex(lines, i);
}

/** Line numbers (0-based) touched by a change delta applied to `ops` (after the change). */
export function touchedLines(ops: Op[], change: Op[]): Set<number> {
  const lines = splitLines(ops);
  const starts: number[] = [];
  let idx = 0;
  for (const l of lines) {
    starts.push(idx);
    idx += lineLength(l);
  }
  const lineAt = (pos: number) => Math.max(0, starts.findLastIndex((s) => s <= pos));
  const touched = new Set<number>();
  let pos = 0;
  for (const op of change) {
    if (op.retain !== undefined) {
      const n = typeof op.retain === "number" ? op.retain : 1;
      if (op.attributes) for (let p = pos; p < pos + n; p++) touched.add(lineAt(p));
      pos += n;
    } else if (typeof op.insert === "string") {
      for (let p = pos; p < pos + op.insert.length; p++) touched.add(lineAt(p));
      pos += op.insert.length;
    } else if (op.insert !== undefined) {
      touched.add(lineAt(pos));
      pos += 1;
    } else if (op.delete !== undefined) {
      touched.add(lineAt(pos));
    }
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Flags (design 04 §3.5): a located line carries `ai-flag` = flag id until acknowledged
// ---------------------------------------------------------------------------

/**
 * Where a flag points, in the Client's terms: the section file (or the whole report when
 * `section` is null), the 1-based line of that file *as the agent read it*, and that line's text.
 */
export type FlagTarget = { section: SectionId | null; ordinal: number; text: string };

/**
 * Buffer line index for a flag target, or -1. Walks the section's buffer lines the way
 * `canonicalLines` would count them (insert lines skipped, blank runs collapsed, leading blanks
 * dropped) to the ordinal, then verifies the text; if the buffer moved since the agent read it,
 * falls back to the first line with that exact text — never for a blank or a label line, which
 * would be ambiguous.
 */
export function locateFlagLine(lines: Line[], target: FlagTarget): number {
  const range = sectionRange(lines, target.section);
  if (range.start < 0) return -1;
  const matchable = (i: number) => !isInsertLine(lines[i]!);
  let emitted = 0;
  let prevBlank = true; // nothing emitted yet ⇒ leading blanks are dropped
  for (let i = range.start; i < range.end; i++) {
    if (!matchable(i)) continue;
    const text = lineText(lines[i]!);
    if (text === "" && prevBlank) continue;
    prevBlank = text === "";
    emitted += 1;
    if (emitted === target.ordinal) {
      if (text === target.text) return i;
      break;
    }
  }
  if (target.text === "" || sectionIdOfLine(target.text) !== undefined) return -1;
  for (let i = range.start; i < range.end; i++) if (matchable(i) && lineText(lines[i]!) === target.text) return i;
  return -1;
}

export type FlagResult = { ops: Op[]; found: boolean };

/** Mark the target line with the flag id; `found: false` leaves the ops untouched (card only). */
export function flagLineOps(ops: Op[], target: FlagTarget, flagId: string): FlagResult {
  const lines = splitLines(ops);
  const i = locateFlagLine(lines, target);
  if (i < 0) return { ops, found: false };
  markRuns(lines[i]!, AI_FLAG, flagId);
  return { ops: joinLines(lines), found: true };
}

/** Remove one flag's mark wherever it is (acknowledged). */
export function clearFlagOps(ops: Op[], flagId: string): Op[] {
  return joinLines(splitLines(ops).map((l) => ({ attrs: l.attrs, runs: l.runs.map((r) => (r.attributes?.[AI_FLAG] === flagId ? dropAttr(r, AI_FLAG) : r)) })));
}

/** Character index of the first line carrying the flag's mark (any run — typing may unmark the first), or -1. */
export function flagLineIndex(ops: Op[], flagId: string): number {
  const lines = splitLines(ops);
  const i = lines.findIndex((l) => l.runs.some((r) => r.attributes?.[AI_FLAG] === flagId));
  return i < 0 ? -1 : lineIndex(lines, i);
}

/** Flag ids currently marked in the buffer (a deleted line takes its mark with it). */
export function flaggedIds(ops: Op[]): string[] {
  const ids = new Set<string>();
  for (const l of splitLines(ops)) for (const r of l.runs) if (typeof r.attributes?.[AI_FLAG] === "string") ids.add(r.attributes[AI_FLAG] as string);
  return [...ids];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cloneOp(op: Op): Op {
  return op.attributes ? { ...op, attributes: { ...op.attributes } } : { ...op };
}
function withoutOverlayAttrs(op: Op): Op {
  if (!op.attributes) return op;
  const { [AI_INSERT]: _a, [AI_DELETE]: _b, [AI_UNREVIEWED]: _c, ...rest } = op.attributes;
  return Object.keys(rest).length ? { insert: op.insert, attributes: rest } : { insert: op.insert };
}
function dropAttr(op: Op, key: string): Op {
  if (!op.attributes || !(key in op.attributes)) return op;
  const { [key]: _x, ...rest } = op.attributes;
  return Object.keys(rest).length ? { insert: op.insert, attributes: rest } : { insert: op.insert };
}
function markRuns(line: Line, key: string, value: string): void {
  line.runs = line.runs.length
    ? line.runs.map((r) => ({ ...r, attributes: { ...r.attributes, [key]: value } }))
    : [{ insert: " ", attributes: { [key]: value } }];
}
function pushOp(out: Op[], op: Op): void {
  const last = out[out.length - 1];
  if (last && typeof last.insert === "string" && typeof op.insert === "string" && sameAttrs(last.attributes, op.attributes)) {
    last.insert += op.insert;
    return;
  }
  out.push(cloneOp(op));
}
function sameAttrs(a?: AttributeMap, b?: AttributeMap): boolean {
  const ka = a ? Object.keys(a).sort() : [];
  const kb = b ? Object.keys(b).sort() : [];
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a![k] === b![k]);
}
