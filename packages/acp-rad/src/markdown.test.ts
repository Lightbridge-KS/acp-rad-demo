import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, deltaToMarkdown, markdownToDelta, parseInline } from "./markdown.ts";

const FIXTURES = fileURLToPath(new URL("../../../apps/editor/fixtures/", import.meta.url));
const readFixture = (rel: string) => readFileSync(`${FIXTURES}${rel}`, "utf8");
const listMd = (dir: string) =>
  readdirSync(`${FIXTURES}${dir}`)
    .filter((f) => f.endsWith(".md"))
    .map((f) => `${dir}/${f}`);

describe("grammar table", () => {
  it.each<[string, string, unknown[]]>([
    ["plain paragraph", "Hello world\n", [{ insert: "Hello world\n" }]],
    ["bold label line", "**HISTORY:** text\n", [{ insert: "HISTORY:", attributes: { bold: true } }, { insert: " text\n" }]],
    ["italic run", "a _b_ c\n", [{ insert: "a " }, { insert: "b", attributes: { italic: true } }, { insert: " c\n" }]],
    ["bold+italic", "**_x_**\n", [{ insert: "x", attributes: { bold: true, italic: true } }, { insert: "\n" }]],
    ["bullet", "- item\n", [{ insert: "item" }, { insert: "\n", attributes: { list: "bullet" } }]],
    ["ordered", "1. one\n2. two\n", [{ insert: "one" }, { insert: "\n", attributes: { list: "ordered" } }, { insert: "two" }, { insert: "\n", attributes: { list: "ordered" } }]],
    ["blank line between blocks", "a\n\nb\n", [{ insert: "a\n\nb\n" }]],
    ["literal ** followed by space stays text", "** This is a PRELIMINARY report.\n", [{ insert: "** This is a PRELIMINARY report.\n" }]],
    ["underscore blanks stay literal", "Known case of ___ for __ hours.\n", [{ insert: "Known case of ___ for __ hours.\n" }]],
    ["underscores inside a word stay literal", "GCS of E_V_M_ and grade\n", [{ insert: "GCS of E_V_M_ and grade\n" }]],
  ])("%s", (_name, md, ops) => {
    expect(markdownToDelta(md)).toEqual(ops);
    expect(deltaToMarkdown(markdownToDelta(md))).toBe(md);
  });
});

describe("normalization", () => {
  it("strips trailing whitespace, CRLF, and collapses blank runs", () => {
    expect(canonicalize("a  \r\n\r\n\r\nb \r\n\n\n")).toBe("a\n\nb\n");
  });
  it("empty input is a single newline", () => {
    expect(canonicalize("")).toBe("\n");
    expect(markdownToDelta("")).toEqual([{ insert: "\n" }]);
  });
  it("ordered lists renumber from 1 per run", () => {
    expect(canonicalize("7. a\n9. b\n\n4. c\n")).toBe("1. a\n2. b\n\n1. c\n");
  });
  it("moves markers off whitespace when serializing a bold run with spaces", () => {
    const md = deltaToMarkdown([{ insert: " bold ", attributes: { bold: true } }, { insert: "x\n" }]);
    expect(md).toBe(" **bold** x\n");
    expect(canonicalize(md)).toBe(md);
  });
  it("drops attributes outside the grammar", () => {
    const md = deltaToMarkdown([
      { insert: "H", attributes: { bold: true, color: "#f00" } },
      { insert: "\n", attributes: { header: 2 } },
      { insert: "u", attributes: { underline: true } },
      { insert: "\n" },
    ]);
    expect(md).toBe("**H**\nu\n");
  });
});

describe("parseInline edge cases", () => {
  it("unclosed bold marker is literal", () => {
    expect(parseInline("**oops")).toEqual([{ text: "**oops" }]);
  });
  it("closing marker after a space is literal, so the whole thing unwinds", () => {
    expect(parseInline("**a **b")).toEqual([{ text: "**a **b" }]);
  });
  it("unclosed italic opener in a real template line stays literal", () => {
    expect(parseInline("volume:** __, _ml.")).toEqual([{ text: "volume:** __, _ml." }]);
    expect(parseInline("**Intravenous:** __, _ml.")).toEqual([
      { text: "Intravenous:", attrs: { bold: true } },
      { text: " __, _ml." },
    ]);
  });
});

describe("round-trip over real fixtures", () => {
  const files = [
    "ct-brain-er-stroke/report.md",
    ...listMd("templates"),
    ...listMd("snippets"),
  ];
  it("has fixtures to test", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });
  it.each(files)("%s: fixture is canonical and stable", (rel) => {
    const md = readFixture(rel);
    const once = canonicalize(md);
    expect(once).toBe(md); // fixtures are stored in canonical form
    expect(canonicalize(once)).toBe(once);
    expect(markdownToDelta(once)).toEqual(markdownToDelta(canonicalize(once)));
  });
});
