---
name: qa
description: Additional QA checks required at this institution, applied on top of the base checks. Appended to the sealed base skill, never replacing it.
metadata:
  requires: flags
---
The following checks are **in addition to** the base checks above. Apply both sets; never skip a base check.

- **Unreviewed trainee prelim.** If the report is a preliminary report written by a trainee — the impression head carries the "This is a PRELIMINARY report" marker — and that marker says the study has **not** been reviewed by the attending, raise `omission` on the marker line. A prelim that leaves the ward without an attending's review is an institutional gap, not a clinical one, but it is the radiologist's to see before signing.
