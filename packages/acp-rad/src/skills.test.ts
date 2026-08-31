import { describe, expect, it } from "vitest";
import { EFFECTIVE_SKILL_ROOT, effectiveSkillPath, mentionedSkills } from "./skills.ts";

const ADVERTISED = ["impression", "compare", "proofread", "qa"];

describe("mentionedSkills", () => {
  it("finds a mention wherever it sits in the sentence", () => {
    expect(mentionedSkills("/impression", ADVERTISED)).toEqual(["impression"]);
    expect(mentionedSkills("Please explain the /impression", ADVERTISED)).toEqual(["impression"]);
    expect(mentionedSkills("before signing, run /qa on this", ADVERTISED)).toEqual(["qa"]);
    expect(mentionedSkills("\n/qa\n", ADVERTISED)).toEqual(["qa"]);
  });

  it("keeps order of appearance and deduplicates", () => {
    expect(mentionedSkills("/impression then /qa", ADVERTISED)).toEqual(["impression", "qa"]);
    expect(mentionedSkills("/qa and again /qa", ADVERTISED)).toEqual(["qa"]);
  });

  it("never matches a slash inside a word — dates and ratios are not invocations", () => {
    expect(mentionedSkills("the study on dd/mm/yyyy", ADVERTISED)).toEqual([]);
    expect(mentionedSkills("slice 2/qa of the series", ADVERTISED)).toEqual([]);
    expect(mentionedSkills("see /etc/passwd", ADVERTISED)).toEqual([]);
  });

  it("only counts names the agent actually advertised", () => {
    // A Level-1 agent never offers `/qa`; the word then stays ordinary prose and must not
    // conjure a resource link to a skill that does not exist.
    expect(mentionedSkills("run /qa", ["impression"])).toEqual([]);
    expect(mentionedSkills("/nope", ADVERTISED)).toEqual([]);
    expect(mentionedSkills("/impression", [])).toEqual([]);
  });

  it("matches a longer name over a prefix of it", () => {
    expect(mentionedSkills("/proofread", ADVERTISED)).toEqual(["proofread"]);
    expect(mentionedSkills("/qatar", ADVERTISED)).toEqual([]);
  });
});

describe("effectiveSkillPath", () => {
  it("points at the composed skill, not at any single layer", () => {
    expect(effectiveSkillPath("qa")).toBe(`${EFFECTIVE_SKILL_ROOT}qa/SKILL.md`);
    expect(effectiveSkillPath("qa")).toBe("/skills/effective/qa/SKILL.md");
  });
});
