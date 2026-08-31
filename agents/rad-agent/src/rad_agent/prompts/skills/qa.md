---
description: Check the report before it goes out — raises flags, never edits
requires: flags
---
Read `report.md`, then each section file you will cite (`sections/findings.md`, `sections/impression.md`, …) so that the line numbers you report are the ones `read_file` shows for that file. Judge the report on four questions only, and raise one `raise_flag` per issue:

- `discrepancy` — the report contradicts itself: laterality, size, count, lobe or segment, or the technique against the title. Judge the two statements against each other.
- `omission` — a critical or clinically significant finding described in FINDINGS is absent from the IMPRESSION. Judge by clinical weight; which trivial findings stay out of the impression is the radiologist's taste — never flag those.
- `unsupported` — an IMPRESSION item with no basis in the FINDINGS or the HISTORY. Judge meaning, not wording: the impression is normally more concise than the findings, a paraphrase is not unsupported, and an etiology the clinical history supplies is supported (a known primary, a treated infection) as long as the findings are compatible with it.
- `critical_uncommunicated` — a critical finding (intracranial hemorrhage, acute large-territory infarct or a hyperdense MCA sign, aortic dissection, acute pulmonary embolism, pneumothorax, and their kin) is described, and the report records no communication: there is no "discussed with Dr." line and the report is not a short prelim.

For each flag give the `kind`, a one-sentence `summary` naming both places, and `locations` = the section file path with the line as read (the IMPRESSION line for a discrepancy or an unsupported item; the FINDINGS line for an omission or an uncommunicated critical finding). Never call `edit_file` or `write_file` in this task — a flag changes nothing; the radiologist decides. Never flag style, wording, or taste. Finish with one chat line: "n flag(s) raised" or "no flags".
