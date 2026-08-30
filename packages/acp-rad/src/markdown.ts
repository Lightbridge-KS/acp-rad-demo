/**
 * Canonical Markdown ⇄ Quill Delta for the house report grammar (design §5.5).
 *
 * One Quill line ⇄ one Markdown line. Blocks: paragraph · `- ` bullet · `1. ` ordered ·
 * empty line. Inline: `**bold**`, `_italic_`. Everything else is dropped.
 *
 * Determinism is the contract: `deltaToMarkdown(markdownToDelta(md))` is a fixed point after
 * one pass, and `markdownToDelta` of canonical text is stable. The converter works on plain
 * `Op[]` so Quill's own Delta instance and this package's never need to be the same class.
 */
import type { AttributeMap, Op } from "quill-delta";

export type InlineAttrs = { bold?: true; italic?: true };

// ---------------------------------------------------------------------------
// Delta → Markdown
// ---------------------------------------------------------------------------

export function deltaToMarkdown(ops: Op[]): string {
  const lines: string[] = [];
  let ordinal = 0;
  for (const { runs, attrs } of eachLine(ops)) {
    const text = inlineToMarkdown(runs);
    const list = attrs.list;
    if (list === "ordered") {
      ordinal += 1;
      lines.push(`${ordinal}. ${text}`);
    } else {
      ordinal = 0;
      lines.push(list === "bullet" ? `- ${text}` : text);
    }
  }
  return normalizeLines(lines);
}

/**
 * Same contract as `Delta.eachLine`: yields each line's inline ops plus the block attributes
 * carried by its terminating `\n` op. Embeds are skipped (outside the grammar). Implemented
 * over plain ops so the package needs no runtime Delta class.
 */
export function* eachLine(ops: Op[]): Generator<{ runs: Op[]; attrs: AttributeMap }> {
  let runs: Op[] = [];
  for (const op of ops) {
    if (typeof op.insert !== "string") continue;
    const parts = op.insert.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part) runs.push(op.attributes ? { insert: part, attributes: op.attributes } : { insert: part });
      if (i < parts.length - 1) {
        yield { runs, attrs: op.attributes ?? {} };
        runs = [];
      }
    }
  }
  if (runs.length > 0) yield { runs, attrs: {} };
}

/** Serialize inline runs; markers never touch whitespace (so they always re-parse). */
export function inlineToMarkdown(ops: Op[]): string {
  let out = "";
  for (const op of ops) {
    if (typeof op.insert !== "string") continue; // embeds are not part of the grammar
    const bold = op.attributes?.bold === true;
    const italic = op.attributes?.italic === true;
    if (!bold && !italic) {
      out += op.insert;
      continue;
    }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(op.insert);
    const lead = m?.[1] ?? "";
    const core = m?.[2] ?? "";
    const trail = m?.[3] ?? "";
    if (core === "") {
      out += op.insert;
      continue;
    }
    const open = (bold ? "**" : "") + (italic ? "_" : "");
    const close = (italic ? "_" : "") + (bold ? "**" : "");
    out += `${lead}${open}${core}${close}${trail}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown → Delta
// ---------------------------------------------------------------------------

export function markdownToDelta(markdown: string): Op[] {
  const ops: Op[] = [];
  for (const raw of canonicalLines(markdown)) {
    let text = raw;
    let block: AttributeMap | undefined;
    if (text.startsWith("- ")) {
      block = { list: "bullet" };
      text = text.slice(2);
    } else {
      const ordered = /^\d+\. /.exec(text);
      if (ordered) {
        block = { list: "ordered" };
        text = text.slice(ordered[0].length);
      }
    }
    for (const run of parseInline(text)) pushInsert(ops, run.text, run.attrs);
    pushInsert(ops, "\n", block);
  }
  if (ops.length === 0) ops.push({ insert: "\n" });
  return ops;
}

/** Append a text insert, merging into the previous op when attributes match (as `Delta.insert` does). */
function pushInsert(ops: Op[], text: string, attributes?: AttributeMap): void {
  if (!text) return;
  const attrs = attributes && Object.keys(attributes).length > 0 ? attributes : undefined;
  const last = ops[ops.length - 1];
  if (last && typeof last.insert === "string" && sameAttributeMap(last.attributes, attrs)) {
    last.insert += text;
    return;
  }
  ops.push(attrs ? { insert: text, attributes: attrs } : { insert: text });
}

function sameAttributeMap(a?: AttributeMap, b?: AttributeMap): boolean {
  const ka = a ? Object.keys(a).sort() : [];
  const kb = b ? Object.keys(b).sort() : [];
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a![k] === b![k]);
}

/** `deltaToMarkdown(markdownToDelta(md))` — the normal form. */
export function canonicalize(markdown: string): string {
  return deltaToMarkdown(markdownToDelta(markdown));
}

type Run = { text: string; attrs?: InlineAttrs };

/**
 * Tokenize one line into runs. `**` opens bold only before a non-space and closes only after
 * a non-space, so `** This is a PRELIMINARY…` stays literal. `_` is a marker only at a word
 * boundary and never next to another `_` (so `___` blanks and `E_V_M_` stay literal). An
 * opener that is never closed is unwound back to literal text (`**oops`, `__, _ml.`).
 */
export function parseInline(line: string): Run[] {
  const runs: Run[] = [];
  let bold = false;
  let italic = false;
  let boldOpenAt = -1; // runs.length when the marker was consumed
  let italicOpenAt = -1;
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const attrs: InlineAttrs = {};
    if (bold) attrs.bold = true;
    if (italic) attrs.italic = true;
    runs.push(bold || italic ? { text: buf, attrs } : { text: buf });
    buf = "";
  };
  const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
  const isWordish = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const prev = line[i - 1];
    if (c === "*" && line[i + 1] === "*") {
      const next = line[i + 2];
      if (!bold && !isSpace(next) && next !== "*") {
        flush();
        bold = true;
        boldOpenAt = runs.length;
        i += 1;
        continue;
      }
      if (bold && !isSpace(prev)) {
        flush();
        bold = false;
        i += 1;
        continue;
      }
    }
    if (c === "_" && prev !== "_" && line[i + 1] !== "_") {
      const next = line[i + 1];
      if (!italic && !isWordish(prev) && !isSpace(next)) {
        flush();
        italic = true;
        italicOpenAt = runs.length;
        continue;
      }
      if (italic && !isSpace(prev) && !isWordish(next)) {
        flush();
        italic = false;
        continue;
      }
    }
    buf += c;
  }
  flush();
  if (bold) unwind(runs, boldOpenAt, "bold", "**");
  if (italic) unwind(runs, italicOpenAt, "italic", "_");
  return mergeRuns(runs);
}

/** Drop an unmatched opener's formatting from the runs after it and restore the marker text. */
function unwind(runs: Run[], openAt: number, key: keyof InlineAttrs, marker: string): void {
  for (let i = openAt; i < runs.length; i++) {
    const r = runs[i]!;
    if (!r.attrs) continue;
    const { [key]: _dropped, ...rest } = r.attrs;
    runs[i] = Object.keys(rest).length ? { text: r.text, attrs: rest } : { text: r.text };
  }
  runs.splice(openAt, 0, { text: marker });
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameAttrs(last.attrs, r.attrs)) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

function sameAttrs(a?: InlineAttrs, b?: InlineAttrs): boolean {
  return (a?.bold ?? false) === (b?.bold ?? false) && (a?.italic ?? false) === (b?.italic ?? false);
}

// ---------------------------------------------------------------------------
// Normalization shared by both directions
// ---------------------------------------------------------------------------

/** Split into lines: CRLF→LF, trailing whitespace stripped, blank runs collapsed, no leading/trailing blanks. */
export function canonicalLines(text: string): string[] {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  return normalizeLineArray(raw.map((l) => l.replace(/\s+$/, "")));
}

function normalizeLines(lines: string[]): string {
  const out = normalizeLineArray(lines.map((l) => l.replace(/\s+$/, "")));
  return out.length === 0 ? "\n" : `${out.join("\n")}\n`;
}

function normalizeLineArray(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(l);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}
