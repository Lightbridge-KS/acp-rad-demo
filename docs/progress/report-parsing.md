---
summary: Tracker for report parsing — P1 tolerant labels, P2 the section profile, P3 absent sections + static manifest + `/normalize`; P4 (a standalone package) deferred.
read_when: Working on `labels.ts` / `sections.ts` / `sectionRange`; landing a parsing step (tick boxes, add SHAs); asking what is left of the pasted-report defect.
---

# ACP-Rad Demo — report parsing

Parent: [`overview-demo.md`](./overview-demo.md) · Design: [`06-report-parsing`](../design/06-report-parsing.md) · glossary [`CONTEXT.md`](../../CONTEXT.md). Plan approved 2026-08-31 (`~/.claude/plans/soft-crunching-dahl.md`).

Steps are **P1–P4**, not "slices" — the parent tracker's slice numbers mean something else.

## Milestones

- [x] **P1. Tolerant, line-anchored section labels** (2026-08-31, `f59a1d1`) — new `packages/acp-rad/src/labels.ts` owns the whole grammar: `SectionProfile` + `HOUSE_PROFILE` (ported from `radreportparser`'s `KeyWord`), `sectionIdOfLine`, `isFooterLine`, `canonicalLabel`, `normalizeLabels`. `sections.ts` drops `SECTION_LABEL_RE`/`LABEL_TO_ID` and closes a section at a RIS footer. New fixture `ct-neck-tb-lymph` (`ACC0000040`) — the report that broke, synthetic. Verified: 66 new tests; the fixture sweep proves the tolerant recognizer yields the *identical* label set as the strict one on all 20 pre-existing fixture files; `just check` green.
- [x] **P2. The section profile as configuration** (2026-08-31, `e290a57`) — `ReportStoreDeps.profile?`, threaded into every `splitSections`. Verified: a custom profile parses `DESCRIPTION:`/`CONCLUSION:` and does not leak into `HOUSE_PROFILE`.
- [x] **P3a. Absent sections, static manifest** (2026-08-31, `e290a57`) — `read` of an absent section returns `""`; `manifest()` always lists the five `SECTION_IDS`; `proposals` prefixes `canonicalLabel(id)` when the base is `""`; `overlay.sectionInsertionPoint()` places a created section in `SECTION_IDS` order; `smoke.ts` guarded against `replace("")`. Verified: `just check` green (164 + 10 + 117 TS, 47 py).
- [x] **P3b. `/normalize`** (2026-08-31, `2b8a809`) — a `replace` effect from `normalizeLabels` through the existing local-proposal path, so the rewrite is tracked changes the radiologist decides. Suggested only when the buffer holds a foreign label. Verified: `just check` green.
- [x] **P3c. Contract docs synced** (2026-08-31, `66968ea` + this commit) — *absent section ⇒ `""`* replaces *⇒ `-32004`* in design 01 §8, 02 §4, 05 §3.3/§4, protocol §5.4/§6 and the parent tracker's slice-2 contract; `CONTEXT.md` gained **Section profile** and an extended **Label line**; README + AGENTS doc lists.
- [ ] **P4. (deferred) Standalone TS package** — extract once the profile has survived a real corpus and a second consumer. The artifact to share with the Python package is the **profile + conformance corpus**, not the engine (design 06 §7). Also file the two upstream defects found while porting: mid-prose false positives, and `verbose=True` printing to stdout.

## Now / Next

- **Now:** P1–P3 landed and verified in the browser (2026-08-31, `openai:gpt-5.6-terra`, case `ct-neck-tb-lymph`). `/impression` on the report that broke: **one** `ls` → `read findings.md` complete → `read impression.md` complete → `edit` `requires-action` → Accept → `complete · accepted` → read-back → *"Proposed IMPRESSION items in `sections/impression.md` for radiologist review."* No "unable to access", no repeated `ls`, no `sections/./findings.md` retry — the failing trace was 9 tool calls, this one is 4. `/normalize` then offered itself under **Suggested**, proposed 4 changes (label wrappers only; `TECHNIQUES` kept plural as authored, organ lines untouched) and left the report in house grammar after Accept all.
- **Next:** nothing scheduled. `just smoke` has not been re-run since these changes (it needs port 8787, held by the dev bridge). P4 (the standalone package) is deferred with no date.

## Deferred

- Organ lines (`**Lymph nodes:**`) are recognized as label lines but are not addressable; a second partition level waits for a skill that needs one (design 06 §9).
- Labels with a tail (`IMPRESSION AND RECOMMENDATION:`) are not recognized — deliberate; add the phrase as a keyword if a real report needs it.
- Thai-language section labels: out of scope, reports here are English.

## Confirmed contracts

- **A label is anchored and terminated.** It must open its line, and after the keyword the line must hold a colon or end. Anchoring is what keeps the partition line-indexed; the terminator is what stops prose (`Findings are consistent with…`, `Comparison with the prior…`) from opening a section. Dropping either re-creates the Python package's mid-prose false positives — proven, design 06 §5.
- **`""` means absent, unambiguously.** A section that is present always carries at least its own label line, so an empty read can only mean the section is missing. Both halves must move together: if `read` returns `""` while `manifest()` still omits the path, the listing lies in the other direction.
- **The manifest is static or it is stale.** It is sent once at `session/new` and never refreshed, so every input must be fixture-constant. Listing all five sections regardless of presence is what makes that true — the same class of bug as the agent-side `reportStatus` snapshot (data 05 §8).
- **The Client supplies the label, the agent supplies the content.** A created section's label is prefixed by `proposals`, never by the agent, and appears in the tracked-change diff — so creating a section is decided, not assumed (INV-1).
- **`normalizeLabels` keeps the author's keyword.** The house writes both `**TECHNIQUE:**` and `**TECHNIQUES:**`; normalizing fixes the wrapper only. `canonicalLabel` picks a spelling *only* when creating a section from nothing.
- **Tolerance must be additive.** The fixture sweep in `labels.test.ts` compares the recognizer against the strict regex on every fixture but the deliberately foreign one; a widening that changes any existing partition fails it.

## Open questions

- (none attached to scheduled work)
