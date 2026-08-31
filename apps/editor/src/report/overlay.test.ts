import { buildHunks, deltaToMarkdown, markdownToDelta } from "acp-rad";
import { describe, expect, it } from "vitest";
import {
  AI_DELETE,
  AI_FLAG,
  AI_UNREVIEWED,
  AI_INSERT,
  clearAllUnreviewed,
  clearFlagOps,
  clearUnreviewedOnLines,
  decideHunkOps,
  flagLineIndex,
  flagLineOps,
  flaggedIds,
  joinLines,
  lineText,
  unreviewedLineCount,
  hunkLineIndex,
  locateHunk,
  overlayOps,
  pendingHunkIds,
  sectionInsertionPoint,
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

describe("flags", () => {
  const flaggedLine = (o: ReturnType<typeof ops>, id: string) => splitLines(o).find((l) => l.runs.some((r) => r.attributes?.[AI_FLAG] === id));

  it("marks the line at the served ordinal of a section file and stays out of the canonical buffer", () => {
    // sections/impression.md as served = "**IMPRESSION:**\n- ...\n" → line 2 is "- ..."
    const { ops: out, found } = flagLineOps(ops(), { section: "impression", ordinal: 2, text: "- ..." }, "f1");
    expect(found).toBe(true);
    expect(lineText(flaggedLine(out, "f1")!)).toBe("- ...");
    expect(deltaToMarkdown(stripOverlays(out))).toBe(REPORT);
    expect(deltaToMarkdown(out)).toBe(REPORT); // deltaToMarkdown ignores the mark even unstripped
    expect(flaggedIds(out)).toEqual(["f1"]);
    expect(flagLineIndex(out, "f1")).toBeGreaterThan(0);
    expect(flagLineIndex(out, "nope")).toBe(-1);
  });

  it("counts like canonicalLines: skips insert lines and collapses doubled blank lines (report.md ordinal)", () => {
    const laid = overlayOps(ops(), "findings", buildHunks("**Liver:** Normal.\n", "**Liver:** Normal.\n**Spleen:** Big.\n")).ops;
    const lines = splitLines(laid);
    const label = lines.findIndex((l) => lineText(l) === "**IMPRESSION:**");
    lines.splice(label - 1, 0, { runs: [], attrs: {} }); // a second blank line before IMPRESSION
    const buffer = joinLines(lines);
    // canonical report.md: title(1) blank(2) FINDINGS(3) Liver(4) Vascular(5) blank(6) IMPRESSION(7) "- ..."(8)
    const { found, ops: out } = flagLineOps(buffer, { section: null, ordinal: 8, text: "- ..." }, "f1");
    expect(found).toBe(true);
    expect(lineText(flaggedLine(out, "f1")!)).toBe("- ...");
    expect(pendingHunkIds(out)).toEqual(["h1"]); // the proposal overlay is untouched
  });

  it("a struck (ai-delete) line is matchable; a wrong ordinal falls back to the text; unknown text is not found", () => {
    const laid = overlayOps(ops(), "impression", buildHunks("- ...\n", "- A.\n")).ops;
    const struck = flagLineOps(laid, { section: "impression", ordinal: 2, text: "- ..." }, "f1");
    expect(struck.found).toBe(true);
    expect(flaggedLine(struck.ops, "f1")!.runs[0]!.attributes?.[AI_DELETE]).toBe("h1");
    expect(flagLineOps(ops(), { section: "impression", ordinal: 1, text: "- ..." }, "f2").found).toBe(true);
    expect(flagLineOps(ops(), { section: "impression", ordinal: 2, text: "- nope" }, "f3").found).toBe(false);
    expect(flagLineOps(ops(), { section: "findings", ordinal: 9, text: "**FINDINGS:**" }, "f4").found).toBe(false); // label: no text fallback
    expect(flagLineOps(ops(), { section: "comparison", ordinal: 1, text: "x" }, "f5").found).toBe(false); // absent section
  });

  it("clears on acknowledge, survives a rejected proposal on the same line, and is found from any run", () => {
    const flagged = flagLineOps(ops(), { section: "findings", ordinal: 3, text: "**Vascular system:** Normal." }, "f1").ops;
    expect(flaggedIds(clearFlagOps(flagged, "f1"))).toEqual([]);
    const laid = overlayOps(flagged, "findings", buildHunks("**Vascular system:** Normal.\n", "**Vascular system:** X.\n")).ops;
    expect(flaggedIds(decideHunkOps(laid, "h1", "reject", "p1"))).toEqual(["f1"]);
    expect(flaggedIds(decideHunkOps(laid, "h1", "accept", "p1"))).toEqual([]); // the flagged line was replaced
    // The radiologist typed at the line start: the first run lost its marks (afterUserChange), the rest keeps them.
    const lines = splitLines(flagged);
    const i = lines.findIndex((l) => l.runs.some((r) => r.attributes?.[AI_FLAG] === "f1"));
    lines[i]!.runs.unshift({ insert: "Re-read: " });
    expect(flagLineIndex(joinLines(lines), "f1")).toBeGreaterThan(0);
  });
});

describe("creating an absent section (design 06 §6)", () => {
  const noImpression = ["**TITLE**", "", "**HISTORY:** x", "", "**FINDINGS:**", "**Liver:** Normal."].join("\n") + "\n";
  const lines = (md: string) => splitLines(markdownToDelta(md));

  it("places a new section after the last earlier one, against its text", () => {
    // IMPRESSION follows FINDINGS, whose last line is index 5 — so it lands at the end.
    expect(sectionInsertionPoint(lines(noImpression), "impression")).toBe(6);
  });

  it("places a new section between the two it belongs between", () => {
    // FINDINGS goes after HISTORY's body (index 3) and before IMPRESSION (index 5), blank trimmed.
    const md = ["**TITLE**", "", "**HISTORY:** x", "more history", "", "**IMPRESSION:**", "- b"].join("\n") + "\n";
    expect(sectionInsertionPoint(lines(md), "findings")).toBe(4);
  });

  it("places a new section before the first later one", () => {
    const md = ["**TITLE**", "", "**FINDINGS:**", "- a", "**IMPRESSION:**", "- b"].join("\n") + "\n";
    expect(sectionInsertionPoint(lines(md), "history")).toBe(2); // at FINDINGS, pushing it down
    expect(sectionInsertionPoint(lines(md), "comparison")).toBe(2);
  });

  it("falls back to the end of a report with no sections at all", () => {
    expect(sectionInsertionPoint(lines("**TITLE**\n\n"), "impression")).toBe(1);
  });

  it("locateHunk creates instead of conflicting, and the label lands with the content", () => {
    const before = lines(noImpression);
    const hunks = buildHunks("", "**IMPRESSION:**\n- Fatty liver.\n");
    expect(locateHunk(before, "impression", hunks[0]!)).toEqual({ start: 6, count: 0 });

    const { ops: laid, conflicts } = overlayOps(markdownToDelta(noImpression), "impression", hunks);
    expect(conflicts).toEqual([]);
    // The overlay shows it; the buffer is untouched until the radiologist decides (INV-1).
    expect(deltaToMarkdown(stripOverlays(laid))).toBe(noImpression);
    const shown = splitLines(laid).map((l) => lineText(l));
    expect(shown).toContain("**IMPRESSION:**");
    expect(shown).toContain("- Fatty liver.");
  });

  it("a whole-report proposal still conflicts when it cannot be placed", () => {
    const hunks = buildHunks("- nowhere to be found\n", "- x\n");
    expect(locateHunk(lines(noImpression), null, hunks[0]!)).toBeNull();
  });
});
