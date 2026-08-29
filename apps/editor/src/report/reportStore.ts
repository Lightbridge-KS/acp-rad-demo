/**
 * The editor's ReportStore: `acp-rad`'s store over live Quill ops, with the proposal overlay
 * stripped (INV-1 — the agent never reads a pending proposal) and the live report status.
 */
import type Quill from "quill";
import { createReportStore, type ReportStatus, type ReportStore } from "acp-rad";
import { snippets, templates, type CaseFixture } from "../fixtures/index.ts";
import { stripOverlays } from "./overlay.ts";

export function makeReportStore(quill: Quill, fixture: CaseFixture, reportStatus: () => ReportStatus): ReportStore {
  return createReportStore({
    accession: fixture.session.accession,
    getOps: () => stripOverlays(quill.getContents().ops),
    meta: fixture.meta,
    priors: fixture.priors,
    ...(fixture.priorsIndex !== undefined ? { priorsIndex: fixture.priorsIndex } : {}),
    templates,
    snippets,
    reportStatus,
  });
}
