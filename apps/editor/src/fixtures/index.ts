/**
 * Synthetic fixtures (no PHI): cases, house templates, quick-text snippets.
 * All Markdown is stored in canonical form (see packages/acp-rad markdown.ts).
 */
import { zRadSessionMeta, type RadSessionMeta } from "acp-rad";

const md = import.meta.glob("../../fixtures/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const metas = import.meta.glob("../../fixtures/*/meta.json", {
  import: "default",
  eager: true,
}) as Record<string, CaseMetaJson>;

type CaseMetaJson = {
  title: string;
  session: unknown;
  patient?: Record<string, unknown>;
  study?: Record<string, unknown>;
};

export type CaseFixture = {
  id: string;
  title: string;
  session: RadSessionMeta;
  /** Served as /worklist/{acc}/meta.json — de-identified. */
  meta: Record<string, unknown>;
  reportMarkdown: string;
  /** Prior reports by accession (canonical Markdown). */
  priors: Record<string, string>;
};

const idOf = (path: string) => path.replace(/^.*\/([^/]+)\.md$/, "$1");

function collection(dir: "templates" | "snippets"): Record<string, string> {
  const prefix = `../../fixtures/${dir}/`;
  return Object.fromEntries(
    Object.entries(md)
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, text]) => [idOf(p), text]),
  );
}

export const templates: Record<string, string> = collection("templates");
export const snippets: Record<string, string> = collection("snippets");

export const cases: CaseFixture[] = Object.entries(metas)
  .map(([path, meta]) => {
    const id = path.replace(/^\.\.\/\.\.\/fixtures\/([^/]+)\/meta\.json$/, "$1");
    const base = `../../fixtures/${id}/`;
    const priors = Object.fromEntries(
      Object.entries(md)
        .filter(([p]) => p.startsWith(`${base}priors/`))
        .map(([p, text]) => [idOf(p), text]),
    );
    const { session: _s, ...rest } = meta;
    return {
      id,
      title: meta.title,
      session: zRadSessionMeta.parse(meta.session),
      meta: rest as Record<string, unknown>,
      reportMarkdown: md[`${base}report.md`] ?? "\n",
      priors,
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

export const defaultCase: CaseFixture = cases[0]!;
