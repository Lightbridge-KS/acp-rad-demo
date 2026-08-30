/**
 * The shell: which case is open (the worklist) and who is working (the role). Everything
 * about the open case lives in `Workspace`, remounted per case (`key={fixture.id}`) so a
 * switch starts clean — nothing is persisted across cases in v0.1 (data doc §8). A switch
 * that would discard work asks first, inline (never `window.confirm`: it blocks the page).
 */
import { useCallback, useRef, useState } from "react";
import { cases, defaultCase, type CaseFixture } from "./fixtures/index.ts";
import type { Role } from "./report/lifecycle.ts";
import { Workspace, type Dirty, type WorkspaceHandle } from "./Workspace.tsx";

/** `?case=<id>` opens a case directly (deep link); the worklist keeps it in sync. */
function caseFromUrl(): CaseFixture {
  const id = new URLSearchParams(window.location.search).get("case");
  return cases.find((c) => c.id === id) ?? defaultCase;
}

function syncUrl(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("case", id);
  window.history.replaceState(null, "", url);
}

const ROLES: Role[] = ["resident", "attending"];

/** What the switch would throw away, in the header's own words; empty when nothing would be lost. */
export function describeDirty(d: Dirty): string[] {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (d.pending) parts.push(n(d.pending, "pending change", "pending changes"));
  if (d.unreviewed) parts.push(n(d.unreviewed, "unreviewed line", "unreviewed lines"));
  if (d.flags) parts.push(n(d.flags, "open flag", "open flags"));
  if (d.running) parts.push("the running turn");
  return parts;
}

export default function App() {
  const [fixture, setFixture] = useState<CaseFixture>(caseFromUrl);
  const [role, setRole] = useState<Role>("attending");
  const [pendingSwitch, setPendingSwitch] = useState<{ next: CaseFixture; losing: string[] } | null>(null);
  const workspace = useRef<WorkspaceHandle>(null);

  const open = useCallback((next: CaseFixture) => {
    void workspace.current?.cancel();
    setPendingSwitch(null);
    setFixture(next);
    syncUrl(next.id);
  }, []);

  const requestSwitch = useCallback(
    (id: string) => {
      const next = cases.find((c) => c.id === id);
      if (!next || next.id === fixture.id) return;
      const losing = describeDirty(workspace.current?.dirty() ?? { pending: 0, unreviewed: 0, running: false, flags: 0 });
      if (losing.length === 0) open(next);
      else setPendingSwitch({ next, losing });
    },
    [fixture.id, open],
  );

  const headerStart = (
    <>
      <select data-testid="worklist" className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs" value={fixture.id} onChange={(e) => requestSwitch(e.target.value)}>
        {cases.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title} · {c.session.accession}
          </option>
        ))}
      </select>
      <span data-testid="role" className="flex overflow-hidden rounded border border-gray-300 text-xs">
        {ROLES.map((r) => (
          <button key={r} type="button" data-active={r === role} className={`px-2 py-0.5 ${r === role ? "bg-gray-800 text-white" : "bg-white text-gray-600"}`} onClick={() => setRole(r)}>
            {r}
          </button>
        ))}
      </span>
    </>
  );

  const banner = pendingSwitch && (
    <div data-testid="switch-confirm" className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm">
      <span>
        Open <span className="font-medium">{pendingSwitch.next.title}</span>? This discards {pendingSwitch.losing.join(", ")} — nothing is kept across cases.
      </span>
      <button type="button" data-testid="switch-go" className="ml-auto rounded bg-amber-600 px-2 py-0.5 text-xs text-white" onClick={() => open(pendingSwitch.next)}>
        Switch
      </button>
      <button type="button" data-testid="switch-stay" className="rounded border border-gray-300 px-2 py-0.5 text-xs" onClick={() => setPendingSwitch(null)}>
        Stay
      </button>
    </div>
  );

  return <Workspace key={fixture.id} ref={workspace} fixture={fixture} role={role} headerStart={headerStart} banner={banner} />;
}
