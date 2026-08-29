import { describe, expect, it } from "vitest";
import SP_BRAIN from "../../fixtures/snippets/sp-brain.md?raw";
import CT_BRAIN from "../../fixtures/templates/ct-brain-er.md?raw";
import US_WA from "../../fixtures/templates/us-wa.md?raw";
import { foldInShortPrelim, instantiateTemplate, isBlankBuffer, regionSnippetId, shortPrelimDocument, templateIdFor } from "./document.ts";

const lines = (md: string) => md.replace(/\n$/, "").split("\n");

describe("instantiateTemplate", () => {
  it("fills the dose blanks and keeps every clinical blank", () => {
    const out = instantiateTemplate(CT_BRAIN, { study: { doseMgy: 58, doseMgycm: 890 } });
    expect(out).toContain("**Estimated radiation dose:** 58 mGy, 890 mGycm. Standard DRL");
    expect(out).toContain("**HISTORY:** Known case of _____ presents with _____ for __ hours.");
    expect(out).toContain("**COMPARISON:** ____");
    expect(out).toContain("- ...");
    expect(out).toContain("The findings about ___ in this report was discussed with Dr.____");
    expect(lines(out)).toHaveLength(lines(CT_BRAIN).length); // nothing dropped, nothing added
  });

  it("leaves the dose blanks when the study has no dose", () => {
    const out = instantiateTemplate(CT_BRAIN, {});
    expect(out).toContain("**Estimated radiation dose:** ___ mGy, ___ mGycm.");
  });

  it("resolves sex-conditional lines: male keeps prostate, drops uterus/adnexae", () => {
    const out = instantiateTemplate(US_WA, { patient: { sex: "M" } });
    expect(out).toContain("**Prostate gland:** Normal size, measuring ??? ml in volume.");
    expect(out).not.toContain("Uterus");
    expect(out).not.toContain("Adnexae");
    expect(out).not.toMatch(/\[(male|female)\]/i);
  });

  it("resolves sex-conditional lines: female keeps uterus/adnexae, drops prostate", () => {
    const out = instantiateTemplate(US_WA, { patient: { sex: "F" } });
    expect(out).toContain("**Uterus:** Unremarkable.");
    expect(out).toContain("**Adnexae:** Non-visualized both ovaries. No gross adnexal mass.");
    expect(out).not.toContain("Prostate");
  });

  it("unknown sex keeps both lines with their tokens as visible blanks", () => {
    const out = instantiateTemplate(US_WA, {});
    expect(out).toContain("**Prostate gland:** [Male] Normal size");
    expect(out).toContain("**Uterus:** [female] Unremarkable.");
  });

  it("is canonical (round-trips)", () => {
    const out = instantiateTemplate(CT_BRAIN, { patient: { sex: "M" }, study: { doseMgy: 58, doseMgycm: 890 } });
    expect(instantiateTemplate(out, {})).toBe(out);
  });
});

describe("templateIdFor / regionSnippetId", () => {
  it("prefers the argument, falls back to the study's template", () => {
    expect(templateIdFor({ study: { template: "ct-brain-er" } })).toBe("ct-brain-er");
    expect(templateIdFor({ study: { template: "ct-brain-er" } }, " cxr-pa ")).toBe("cxr-pa");
    expect(templateIdFor({})).toBeUndefined();
  });
  it("maps regions onto the three SP snippets", () => {
    expect(regionSnippetId("brain")).toBe("sp-brain");
    expect(regionSnippetId("Chest")).toBe("sp-chest");
    expect(regionSnippetId("abdomen")).toBe("sp-body");
    expect(regionSnippetId(undefined)).toBe("sp-body");
  });
});

describe("short prelim", () => {
  it("the SP document is the paragraph alone", () => {
    const sp = shortPrelimDocument(SP_BRAIN);
    expect(lines(sp)).toHaveLength(1);
    expect(sp).toMatch(/^An initial review shows no evidence of intracranial hemorrhage/);
    expect(sp.endsWith("A full report will follow.\n")).toBe(true);
  });

  it("folds the SP (and lines typed under it) after the impression items, before the discussed-with line", () => {
    const template = instantiateTemplate(CT_BRAIN, { study: { doseMgy: 58, doseMgycm: 890 } });
    const spBuffer = `${shortPrelimDocument(SP_BRAIN)}Hyperdense left M1 segment — discussed with the stroke team.\n`;
    const out = foldInShortPrelim(template, spBuffer);
    const ls = lines(out);
    const items = ls.indexOf("- ...");
    const folded = ls.findIndex((l) => l.startsWith("An initial review shows"));
    const typed = ls.findIndex((l) => l.startsWith("Hyperdense left M1"));
    const discussed = ls.findIndex((l) => l.startsWith("The findings about"));
    expect(items).toBeGreaterThan(0);
    expect(folded).toBe(items + 2); // one blank line between the items and the folded text
    expect(typed).toBe(folded + 1);
    expect(discussed).toBe(typed + 2);
    expect(out).not.toContain("A full report will follow");
    expect(out).toContain("The contents in this short preliminary report include only critical imaging findings as listed.");
  });

  it("appends at the end when the template has no discussed-with line", () => {
    const template = "**CHEST (PA UPRIGHT)**\n\n**FINDINGS:**\n**Lungs:** Clear.\n\n**IMPRESSION:**\n- Normal.\n";
    const out = foldInShortPrelim(template, "An initial review shows nothing. A full report will follow.\n");
    expect(lines(out).slice(-3)).toEqual(["- Normal.", "", "An initial review shows nothing."]);
  });

  it("an SP that is only the closing sentence folds to the bare template", () => {
    expect(foldInShortPrelim("**T**\n\n**IMPRESSION:**\n- ...\n", "A full report will follow.\n")).toBe("**T**\n\n**IMPRESSION:**\n- ...\n");
  });
});

describe("isBlankBuffer", () => {
  it.each(["", "\n", "  \n\n", "\r\n"])("%j is blank", (md) => expect(isBlankBuffer(md)).toBe(true));
  it("a title alone is not blank", () => expect(isBlankBuffer("**T**\n")).toBe(false));
});
