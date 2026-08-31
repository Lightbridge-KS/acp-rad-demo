---
name: qa
description: Dr B's own QA checks, appended to the base and house checks. Never replaces them.
metadata:
  requires: flags
---
These are **further** checks on top of everything above. Apply all of them.

- **Unsized lesion in the impression.** If FINDINGS states a measurement for a lesion and the IMPRESSION mentions that lesion without its size, raise `omission` on the impression line. A referring clinician reading only the impression should not have to go back to the findings for the number that decides follow-up.
