import type Quill from "quill";
import { createReportStore, type ReportStore } from "acp-rad";
import { snippets, templates, type CaseFixture } from "../fixtures/index.ts";

/** The ReportStore over a live Quill instance — every read canonicalizes current editor state. */
export function makeReportStore(quill: Quill, fixture: CaseFixture): ReportStore {
  return createReportStore({
    accession: fixture.session.accession,
    getOps: () => quill.getContents().ops,
    meta: fixture.meta,
    priors: fixture.priors,
    templates,
    snippets,
  });
}
