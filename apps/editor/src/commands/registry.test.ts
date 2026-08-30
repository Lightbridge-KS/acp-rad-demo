import { describe, expect, it } from "vitest";
import SP_BRAIN from "../../fixtures/snippets/sp-brain.md?raw";
import DISCUSS from "../../fixtures/snippets/discuss-with-dr.md?raw";
import REVIEWED from "../../fixtures/snippets/er-reviewed.md?raw";
import CT_BRAIN from "../../fixtures/templates/ct-brain-er.md?raw";
import { filterCommands, flattenCommands, listCommands, parseInvocation, runEditorCommand, type CommandContext, type EditorCommandInput } from "./registry.ts";

const SKILLS = [
  { name: "impression", description: "Draft the IMPRESSION" },
  { name: "compare", description: "Compare with a prior", hint: "[prior accession]" },
];
const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  blank: false,
  shortPrelim: false,
  caretSection: null,
  caretAtEnd: false,
  hasPriors: false,
  level: 1,
  skills: SKILLS,
  ...over,
});

describe("listCommands", () => {
  it("suggests /template (and /short-prelim) on a blank buffer", () => {
    const g = listCommands(ctx({ blank: true }));
    expect(g.suggested.map((c) => c.id)).toEqual(["template", "short-prelim"]);
    expect(g.editor).toHaveLength(5);
    expect(g.skills.map((c) => c.id)).toEqual(["impression", "compare"]);
    expect(g.skills[1]!.hint).toBe("[prior accession]");
  });

  it("suggests the fold-in on a short prelim, /impression and the ER marker under IMPRESSION, /compare with priors", () => {
    expect(listCommands(ctx({ shortPrelim: true })).suggested.map((c) => c.id)).toEqual(["template"]);
    expect(listCommands(ctx({ caretSection: "impression" })).suggested.map((c) => c.id)).toEqual(["impression", "er-reviewed"]);
    expect(listCommands(ctx({ hasPriors: true })).suggested.map((c) => c.id)).toEqual(["compare"]);
    expect(listCommands(ctx({ caretAtEnd: true })).suggested.map((c) => c.id)).toEqual(["discuss-with-dr"]);
  });

  it("hides a Level 0 agent's skills and shows none while disconnected", () => {
    expect(listCommands(ctx({ level: 0 })).skills).toEqual([]);
    expect(listCommands(ctx({ level: undefined, skills: [] })).skills).toEqual([]);
  });

  it("a query collapses the groups into one ranked, deduplicated match list", () => {
    const g = listCommands(ctx({ blank: true }));
    expect(flattenCommands(filterCommands(g, "short-")).map((c) => c.id)).toEqual(["short-prelim"]);
    expect(flattenCommands(filterCommands(g, "prelim")).map((c) => c.id)).toEqual(["short-prelim", "er-reviewed"]); // id substring before description hit
    expect(flattenCommands(filterCommands(g, "attending")).map((c) => c.id)).toEqual(["er-reviewed", "er-not-reviewed"]);
    expect(flattenCommands(filterCommands(g, "zzz"))).toEqual([]);
    // the skill outranks the snippet whose description mentions the impression head
    expect(flattenCommands(filterCommands(g, "impression")).map((c) => c.id)).toEqual(["impression", "er-reviewed", "er-not-reviewed"]);
    expect(filterCommands(g, "impression").editor).toEqual([]);
  });
});

describe("parseInvocation", () => {
  it("splits name and argument, slash optional", () => {
    expect(parseInvocation("/template cxr-pa")).toEqual({ name: "template", arg: "cxr-pa" });
    expect(parseInvocation("compare ACC0000011")).toEqual({ name: "compare", arg: "ACC0000011" });
    expect(parseInvocation("/impression")).toEqual({ name: "impression", arg: undefined });
    expect(parseInvocation("/")).toEqual({ name: "", arg: undefined });
  });
});

describe("runEditorCommand", () => {
  const input = (over: Partial<EditorCommandInput> = {}): EditorCommandInput => ({
    markdown: "\n",
    meta: { patient: { sex: "M" }, study: { template: "ct-brain-er", doseMgy: 58, doseMgycm: 890 } },
    region: "brain",
    shortPrelim: false,
    templates: { "ct-brain-er": CT_BRAIN },
    snippets: { "sp-brain": SP_BRAIN, "er-reviewed": REVIEWED, "discuss-with-dr": DISCUSS },
    ...over,
  });

  it("/template instantiates the study's template; an unknown id is a hint", () => {
    const e = runEditorCommand("template", undefined, input());
    expect(e.kind).toBe("replace");
    if (e.kind !== "replace") return;
    expect(e.markdown).toContain("58 mGy, 890 mGycm");
    expect(e.shortPrelim).toBe(false);
    expect(runEditorCommand("template", "nope", input())).toEqual({ kind: "hint", text: 'no template "nope"' });
  });

  it("/short-prelim makes the region's paragraph the buffer and flags it", () => {
    const e = runEditorCommand("short-prelim", undefined, input());
    expect(e).toMatchObject({ kind: "replace", shortPrelim: true });
    if (e.kind === "replace") expect(e.markdown).toMatch(/^An initial review shows no evidence of intracranial hemorrhage/);
  });

  it("/template on a short-prelim buffer folds it in", () => {
    const sp = runEditorCommand("short-prelim", undefined, input());
    if (sp.kind !== "replace") throw new Error("expected replace");
    const e = runEditorCommand("template", undefined, input({ markdown: sp.markdown, shortPrelim: true }));
    expect(e).toMatchObject({ kind: "replace", shortPrelim: false, folded: true });
    if (e.kind === "replace") {
      expect(e.markdown).toContain("The contents in this short preliminary report");
      expect(e.markdown).not.toContain("A full report will follow");
    }
  });

  it("snippets land at their home, or point at what is already there", () => {
    const report = "**T**\n\n**IMPRESSION:**\n- Normal.\n";
    expect(runEditorCommand("er-reviewed", undefined, input({ markdown: report }))).toMatchObject({ kind: "insert-line", line: 3 });
    const withMarker = `**T**\n\n**IMPRESSION:**\n${REVIEWED.trim()}\n- Normal.\n`;
    expect(runEditorCommand("er-reviewed", undefined, input({ markdown: withMarker }))).toEqual({ kind: "caret", line: 3 });
    expect(runEditorCommand("discuss-with-dr", undefined, input({ markdown: report }))).toMatchObject({ kind: "insert-line", line: 5, blankBefore: true });
    expect(runEditorCommand("er-reviewed", undefined, input({ markdown: "**T**\n" })).kind).toBe("hint");
  });
});
