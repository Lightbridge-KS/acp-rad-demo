/**
 * ReportStore — the one seam through which every report access flows (design §3.1, §5.4).
 *
 * On ACP v1 it backs `fs/read_text_file`; on v2 the same object becomes MCP-over-ACP tools.
 * It is deliberately stateless: every read canonicalizes the *live* editor ops, so the agent
 * always sees what the radiologist sees.
 */
import type { Op } from "quill-delta";
import { deltaToMarkdown } from "./markdown.ts";
import { buildManifest, isWritable, resolvePath } from "./namespace.ts";
import { RAD_ERRORS, type RadErrorCode, type SectionId } from "./schema.ts";
import { splitSections } from "./sections.ts";

export class RadError extends Error {
  readonly code: RadErrorCode;
  constructor(code: RadErrorCode, message: string) {
    super(message);
    this.name = "RadError";
    this.code = code;
  }
}

export type ReportStoreDeps = {
  accession: string;
  /** Live Quill ops (`quill.getContents().ops`), or any Delta-shaped source. */
  getOps: () => Op[];
  /** De-identified study metadata, served as `/worklist/{acc}/meta.json`. */
  meta: Record<string, unknown>;
  /** Prior reports by accession, canonical Markdown. */
  priors?: Record<string, string>;
  /** House templates by id, canonical Markdown. */
  templates?: Record<string, string>;
  /** Quick-text snippets by id, canonical Markdown. */
  snippets?: Record<string, string>;
};

export type ReportStore = {
  accession: string;
  /** Canonical content at `path`; throws `RadError` (-32004 / -32003). */
  read: (path: string) => string;
  /** Rejects every write in this slice; the proposal flow arrives with slice 3. */
  write: (path: string, content: string) => never;
  /** The whole live report as canonical Markdown. */
  reportMarkdown: () => string;
  /** Every readable path, for `session/new._meta.rad.manifest`. */
  manifest: () => string[];
};

export function createReportStore(deps: ReportStoreDeps): ReportStore {
  const priors = deps.priors ?? {};
  const templates = deps.templates ?? {};
  const snippets = deps.snippets ?? {};
  const notFound = (path: string) => new RadError(RAD_ERRORS.NOT_FOUND, `not found: ${path}`);

  const reportMarkdown = () => deltaToMarkdown(deps.getOps());

  const read = (path: string): string => {
    const r = resolvePath(path, deps.accession);
    if (!r) throw notFound(path);
    switch (r.kind) {
      case "report":
        return reportMarkdown();
      case "section": {
        const s = splitSections(reportMarkdown()).sections[r.id];
        if (s === undefined) throw notFound(path);
        return s;
      }
      case "meta":
        return `${JSON.stringify(deps.meta, null, 2)}\n`;
      case "priorsIndex": {
        const accs = Object.keys(priors).sort();
        return accs.length === 0
          ? "(no priors)\n"
          : `${accs.map((a) => `- /priors/${a}/report.md`).join("\n")}\n`;
      }
      case "prior":
        return priors[r.accession] ?? throwNotFound(path);
      case "template":
        return templates[r.id] ?? throwNotFound(path);
      case "snippet":
        return snippets[r.id] ?? throwNotFound(path);
    }
  };

  const write = (path: string): never => {
    const r = resolvePath(path, deps.accession);
    if (!r) throw notFound(path);
    if (!isWritable(r)) throw new RadError(RAD_ERRORS.FORBIDDEN, `read-only: ${path}`);
    throw new RadError(RAD_ERRORS.FORBIDDEN, "writes are proposals; not available yet");
  };

  const manifest = () =>
    buildManifest(deps.accession, {
      sections: Object.keys(splitSections(reportMarkdown()).sections) as SectionId[],
      priors: Object.keys(priors),
      templates: Object.keys(templates),
      snippets: Object.keys(snippets),
    });

  return { accession: deps.accession, read, write, reportMarkdown, manifest };

  function throwNotFound(path: string): never {
    throw notFound(path);
  }
}

/**
 * Apply ACP `fs/read_text_file` windowing: `line` is 1-based, `limit` counts lines.
 * Returns the whole content when neither is given.
 */
export function sliceLines(content: string, line?: number | null, limit?: number | null): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const start = Math.max((line ?? 1) - 1, 0);
  const end = limit == null ? lines.length : Math.min(start + limit, lines.length);
  const out = lines.slice(start, end);
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}
