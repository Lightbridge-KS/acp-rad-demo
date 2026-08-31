---
summary: Tracker for report parsing — P1 tolerant labels, P2 the section profile, P3 absent sections + static manifest + `/normalize`; P4 (a standalone package) deferred.
read_when: Working on `labels.ts` / `sections.ts` / `sectionRange`; landing a parsing step (tick boxes, add SHAs); asking what is left of the pasted-report defect.
---

# ACP-Rad Demo — report parsing

Parent: [`overview-demo.md`](./overview-demo.md) · Design: [`06-report-parsing`](../design/06-report-parsing.md) · glossary [`CONTEXT.md`](../../CONTEXT.md). Plan approved 2026-08-31 (`~/.claude/plans/soft-crunching-dahl.md`).

Steps are **P1–P4**, not "slices" — the parent tracker's slice numbers mean something else.

## Milestones

- [ ] **P1. Tolerant, line-anchored section labels** — new `packages/acp-rad/src/labels.ts` (`SectionProfile`, `HOUSE_PROFILE` ported from `radreportparser`'s `KeyWord`, `sectionIdOfLine`, `isFooterLine`, `canonicalLabel`, `normalizeLabels`); `sections.ts` drops `SECTION_LABEL_RE`/`LABEL_TO_ID` and closes a section at a footer line; new fixture `ct-neck-tb-lymph` (the report that broke, synthetic). All three call sites import from the package root and need no edit.
- [ ] **P2. The section profile as configuration** — `ReportStoreDeps.profile?`, threaded into every `splitSections`; a per-case override in `fixtures/index.ts`.
- [ ] **P3. Absent sections, static manifest, `/normalize`** —
  - [ ] P3a: `read` of an absent section returns `""`; `manifest()` always lists the five `SECTION_IDS` (so it cannot go stale); `proposals` prefixes `canonicalLabel(id)` when the base is `""`; `overlay.sectionInsertionPoint()` places a materialized section by `SECTION_IDS` order; `smoke.ts` guarded against `replace("")`.
  - [ ] P3b: `/normalize` — `runEditorCommand` returns a `replace` effect from `normalizeLabels`, which the existing local-proposal path (`apply.ts`) renders as tracked changes. Never on paste, never silent.
- [ ] **P3c. Contract docs synced** — *absent section ⇒ `""`* replaces *⇒ `-32004`* in design 01 §8, 02 §4, 05 §3.3, protocol §5.4/§6, and this repo's parent tracker; `CONTEXT.md` gains **Section profile** and extends **Label line**; README + AGENTS doc lists.
- [ ] **P4. (deferred) Standalone TS package** — extract once the profile has survived a real corpus and a second consumer. The artifact to share with the Python package is the **profile + conformance corpus**, not the engine (design 06 §7). Also file the two upstream defects found while porting.

## Now / Next

- **Now:** P1 — the design doc is written; `labels.ts` is next.
- **Next:** P2, then P3a/P3b in that order (P3b depends on `normalizeLabels` from P1 and nothing else).

## Deferred

- Organ lines (`**Lymph nodes:**`) are recognized as label lines but are not addressable; a second partition level waits for a skill that needs one (design 06 §9).
- Labels with a tail (`IMPRESSION AND RECOMMENDATION:`) are not recognized — deliberate; add the phrase as a keyword if a real report needs it.
- Thai-language section labels: out of scope, reports here are English.

## Confirmed contracts

- (none yet — filled as steps land)

## Open questions

- (none attached to scheduled work)
