import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { markdownToDelta } from "./markdown.ts";
import { buildManifest, isWritable, resolvePath } from "./namespace.ts";
import { RAD_ERRORS } from "./schema.ts";
import { sectionFile, splitSections } from "./sections.ts";
import { RadError, createReportStore, sliceLines } from "./store.ts";

const FIXTURES = fileURLToPath(new URL("../../../apps/editor/fixtures/", import.meta.url));
const stroke = readFileSync(`${FIXTURES}ct-brain-er-stroke/report.md`, "utf8");
const usWa = readFileSync(`${FIXTURES}templates/us-wa.md`, "utf8");

describe("sections", () => {
  it("partitions the stroke report into title + 5 sections", () => {
    const s = splitSections(stroke);
    expect(s.title).toBe("**EMERGENCY MDCT OF THE BRAIN**\n");
    expect(Object.keys(s.sections).sort()).toEqual(["comparison", "findings", "history", "impression", "technique"]);
    expect(s.sections.technique).toMatch(/^\*\*TECHNIQUES:\*\*/);
    expect(s.sections.technique).toContain("**Estimated radiation dose:**"); // header block belongs to technique
    expect(s.sections.comparison).toBe("**COMPARISON:** None.\n");
    expect(s.sections.findings).toMatch(/^\*\*FINDINGS:\*\*\n\*\*Cerebral parenchyma:\*\*/);
    expect(s.sections.impression).toMatch(/^\*\*IMPRESSION:\*\*\n- /);
    expect(s.sections.findings?.endsWith("\n\n")).toBe(false); // trailing blank trimmed
  });
  it("US whole abdomen has no technique section", () => {
    expect(sectionFile(usWa, "technique")).toBeUndefined();
    expect(sectionFile(usWa, "findings")).toBeDefined();
  });
});

describe("namespace", () => {
  const acc = "ACC0000001";
  it.each<[string, unknown]>([
    ["/worklist/ACC0000001/report.md", { kind: "report" }],
    ["/worklist/ACC0000001/sections/findings.md", { kind: "section", id: "findings" }],
    ["/worklist/ACC0000001/sections/liver.md", null],
    ["/worklist/OTHER/report.md", null],
    ["/worklist/ACC0000001/meta.json", { kind: "meta" }],
    ["/priors/index.md", { kind: "priorsIndex" }],
    ["/priors/ACC0000000/report.md", { kind: "prior", accession: "ACC0000000" }],
    ["/templates/ct-brain-er.md", { kind: "template", id: "ct-brain-er" }],
    ["/snippets/sp-brain.md", { kind: "snippet", id: "sp-brain" }],
    ["/etc/passwd", null],
    ["worklist/ACC0000001/report.md", null],
    ["/worklist/ACC0000001/../x/report.md", null],
  ])("%s", (path, expected) => {
    expect(resolvePath(path, acc)).toEqual(expected);
  });
  it("only report and sections are writable", () => {
    expect(isWritable({ kind: "report" })).toBe(true);
    expect(isWritable({ kind: "section", id: "impression" })).toBe(true);
    expect(isWritable({ kind: "template", id: "x" })).toBe(false);
    expect(isWritable({ kind: "meta" })).toBe(false);
  });
  it("builds a sorted, de-duplicated manifest", () => {
    const m = buildManifest(acc, { sections: ["findings", "impression"], priors: [], templates: ["cxr-pa"], snippets: ["sp-brain"] });
    expect(m).toEqual([...m].sort());
    expect(m).toContain("/worklist/ACC0000001/sections/findings.md");
    expect(m).toContain("/priors/index.md");
    expect(m).toContain("/templates/cxr-pa.md");
  });
});

describe("ReportStore", () => {
  const ops = markdownToDelta(stroke);
  const store = createReportStore({
    accession: "ACC0000001",
    getOps: () => ops,
    meta: { accession: "ACC0000001", modality: "CT" },
    templates: { "ct-brain-er": "**EMERGENCY MDCT OF THE BRAIN**\n" },
    snippets: { "sp-brain": "An initial review shows…\n" },
  });

  it("serves the live report and its sections canonically", () => {
    expect(store.read("/worklist/ACC0000001/report.md")).toBe(stroke);
    expect(store.read("/worklist/ACC0000001/sections/comparison.md")).toBe("**COMPARISON:** None.\n");
  });
  it("serves meta, priors index, templates, snippets", () => {
    expect(JSON.parse(store.read("/worklist/ACC0000001/meta.json"))).toEqual({ accession: "ACC0000001", modality: "CT" });
    expect(store.read("/priors/index.md")).toBe("(no priors)\n");
    expect(store.read("/templates/ct-brain-er.md")).toMatch(/^\*\*EMERGENCY/);
    expect(store.read("/snippets/sp-brain.md")).toMatch(/^An initial review/);
  });
  it("throws -32004 for unknown paths and missing files", () => {
    for (const p of ["/nope.md", "/templates/missing.md", "/priors/ACC9/report.md", "/worklist/ACC0000001/sections/liver.md"]) {
      expect(() => store.read(p)).toThrow(RadError);
      try {
        store.read(p);
      } catch (e) {
        expect((e as RadError).code).toBe(RAD_ERRORS.NOT_FOUND);
      }
    }
  });
  it("assertWritable: RW paths pass, RO paths -32003, unknown -32004", () => {
    expect(() => store.assertWritable("/worklist/ACC0000001/sections/impression.md")).not.toThrow();
    expect(() => store.assertWritable("/worklist/ACC0000001/report.md")).not.toThrow();
    try {
      store.assertWritable("/templates/ct-brain-er.md");
      expect.unreachable();
    } catch (e) {
      expect((e as RadError).code).toBe(RAD_ERRORS.FORBIDDEN);
    }
    try {
      store.assertWritable("/nope.md");
      expect.unreachable();
    } catch (e) {
      expect((e as RadError).code).toBe(RAD_ERRORS.NOT_FOUND);
    }
  });
  it("manifest lists every canonical section, present or not", () => {
    const m = store.manifest();
    expect(m).toContain("/worklist/ACC0000001/sections/impression.md");
    expect(m).toContain("/snippets/sp-brain.md");
    expect(m.filter((p) => p.includes("/sections/"))).toHaveLength(5);
  });

  describe("absent sections (design 06 §6)", () => {
    // The bug: a listing that outlives the state it described. The manifest is snapshotted at
    // session/new, so it must not depend on which sections happen to exist.
    let live = markdownToDelta("**FINDINGS:**\n- a\n");
    const s = createReportStore({ accession: "A", getOps: () => live, meta: {} });

    it("read of an absent section is empty, not -32004", () => {
      expect(s.read("/worklist/A/sections/impression.md")).toBe("");
      expect(s.read("/worklist/A/sections/findings.md")).toBe("**FINDINGS:**\n- a\n");
    });

    it("a present section is never empty, so \"\" is unambiguous", () => {
      // Even a label with no body carries the label line itself.
      live = markdownToDelta("**IMPRESSION:**\n");
      expect(s.read("/worklist/A/sections/impression.md")).toBe("**IMPRESSION:**\n");
    });

    it("the manifest cannot go stale: same 5 sections whatever the report holds", () => {
      const before = s.manifest();
      live = markdownToDelta("nothing but a title\n");
      expect(s.manifest()).toEqual(before);
      expect(before.filter((p) => p.includes("/sections/"))).toHaveLength(5);
    });

    it("an absent section is still writable (the editor creates it)", () => {
      live = markdownToDelta("**FINDINGS:**\n- a\n");
      expect(() => s.assertWritable("/worklist/A/sections/impression.md")).not.toThrow();
    });
  });
  it("reads reflect live ops", () => {
    let live = markdownToDelta("**HISTORY:** a\n");
    const s = createReportStore({ accession: "A", getOps: () => live, meta: {} });
    expect(s.read("/worklist/A/sections/history.md")).toBe("**HISTORY:** a\n");
    live = markdownToDelta("**HISTORY:** b\n");
    expect(s.read("/worklist/A/sections/history.md")).toBe("**HISTORY:** b\n");
  });
});

describe("sliceLines (ACP line/limit windowing)", () => {
  const c = "l1\nl2\nl3\n";
  it.each<[number | null | undefined, number | null | undefined, string]>([
    [undefined, undefined, c],
    [null, null, c],
    [2, null, "l2\nl3\n"],
    [1, 2, "l1\nl2\n"],
    [3, 5, "l3\n"],
    [9, null, ""],
  ])("line=%s limit=%s", (line, limit, expected) => {
    expect(sliceLines(c, line, limit)).toBe(expected);
  });
});

describe("report status lock", () => {
  it("refuses every write once the report is final, reads still work", () => {
    let status: "draft" | "final" = "draft";
    const store = createReportStore({ accession: "ACC1", getOps: () => markdownToDelta("**T**\n\n**IMPRESSION:**\n- ...\n"), meta: {}, reportStatus: () => status });
    expect(() => store.assertWritable("/worklist/ACC1/sections/impression.md")).not.toThrow();
    status = "final";
    expect(store.reportStatus()).toBe("final");
    expect(() => store.assertWritable("/worklist/ACC1/sections/impression.md")).toThrow(/final/);
    expect(store.read("/worklist/ACC1/sections/impression.md")).toContain("- ...");
  });
});

describe("priors index", () => {
  it("serves the authored index verbatim and still lists every prior in the manifest", () => {
    const index = "**Priors:** same patient.\n- ACC2 · CT chest · 12/06/2025 · /priors/ACC2/report.md\n";
    const store = createReportStore({ accession: "ACC1", getOps: () => markdownToDelta("**T**\n"), meta: {}, priors: { ACC2: "**T**\n" }, priorsIndex: index });
    expect(store.read("/priors/index.md")).toBe(index);
    expect(store.manifest()).toContain("/priors/ACC2/report.md");
    const generated = createReportStore({ accession: "ACC1", getOps: () => markdownToDelta("**T**\n"), meta: {}, priors: { ACC2: "**T**\n" } });
    expect(generated.read("/priors/index.md")).toBe("- /priors/ACC2/report.md\n");
  });
});
