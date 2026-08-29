/**
 * Section partition of a canonical report (design §5.5).
 *
 * A line matching `**HISTORY:**` / `**TECHNIQUE(S):**` / `**COMPARISON:**` / `**FINDINGS:**` /
 * `**IMPRESSION:**` starts that section; it runs to the line before the next label. Lines before
 * the first label are the title (read-only). The header block (contrast, complication, dose,
 * phases) therefore belongs to `technique`. Absent section ⇒ absent file.
 */
import { canonicalLines } from "./markdown.ts";
import type { SectionId } from "./schema.ts";

export const SECTION_LABEL_RE = /^\*\*(HISTORY|TECHNIQUES?|COMPARISON|FINDINGS|IMPRESSION):\*\*/;

const LABEL_TO_ID: Record<string, SectionId> = {
  HISTORY: "history",
  TECHNIQUE: "technique",
  TECHNIQUES: "technique",
  COMPARISON: "comparison",
  FINDINGS: "findings",
  IMPRESSION: "impression",
};

export type SectionRange = { id: SectionId; start: number; end: number }; // [start, end) line indexes

export type SplitReport = {
  title: string;
  sections: Partial<Record<SectionId, string>>;
  ranges: SectionRange[];
  lines: string[];
};

export function sectionIdOfLine(line: string): SectionId | undefined {
  const m = SECTION_LABEL_RE.exec(line);
  return m ? LABEL_TO_ID[m[1]!] : undefined;
}

export function splitSections(markdown: string): SplitReport {
  const lines = canonicalLines(markdown);
  const ranges: SectionRange[] = [];
  let current: SectionRange | undefined;
  let titleEnd = lines.length;
  lines.forEach((line, i) => {
    const id = sectionIdOfLine(line);
    if (!id) return;
    if (current) current.end = i;
    else titleEnd = i;
    current = { id, start: i, end: lines.length };
    ranges.push(current);
  });
  const sections: Partial<Record<SectionId, string>> = {};
  for (const r of ranges) sections[r.id] = joinTrimmed(lines.slice(r.start, r.end));
  return { title: joinTrimmed(lines.slice(0, titleEnd)), sections, ranges, lines };
}

/** The section's canonical file content, or `undefined` if the section is absent. */
export function sectionFile(markdown: string, id: SectionId): string | undefined {
  return splitSections(markdown).sections[id];
}

function joinTrimmed(lines: string[]): string {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop();
  return copy.length === 0 ? "" : `${copy.join("\n")}\n`;
}
