/**
 * The shell: which case is open (the worklist) and who is working (the role). Everything
 * about the open case lives in `Workspace`, remounted per case (`key={fixture.id}`) so a
 * switch starts clean — nothing is persisted across cases in v0.1 (data doc §8).
 */
import { useCallback, useRef, useState } from "react";
import { cases, defaultCase, type CaseFixture } from "./fixtures/index.ts";
import type { Role } from "./report/lifecycle.ts";
import { Workspace, type WorkspaceHandle } from "./Workspace.tsx";

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

export default function App() {
  const [fixture, setFixture] = useState<CaseFixture>(caseFromUrl);
  const [role, setRole] = useState<Role>("attending");
  const workspace = useRef<WorkspaceHandle>(null);

  const switchCase = useCallback((id: string) => {
    const next = cases.find((c) => c.id === id);
    if (!next) return;
    void workspace.current?.cancel();
    setFixture(next);
    syncUrl(next.id);
  }, []);

  const headerStart = (
    <>
      <select data-testid="worklist" className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs" value={fixture.id} onChange={(e) => switchCase(e.target.value)}>
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

  return <Workspace key={fixture.id} ref={workspace} fixture={fixture} role={role} headerStart={headerStart} />;
}
