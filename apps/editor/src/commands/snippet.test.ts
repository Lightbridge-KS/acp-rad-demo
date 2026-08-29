import { describe, expect, it } from "vitest";
import DISCUSS from "../../fixtures/snippets/discuss-with-dr.md?raw";
import NOT_REVIEWED from "../../fixtures/snippets/er-not-reviewed.md?raw";
import REVIEWED from "../../fixtures/snippets/er-reviewed.md?raw";
import CT_BRAIN_TEMPLATE from "../../fixtures/templates/ct-brain-er.md?raw";
import { firstBlankOffset, placeSnippet } from "./snippet.ts";

const REPORT = ["**TITLE**", "", "**FINDINGS:**", "**Liver:** Normal.", "", "**IMPRESSION:**", "- Normal study."].join("\n") + "\n";
const lines = (md: string) => md.replace(/\n$/, "").split("\n");

describe("ER markers at the impression head", () => {
  it("inserts right after **IMPRESSION:**, before the items", () => {
    const p = placeSnippet(REPORT, REVIEWED, "impression-head");
    expect(p.op).toBe("insert");
    expect(p.line).toBe(6);
    expect(lines(p.markdown).slice(5, 8)).toEqual(["**IMPRESSION:**", REVIEWED.trim(), "- Normal study."]);
  });

  it("is a toggle set: the other marker replaces it in place", () => {
    const first = placeSnippet(REPORT, REVIEWED, "impression-head").markdown;
    const p = placeSnippet(first, NOT_REVIEWED, "impression-head");
    expect(p.op).toBe("replace");
    expect(p.line).toBe(6);
    expect(lines(p.markdown)[6]).toBe(NOT_REVIEWED.trim());
    expect(p.markdown).not.toContain("REVIEWED by the attending");
    expect(lines(p.markdown)).toHaveLength(lines(first).length);
  });

  it("is idempotent for the same marker", () => {
    const first = placeSnippet(REPORT, REVIEWED, "impression-head").markdown;
    const p = placeSnippet(first, REVIEWED, "impression-head");
    expect(p.op).toBe("none");
    expect(p.markdown).toBe(first);
  });

  it("has no home without an IMPRESSION section", () => {
    const p = placeSnippet("**TITLE**\n\n**FINDINGS:**\n**Liver:** Normal.\n", REVIEWED, "impression-head");
    expect(p.op).toBe("none");
    expect(p.line).toBe(-1);
  });

  it("survives the canonical grammar (the leading ** is literal, not bold)", () => {
    const p = placeSnippet(REPORT, REVIEWED, "impression-head");
    expect(p.markdown).toContain("** This is a PRELIMINARY report");
  });
});

describe("discussed-with line at the report end", () => {
  it("appends after a blank line", () => {
    const p = placeSnippet(REPORT, DISCUSS, "report-end");
    expect(p.op).toBe("insert");
    expect(lines(p.markdown).slice(-3)).toEqual(["- Normal study.", "", DISCUSS.trim()]);
    expect(p.line).toBe(lines(p.markdown).length - 1);
  });

  it("is idempotent: an existing line is only located", () => {
    const first = placeSnippet(REPORT, DISCUSS, "report-end").markdown;
    const p = placeSnippet(first, DISCUSS, "report-end");
    expect(p.op).toBe("none");
    expect(p.line).toBe(lines(first).length - 1);
    expect(p.markdown).toBe(first);
  });

  it("finds a template's own discussed-with line", () => {
    const template = CT_BRAIN_TEMPLATE;
    const p = placeSnippet(template, DISCUSS, "report-end");
    expect(p.op).toBe("none");
    expect(lines(template)[p.line]).toMatch(/^The findings about/);
  });

  it("on a blank buffer the snippet is the whole buffer", () => {
    const p = placeSnippet("\n", DISCUSS, "report-end");
    expect(p.op).toBe("insert");
    expect(p.line).toBe(0);
    expect(p.markdown).toBe(`${DISCUSS.trim()}\n`);
  });
});

describe("firstBlankOffset", () => {
  it("points at the first ___ blank", () => {
    expect(firstBlankOffset(DISCUSS)).toBe(DISCUSS.indexOf("___"));
    expect(firstBlankOffset("no blanks here")).toBe(-1);
  });
});
