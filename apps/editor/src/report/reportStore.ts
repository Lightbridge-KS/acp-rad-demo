import type Quill from "quill";
import { createReportStore, type ReportStore } from "acp-rad";
import { snippets, templates, type CaseFixture } from "../fixtures/index.ts";
import { stripOverlays } from "./overlay.ts";

/**
 * The ReportStore over a live Quill instance — every read canonicalizes current editor state
 * **with pending overlays stripped** (INV-1: a proposal is rendered, never in the buffer).
 */
export function makeReportStore(quill: Quill, fixture: CaseFixture): ReportStore {
  return createReportStore({
    accession: fixture.session.accession,
    getOps: () => stripOverlays(quill.getContents().ops),
    meta: fixture.meta,
    priors: fixture.priors,
    templates,
    snippets,
  });
}
