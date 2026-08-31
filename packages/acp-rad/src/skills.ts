/**
 * Skill mentions — the profile's half of how a radiologist invokes a skill.
 *
 * A mention is `/name` written anywhere in an ordinary sentence ("please run /qa on this"),
 * not a command that consumes the whole prompt. The Client detects them and sends each one as
 * an ACP `resource_link` beside the text; the Agent resolves the link before the model runs.
 *
 * Two rules make the detection safe to run over prose:
 *  - the `/` must open the string or follow whitespace, so `dd/mm/yyyy` and `2/5` never match;
 *  - only names the Agent actually advertised count, so `/etc/passwd` is text, not an invocation.
 */

/** Where the Agent serves the composed skill (base + institution + individual, folded). */
export const EFFECTIVE_SKILL_ROOT = "/skills/effective/";

export function effectiveSkillPath(name: string): string {
  return `${EFFECTIVE_SKILL_ROOT}${name}/SKILL.md`;
}

const MENTION_RE = /(^|\s)\/([a-z][a-z-]*)/g;

/** Skill names mentioned in `text`, in order of appearance, deduplicated. */
export function mentionedSkills(text: string, names: readonly string[]): string[] {
  const known = new Set(names);
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const name = m[2]!;
    if (known.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
