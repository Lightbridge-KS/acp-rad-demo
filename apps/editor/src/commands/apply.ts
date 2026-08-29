/**
 * Perform a command effect on the live Quill buffer (the editor half of `registry.ts`).
 *
 * Instant effects are `user`-sourced Quill changes (⌘Z works, `history.userOnly`); a whole-
 * buffer replacement on a non-blank buffer becomes a *local* proposal — tracked changes the
 * radiologist decides per hunk (option C). Canonical line numbers are mapped onto the live
 * document, which may hold overlay lines of pending proposals.
 */
import type Quill from "quill";
import { Delta } from "quill";
import type { Op } from "quill";
import { markdownToDelta, worklistRoot } from "acp-rad";
import { isInsertLine, lineIndex, lineLength, lineText, splitLines } from "../report/overlay.ts";
import type { Proposal, ProposalStore } from "../report/proposals.ts";
import { isBlankBuffer } from "./document.ts";
import type { CommandEffect } from "./registry.ts";
import { firstBlankOffset } from "./snippet.ts";

export type ApplyDeps = {
  quill: Quill;
  accession: string;
  proposals: ProposalStore;
  /** The live buffer, overlays stripped, canonical (what the effect was computed against). */
  currentMarkdown: () => string;
  /** Render a freshly created local proposal as tracked changes. */
  renderProposal: (p: Proposal) => void;
  commandId: string;
};

export type ApplyOutcome =
  | { outcome: "instant"; shortPrelim?: boolean; folded?: boolean }
  | { outcome: "proposal"; proposal: Proposal }
  | { outcome: "caret" }
  | { outcome: "hint"; text: string };

export function applyEffect(effect: CommandEffect, deps: ApplyDeps): ApplyOutcome {
  const { quill } = deps;
  switch (effect.kind) {
    case "hint":
      return { outcome: "hint", text: effect.text };
    case "replace": {
      const current = deps.currentMarkdown();
      if (isBlankBuffer(current)) {
        quill.setContents(markdownToDelta(effect.markdown), "user");
        quill.setSelection(firstCaret(effect.markdown), 0, "silent");
        quill.focus();
        return { outcome: "instant", shortPrelim: effect.shortPrelim, ...(effect.folded ? { folded: true } : {}) };
      }
      const id = `cmd-${deps.commandId}-${Date.now().toString(36)}`;
      const proposal = deps.proposals.fromLocal(id, `${worklistRoot(deps.accession)}/report.md`, effect.markdown, current, {
        command: deps.commandId,
        ...(effect.folded ? { folded: true } : {}),
      });
      if (!proposal) return { outcome: "hint", text: "could not build the proposal" };
      if (proposal.hunks.length === 0) return { outcome: "hint", text: "the report already matches" };
      deps.renderProposal(proposal);
      return { outcome: "proposal", proposal };
    }
    case "insert-line": {
      const ops = quill.getContents().ops;
      const { count } = canonicalLines(ops);
      const text = effect.markdown.replace(/\n$/, "");
      if (effect.line >= count) {
        // Append after the last line: the document keeps its final newline.
        const at = Math.max(0, quill.getLength() - 1);
        quill.updateContents(new Delta().retain(at).concat(lineDelta(`${effect.blankBefore ? "\n" : ""}\n${text}`, false)), "user");
        const target = Math.max(0, quill.getLength() - 1 - text.length);
        quill.setSelection(target + Math.max(0, firstBlankOffset(text)), 0, "silent");
      } else {
        const at = liveIndexOf(ops, effect.line);
        quill.updateContents(new Delta().retain(at).concat(lineDelta(text, true)), "user");
        quill.setSelection(at + Math.max(0, firstBlankOffset(text)), 0, "silent");
      }
      quill.focus();
      return { outcome: "instant" };
    }
    case "replace-line": {
      const ops = quill.getContents().ops;
      const at = liveIndexOf(ops, effect.line);
      const live = splitLines(ops);
      const li = liveLineNumber(live, effect.line);
      const oldLen = li >= 0 ? lineLength(live[li]!) - 1 : 0;
      const text = effect.markdown.replace(/\n$/, "");
      quill.updateContents(new Delta().retain(at).delete(oldLen).concat(lineDelta(text, false)), "user");
      quill.setSelection(at + Math.max(0, firstBlankOffset(text)), 0, "silent");
      quill.focus();
      return { outcome: "instant" };
    }
    case "caret": {
      const ops = quill.getContents().ops;
      const at = liveIndexOf(ops, effect.line);
      const live = splitLines(ops);
      const li = liveLineNumber(live, effect.line);
      const text = li >= 0 ? lineText(live[li]!) : "";
      quill.setSelection(at + Math.max(0, firstBlankOffset(text)), 0, "user");
      quill.focus();
      return { outcome: "caret" };
    }
  }
}

// ---------------------------------------------------------------------------
// canonical line ⇄ live document
// ---------------------------------------------------------------------------

/** Lines of the live document that exist in the canonical view (overlay insert-lines skipped). */
function canonicalLines(ops: Op[]): { count: number } {
  return { count: splitLines(ops).filter((l) => !isInsertLine(l)).length };
}

/** Live line number of canonical line `n`; −1 when past the end. */
function liveLineNumber(live: ReturnType<typeof splitLines>, n: number): number {
  let seen = 0;
  for (let i = 0; i < live.length; i++) {
    if (isInsertLine(live[i]!)) continue;
    if (seen === n) return i;
    seen++;
  }
  return -1;
}

/** Quill character index where canonical line `n` starts (document end when past the end). */
export function liveIndexOf(ops: Op[], n: number): number {
  const live = splitLines(ops);
  const li = liveLineNumber(live, n);
  return li < 0 ? Math.max(0, lineIndex(live, live.length) - 1) : lineIndex(live, li);
}

/** Delta ops for one canonical line's text (bold/italic honoured); with or without its newline. */
function lineDelta(text: string, withNewline: boolean): Delta {
  const ops = markdownToDelta(`${text.replace(/^\n+/, "")}\n`);
  const leading = /^\n+/.exec(text)?.[0] ?? "";
  const d = new Delta();
  if (leading) d.insert(leading);
  for (const op of ops) {
    if (op.insert === undefined) continue;
    d.insert(op.insert as string, op.attributes ?? undefined);
  }
  if (!withNewline) {
    // Drop the trailing newline op (the line keeps the newline it already has).
    const last = d.ops[d.ops.length - 1];
    if (last && typeof last.insert === "string" && last.insert.endsWith("\n")) {
      last.insert = last.insert.slice(0, -1);
      if (last.insert === "") d.ops.pop();
    }
  }
  return d;
}

/** Caret for a fresh document: the first clinical blank, else the end of the title line. */
function firstCaret(markdown: string): number {
  const lines = markdown.replace(/\n$/, "").split("\n");
  let idx = 0;
  for (const raw of lines) {
    const plain = raw.replace(/\*\*/g, "");
    const b = firstBlankOffset(plain);
    if (b >= 0) return idx + b;
    idx += plain.length + 1;
  }
  return Math.max(0, (lines[0]?.replace(/\*\*/g, "").length ?? 0));
}

