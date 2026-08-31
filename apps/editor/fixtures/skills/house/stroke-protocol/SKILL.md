---
name: stroke-protocol
description: Draft an ER CT brain report against this hospital's acute stroke protocol — ASPECTS scoring, the hyperdense vessel sign, and what must be communicated by phone. Use for a non-contrast CT brain requested to rule out acute stroke or intracranial hemorrhage.
metadata:
  contract: "1.0"
---
This is the acute stroke reporting protocol in force at this hospital. It is longer than fits here, so the detail lives beside this file.

1. Read `/skills/house/stroke-protocol/references/aspects.md` before scoring. It carries the region map and the worked example; do not score from memory.
2. Read `sections/history.md` for the time of onset — it decides whether the study is in the thrombolysis window, and therefore how urgently a finding must be communicated.
3. Then read `sections/findings.md` and propose on `sections/impression.md` as `/impression` would, with these additions:
   - state the ASPECTS score explicitly when there is any established infarct, as `ASPECTS 7/10`;
   - name the vessel when a hyperdense vessel sign is present, with its side;
   - when the study is normal, say so in one item and add nothing else.

Never estimate a score the findings do not support, and never state a time of onset the HISTORY does not give. If the findings describe a critical result and the report records no communication, say so in one chat sentence — raising it as a flag is `/qa`'s job, not yours.
