---
summary: ADR — the agent sidebar adopts @assistant-ui/react partially (external-store runtime + unstyled primitives), pinned, behind a converter seam; registry kit, HITL UI and unstable APIs rejected.
read_when: Touching apps/editor/src/sidebar or agent/store; bumping @assistant-ui; wondering why the sidebar does not use assistant-ui's tool/approval UI.
---

# ADR 0001 — Sidebar on assistant-ui (partial adoption)

**Status:** accepted 2026-08-29 (KS). **Amends:** design §3.1 `sidebar/` module. **Evidence:** `_playground/2026-08-29_assistant-ui-spike/NOTES.md` (throwaway proof: tsc + vitest + vite build green).

## Decision

The editor's sidebar is built on `@assistant-ui/react` **0.15.17 (pinned exact)** using only:

- `useExternalStoreRuntime` — our ACP-fed reducer *is* the store; assistant-ui never owns the run.
- The unstyled `ThreadPrimitive` / `MessagePrimitive` / `ComposerPrimitive` families, styled with the editor's own Tailwind 4.
- `@assistant-ui/react-markdown` when the transcript needs markdown (later slice).

Every assistant-ui type is confined to `apps/editor/src/sidebar/convert.ts` (ACP `SessionUpdate` → `ThreadMessageLike`), so a rename in the 0.15 line touches one file.

**Not adopted:** the registry/shadcn kit (`npx assistant-ui add …`), `makeAssistantToolUI` / toolkits / `hitl`, thread list, attachments, branching, `assistant-stream`, `@assistant-ui/vite`, any `unstable_*` API.

## Why

- Interaction model B puts the permission decision **in the report**; the sidebar only mirrors it. assistant-ui allows exactly that: a tool-call part carries `approval` as data, and omitting `onRespondToToolApproval` leaves it no decision path. Its approval option kinds are ACP's (`allow-once` / `reject-once` …).
- Streaming, cancel (`Stop` → `session/cancel`), status machinery (running / requires-action / complete), composer and autoscroll fall out of the store shape we already have. Vite + React 19 + TS 6 build clean; ≈ +80 kB gzip, one direct dependency.
- The registry kit would drag shadcn into `apps/editor` for cards we must write ourselves anyway (diff path + mirrored decision, clinical verbs, QA flag).

## Rejected alternatives

- **HAND-ROLL** — keep the 214-line custom sidebar. ~0.5 day now, ~0.5 day later for markdown/autoscroll/composer polish; permission-status logic stays bespoke. Defensible if the demo date were the binding constraint.
- **ADOPT (full kit)** — runtime + registry components. ~1.25 days; adds shadcn tokens, `cn()`, `lucide-react` for no extra value.

## Consequences

- Sidebar effort in slice 3 ≈ 0.75 day; the spike's `store.ts` / `convert.ts` / `Sidebar.tsx` port nearly as-is.
- Watch item: 0.15.x ships a patch every ~2 days; `approval.options` semantics are young. Bump deliberately; the vendored assistant-ui skills under `.agents/skills/` are the API reference and are re-vendored on each bump.
- Test setup needs a `ResizeObserver` shim and `Element.prototype.scrollTo` for `ThreadPrimitive.Viewport` under jsdom.
