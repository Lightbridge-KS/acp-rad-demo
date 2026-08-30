import { describe, expect, it } from "vitest";
import { blankLineCount, describeBlockers, deterministicGate, isQaPrompt, nextStatus, transitionsFor } from "./lifecycle.ts";

const CLEAN = "**EMERGENCY MDCT OF THE BRAIN**\n\n**HISTORY:** Weakness.\n\n**FINDINGS:**\n**Cerebral parenchyma:** Normal.\n\n**IMPRESSION:**\n- No acute abnormality.\n";

describe("transitionsFor", () => {
  it("offers the resident Prelim from draft only", () => {
    expect(transitionsFor("draft", "resident")).toEqual(["prelim"]);
    expect(transitionsFor("preliminary", "resident")).toEqual([]);
    expect(transitionsFor("final", "resident")).toEqual([]);
  });

  it("offers the attending Sign off from draft and preliminary, never from final", () => {
    expect(transitionsFor("draft", "attending")).toEqual(["signoff"]);
    expect(transitionsFor("preliminary", "attending")).toEqual(["signoff"]);
    expect(transitionsFor("final", "attending")).toEqual([]);
  });

  it("maps a transition to its target status", () => {
    expect(nextStatus("prelim")).toBe("preliminary");
    expect(nextStatus("signoff")).toBe("final");
  });
});

describe("deterministicGate", () => {
  it("passes a clean report with nothing pending", () => {
    expect(deterministicGate({ pending: 0, unreviewed: 0, markdown: CLEAN })).toEqual({ ok: true });
  });

  it("refuses an empty buffer — a never-templated case must not go final", () => {
    expect(deterministicGate({ pending: 0, unreviewed: 0, markdown: "\n" })).toEqual({ ok: false, blockers: [{ kind: "empty", count: 1 }] });
  });

  it("reports every blocker at once, in a fixed order", () => {
    const md = "**HISTORY:** Onset __ hours ago. E_V_M_\n\n**IMPRESSION:**\n- Discussed with Dr. ____ at ____.\n";
    expect(deterministicGate({ pending: 2, unreviewed: 1, markdown: md })).toEqual({
      ok: false,
      blockers: [
        { kind: "pending", count: 2 },
        { kind: "unreviewed", count: 1 },
        { kind: "blank", count: 2 },
      ],
    });
  });

  it("counts blank lines with two or more underscores; single underscores are not blanks", () => {
    expect(blankLineCount("E_V_M_ normal\n")).toBe(0);
    expect(blankLineCount("within __ minutes\nsize ____ mm\n")).toBe(2);
    expect(blankLineCount("a ____ b ____\n")).toBe(1);
  });

  it("describes blockers in human words for the panel and the audit outcome", () => {
    expect(
      describeBlockers([
        { kind: "empty", count: 1 },
        { kind: "pending", count: 1 },
        { kind: "unreviewed", count: 3 },
        { kind: "blank", count: 7 },
      ]),
    ).toBe("empty report · 1 pending change · 3 unreviewed lines · 7 blanks left");
  });
});

describe("isQaPrompt", () => {
  it("matches the bare skill and tolerates whitespace, nothing else", () => {
    expect(isQaPrompt("/qa")).toBe(true);
    expect(isQaPrompt(" /qa \n")).toBe(true);
    expect(isQaPrompt("/qa please")).toBe(true);
    expect(isQaPrompt("/qatar")).toBe(false);
    expect(isQaPrompt("/impression")).toBe(false);
    expect(isQaPrompt("run /qa")).toBe(false);
    expect(isQaPrompt(null)).toBe(false);
    expect(isQaPrompt(undefined)).toBe(false);
  });
});
