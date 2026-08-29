/**
 * ACP-Rad profile v0.1 — wire-level schemas.
 *
 * Everything the profile adds to vanilla ACP rides in `_meta.rad` (v1 has no
 * custom content types). See docs/design/acp-rad-poc-spec.md §5 and the
 * proposal in docs/ideas/acp-rad-protocol-proposal.md.
 */
import { z } from "zod";

export const PROFILE_VERSION = "0.1";

/** Key under `_meta` on initialize / session/new / session/prompt. */
export const RAD_META_KEY = "rad";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Section ids = files under /worklist/{accession}/sections/{id}.md (design §5.5). */
export const SECTION_IDS = ["history", "technique", "comparison", "findings", "impression"] as const;
export const zSectionId = z.enum(SECTION_IDS);
export type SectionId = z.infer<typeof zSectionId>;

/** Real ER lifecycle (design §5.6). Only `final` changes behaviour: it locks writes. */
export const zReportStatus = z.enum(["short_prelim", "preliminary", "preliminary_reviewed", "final"]);
export type ReportStatus = z.infer<typeof zReportStatus>;

export const zPhiBoundary = z.enum(["deidentified_egress", "onprem_full", "research_synthetic"]);
export type PhiBoundary = z.infer<typeof zPhiBoundary>;

export const zCodeSystem = z.enum(["RadLex", "ICD10"]);
export type CodeSystem = z.infer<typeof zCodeSystem>;

// ---------------------------------------------------------------------------
// Capability negotiation (initialize)
// ---------------------------------------------------------------------------

/** Client → Agent, `initialize.params._meta.rad`. */
export const zRadClientCaps = z.object({
  profileVersion: z.string(),
  focusState: z.boolean().default(false),
  criticalFindings: z.boolean().default(false),
  clinicalPermissionVerbs: z.boolean().default(false),
  codedContent: z.array(zCodeSystem).default([]),
});
export type RadClientCaps = z.infer<typeof zRadClientCaps>;

/** Agent → Client, `initialize.result._meta.rad`. Absent ⇒ Level 0. */
export const zRadAgentCaps = z.object({
  profileVersion: z.string(),
  focusState: z.boolean().default(false),
  criticalFindings: z.boolean().default(false),
  codedContent: z.array(zCodeSystem).default([]),
  /** Informational: the model the agent is running (for display and audit). */
  model: z.string().optional(),
});
export type RadAgentCaps = z.infer<typeof zRadAgentCaps>;

export type ProfileLevel = 0 | 1 | 2;

/**
 * Conformance level inferred from an agent's `initialize` result `_meta`.
 * 0 = vanilla ACP agent; 1 = rad-aware; 2 = rad-native (alerts and/or codes).
 * Tolerant: a malformed `rad` block degrades to Level 0 rather than throwing.
 */
export function levelOf(initMeta: Record<string, unknown> | null | undefined): ProfileLevel {
  const caps = readRadAgentCaps(initMeta);
  if (!caps) return 0;
  return caps.criticalFindings || caps.codedContent.length > 0 ? 2 : 1;
}

/** Parse `_meta.rad` from an agent's initialize result; `undefined` if absent or malformed. */
export function readRadAgentCaps(
  initMeta: Record<string, unknown> | null | undefined,
): RadAgentCaps | undefined {
  const raw = initMeta?.[RAD_META_KEY];
  if (raw === undefined || raw === null) return undefined;
  const parsed = zRadAgentCaps.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------------------
// Session binding (session/new)
// ---------------------------------------------------------------------------

/** `session/new.params._meta.rad` — one session ↔ one accession. */
export const zRadSessionMeta = z.object({
  accession: z.string().min(1),
  modality: z.string(),
  region: z.string().optional(),
  protocol: z.string().optional(),
  setting: z.string().optional(),
  reportStatus: zReportStatus,
  phiBoundary: zPhiBoundary,
});
export type RadSessionMeta = z.infer<typeof zRadSessionMeta>;

/** Virtual root the session is scoped to; also the `cwd` passed to `session/new`. */
export function worklistRoot(accession: string): string {
  return `/worklist/${accession}`;
}

// ---------------------------------------------------------------------------
// Focus (session/prompt)
// ---------------------------------------------------------------------------

export const zFocus = z.object({
  section: zSectionId.nullable(),
  /** 0-based offset in the canonical Markdown of `section`. */
  cursorOffset: z.number().int().nonnegative().nullable(),
  selection: z.object({ start: z.number().int(), end: z.number().int() }).nullable(),
});
export type Focus = z.infer<typeof zFocus>;

/** `session/prompt.params._meta.rad` (design §5.3: focus travels at prompt time). */
export const zRadPromptMeta = z.object({
  focus: zFocus.optional(),
});
export type RadPromptMeta = z.infer<typeof zRadPromptMeta>;

// ---------------------------------------------------------------------------
// Errors (proposal §10)
// ---------------------------------------------------------------------------

export const RAD_ERRORS = {
  /** RO path write; `final` report; PHI policy. */
  FORBIDDEN: -32003,
  /** Path outside the virtual namespace. */
  NOT_FOUND: -32004,
  /** Proposal rejected by the user (returned to a pending fs/write_text_file). */
  PROPOSAL_REJECTED: -32010,
  /** Buffer changed since the diff's base; agent should re-read and re-propose. */
  CANONICALIZATION_CONFLICT: -32011,
} as const;
export type RadErrorCode = (typeof RAD_ERRORS)[keyof typeof RAD_ERRORS];
