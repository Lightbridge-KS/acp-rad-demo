import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOUSE_PROFILE, canonicalLabel, isFooterLine, normalizeLabels, sectionIdOfLine, type SectionProfile } from "./labels.ts";
import { splitSections } from "./sections.ts";
import type { SectionId } from "./schema.ts";

const fixtures = fileURLToPath(new URL("../../../apps/editor/fixtures/", import.meta.url));

/** Every fixture `.md` on disk, recursively (reports, priors, templates, snippets). */
function fixtureFiles(dir = fixtures): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? fixtureFiles(`${dir}${e.name}/`) : e.name.endsWith(".md") ? [`${dir}${e.name}`] : [],
  );
}

describe("sectionIdOfLine — tolerant recognition", () => {
  it.each<[string, SectionId]>([
    ["**HISTORY:**", "history"], // the house form
    ["**HISTORY**: Known case of TB lymph node.", "history"], // colon outside the bold — what Word pastes
    ["HISTORY: 25F with headache", "history"], // plain text, no markup
    ["Clinical history: 25F", "history"],
    ["Indications: rule out stroke", "history"],
    ["**TECHNIQUES**: Plain and contrast enhanced scan.", "technique"],
    ["**TECHNIQUE:**", "technique"],
    ["*Comparison:*", "comparison"], // italic label
    ["**FINDINGS**:", "findings"],
    ["Findings:", "findings"],
    ["**IMPRESSION**", "impression"], // bare label — terminated by end of line
    ["IMPRESSION", "impression"],
    ["- IMPRESSION:", "impression"], // a label that survived a bullet
    ["  Impression:", "impression"],
  ])("opens a section: %s", (line, id) => {
    expect(sectionIdOfLine(line)).toBe(id);
  });

  it.each<[string]>([
    ["Findings are consistent with pneumonia."], // prose, not a label — no terminator
    ["Comparison with the prior study is limited by technique."], // the classic false positive
    ["Impression of the referring physician was pneumonia"],
    ["No comparison available."],
    ["**Lymph nodes**:"], // an organ line is a label line, but not a *section* label
    ["**Thoracic inlet**: Please refer to the chest CT."],
    ["**Estimated radiation dose:** ___ mGy"], // the technique header block
    ["HISTORYX: foo"], // the keyword must end where the word ends
    ["MDCT OF THE NECK"], // the title
    [""],
  ])("is body text: %s", (line) => {
    expect(sectionIdOfLine(line)).toBeUndefined();
  });

  it("prefers the longer keyword", () => {
    expect(sectionIdOfLine("CLINICAL HISTORY: x")).toBe("history");
    expect(sectionIdOfLine("CLINICAL INDICATION: x")).toBe("history");
  });
});

describe("isFooterLine", () => {
  it.each([["Report Severity: Routine", true], ["Finalized Datetime: 30/08/2026", true], ["**Preliminary Datetime:** —", true], ["**IMPRESSION:**", false], ["The report severity was discussed.", false]] as const)(
    "%s",
    (line, expected) => {
      expect(isFooterLine(line)).toBe(expected);
    },
  );

  it("closes the last section and opens nothing", () => {
    const s = splitSections("**FINDINGS:**\n- a\n**IMPRESSION:**\n- b\nReport Severity: Routine\nFinalized Datetime: x\n");
    expect(s.sections.impression).toBe("**IMPRESSION:**\n- b\n");
    expect(Object.keys(s.sections).sort()).toEqual(["findings", "impression"]);
  });
});

describe("the report that broke /impression (design 06 §1)", () => {
  // Colon outside the bold, a bare **IMPRESSION**, organ sub-labels: the old strict regex found none.
  const pasted = [
    "**MDCT OF THE NECK**",
    "",
    "**HISTORY**: Known case of TB lymph node at right neck on HRZE.",
    "**TECHNIQUES**: Plain and contrast enhanced axial helical scan.",
    "**Intravenous contrast brand, concentration, volume**: Ultravist370; 60 ml.",
    "**COMPARISON**: None.",
    "",
    "**FINDINGS**:",
    "**Lymph nodes**:",
    "- Multiple enlarged, matted heterogeneous enhancing lymph nodes.",
    "**Thoracic inlet**: Please refer to the details on chest CT.",
    "",
    "**IMPRESSION**",
  ].join("\n");

  it("partitions into title + 5 sections", () => {
    const s = splitSections(pasted);
    expect(s.title).toBe("**MDCT OF THE NECK**\n");
    expect(Object.keys(s.sections).sort()).toEqual(["comparison", "findings", "history", "impression", "technique"]);
  });

  it("keeps organ lines inside their section", () => {
    const s = splitSections(pasted);
    expect(s.sections.technique).toContain("**Intravenous contrast brand, concentration, volume**:");
    expect(s.sections.findings).toContain("**Lymph nodes**:");
    expect(s.sections.findings).toContain("**Thoracic inlet**:");
  });

  it("the impression exists even though it is only a label", () => {
    expect(splitSections(pasted).sections.impression).toBe("**IMPRESSION**\n");
  });
});

describe("no regression against the strict form", () => {
  // The recognizer this replaces. Tolerance must be purely additive on text the editor already
  // parsed — every fixture but the deliberately foreign one must yield the identical label set.
  const STRICT = /^\*\*(HISTORY|TECHNIQUES?|COMPARISON|FINDINGS|IMPRESSION):\*\*/;
  // Reports, priors, templates and snippets only. `/skills/**` is instructions, not a report
  // (INV-3): a skill body is prose about label lines rather than a document made of them, so
  // holding it to the report grammar would fail the next author for no clinical reason.
  const files = fixtureFiles().filter((f) => !f.includes("ct-neck-tb-lymph") && !f.includes("/skills/"));

  it("finds fixtures to check", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(files.map((f) => [f.slice(fixtures.length), f] as const))("%s: same label lines as before", (_name, file) => {
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines.filter((l) => sectionIdOfLine(l) !== undefined)).toEqual(lines.filter((l) => STRICT.test(l)));
  });
});

describe("the ct-neck-tb-lymph fixture (a report pasted from outside)", () => {
  const report = readFileSync(`${fixtures}ct-neck-tb-lymph/report.md`, "utf8");
  const STRICT = /^\*\*(HISTORY|TECHNIQUES?|COMPARISON|FINDINGS|IMPRESSION):\*\*/;

  it("is exactly what the strict recognizer could not see", () => {
    expect(report.split("\n").filter((l) => STRICT.test(l))).toEqual([]);
  });

  it("parses to title + 5 sections, organ lines intact", () => {
    const s = splitSections(report);
    expect(s.title).toBe("**MDCT OF THE NECK**\n");
    expect(Object.keys(s.sections).sort()).toEqual(["comparison", "findings", "history", "impression", "technique"]);
    expect(s.sections.technique).toContain("**Immediate complication**: None.");
    expect(s.sections.findings).toContain("**Bony structures**:");
    expect(s.sections.impression).toBe("**IMPRESSION**\n");
  });

  it("/normalize brings it to house grammar", () => {
    const out = normalizeLabels(report);
    expect(out).toContain("**HISTORY:** Known case of TB lymph node");
    expect(out).toContain("**IMPRESSION:**");
    expect(out).toContain("**Lymph nodes**:"); // organ lines untouched
    expect(normalizeLabels(out)).toBe(out); // fixed point
  });
});

describe("canonicalLabel", () => {
  it.each<[SectionId, string]>([
    ["history", "**HISTORY:**"],
    ["technique", "**TECHNIQUES:**"],
    ["comparison", "**COMPARISON:**"],
    ["findings", "**FINDINGS:**"],
    ["impression", "**IMPRESSION:**"],
  ])("%s → %s", (id, label) => {
    expect(canonicalLabel(id)).toBe(label);
    expect(sectionIdOfLine(label)).toBe(id); // what we write, we read
  });
});

describe("normalizeLabels", () => {
  it("fixes the wrapper and keeps the author's keyword", () => {
    // TECHNIQUE and TECHNIQUES are both house usage; normalizing must not pick a side.
    const out = normalizeLabels("**HISTORY**: Known case.\n**TECHNIQUE**: Plain scan.\n**IMPRESSION**\n");
    expect(out).toBe("**HISTORY:** Known case.\n**TECHNIQUE:** Plain scan.\n**IMPRESSION:**\n");
  });

  it("is a fixed point on canonical text", () => {
    const canonical = "**MDCT OF THE NECK**\n\n**HISTORY:** x\n**FINDINGS:**\n**Liver:** Normal.\n**IMPRESSION:**\n- a\n";
    expect(normalizeLabels(canonical)).toBe(canonical);
  });

  it("leaves body text and organ lines alone", () => {
    const body = "**FINDINGS:**\n**Lymph nodes**: enlarged.\nComparison with the prior is limited.\n";
    expect(normalizeLabels(body)).toBe(body);
  });

  it("promotes a plain-text report to house grammar", () => {
    expect(normalizeLabels("CT CHEST\n\nHistory: cough\nfindings:\n- nodule\n")).toBe(
      "CT CHEST\n\n**HISTORY:** cough\n**FINDINGS:**\n- nodule\n",
    );
  });
});

describe("a custom profile", () => {
  const profile: SectionProfile = {
    labels: [
      { id: "findings", patterns: ["descriptions?", "findings?"] },
      { id: "impression", patterns: ["conclusions?", "impressions?"] },
    ],
    footer: [],
  };

  it("parses another institution's vocabulary", () => {
    const s = splitSections("CT CHEST\n\nDESCRIPTION:\n- nodule\nCONCLUSION:\n- benign\n", profile);
    expect(Object.keys(s.sections).sort()).toEqual(["findings", "impression"]);
    expect(s.sections.findings).toBe("DESCRIPTION:\n- nodule\n");
  });

  it("does not leak into the house profile", () => {
    expect(sectionIdOfLine("DESCRIPTION:", profile)).toBe("findings");
    expect(sectionIdOfLine("DESCRIPTION:", HOUSE_PROFILE)).toBeUndefined();
  });
});
