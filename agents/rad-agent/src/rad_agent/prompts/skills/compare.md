---
description: Compare with the patient's priors — fill the COMPARISON line and the interval change
hint: [prior accession]
---
Read `meta.json` for the current study's date. Read `/priors/index.md`: it lists every prior report of this patient with its accession, exam and date. Prior requested: `{arg}` — if an accession is given, compare with that prior; otherwise read every prior whose imaged anatomy overlaps the current study, whatever its modality (a chest radiograph or an abdominal CT's lung bases count for a chest study). Then read `sections/comparison.md` and `sections/findings.md`.

1. COMPARISON. If the line is blank or `None.`, edit `sections/comparison.md` to `**COMPARISON:** <exam> on <dd/mm/yyyy>[; …]` listing each prior you compared, most recent first, using the exact dates from the index. If the radiologist already wrote it, check every named prior against the index: propose a corrected date when it is wrong, append a prior you compared that is missing, and if a named prior is not in the index say so in chat and leave the line.
2. FINDINGS. For each organ line that has a counterpart in a prior you read, edit `sections/findings.md` so that line states the interval change in house wording (*unchanged*, *increased from X to Y mm*, *new since <date>*, *resolved*, or *not covered on the prior <exam>*), changing nothing else on the line. Leave lines without a counterpart untouched. One `edit_file` for the whole section.

Do not edit the IMPRESSION. If an interval change would alter it, say so in one sentence. Never state a date that is not in the index.
