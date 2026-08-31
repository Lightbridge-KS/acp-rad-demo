/**
 * Section labels — the one place the report's grammar is spelled (design 06).
 *
 * The editor *writes* one canonical form (`**IMPRESSION:**`) and *reads* many: a report pasted
 * from Word, the RIS or a colleague carries `**IMPRESSION**`, `**IMPRESSION**:` or `Impression:`,
 * and a radiologist recognizes all of them as the same heading. So does this module.
 *
 * Two rules keep tolerance from becoming gullibility:
 *   - **anchored** — a label only ever opens a line, which is what keeps the partition
 *     line-indexed (design 06 §5) and stops prose from being read as structure;
 *   - **terminated** — after the keyword the line must hold a colon or end. Without it,
 *     `Findings are consistent with pneumonia.` would open a section.
 *
 * The vocabulary is data (`SectionProfile`), not code: another institution supplies its own.
 */
import { canonicalLines } from "./markdown.ts";
import type { SectionId } from "./schema.ts";

/** One section's keyword vocabulary. Patterns are regex source, matched case-insensitively. */
export type LabelRule = { readonly id: SectionId; readonly patterns: readonly string[] };

/**
 * The configurable unit: which keywords open which section, and which lines close the last one.
 * `footer` lines (a RIS trailer) end the section in progress and open nothing.
 */
export type SectionProfile = {
  readonly labels: readonly LabelRule[];
  readonly footer: readonly string[];
};

/** The house vocabulary — ported from `radreportparser`'s `KeyWord` (design 06 §4). */
export const HOUSE_PROFILE: SectionProfile = {
  labels: [
    { id: "history", patterns: ["clinical\\s+histor(?:y|ies)", "clinical\\s+indications?", "histor(?:y|ies)", "indications?"] },
    { id: "technique", patterns: ["techniques?"] },
    { id: "comparison", patterns: ["comparisons?"] },
    { id: "findings", patterns: ["findings?"] },
    { id: "impression", patterns: ["impressions?"] },
  ],
  footer: ["report\\s+severity", "finalized\\s+datetime", "preliminary\\s+datetime"],
};

/** How the editor writes each label when it creates a section (`normalizeLabels` keeps the author's word). */
const CANONICAL_KEYWORD: Record<SectionId, string> = {
  history: "HISTORY",
  technique: "TECHNIQUES",
  comparison: "COMPARISON",
  findings: "FINDINGS",
  impression: "IMPRESSION",
};

/** The canonical label line for a section: `**IMPRESSION:**`. */
export function canonicalLabel(id: SectionId): string {
  return `**${CANONICAL_KEYWORD[id]}:**`;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * `^<decoration> <keyword> <terminator lookahead> <decoration>`, with the keyword captured.
 *
 * The lookahead decides *whether* this is a label; the trailing class then consumes the wrapper
 * (`:`, `*`, spaces) so `slice(m[0].length)` is exactly the text after the label. The trailing
 * class is deliberately narrower than the leading one: a line may open with `- `, but a dash
 * after the colon is report text, not decoration.
 */
function labelRegExp(patterns: readonly string[]): RegExp {
  // Longest alternative first: `clinical history` must win over `history`.
  const alts = [...patterns].sort((a, b) => b.length - a.length).join("|");
  return new RegExp(`^[^\\w\\n]*(${alts})\\b(?=[*\\s]*(?::|$))[*:\\s]*`, "i");
}

type Compiled = {
  readonly rules: readonly { readonly id: SectionId; readonly re: RegExp }[];
  readonly footer: RegExp | null;
};

const HOUSE_COMPILED = compile(HOUSE_PROFILE);
/** `sectionIdOfLine` runs per line on every keystroke (`overlay.ts`); never recompile in the loop. */
const compiled = new WeakMap<SectionProfile, Compiled>([[HOUSE_PROFILE, HOUSE_COMPILED]]);

function compile(profile: SectionProfile): Compiled {
  return {
    rules: profile.labels.map((rule) => ({ id: rule.id, re: labelRegExp(rule.patterns) })),
    footer: profile.footer.length > 0 ? labelRegExp(profile.footer) : null,
  };
}

function compiledFor(profile: SectionProfile): Compiled {
  const hit = compiled.get(profile);
  if (hit) return hit;
  const made = compile(profile);
  compiled.set(profile, made);
  return made;
}

/** The label span at the head of `line` — the matched text and the section it opens. */
export type LabelMatch = { id: SectionId; keyword: string; length: number };

/** Recognize a section label; `undefined` ⇒ this line is body text. Rules are tried in order. */
export function matchLabel(line: string, profile: SectionProfile = HOUSE_PROFILE): LabelMatch | undefined {
  for (const rule of compiledFor(profile).rules) {
    const m = rule.re.exec(line);
    if (m) return { id: rule.id, keyword: m[1]!, length: m[0].length };
  }
  return undefined;
}

/** The section a line opens, or `undefined`. The one seam every consumer goes through. */
export function sectionIdOfLine(line: string, profile: SectionProfile = HOUSE_PROFILE): SectionId | undefined {
  return matchLabel(line, profile)?.id;
}

/** A report trailer (`Report Severity: …`): closes the section in progress, opens nothing. */
export function isFooterLine(line: string, profile: SectionProfile = HOUSE_PROFILE): boolean {
  const re = compiledFor(profile).footer;
  return re !== null && re.test(line);
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite every recognized section label to the canonical wrapper, keeping the keyword the author
 * wrote (upper-cased): the house uses both `**TECHNIQUE:**` and `**TECHNIQUES:**` and neither is
 * wrong. Body text is never touched. Used by `/normalize`, which proposes the result through the
 * human gate — this function never runs on paste.
 */
export function normalizeLabels(markdown: string, profile: SectionProfile = HOUSE_PROFILE): string {
  const out = canonicalLines(markdown).map((line) => {
    const m = matchLabel(line, profile);
    if (!m) return line;
    const rest = line.slice(m.length).trim();
    const label = `**${m.keyword.toUpperCase().replace(/\s+/g, " ")}:**`;
    return rest === "" ? label : `${label} ${rest}`;
  });
  return out.length === 0 ? "\n" : `${out.join("\n")}\n`;
}
