/**
 * Section partition of a report (design 06).
 *
 * A line `labels.ts` recognizes as a section label starts that section; it runs to the line before
 * the next label, or before a footer line, whichever comes first. Lines before the first label are
 * the title (read-only). The header block (contrast, complication, dose, phases) therefore belongs
 * to `technique`. Absent section ⇒ absent range (the store decides what that means on the wire).
 *
 * Recognition is tolerant and configurable; what the editor *writes* stays canonical. Both halves
 * live in `labels.ts` — this module only walks lines.
 */
import { isFooterLine, sectionIdOfLine, type SectionProfile } from "./labels.ts";
import { canonicalLines } from "./markdown.ts";
import type { SectionId } from "./schema.ts";

export type SectionRange = { id: SectionId; start: number; end: number }; // [start, end) line indexes

export type SplitReport = {
  title: string;
  sections: Partial<Record<SectionId, string>>;
  ranges: SectionRange[];
  lines: string[];
};

export function splitSections(markdown: string, profile?: SectionProfile): SplitReport {
  const lines = canonicalLines(markdown);
  const ranges: SectionRange[] = [];
  let current: SectionRange | undefined;
  let titleEnd = lines.length;
  lines.forEach((line, i) => {
    // A footer closes the section in progress and opens nothing (design 06 §4).
    if (current && isFooterLine(line, profile)) {
      current.end = i;
      current = undefined;
      return;
    }
    const id = sectionIdOfLine(line, profile);
    if (!id) return;
    if (current) current.end = i;
    else if (ranges.length === 0) titleEnd = i;
    current = { id, start: i, end: lines.length };
    ranges.push(current);
  });
  const sections: Partial<Record<SectionId, string>> = {};
  for (const r of ranges) sections[r.id] = joinTrimmed(lines.slice(r.start, r.end));
  return { title: joinTrimmed(lines.slice(0, titleEnd)), sections, ranges, lines };
}

/** The section's canonical file content, or `undefined` if the section is absent. */
export function sectionFile(markdown: string, id: SectionId, profile?: SectionProfile): string | undefined {
  return splitSections(markdown, profile).sections[id];
}

function joinTrimmed(lines: string[]): string {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop();
  return copy.length === 0 ? "" : `${copy.join("\n")}\n`;
}
