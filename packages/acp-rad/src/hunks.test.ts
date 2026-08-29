import { describe, expect, it } from "vitest";
import { applyHunks, buildHunks, expectedAfterAll, findRun, lineDiff } from "./hunks.ts";

const IMPRESSION_OLD = "**IMPRESSION:**\n- ...\n";
const IMPRESSION_NEW =
  "**IMPRESSION:**\n- Acute infarction of the left MCA territory.\n- Chronic lacunar infarction at the right caudate nucleus.\n";

describe("lineDiff", () => {
  it("marks equal / delete / insert", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c"])).toEqual([
      { type: "equal", line: "a" },
      { type: "delete", line: "b" },
      { type: "insert", line: "x" },
      { type: "equal", line: "c" },
    ]);
  });
  it("handles empty sides", () => {
    expect(lineDiff([], ["a"])).toEqual([{ type: "insert", line: "a" }]);
    expect(lineDiff(["a"], [])).toEqual([{ type: "delete", line: "a" }]);
  });
});

describe("buildHunks", () => {
  it("impression placeholder → two bullets is one hunk with context", () => {
    const hunks = buildHunks(IMPRESSION_OLD, IMPRESSION_NEW);
    expect(hunks).toEqual([
      {
        id: "h1",
        oldLines: ["- ..."],
        newLines: [
          "- Acute infarction of the left MCA territory.",
          "- Chronic lacunar infarction at the right caudate nucleus.",
        ],
        contextBefore: "**IMPRESSION:**",
      },
    ]);
  });
  it("one organ line replaced is one hunk", () => {
    const hunks = buildHunks("**Vascular system:** Normal.\n", "**Vascular system:** Hyperdense left M1.\n");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.oldLines).toEqual(["**Vascular system:** Normal."]);
    expect(hunks[0]!.newLines).toEqual(["**Vascular system:** Hyperdense left M1."]);
    expect(hunks[0]!.contextBefore).toBeUndefined();
  });
  it("pure insertion anchors on the preceding line", () => {
    const hunks = buildHunks("**A:** 1\n**B:** 2\n", "**A:** 1\n**A2:** 1b\n**B:** 2\n");
    expect(hunks).toEqual([{ id: "h1", oldLines: [], newLines: ["**A2:** 1b"], contextBefore: "**A:** 1" }]);
  });
  it("two separated changes are two hunks", () => {
    const hunks = buildHunks("a\nb\nc\nd\n", "a\nB\nc\nD\n", "x");
    expect(hunks.map((h) => h.id)).toEqual(["x1", "x2"]);
    expect(hunks[1]).toEqual({ id: "x2", oldLines: ["d"], newLines: ["D"], contextBefore: "c" });
  });
  it("identical texts yield no hunks", () => {
    expect(buildHunks("a\nb\n", "a\nb\n")).toEqual([]);
  });
});

describe("applyHunks", () => {
  const section = "**IMPRESSION:**\n- ...\n";
  const hunks = buildHunks(IMPRESSION_OLD, IMPRESSION_NEW);

  it("all accepted reproduces the new text", () => {
    expect(expectedAfterAll(section, hunks)).toBe(IMPRESSION_NEW);
  });
  it("applies inside a larger section by anchoring on old lines", () => {
    const findings = "**FINDINGS:**\n**Liver:** Normal.\n**Vascular system:** Normal.\n**Bone:** Normal.\n";
    const h = buildHunks("**Vascular system:** Normal.\n", "**Vascular system:** Hyperdense left M1.\n");
    expect(applyHunks(findings, h).text).toBe(
      "**FINDINGS:**\n**Liver:** Normal.\n**Vascular system:** Hyperdense left M1.\n**Bone:** Normal.\n",
    );
  });
  it("applies a subset and reports none as conflict", () => {
    const h = buildHunks("a\nb\nc\nd\n", "a\nB\nc\nD\n");
    const r = applyHunks("a\nb\nc\nd\n", h, (x) => x.id === "h2");
    expect(r).toEqual({ text: "a\nb\nc\nD\n", conflicts: [] });
  });
  it("reports a conflict when the anchor was edited away", () => {
    const h = buildHunks("**Vascular system:** Normal.\n", "**Vascular system:** Hyperdense.\n");
    const r = applyHunks("**Vascular system:** Edited by hand.\n", h);
    expect(r.conflicts).toEqual(["h1"]);
    expect(r.text).toBe("**Vascular system:** Edited by hand.\n");
  });
  it("pure insertion without context appends at the end", () => {
    const r = applyHunks("a\n", [{ id: "h1", oldLines: [], newLines: ["z"] }]);
    expect(r.text).toBe("a\nz\n");
  });
});

describe("findRun", () => {
  it("finds consecutive runs from an offset", () => {
    expect(findRun(["a", "b", "a", "b"], ["a", "b"], 1)).toBe(2);
    expect(findRun(["a"], ["b"])).toBe(-1);
    expect(findRun(["a"], [])).toBe(-1);
  });
});
