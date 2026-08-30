/**
 * Document commands — pure functions over canonical Markdown (design 02 §2.2, CONTEXT.md).
 *
 *   /template [id]        instantiate a house template for this study
 *   /short-prelim [region] the region's short-prelim paragraph as the whole buffer
 *   fold-in               a short prelim placed inside the full skeleton
 *
 * House policy lives here, not in `acp-rad`: the profile package knows sections and grammar,
 * not what `[Male]` or `___ mGy` mean. No Quill, no React — see `apply.ts` for the editor side.
 */
import { canonicalLines, canonicalize, splitSections } from "acp-rad";
import type { CaseMeta } from "./meta.ts";

/** `[Male]` / `[female]` on a template line: keep the line only for that sex. */
const SEX_TOKEN_RE = /\s*\[(male|female)\]\s*/i;
const DOSE_LABEL_RE = /^\*\*Estimated radiation dose:\*\*/;
/** The closing snippet of a report (`/discuss-with-dr`); the fold-in lands just before it. */
export const DISCUSSED_WITH_RE = /^The findings about /;
/** Dropped from a short prelim when it is folded into the full report. */
const FULL_REPORT_FOLLOWS_RE = /\s*A full report will follow\.?/g;

/**
 * Instantiate a house template for a study.
 *
 * - A line carrying `[Male]`/`[female]` is kept only when `patient.sex` matches, token removed.
 *   Unknown sex keeps both lines *with* their tokens — they read as blanks, like `___`.
 * - On the dose label line, `___ mGy` / `___ mGycm` are filled from `study.doseMgy/doseMgycm`
 *   when present. Every other blank (`___`, `??`, `dd/mm/yyyy`) is clinical and stays.
 */
export function instantiateTemplate(template: string, meta: CaseMeta): string {
  const sex = meta.patient?.sex;
  const study = meta.study;
  const out: string[] = [];
  for (const line of canonicalLines(template)) {
    const m = SEX_TOKEN_RE.exec(line);
    if (m) {
      if (!sex) {
        out.push(line);
        continue;
      }
      const lineSex = m[1]!.toLowerCase() === "male" ? "M" : "F";
      if (lineSex === sex) out.push(line.replace(SEX_TOKEN_RE, " ").trim());
      continue;
    }
    if (DOSE_LABEL_RE.test(line)) {
      let filled = line;
      if (study?.doseMgy !== undefined) filled = filled.replace(/_+(?= mGy\b)/, String(study.doseMgy));
      if (study?.doseMgycm !== undefined) filled = filled.replace(/_+(?= mGycm\b)/, String(study.doseMgycm));
      out.push(filled);
      continue;
    }
    out.push(line);
  }
  return canonicalize(`${out.join("\n")}\n`);
}

/** The template id an invocation refers to: the argument, else the study's own. */
export function templateIdFor(meta: CaseMeta, arg?: string): string | undefined {
  const a = arg?.trim();
  return a ? a : meta.study?.template;
}

/** Short-prelim snippet for a region (`session.region` or the command's argument). */
export function regionSnippetId(region: string | undefined): "sp-brain" | "sp-chest" | "sp-body" {
  const r = (region ?? "").trim().toLowerCase();
  if (r === "brain" || r === "head") return "sp-brain";
  if (r === "chest" || r === "thorax") return "sp-chest";
  return "sp-body";
}

/** A short prelim is the region's paragraph and nothing else — no title, no sections. */
export function shortPrelimDocument(snippet: string): string {
  return canonicalize(snippet);
}

/**
 * Fold a short-prelim buffer into an instantiated template: its lines (minus "A full report
 * will follow.") go after the IMPRESSION items and before the discussed-with line. Lines the
 * radiologist typed under the paragraph (critical findings) travel with it.
 */
export function foldInShortPrelim(template: string, shortPrelimBuffer: string): string {
  const sp = canonicalLines(shortPrelimBuffer)
    .map((l) => l.replace(FULL_REPORT_FOLLOWS_RE, "").trim())
    .filter((l) => l !== "");
  if (sp.length === 0) return canonicalize(template);
  const { lines, ranges } = splitSections(template);
  const impression = ranges.find((r) => r.id === "impression");
  let at = lines.length;
  if (impression) {
    const discussed = lines.slice(impression.start, impression.end).findIndex((l) => DISCUSSED_WITH_RE.test(l));
    if (discussed >= 0) at = impression.start + discussed;
    else {
      at = impression.end;
      while (at > impression.start + 1 && lines[at - 1] === "") at--;
    }
  }
  const out = [...lines.slice(0, at), "", ...sp, "", ...lines.slice(at)];
  return canonicalize(`${out.join("\n")}\n`);
}

/** Quill's empty document canonicalizes to `"\n"`; so does whitespace-only text. */
export function isBlankBuffer(markdown: string): boolean {
  return canonicalize(markdown) === "\n";
}

/** Blank for the command menu's purposes: empty, or nothing but the `/query` being typed. */
export function isBlankApartFromSlash(markdown: string): boolean {
  const lines = canonicalLines(markdown);
  return lines.length === 0 || (lines.length === 1 && lines[0]!.startsWith("/"));
}
