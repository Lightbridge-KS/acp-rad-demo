/**
 * Report lifecycle (design 02 §5.2) and the deterministic half of the QA gate (04 §3.5).
 *
 * Status moves only by an explicit act of the radiologist: **Prelim** (draft → preliminary,
 * the resident's act) or **Sign off** (draft | preliminary → final, the attending's act).
 * Roles are display-only in the demo — they decide which button is offered, nothing more.
 *
 * The deterministic gate never goes to a model: pending changes, unreviewed text and
 * template blanks are facts the editor already holds. Pure functions; no React, no Quill.
 */
import type { ReportStatus } from "acp-rad";
import { isBlankBuffer } from "../commands/document.ts";

export type Role = "resident" | "attending";
export type Transition = "prelim" | "signoff";

/** The transitions a role may take from a status — in the order the pill offers them. */
export function transitionsFor(status: ReportStatus, role: Role): Transition[] {
  if (status === "final") return [];
  if (role === "resident") return status === "draft" ? ["prelim"] : [];
  return ["signoff"];
}

export function nextStatus(transition: Transition): ReportStatus {
  return transition === "prelim" ? "preliminary" : "final";
}

/** The UI word for a transition (glossary: Sign-off is the attending's act). */
export function transitionLabel(transition: Transition): string {
  return transition === "prelim" ? "Prelim" : "Sign off";
}

export type BlockerKind = "empty" | "pending" | "unreviewed" | "blank";
export type Blocker = { kind: BlockerKind; count: number };
export type GateResult = { ok: true } | { ok: false; blockers: Blocker[] };

export type GateInput = {
  /** `proposals.pending().length` */
  pending: number;
  /** `unreviewedLineCount(currentOps(quill))` */
  unreviewed: number;
  /** `store.reportMarkdown()` — canonical Markdown of the whole report */
  markdown: string;
};

/** A template blank: two or more underscores (`____`, `__ hours`). `E_V_M_` has single ones. */
const BLANK = /_{2,}/;

/** Lines still carrying a template blank. */
export function blankLineCount(markdown: string): number {
  return markdown.split("\n").filter((line) => BLANK.test(line)).length;
}

/** The instant, model-free check; refuses with every blocker so the radiologist sees all of them at once. */
export function deterministicGate(input: GateInput): GateResult {
  const blockers: Blocker[] = [];
  if (isBlankBuffer(input.markdown)) blockers.push({ kind: "empty", count: 1 });
  if (input.pending > 0) blockers.push({ kind: "pending", count: input.pending });
  if (input.unreviewed > 0) blockers.push({ kind: "unreviewed", count: input.unreviewed });
  const blanks = blankLineCount(input.markdown);
  if (blanks > 0) blockers.push({ kind: "blank", count: blanks });
  return blockers.length === 0 ? { ok: true } : { ok: false, blockers };
}

/** One human phrase per blocker, e.g. `2 pending changes`; joined with ` · ` for the audit outcome. */
export function describeBlocker(b: Blocker): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  switch (b.kind) {
    case "empty":
      return "empty report";
    case "pending":
      return plural(b.count, "pending change", "pending changes");
    case "unreviewed":
      return plural(b.count, "unreviewed line", "unreviewed lines");
    case "blank":
      return plural(b.count, "blank left", "blanks left");
  }
}

export function describeBlockers(blockers: Blocker[]): string {
  return blockers.map(describeBlocker).join(" · ");
}

/** The one definition of "this turn is `/qa`" — shared by the connection (write refusal) and the gate. */
export function isQaPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /^\/qa(\s|$)/.test(text.trim());
}
