---
summary: ADR — inline tracked changes use line-level hunks (a hunk = contiguous run of changed canonical lines); word-level hunks recorded as the alternative for later.
read_when: Touching apps/editor/src/report/overlay.ts or packages/acp-rad/src/hunks.ts; when a proposal renders "too coarse" and word-level diffing comes up.
---

# ADR 0002 — Hunk granularity: line-level (word-level kept as alternative)

**Status:** accepted 2026-08-29 (KS). **Amends:** design §5.7 (interaction model B). **Related:** ADR 0001.

## Decision

A **hunk** — the unit the radiologist accepts or discards — is a **contiguous run of changed canonical lines** between a proposal's old and new text (LCS diff over lines from `canonicalLines`). The overlay strikes the old lines (`ai-delete`) and inserts the new lines after them (`ai-insert`); accept/discard acts on whole lines.

Anchor = `(section, oldLines[])`, located by canonical line equality within the section; pure insertions anchor after the diff's preceding context line, else at the section end. An unfindable anchor marks the hunk `conflict` (INV-2).

## Why

- The report grammar is line-shaped: one organ line, one impression bullet, one header field. A line is the natural clinical review unit, and the anchor is a plain string equality — no offset mapping.
- Ships in slice 3 with no diff library; the overlay builder is ~100 lines over `Op[]` and is testable without a DOM.

## Alternative kept for later — word-level hunks

Diff *inside* a line (e.g. only `Normal.` → `Hyperdense left M1 segment …` struck/inserted within the Vascular line), the way Word track-changes reads and the way the wireframe drew it.

- **What changes:** only the overlay builder — the hunk model (`buildHunks` / `applyHunks` / grant expectation) is unchanged. Needs a character/word diff (e.g. `diff` or `fast-diff`, both small) and a mapping from canonical-Markdown offsets to Quill indexes through `**`/`_` markers (bold runs shift offsets by 2 per marker).
- **Cost:** roughly +0.5 day and more edge cases (a change that spans a bold boundary; a line that is both edited and re-bulleted).
- **When to switch:** if radiologists find whole-line strike/insert noisy for one-word edits (dictation corrections), or when word-level inline suggestions become a demo point. Rejecting a word-level hunk must still leave the line canonical.

## Consequences

- One-word changes re-render the whole line as struck + inserted; acceptable for v0.1.
- `Hunk` carries `oldLines`/`newLines` only; a future word-level hunk adds an optional `spans` field rather than replacing the model.
