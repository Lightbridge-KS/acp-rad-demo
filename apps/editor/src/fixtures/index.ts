/**
 * Synthetic fixtures (no PHI): cases, house templates, quick-text snippets.
 * All Markdown is stored in canonical form (see packages/acp-rad markdown.ts).
 */
import { zRadSessionMeta, type RadSessionMeta } from "acp-rad";
import { zCaseMeta, type CaseMeta } from "../commands/meta.ts";

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
  /** Demo start state applied at load; the file itself stays the complete, reviewed case. `default` marks the case the editor opens without `?case=`. */
  demo?: { start?: "complete" | "impression_empty"; default?: boolean };
  patient?: Record<string, unknown>;
  study?: Record<string, unknown>;
};

/** Blank the IMPRESSION items so scenario 1 ("draft the impression") has something to draft. */
export function applyStartState(markdown: string, start: "complete" | "impression_empty" | undefined): string {
  if (start !== "impression_empty") return markdown;
  const lines = markdown.replace(/\n$/, "").split("\n");
  const i = lines.findIndex((l) => /^\*\*IMPRESSION:\*\*/.test(l));
  if (i < 0) return markdown;
  return `${[...lines.slice(0, i + 1), "- ..."].join("\n")}\n`;
}

export type CaseFixture = {
  id: string;
  title: string;
  session: RadSessionMeta;
  /** Served as /worklist/{acc}/meta.json — de-identified; typed for the editor commands. */
  meta: CaseMeta;
  reportMarkdown: string;
  /** Prior reports by accession (canonical Markdown). */
  priors: Record<string, string>;
  /** Hand-written `/priors/index.md` (accession · exam · date per prior); generated when absent. */
  priorsIndex?: string;
  demoDefault: boolean;
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

// ---------------------------------------------------------------------------
// Skills (Agent Skills spec: `<name>/SKILL.md`, agentskills.io)
// ---------------------------------------------------------------------------
//
// Nested, so `collection()`/`idOf` cannot serve them — those flatten a path to its basename and
// every `SKILL.md` would collide on one key. Keys here keep the path inside the layer
// (`qa/SKILL.md`, `impression/references/guide.md`), which is what the namespace addresses.
//
// The `builtin` layer is absent by design: it ships with the agent, not the client.

const HOUSE_RE = /^\.\.\/\.\.\/fixtures\/skills\/house\/(.+)$/;
const PERSONAL_RE = /^\.\.\/\.\.\/fixtures\/skills\/personal\/([^/]+)\/(.+)$/;

/** House-authored skills, keyed `{name}/{file}`. */
export const houseSkills: Record<string, string> = Object.fromEntries(
  Object.entries(md)
    .map(([p, text]) => [HOUSE_RE.exec(p)?.[1], text] as const)
    .filter((e): e is readonly [string, string] => e[0] !== undefined),
);

/** Personal skills by persona (`dr-a`, …), each keyed `{name}/{file}`. */
export const personalSkills: Record<string, Record<string, string>> = (() => {
  const out: Record<string, Record<string, string>> = {};
  for (const [p, text] of Object.entries(md)) {
    const m = PERSONAL_RE.exec(p);
    if (!m) continue;
    (out[m[1]!] ??= {})[m[2]!] = text;
  }
  return out;
})();

/** Persona ids that own a personal skill layer, sorted. `?radiologist=` selects one. */
export const personas: string[] = Object.keys(personalSkills).sort();

/**
 * The skill files the Client serves for one radiologist, keyed the way `ReportStoreDeps.skills`
 * addresses them (`{layer}/{name}/{file}`). Only the *active* persona is mounted, at
 * `/skills/personal/…` — the agent never sees that personas exist, only that a personal layer does.
 */
export function skillFiles(persona: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(houseSkills)) out[`house/${key}`] = text;
  for (const [key, text] of Object.entries((persona && personalSkills[persona]) ?? {})) out[`personal/${key}`] = text;
  return out;
}

export const cases: CaseFixture[] = Object.entries(metas)
  .map(([path, meta]) => {
    const id = path.replace(/^\.\.\/\.\.\/fixtures\/([^/]+)\/meta\.json$/, "$1");
    const base = `../../fixtures/${id}/`;
    const priors = Object.fromEntries(
      Object.entries(md)
        .filter(([p]) => p.startsWith(`${base}priors/`) && !p.endsWith("/index.md"))
        .map(([p, text]) => [idOf(p), text]),
    );
    const priorsIndex = md[`${base}priors/index.md`];
    const { session: _s, demo, ...rest } = meta;
    return {
      id,
      title: meta.title,
      session: zRadSessionMeta.parse(meta.session),
      meta: zCaseMeta.parse(rest),
      reportMarkdown: applyStartState(md[`${base}report.md`] ?? "\n", demo?.start),
      priors,
      ...(priorsIndex !== undefined ? { priorsIndex } : {}),
      demoDefault: demo?.default === true,
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

export const defaultCase: CaseFixture = cases.find((c) => c.demoDefault) ?? cases[0]!;
