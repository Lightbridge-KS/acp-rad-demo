/**
 * The shell: which case is open (the worklist) and who is working (the role). Everything
 * about the open case lives in `Workspace`, remounted per case (`key={fixture.id}`) so a
 * switch starts clean — nothing is persisted across cases in v0.1 (data doc §8). A switch
 * that would discard work asks first, inline (never `window.confirm`: it blocks the page).
 */
import { useCallback, useRef, useState } from "react";
import { cases, defaultCase, personas, type CaseFixture } from "./fixtures/index.ts";
import type { Role } from "./report/lifecycle.ts";
import { Workspace, type Dirty, type WorkspaceHandle } from "./Workspace.tsx";

/** `?case=<id>` opens a case directly (deep link); the worklist keeps it in sync. */
function caseFromUrl(): CaseFixture {
  const id = new URLSearchParams(window.location.search).get("case");
  return cases.find((c) => c.id === id) ?? defaultCase;
}

/** `?radiologist=<persona>` picks whose personal skill layer is mounted (stands in for Settings). */
function personaFromUrl(): string | undefined {
  const id = new URLSearchParams(window.location.search).get("radiologist");
  return id && personas.includes(id) ? id : personas[0];
}

function syncUrl(params: Record<string, string>): void {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  window.history.replaceState(null, "", url);
}

const ROLES: Role[] = ["resident", "attending"];

/**
 * What a switch opens. Both kinds restart the session: the namespace **manifest is sent once**
 * at `session/new` and never refreshed, so a personal layer swapped underneath a live session
 * would leave the agent holding a listing that lies (design 06 §6).
 */
type Target = { kind: "case"; value: CaseFixture } | { kind: "persona"; value: string };

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
  const [persona, setPersona] = useState<string | undefined>(personaFromUrl);
  const [role, setRole] = useState<Role>("attending");
  const [pendingSwitch, setPendingSwitch] = useState<{ target: Target; losing: string[] } | null>(null);
  const workspace = useRef<WorkspaceHandle>(null);

  const open = useCallback((target: Target) => {
    void workspace.current?.cancel();
    setPendingSwitch(null);
    if (target.kind === "case") {
      setFixture(target.value);
      syncUrl({ case: target.value.id });
    } else {
      setPersona(target.value);
      syncUrl({ radiologist: target.value });
    }
  }, []);

  const requestSwitch = useCallback(
    (target: Target) => {
      const losing = describeDirty(workspace.current?.dirty() ?? { pending: 0, unreviewed: 0, running: false, flags: 0 });
      if (losing.length === 0) open(target);
      else setPendingSwitch({ target, losing });
    },
    [open],
  );

  const requestCase = useCallback(
    (id: string) => {
      const next = cases.find((c) => c.id === id);
      if (next && next.id !== fixture.id) requestSwitch({ kind: "case", value: next });
    },
    [fixture.id, requestSwitch],
  );

  const headerStart = (
    <>
      <select data-testid="worklist" className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs" value={fixture.id} onChange={(e) => requestCase(e.target.value)}>
        {cases.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title} · {c.session.accession}
          </option>
        ))}
      </select>
      {personas.length > 1 && (
        <select
          data-testid="radiologist"
          title="Whose personal skill layer is loaded"
          className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs"
          value={persona ?? ""}
          onChange={(e) => requestSwitch({ kind: "persona", value: e.target.value })}
        >
          {personas.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      )}
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
        Open{" "}
        <span className="font-medium">
          {pendingSwitch.target.kind === "case" ? pendingSwitch.target.value.title : `${pendingSwitch.target.value}'s skills`}
        </span>
        ? This discards {pendingSwitch.losing.join(", ")} — nothing is kept across cases.
      </span>
      <button type="button" data-testid="switch-go" className="ml-auto rounded bg-amber-600 px-2 py-0.5 text-xs text-white" onClick={() => open(pendingSwitch.target)}>
        Switch
      </button>
      <button type="button" data-testid="switch-stay" className="rounded border border-gray-300 px-2 py-0.5 text-xs" onClick={() => setPendingSwitch(null)}>
        Stay
      </button>
    </div>
  );

  // The key carries the persona too: a new personal layer means a new manifest, so a new session.
  return <Workspace key={`${fixture.id}:${persona ?? ""}`} ref={workspace} fixture={fixture} role={role} persona={persona} headerStart={headerStart} banner={banner} />;
}
