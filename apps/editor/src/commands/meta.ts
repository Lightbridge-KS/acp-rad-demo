/**
 * Typed view of a case's `meta.json` (the de-identified study metadata, design 02 §2.3).
 * Editor commands are its first consumer: `/template` reads sex, dose and the template id.
 * Loose on purpose — unknown keys pass through and are served verbatim to the agent.
 */
import { z } from "zod";

export const zCaseMeta = z.looseObject({
  title: z.string().optional(),
  patient: z
    .looseObject({
      sex: z.enum(["M", "F"]).optional(),
      ageBand: z.string().optional(),
    })
    .optional(),
  study: z
    .looseObject({
      /** House template id (`/templates/{id}.md`), the default for `/template`. */
      template: z.string().optional(),
      doseMgy: z.number().optional(),
      doseMgycm: z.number().optional(),
      /** Study date, `dd/mm/yyyy` (synthetic here; a PHI identifier in real deployments). */
      date: z.string().optional(),
    })
    .optional(),
});
export type CaseMeta = z.infer<typeof zCaseMeta>;
