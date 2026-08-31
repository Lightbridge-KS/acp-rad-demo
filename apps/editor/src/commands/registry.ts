/**
 * The command registry — one list behind three surfaces (`Commands ▾`, the in-report `/`
 * menu, the composer `/`), grouped Suggested · Editor · Skills (design 02 §2.2).
 *
 * Editor commands are known here; skills come from the agent's `available_commands_update`.
 * `runEditorCommand` is pure: it turns a command into an *effect* over canonical Markdown that
 * `apply.ts` performs on the live Quill buffer. Nothing in this file touches Quill or React.
 */
import { normalizeLabels, type ProfileLevel, type ReportStatus, type SectionId } from "acp-rad";
import { foldInShortPrelim, instantiateTemplate, isBlankBuffer, regionSnippetId, shortPrelimDocument, templateIdFor } from "./document.ts";
import type { CaseMeta } from "./meta.ts";
import { placeSnippet } from "./snippet.ts";

export type CommandKind = "document" | "snippet" | "skill";

export type Command = {
  /** The name after the slash: `template`, `er-reviewed`, `impression` … */
  id: string;
  kind: CommandKind;
  description: string;
  /** Argument hint shown in the menu, e.g. `[template id]`. */
  hint?: string;
};

/** A skill as the sidebar store holds it (from `available_commands_update`). */
export type SkillCommand = { name: string; description: string; hint?: string };

export const EDITOR_COMMANDS: readonly Command[] = [
  { id: "template", kind: "document", description: "Scaffold the house template for this study", hint: "[template id]" },
  { id: "short-prelim", kind: "document", description: "Issue a short prelim — the region's paragraph as the whole report", hint: "[brain | chest | body]" },
  { id: "er-reviewed", kind: "snippet", description: "Attending has reviewed this preliminary report (impression head)" },
  { id: "er-not-reviewed", kind: "snippet", description: "Not yet reviewed by the attending (impression head)" },
  { id: "discuss-with-dr", kind: "snippet", description: "Record who the findings were discussed with (report end)" },
  { id: "normalize", kind: "document", description: "Format section labels to house grammar" },
];

export type CommandContext = {
  blank: boolean;
  shortPrelim: boolean;
  caretSection: SectionId | null;
  /** The caret sits on the report's last line. */
  caretAtEnd: boolean;
  hasPriors: boolean;
  /** The buffer holds a section label that is not in house grammar (a pasted report). */
  foreignLabels: boolean;
  /** Agent level; `undefined` while disconnected. Level 0 skills are the host user's — hidden. */
  level: ProfileLevel | undefined;
  skills: readonly SkillCommand[];
  /** A `final` report takes no editor command (the buffer is locked); skills stay — `/qa` is legitimate. */
  status: ReportStatus;
};

export type CommandGroups = { suggested: Command[]; editor: Command[]; skills: Command[] };

export const GROUP_LABEL: Record<keyof CommandGroups, string> = { suggested: "Suggested", editor: "Editor", skills: "Skills" };

export function listCommands(ctx: CommandContext): CommandGroups {
  // `suggested` draws from `all`, so an empty editor list also keeps editor commands out of it.
  const editor = ctx.status === "final" ? [] : [...EDITOR_COMMANDS];
  const skills: Command[] = ctx.level === 0 ? [] : ctx.skills.map((s) => ({ id: s.name, kind: "skill", description: s.description, ...(s.hint ? { hint: s.hint } : {}) }));
  const all = [...editor, ...skills];
  const byId = (id: string) => all.find((c) => c.id === id);
  const suggested: Command[] = [];
  const suggest = (id: string) => {
    const c = byId(id);
    if (c && !suggested.includes(c)) suggested.push(c);
  };
  if (ctx.blank || ctx.shortPrelim) suggest("template");
  if (ctx.blank) suggest("short-prelim");
  if (ctx.caretSection === "impression") {
    suggest("impression");
    suggest("er-reviewed");
  }
  if (ctx.caretSection === "comparison" || ctx.hasPriors) suggest("compare");
  if (ctx.caretAtEnd && !ctx.blank) suggest("discuss-with-dr");
  if (ctx.foreignLabels) suggest("normalize");
  return { suggested, editor, skills };
}

/**
 * How well a command answers a typed query: 0 exact id · 1 id prefix · 2 id substring ·
 * 3 description; −1 no match. The id always outranks the description, so `/impression`
 * is never beaten by a snippet whose description mentions the impression head.
 */
export function matchScore(c: Command, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 3;
  const id = c.id.toLowerCase();
  if (id === q) return 0;
  if (id.startsWith(q)) return 1;
  if (id.includes(q)) return 2;
  if (c.description.toLowerCase().includes(q)) return 3;
  return -1;
}

/**
 * Filter by a typed query. An empty query keeps the groups; a query collapses them into one
 * ranked list (in `suggested`, shown as *Matches*), deduplicated, best match first — so Enter
 * always takes the best match, whatever group it came from.
 */
export function filterCommands(groups: CommandGroups, query: string): CommandGroups {
  const q = query.trim();
  if (!q) return groups;
  const seen = new Set<string>();
  const ranked = flattenCommands(groups)
    .map((c, order) => ({ c, score: matchScore(c, q), order }))
    .filter(({ c, score }) => score >= 0 && !seen.has(c.id) && seen.add(c.id))
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map(({ c }) => c);
  return { suggested: ranked, editor: [], skills: [] };
}

/** Keyboard order: Suggested, then Editor, then Skills. */
export function flattenCommands(groups: CommandGroups): Command[] {
  return [...groups.suggested, ...groups.editor, ...groups.skills];
}

/** `/template cxr-pa` → `{ name: "template", arg: "cxr-pa" }`; the slash is optional. */
export function parseInvocation(text: string): { name: string; arg: string | undefined } {
  const m = /^\/?\s*([^\s]*)\s*(.*)$/s.exec(text.trim()) ?? [];
  const name = (m[1] ?? "").toLowerCase();
  const arg = (m[2] ?? "").trim();
  return { name, arg: arg ? arg : undefined };
}

// ---------------------------------------------------------------------------
// Editor commands → effects
// ---------------------------------------------------------------------------

export type CommandEffect =
  /** The whole buffer becomes `markdown` (instant when blank, tracked changes otherwise). */
  | { kind: "replace"; markdown: string; shortPrelim: boolean; folded?: boolean }
  /** A new line (canonical Markdown) inserted before canonical line `line`; `line === lineCount` appends. */
  | { kind: "insert-line"; line: number; markdown: string; blankBefore: boolean }
  /** Canonical line `line` becomes `markdown`. */
  | { kind: "replace-line"; line: number; markdown: string }
  /** Put the caret on canonical line `line` (its first blank when it has one). */
  | { kind: "caret"; line: number }
  /** Nothing to do; tell the radiologist why. */
  | { kind: "hint"; text: string };

export type EditorCommandInput = {
  /** The live buffer, overlays stripped, canonical. */
  markdown: string;
  meta: CaseMeta;
  region: string | undefined;
  shortPrelim: boolean;
  templates: Record<string, string>;
  snippets: Record<string, string>;
};

/** Compute what an editor command does to this buffer. Pure. */
export function runEditorCommand(id: string, arg: string | undefined, input: EditorCommandInput): CommandEffect {
  switch (id) {
    case "template": {
      const templateId = templateIdFor(input.meta, arg);
      const template = templateId ? input.templates[templateId] : undefined;
      if (!templateId || !template) return { kind: "hint", text: templateId ? `no template "${templateId}"` : "this study names no template — say which: /template <id>" };
      const skeleton = instantiateTemplate(template, input.meta);
      if (input.shortPrelim && !isBlankBuffer(input.markdown)) {
        return { kind: "replace", markdown: foldInShortPrelim(skeleton, input.markdown), shortPrelim: false, folded: true };
      }
      return { kind: "replace", markdown: skeleton, shortPrelim: false };
    }
    case "normalize": {
      // Never on paste, never silent: the rewrite is proposed as tracked changes like any other
      // change, which demonstrates the human gate rather than bypassing it (design 06 §2).
      const normalized = normalizeLabels(input.markdown);
      if (normalized === input.markdown) return { kind: "hint", text: "every section label is already in house grammar" };
      return { kind: "replace", markdown: normalized, shortPrelim: input.shortPrelim };
    }
    case "short-prelim": {
      const snippetId = regionSnippetId(arg ?? input.region);
      const snippet = input.snippets[snippetId];
      if (!snippet) return { kind: "hint", text: `no short-prelim snippet "${snippetId}"` };
      return { kind: "replace", markdown: shortPrelimDocument(snippet), shortPrelim: true };
    }
    case "er-reviewed":
    case "er-not-reviewed": {
      const snippet = input.snippets[id];
      if (!snippet) return { kind: "hint", text: `no snippet "${id}"` };
      const p = placeSnippet(input.markdown, snippet, "impression-head");
      if (p.line < 0) return { kind: "hint", text: "no IMPRESSION section to mark — scaffold the report first" };
      if (p.op === "none") return { kind: "caret", line: p.line };
      return p.op === "replace" ? { kind: "replace-line", line: p.line, markdown: snippet } : { kind: "insert-line", line: p.line, markdown: snippet, blankBefore: false };
    }
    case "discuss-with-dr": {
      const snippet = input.snippets[id];
      if (!snippet) return { kind: "hint", text: `no snippet "${id}"` };
      const p = placeSnippet(input.markdown, snippet, "report-end");
      if (p.op === "none") return { kind: "caret", line: p.line };
      return { kind: "insert-line", line: p.line, markdown: snippet, blankBefore: !isBlankBuffer(input.markdown) };
    }
    default:
      return { kind: "hint", text: `unknown command /${id}` };
  }
}
