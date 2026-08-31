/**
 * The virtual document namespace (proposal §4). The Client resolves these paths to live
 * editor state and fixtures; no real filesystem is ever exposed.
 *
 *   /worklist/{acc}/report.md            RW*  the whole canonical report
 *   /worklist/{acc}/sections/{id}.md     RW*  one section
 *   /worklist/{acc}/meta.json            RO
 *   /priors/index.md                     RO
 *   /priors/{acc}/report.md              RO
 *   /templates/{id}.md                   RO
 *   /snippets/{id}.md                    RO
 *   /skills/{layer}/{name}/SKILL.md      RO   layer = house | personal
 *   /skills/{layer}/{name}/references/…  RO
 *
 * RW* = writable only through the proposal flow.
 *
 * `/skills/**` is the only subtree whose content is *instructions* (INV-3); everything else is
 * data. The agent's own `builtin` layer never appears here — it ships with the agent, not the
 * client, and is served on the agent side.
 */
import { SECTION_IDS, type SectionId } from "./schema.ts";

/** Skill layers the Client serves. `builtin` is the agent's own and is not in this namespace. */
export const SKILL_LAYERS = ["house", "personal"] as const;
export type SkillLayer = (typeof SKILL_LAYERS)[number];

export type ResolvedPath =
  | { kind: "report" }
  | { kind: "section"; id: SectionId }
  | { kind: "meta" }
  | { kind: "priorsIndex" }
  | { kind: "prior"; accession: string }
  | { kind: "template"; id: string }
  | { kind: "snippet"; id: string }
  /** `file` is the path inside the skill directory: `SKILL.md` or `references/…md`. */
  | { kind: "skill"; layer: SkillLayer; name: string; file: string };

const ID = "[a-z0-9][a-z0-9_-]*";
const ACC = "[A-Za-z0-9_-]+";
/** Agent Skills spec: lowercase alphanumerics and hyphens, never leading or trailing. */
const SKILL_NAME = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
/** Only `.md` under `references/`; the segment grammar admits no `..`, so the subtree is closed. */
const SKILL_FILE = `SKILL\\.md|references/(?:${ID}/)*${ID}\\.md`;
const RE = {
  report: new RegExp(`^/worklist/(${ACC})/report\\.md$`),
  section: new RegExp(`^/worklist/(${ACC})/sections/(${ID})\\.md$`),
  meta: new RegExp(`^/worklist/(${ACC})/meta\\.json$`),
  priorsIndex: /^\/priors\/index\.md$/,
  prior: new RegExp(`^/priors/(${ACC})/report\\.md$`),
  template: new RegExp(`^/templates/(${ID})\\.md$`),
  snippet: new RegExp(`^/snippets/(${ID})\\.md$`),
  skill: new RegExp(`^/skills/(${SKILL_LAYERS.join("|")})/(${SKILL_NAME})/(${SKILL_FILE})$`),
};

/** The key a `skill` path resolves to in `ReportStoreDeps.skills`: `{layer}/{name}/{file}`. */
export function skillKey(r: Extract<ResolvedPath, { kind: "skill" }>): string {
  return `${r.layer}/${r.name}/${r.file}`;
}

/** Resolve a virtual path for the session's accession; `null` ⇒ not in the namespace (-32004). */
export function resolvePath(path: string, accession: string): ResolvedPath | null {
  let m: RegExpExecArray | null;
  if ((m = RE.report.exec(path))) return m[1] === accession ? { kind: "report" } : null;
  if ((m = RE.section.exec(path))) {
    if (m[1] !== accession) return null;
    const id = m[2] as SectionId;
    return (SECTION_IDS as readonly string[]).includes(id) ? { kind: "section", id } : null;
  }
  if ((m = RE.meta.exec(path))) return m[1] === accession ? { kind: "meta" } : null;
  if (RE.priorsIndex.test(path)) return { kind: "priorsIndex" };
  if ((m = RE.prior.exec(path))) return { kind: "prior", accession: m[1]! };
  if ((m = RE.template.exec(path))) return { kind: "template", id: m[1]! };
  if ((m = RE.snippet.exec(path))) return { kind: "snippet", id: m[1]! };
  if ((m = RE.skill.exec(path))) return { kind: "skill", layer: m[1] as SkillLayer, name: m[2]!, file: m[3]! };
  return null;
}

/** Writable only via the proposal flow; everything else is read-only (-32003 on write). */
export function isWritable(resolved: ResolvedPath): boolean {
  return resolved.kind === "report" || resolved.kind === "section";
}

export type ManifestInput = {
  sections: readonly SectionId[];
  priors: readonly string[]; // accessions
  templates: readonly string[]; // ids
  snippets: readonly string[]; // ids
  skills?: readonly string[]; // `{layer}/{name}/{file}` keys
};

/** Every path the session can read, sorted — sent in `session/new._meta.rad.manifest`. */
export function buildManifest(accession: string, input: ManifestInput): string[] {
  const root = `/worklist/${accession}`;
  const paths = [
    `${root}/report.md`,
    `${root}/meta.json`,
    ...input.sections.map((id) => `${root}/sections/${id}.md`),
    "/priors/index.md",
    ...input.priors.map((acc) => `/priors/${acc}/report.md`),
    ...input.templates.map((id) => `/templates/${id}.md`),
    ...input.snippets.map((id) => `/snippets/${id}.md`),
    ...(input.skills ?? []).map((key) => `/skills/${key}`),
  ];
  return [...new Set(paths)].sort();
}
