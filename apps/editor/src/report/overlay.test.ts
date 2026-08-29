import { buildHunks, deltaToMarkdown, markdownToDelta } from "acp-rad";
import { describe, expect, it } from "vitest";
import {
  AI_DELETE,
  AI_UNREVIEWED,
  AI_INSERT,
  clearAllUnreviewed,
  clearUnreviewedOnLines,
  decideHunkOps,
  unreviewedLineCount,
  hunkLineIndex,
  locateHunk,
  overlayOps,
  pendingHunkIds,
  splitLines,
  stripOverlays,
  touchedLines,
} from "./overlay.ts";

const REPORT = [
  "**TITLE**",
  "",
  "**FINDINGS:**",
  "**Liver:** Normal.",
  "**Vascular system:** Normal.",
  "",
  "**IMPRESSION:**",
  "- ...",
].join("\n") + "\n";

const ops = () => markdownToDelta(REPORT);

describe("overlayOps", () => {
  const hunks = buildHunks("**IMPRESSION:**\n- ...\n", "**IMPRESSION:**\n- Acute infarct.\n- Lacune.\n");

  it("strikes old lines and inserts new lines after them, keeping the buffer view unchanged", () => {
    const { ops: laid, conflicts } = overlayOps(ops(), "impression", hunks);
    expect(conflicts).toEqual([]);
    const lines = splitLines(laid);
    const texts = lines.map((l) => l.runs.map((r) => r.insert).join("")); // run text; `- ` lives on the block attr
    expect(texts.slice(-3)).toEqual(["...", "Acute infarct.", "Lacune."]);
    expect(lines.at(-3)!.runs[0]!.attributes?.[AI_DELETE]).toBe("h1");
    expect(lines.at(-2)!.runs[0]!.attributes?.[AI_INSERT]).toBe("h1");
    expect(lines.at(-1)!.attrs.list).toBe("bullet"); // block attrs preserved through the overlay
    // INV-1: the agent's view is the unchanged report
    expect(deltaToMarkdown(stripOverlays(laid))).toBe(REPORT);
    expect(pendingHunkIds(laid)).toEqual(["h1"]);
  });

  it("renders bold inside inserted lines", () => {
    const h = buildHunks("**Vascular system:** Normal.\n", "**Vascular system:** Hyperdense M1.\n");
    const { ops: laid } = overlayOps(ops(), "findings", h);
    const inserted = splitLines(laid).find((l) => l.runs[0]?.attributes?.[AI_INSERT]);
    expect(inserted?.runs[0]?.attributes?.bold).toBe(true);
    expect(inserted?.runs.map((r) => r.insert).join("")).toBe("Vascular system: Hyperdense M1.");
  });

  it("reports a conflict when the anchor line was edited away", () => {
    const h = buildHunks("**Vascular system:** Normal.\n", "**Vascular system:** X.\n");
    const edited = markdownToDelta(REPORT.replace("**Vascular system:** Normal.", "**Vascular system:** Edited."));
    const { conflicts } = overlayOps(edited, "findings", h);
    expect(conflicts).toEqual(["h1"]);
  });

  it("does not match the same old line in another section", () => {
    const h = buildHunks("**Liver:** Normal.\n", "**Liver:** Big.\n");
    expect(locateHunk(splitLines(ops()), "impression", h[0]!)).toBeNull();
    expect(locateHunk(splitLines(ops()), "findings", h[0]!)).toEqual({ start: 3, count: 1 });
  });
});

describe("decideHunkOps", () => {
  const hunks = buildHunks("**IMPRESSION:**\n- ...\n", "**IMPRESSION:**\n- Acute infarct.\n");
  const laid = () => overlayOps(ops(), "impression", hunks).ops;

  it("accept: deletion removed, insertion kept plain", () => {
    const out = decideHunkOps(laid(), "h1", "accept", "p1");
    expect(deltaToMarkdown(out)).toBe(REPORT.replace("- ...", "- Acute infarct."));
    expect(pendingHunkIds(out)).toEqual([]);
    expect(unreviewedLineCount(out)).toBe(0);
  });

  it("accept_edit: insertion kept, marked unreviewed", () => {
    const out = decideHunkOps(laid(), "h1", "accept_edit", "p1");
    expect(deltaToMarkdown(out)).toBe(REPORT.replace("- ...", "- Acute infarct."));
    expect(unreviewedLineCount(out)).toBe(1);
    const line = splitLines(out).at(-1)!;
    expect(line.runs[0]!.attributes?.[AI_UNREVIEWED]).toBe("p1");
  });

  it("reject: insertion removed, deletion restored", () => {
    const out = decideHunkOps(laid(), "h1", "reject", "p1");
    expect(deltaToMarkdown(out)).toBe(REPORT);
    expect(pendingHunkIds(out)).toEqual([]);
  });

  it("leaves other hunks untouched", () => {
    const two = buildHunks("**Liver:** Normal.\n**Vascular system:** Normal.\n", "**Liver:** Big.\n**Vascular system:** Normal.\n**Bone:** Ok.\n");
    expect(two).toHaveLength(2);
    const l = overlayOps(ops(), "findings", two).ops;
    const out = decideHunkOps(l, two[0]!.id, "accept", "p");
    expect(pendingHunkIds(out)).toEqual([two[1]!.id]);
  });
});

describe("unreviewed text", () => {
  it("clears the mark per touched line and all at once", () => {
    const hunks = buildHunks("- ...\n", "- A.\n- B.\n");
    const accepted = decideHunkOps(overlayOps(ops(), "impression", hunks).ops, "h1", "accept_edit", "p1");
    expect(unreviewedLineCount(accepted)).toBe(2);
    const n = splitLines(accepted).length;
    const one = clearUnreviewedOnLines(accepted, new Set([n - 2]));
    expect(unreviewedLineCount(one)).toBe(1);
    expect(unreviewedLineCount(clearAllUnreviewed(accepted))).toBe(0);
  });

  it("touchedLines maps a change delta to line numbers", () => {
    const o = markdownToDelta("ab\ncd\nef\n");
    expect([...touchedLines(o, [{ retain: 4 }, { insert: "X" }])]).toEqual([1]); // "cd" line
    expect([...touchedLines(o, [{ retain: 1 }, { delete: 1 }])]).toEqual([0]);
  });
});

describe("hunkLineIndex", () => {
  it("returns the character index of the hunk's first marked line", () => {
    const hunks = buildHunks("- ...\n", "- A.\n");
    const laid = overlayOps(ops(), "impression", hunks).ops;
    const idx = hunkLineIndex(laid, "h1");
    expect(idx).toBeGreaterThan(0);
    expect(hunkLineIndex(laid, "nope")).toBe(-1);
  });
});
