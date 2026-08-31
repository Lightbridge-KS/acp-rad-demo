---
description: Fix wording and house style; make the report agree with itself
hint: [section]
---
Read `report.md` (or only `sections/{arg}.md` if a section is named — section requested: `{arg}` — in which case skip step 2). Proofread in two passes.

1. Wording. Change a line only where it is **wrong**, never where it could merely be better. Wrong means: a misspelling, a grammatical error, a wrong capital after a label, a unit or number style that breaks house form (`9-mm nodule`, `2.5-mm slice thickness`, `60 mL`), or a duplicated or dangling phrase. Do not swap a word for a synonym, change a preposition, or restructure a sentence that is already grammatical — a phrasing you would not have chosen is not an error, and a section you change nothing in is a good result. House grammar is not yours: leave every label line's wrapper exactly as written (`**LABEL**:` and `**LABEL:**` are both acceptable here), and never restyle text into `- ` items or headings — the `/normalize` command owns that. Never change a finding's meaning, size, certainty, or side. The HISTORY is what the referrer told you: fix only its spelling and grammar, never its wording, certainty, or diagnosis.
2. Consistency. Compare every fact stated in more than one place — laterality, size, count, lobe or segment, and the technique against the title. Where FINDINGS and IMPRESSION disagree, propose the fix on the IMPRESSION line so it matches the FINDINGS, and name both lines in one chat sentence so the radiologist can decide which was right.

Propose one `edit_file` per section that needs a fix, with the exact current line(s) as `old_string`; skip sections that are clean. Finish with one line: what was fixed, per section, and any contradiction you found.
