/**
 * The command list shared by `Commands ▾` and the in-report `/` menu: groups with headers,
 * one highlighted row, mouse or keyboard. Keyboard state lives in the pure `menuKey` reducer so
 * both surfaces behave identically and can be unit-tested without a DOM.
 */
import type { MouseEvent } from "react";
import { GROUP_LABEL, flattenCommands, type Command, type CommandGroups } from "./registry.ts";

export type MenuAction = { type: "move"; index: number } | { type: "select"; index: number } | { type: "close" } | null;

/** ↑↓ wrap, Enter/Tab select, Escape closes; anything else is not ours. */
export function menuKey(key: string, index: number, count: number): MenuAction {
  switch (key) {
    case "ArrowDown":
      return { type: "move", index: count === 0 ? 0 : (index + 1) % count };
    case "ArrowUp":
      return { type: "move", index: count === 0 ? 0 : (index - 1 + count) % count };
    case "Enter":
    case "Tab":
      return count === 0 ? { type: "close" } : { type: "select", index };
    case "Escape":
      return { type: "close" };
    default:
      return null;
  }
}

type Props = {
  groups: CommandGroups;
  /** The typed query, if any: the single ranked group is then labelled *Matches*. */
  query?: string;
  highlighted: number;
  onHighlight: (index: number) => void;
  onSelect: (command: Command) => void;
  /** Rendered when every group is empty. */
  empty?: string;
};

export function CommandMenu({ groups, query, highlighted, onHighlight, onSelect, empty = "no matching command" }: Props) {
  const flat = flattenCommands(groups);
  if (flat.length === 0) return <div className="px-3 py-2 text-xs text-gray-400">{empty}</div>;
  let offset = 0;
  const keepFocus = (e: MouseEvent) => e.preventDefault(); // never blur the editor or the composer
  return (
    <div role="listbox" data-testid="command-menu" className="max-h-72 overflow-y-auto py-1 text-sm">
      {(Object.keys(GROUP_LABEL) as (keyof CommandGroups)[]).map((g) => {
        const items = groups[g];
        if (items.length === 0) return null;
        const start = offset;
        offset += items.length;
        return (
          <div key={g} data-group={g}>
            <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide text-gray-400 uppercase">{query?.trim() && g === "suggested" ? "Matches" : GROUP_LABEL[g]}</div>
            {items.map((c, i) => {
              const index = start + i;
              const active = index === highlighted;
              return (
                <button
                  key={`${g}:${c.id}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-highlighted={active ? "" : undefined}
                  data-command={c.id}
                  onMouseDown={keepFocus}
                  onMouseEnter={() => onHighlight(index)}
                  onClick={() => onSelect(c)}
                  className={`flex w-full items-baseline gap-2 px-3 py-1 text-left ${active ? "bg-sky-50" : "hover:bg-gray-50"}`}
                >
                  <span className="font-mono text-xs whitespace-nowrap">/{c.id}</span>
                  {c.hint && <span className="font-mono text-[10px] whitespace-nowrap text-gray-400">{c.hint}</span>}
                  <span className="ml-auto min-w-0 truncate text-xs text-gray-500">{c.description}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
