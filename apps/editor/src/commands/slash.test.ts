import { describe, expect, it } from "vitest";
import { menuKey } from "./CommandMenu.tsx";
import type { CommandGroups } from "./registry.ts";
import { caretAfter, groupsForQuery, insertedSlashAt, slashAt, transformRange, type SlashQuill } from "./SlashMenu.tsx";

/** A one-document fake: `text` is the whole editor; the caret is passed to `slashAt` explicitly. */
function fakeQuill(text: string): SlashQuill {
  return {
    getLine: (index) => {
      const lineStart = text.lastIndexOf("\n", index - 1) + 1;
      return [null, index - lineStart];
    },
    getText: (index, len) => text.slice(index, index + len),
  };
}

describe("slashAt", () => {
  it("opens for / at a line start and reads the query up to the caret", () => {
    const t = "**T**\n/impr\n";
    expect(slashAt(fakeQuill(t), 6, { index: 11, length: 0 })).toEqual({ offset: 6, query: "impr" });
  });
  it("opens after whitespace, never inside a word (2/5, dd/mm)", () => {
    expect(slashAt(fakeQuill("grade 2/5\n"), 7, { index: 9, length: 0 })).toBeNull();
    expect(slashAt(fakeQuill("see /temp\n"), 4, { index: 9, length: 0 })).toEqual({ offset: 4, query: "temp" });
  });
  it("closes when the caret leaves the query, on a selection, or on another line", () => {
    const t = "/impr\nnext\n";
    expect(slashAt(fakeQuill(t), 0, { index: 0, length: 0 })).toBeNull(); // caret before the slash
    expect(slashAt(fakeQuill(t), 0, { index: 8, length: 0 })).toBeNull(); // another line
    expect(slashAt(fakeQuill(t), 0, { index: 5, length: 2 })).toBeNull(); // selection
    expect(slashAt(fakeQuill("x /a /b\n"), 2, { index: 7, length: 0 })).toBeNull(); // a later slash is not the armed one
  });
});

describe("transformRange", () => {
  it("moves the caret with inserts and deletes before it, leaves it on changes after it", () => {
    expect(transformRange({ index: 5, length: 0 }, [{ retain: 2 }, { insert: "ab" }])).toEqual({ index: 7, length: 0 });
    expect(transformRange({ index: 5, length: 0 }, [{ retain: 2 }, { delete: 2 }])).toEqual({ index: 3, length: 0 });
    expect(transformRange({ index: 5, length: 0 }, [{ retain: 8 }, { insert: "x" }])).toEqual({ index: 5, length: 0 });
    expect(transformRange(null, [{ insert: "x" }])).toBeNull();
  });
});

describe("caretAfter", () => {
  it("lands after the typed text or at the deletion", () => {
    expect(caretAfter([{ retain: 6 }, { insert: "/" }])).toEqual({ index: 7, length: 0 });
    expect(caretAfter([{ retain: 3 }, { delete: 2 }])).toEqual({ index: 3, length: 0 });
    expect(caretAfter([{ retain: 3 }, { retain: 1, attributes: { bold: true } }])).toBeNull();
  });
});

describe("insertedSlashAt", () => {
  it("finds the typed slash from the change delta", () => {
    expect(insertedSlashAt([{ retain: 6 }, { insert: "/" }])).toBe(6);
    expect(insertedSlashAt([{ insert: "/" }])).toBe(0);
    expect(insertedSlashAt([{ retain: 3 }, { insert: "ab" }])).toBe(-1);
    expect(insertedSlashAt([{ retain: 3 }, { delete: 1 }])).toBe(-1);
  });
});

describe("groupsForQuery", () => {
  const all: CommandGroups = {
    suggested: [],
    editor: [
      { id: "template", kind: "document", description: "Scaffold" },
      { id: "short-prelim", kind: "document", description: "Short prelim" },
    ],
    skills: [{ id: "compare", kind: "skill", description: "Compare" }],
  };
  it("filters on a bare name and narrows to the exact command once an argument follows", () => {
    expect(groupsForQuery(all, "te").groups.suggested.map((c) => c.id)).toEqual(["template"]);
    expect(groupsForQuery(all, "template cxr-pa")).toEqual({ groups: { suggested: [], editor: [all.editor[0]], skills: [] }, arg: "cxr-pa" });
    expect(groupsForQuery(all, "compare ACC1").groups.skills).toHaveLength(1);
    expect(groupsForQuery(all, "nope arg").groups).toEqual({ suggested: [], editor: [], skills: [] });
  });
});

describe("menuKey", () => {
  it("wraps, selects, closes, ignores the rest", () => {
    expect(menuKey("ArrowDown", 2, 3)).toEqual({ type: "move", index: 0 });
    expect(menuKey("ArrowUp", 0, 3)).toEqual({ type: "move", index: 2 });
    expect(menuKey("Enter", 1, 3)).toEqual({ type: "select", index: 1 });
    expect(menuKey("Tab", 1, 3)).toEqual({ type: "select", index: 1 });
    expect(menuKey("Enter", 0, 0)).toEqual({ type: "close" });
    expect(menuKey("Escape", 0, 3)).toEqual({ type: "close" });
    expect(menuKey("a", 0, 3)).toBeNull();
  });
});
