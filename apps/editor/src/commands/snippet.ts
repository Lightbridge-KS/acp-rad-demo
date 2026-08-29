/**
 * Snippet commands — a house text placed at its home, wherever the menu was summoned
 * (design 02 §2.2 "home-anchored"; CONTEXT.md: Snippet, Home, ER marker, Discussed-with line).
 *
 *   /er-reviewed · /er-not-reviewed   impression head; a toggle set — one replaces the other
 *   /discuss-with-dr                  report end; idempotent — an existing line is only revisited
 *
 * Pure: returns the new canonical Markdown plus what happened and where (a canonical line
 * index), so the editor can perform the same edit on the live Quill buffer as one `user` change.
 */
import { canonicalLines, canonicalize } from "acp-rad";
import { DISCUSSED_WITH_RE } from "./document.ts";

export type Home = "impression-head" | "report-end";

export type Placement = {
  /** The buffer after placement (unchanged when `op` is `none`). */
  markdown: string;
  /** `insert`: snippet placed before `line` · `replace`: `line` swapped · `none`: already there, or no home. */
  op: "insert" | "replace" | "none";
  /** Canonical line index (0-based) of the snippet's home; −1 when the home does not exist. */
  line: number;
};

const IMPRESSION_RE = /^\*\*IMPRESSION:\*\*/;
/** Both ER markers open the same way; that is what makes them a toggle set. */
const ER_MARKER_RE = /^\*\* This is a PRELIMINARY report/;

export function placeSnippet(markdown: string, snippet: string, home: Home): Placement {
  const lines = canonicalLines(markdown);
  const snip = canonicalLines(snippet);
  const unchanged = (line: number): Placement => ({ markdown: canonicalize(markdown), op: "none", line });
  const rebuilt = (out: string[], op: "insert" | "replace", line: number): Placement => ({ markdown: canonicalize(`${out.join("\n")}\n`), op, line });

  if (home === "impression-head") {
    const label = lines.findIndex((l) => IMPRESSION_RE.test(l));
    if (label < 0) return unchanged(-1);
    const head = label + 1;
    const current = lines[head];
    if (current !== undefined && ER_MARKER_RE.test(current)) {
      if (snip.length === 1 && current === snip[0]) return unchanged(head);
      return rebuilt([...lines.slice(0, head), ...snip, ...lines.slice(head + 1)], "replace", head);
    }
    return rebuilt([...lines.slice(0, head), ...snip, ...lines.slice(head)], "insert", head);
  }

  // report-end
  const existing = lines.findIndex((l) => DISCUSSED_WITH_RE.test(l));
  if (existing >= 0) return unchanged(existing);
  const out = lines.length === 0 ? [...snip] : [...lines, "", ...snip];
  return rebuilt(out, "insert", out.length - snip.length);
}

/** First clinical blank on a line (`___`, `____` …), as a column offset; −1 if none. */
export function firstBlankOffset(line: string): number {
  return line.search(/_{2,}/);
}
