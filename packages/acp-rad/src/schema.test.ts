import { describe, expect, it } from "vitest";
import {
  FLAG_METHOD,
  levelOf,
  readRadAgentCaps,
  worklistRoot,
  zAuditRecord,
  zFlagParams,
  zFlagResponse,
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

describe("flags", () => {
  const base = { sessionId: "s1", kind: "discrepancy", summary: "FINDINGS say right; IMPRESSION says left." };

  it("parses a flag and defaults locations to []", () => {
    expect(zFlagParams.parse(base)).toEqual({ ...base, locations: [] });
    expect(zFlagParams.parse({ ...base, locations: [{ path: "/worklist/A/sections/impression.md", line: 2 }] }).locations).toEqual([
      { path: "/worklist/A/sections/impression.md", line: 2 },
    ]);
    expect(FLAG_METHOD).toBe("_rad/flag");
  });

  it("rejects a fifth kind, an empty or overlong summary, and a non-positive line", () => {
    expect(() => zFlagParams.parse({ ...base, kind: "style" })).toThrow();
    expect(() => zFlagParams.parse({ ...base, summary: "" })).toThrow();
    expect(() => zFlagParams.parse({ ...base, summary: "x".repeat(501) })).toThrow();
    expect(() => zFlagParams.parse({ ...base, locations: [{ path: "/worklist/A/report.md", line: 0 }] })).toThrow();
  });

  it("response is acknowledged only; audit records may carry a flagId", () => {
    expect(zFlagResponse.parse({ outcome: "acknowledged" })).toEqual({ outcome: "acknowledged" });
    expect(() => zFlagResponse.parse({ outcome: "dismissed" })).toThrow();
    const rec = zAuditRecord.parse({
      ts: "2026-08-30T00:00:00Z", sessionId: "s", accession: "A",
      actor: { userId: "u", role: "radiologist" }, agent: { name: "a", level: 2 },
      event: "flag.raised", flagId: "f1", outcome: "discrepancy",
    });
    expect(rec.flagId).toBe("f1");
  });

  it("audit records may carry the overridden flagIds and an attending actor", () => {
    const rec = zAuditRecord.parse({
      ts: "2026-08-30T00:00:00Z", sessionId: "s", accession: "A",
      actor: { userId: "u", role: "attending" }, agent: { name: "a", level: 2 },
      event: "qa.overridden", flagIds: ["f1", "f2"],
    });
    expect(rec.flagIds).toEqual(["f1", "f2"]);
    expect(() => zAuditRecord.parse({ ...rec, actor: { userId: "u", role: "nurse" } })).toThrow();
  });
});
