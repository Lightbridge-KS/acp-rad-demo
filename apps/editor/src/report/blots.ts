/**
 * Inline blots for the proposal overlay and the accepted-draft mark (design §5.7).
 *
 *   ai-insert <hunkId>     proposed insertion — rendered, NOT in the canonical buffer
 *   ai-delete <hunkId>     proposed deletion  — still in the buffer until accepted
 *   ai-draft  <proposalId> accepted "as editable draft" — in the buffer, unreviewed
 *
 * Values ride on `data-*` attributes so the overlay module can find a hunk's runs by id.
 */
import Quill from "quill";

const Inline = Quill.import("blots/inline") as {
  new (...args: unknown[]): object;
  create: (value?: unknown) => HTMLElement;
  order: string[];
};

type InlineCtor = typeof Inline & {
  blotName: string;
  tagName: string;
  className: string;
};

function defineMark(blotName: string, className: string, dataAttr: string): InlineCtor {
  class Mark extends Inline {
    static blotName = blotName;
    static tagName = "SPAN";
    static className = className;
    static create(value: unknown): HTMLElement {
      const node = super.create(value);
      if (typeof value === "string" && value) node.setAttribute(dataAttr, value);
      return node;
    }
    static formats(node: HTMLElement): string | undefined {
      return node.getAttribute(dataAttr) ?? undefined;
    }
  }
  return Mark as unknown as InlineCtor;
}

export const AiInsert = defineMark("ai-insert", "ql-ai-insert", "data-hunk");
export const AiDelete = defineMark("ai-delete", "ql-ai-delete", "data-hunk");
export const AiDraft = defineMark("ai-draft", "ql-ai-draft", "data-proposal");

export const OVERLAY_FORMATS = ["ai-insert", "ai-delete", "ai-draft"] as const;

let registered = false;
/** Idempotent; call once before constructing a Quill instance. */
export function registerReportBlots(): void {
  if (registered) return;
  Quill.register({ "formats/ai-insert": AiInsert, "formats/ai-delete": AiDelete, "formats/ai-draft": AiDraft }, true);
  // Keep overlay marks outermost so bold/italic nest inside them predictably.
  for (const name of OVERLAY_FORMATS) if (!Inline.order.includes(name)) Inline.order.push(name);
  registered = true;
}
