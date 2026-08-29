import { describe, expect, it } from "vitest";
import {
  levelOf,
  readRadAgentCaps,
  worklistRoot,
  zRadClientCaps,
  zRadSessionMeta,
  zRadPromptMeta,
} from "./schema.ts";

describe("levelOf", () => {
  it.each<[string, Record<string, unknown> | null | undefined, 0 | 1 | 2]>([
    ["no _meta", undefined, 0],
    ["null _meta", null, 0],
    ["_meta without rad", { other: 1 }, 0],
    ["malformed rad block", { rad: { profileVersion: 1 } }, 0],
    ["rad present, no L2 caps", { rad: { profileVersion: "0.1" } }, 1],
    ["focusState only is still L1", { rad: { profileVersion: "0.1", focusState: true } }, 1],
    ["flags ⇒ L2", { rad: { profileVersion: "0.1", flags: true } }, 2],
    ["codedContent ⇒ L2", { rad: { profileVersion: "0.1", codedContent: ["RadLex"] } }, 2],
  ])("%s → level %i", (_name, meta, expected) => {
    expect(levelOf(meta)).toBe(expected);
  });
});

describe("schemas", () => {
  it("applies defaults on client caps", () => {
    const caps = zRadClientCaps.parse({ profileVersion: "0.1" });
    expect(caps).toEqual({
      profileVersion: "0.1",
      focusState: false,
      flags: false,
      clinicalPermissionVerbs: false,
      codedContent: [],
    });
  });

  it("round-trips a session binding", () => {
    const meta = {
      accession: "ACC0000001",
      modality: "CT",
      region: "brain",
      protocol: "noncontrast",
      setting: "ER",
      reportStatus: "preliminary",
      phiBoundary: "research_synthetic",
    } as const;
    expect(zRadSessionMeta.parse(meta)).toEqual({ ...meta, shortPrelim: false });
    expect(worklistRoot(meta.accession)).toBe("/worklist/ACC0000001");
  });

  it("accepts draft with the short-prelim property and rejects the retired statuses", () => {
    const parsed = zRadSessionMeta.parse({ accession: "A", modality: "CT", reportStatus: "draft", shortPrelim: true, phiBoundary: "research_synthetic" });
    expect(parsed.reportStatus).toBe("draft");
    expect(parsed.shortPrelim).toBe(true);
    for (const reportStatus of ["short_prelim", "preliminary_reviewed", "signed"]) {
      expect(() => zRadSessionMeta.parse({ accession: "A", modality: "CT", reportStatus, phiBoundary: "research_synthetic" })).toThrow();
    }
  });

  it("accepts a prompt meta with and without focus", () => {
    expect(zRadPromptMeta.parse({})).toEqual({});
    expect(
      zRadPromptMeta.parse({ focus: { section: "impression", cursorOffset: 0, selection: null } }),
    ).toEqual({ focus: { section: "impression", cursorOffset: 0, selection: null } });
  });

  it("readRadAgentCaps returns undefined for a malformed block", () => {
    expect(readRadAgentCaps({ rad: "nope" })).toBeUndefined();
  });
});
