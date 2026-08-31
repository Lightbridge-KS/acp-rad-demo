---
summary: System & OOP architecture of the ACP-Rad Demo — C1–C3 (browser editor = ACP Client, WS⇄stdio bridge, Python rad-agent, acp-rad profile package), key classes, the proposal → human gate flow, the profile as exercised, invariants and trust boundary.
read_when: Onboarding to the stack; touching a module boundary (editor ⇄ bridge ⇄ agent, acp-rad seam); planning a slice; asking "where does X live and why".
---

# ACP-Rad Demo — System & OOP Architecture

> Source: this repo (as built through slice 6) + slice-4/5/6 design sessions 2026-08-30 · Date: 2026-08-30 · Mode: Explain (built) + Design (slice 7, marked *planned*) · Type: Application
> See also: [Surface (UX/AX)](./02-surface-architecture.md) · [Agentic Architecture](./03-agentic-architecture.md) · [Data Architecture](./05-data-architecture.md) · [ACP wire shape](../protocol/01-acp-shape.md) · Glossary [`CONTEXT.md`](../../CONTEXT.md) · Tracker [`progress/overview-demo.md`](../progress/overview-demo.md) · Profile proposal [`ideas/acp-rad-protocol-proposal.md`](../ideas/acp-rad-protocol-proposal.md) · Superseded draft [`archive/design/acp-rad-poc-spec.md`](../archive/design/acp-rad-poc-spec.md) (source survey §0, grilling ledger §11)

## 1. Overview

A radiology report editor in the browser (QuillJS) hosting an AI agent through the **Agent Client Protocol (ACP v1)**, extended by the **ACP-Rad profile** (`_meta.rad` + `_rad/*` only). The radiologist prompts; the agent proposes; every write passes the human gate inside the report. Demo target: radiology colleagues; the profile later consolidates into a separate standard, which this demo *exercises* but does not define.

**Type: Application** — three entry points run: `apps/editor/src/main.tsx` (Vite SPA), `apps/bridge/src/index.ts` (Node WebSocket server), `agents/rad-agent/src/rad_agent/main.py` (stdio ACP agent). `packages/acp-rad` is a library, but only the editor consumes it.

**Stack.** pnpm workspace + uv project, `just` at the root. Editor: Vite · React 19 · TypeScript (strict) · QuillJS 2 · Tailwind 4 · `@agentclientprotocol/sdk` (browser-safe, WS stream) · `@assistant-ui/react` 0.15.17 pinned (ADR 0001). Bridge: Node 26 + `ws`, runs TS natively. Agent: Python 3.13 · `deepagents-acp` 0.0.11 subclass · LangChain providers (OpenAI-compatible incl. Ollama, Anthropic). Profile: zod.

### Invariants (the bar every change clears)

> **INV-1 (Human gate).** No byte enters the report buffer except through an explicit act of the radiologist — typing, accepting a hunk, or invoking an editor command. (*Sign-off* means finalization, not this.)
>
> **INV-2 (Non-interference).** The radiologist's typing never blocks and is never overwritten. A pending proposal is an *overlay* anchored by `(section, old lines)`, never by offsets; if the radiologist's edits make the anchor unfindable the hunk conflicts and the agent re-reads and re-proposes.

**Trust boundaries.** Everything that enforces INV-1, read-only paths, the `final` lock, and audit stamping lives in `apps/editor`. The agent is untrusted. For the anonymous public Vercel deployment the bridge additionally owns same-origin validation, global capacity, and durable audit delivery. It still does not interpret ACP except for the editor-originated `_rad/audit` notification. No PHI ever — fixtures are synthetic (`phiBoundary: research_synthetic`). See ADR 0003.

## 2. System Context (C1)

```mermaid
flowchart LR
    rad([Radiologist])
    subgraph Demo["ACP-Rad Demo (local or one Vercel origin)"]
        editor["apps/editor — browser, the ACP Client"]
        bridge["apps/bridge — WS ⇄ stdio"]
        agent["agents/rad-agent — the ACP Agent (Level 2)"]
    end
    l0["Level 0 agents (stretch): claude-agent-acp · gemini --experimental-acp"]
    llm[("LLM: local/direct provider · Vercel AI Gateway")]
    redis[("Managed Redis: leases · audit")]
    audit[("Local audit/{accession}.jsonl")]
    fixtures[("fixtures/: cases · priors · templates · snippets")]
    rad -->|types, prompts, signs off| editor
    editor <-->|ACP over WebSocket| bridge
    bridge <-->|ACP over stdio| agent
    bridge <-.->|stdio| l0
    agent --> llm
    bridge --> audit
    bridge --> redis
    fixtures --> editor
```

The browser **is** the ACP Client (the TS SDK has no Node dependency); there is no server-side client and no protocol duplication. The bridge exists only because ACP agents speak stdio.

## 3. High-Level Structure (C2)

```mermaid
flowchart TD
    subgraph editor["apps/editor (React + Quill)"]
        report["report/ — Quill mount, overlays, hunk controls, ProposalStore"]
        agentc["agent/connection.ts — ACP client wiring"]
        sidebar["sidebar/ — transcript mirror on assistant-ui"]
        auditl["audit/log.ts — AuditLog (stamps)"]
        fix["fixtures/ — cases, templates, snippets"]
        cmds["commands/ — registry, editor commands, menus"]
    end
    pkg["packages/acp-rad — profile as code: schema · markdown · sections · namespace · store · hunks"]
    bridge["apps/bridge — agents.json registry, NDJSON⇄frame, _rad/audit sink"]
    ragent["agents/rad-agent — RadReportAgentServer · AcpClientBackend · PermissionRewritingClient"]
    report --> pkg
    agentc --> pkg
    agentc <-->|"same-origin /acp?agent=rad"| bridge
    bridge <-->|stdio| ragent
```

| Path | Responsibility |
|---|---|
| `apps/editor/src/report/` | `ReportEditor.tsx` (uncontrolled Quill, `history.userOnly`, format whitelist) · `blots.ts` (`ai-insert`, `ai-delete`, `ai-draft`→*unreviewed* marks) · `overlay.ts` (pure `Op[]` transforms: render/decide/strip hunks, clear marks) · `overlayQuill.ts` (apply to a live Quill, post-user-change pass) · `HunkControls.tsx` (per-hunk pills) · `proposals.ts` (`ProposalStore`: proposals, grants, permission answers) · `reportStore.ts` (the `ReportStore` over live Quill with overlays stripped). |
| `apps/editor/src/agent/connection.ts` | `connectAgent()`: `initialize` + `session/new` with `_meta.rad`, serves `fs/read_text_file`/`fs/write_text_file` from the `ReportStore`, answers `session/request_permission` from hunk decisions, grant rule on writes, Level 0 hygiene (`set_mode: default`), cancel. |
| `apps/editor/src/sidebar/` | `store.ts` (reducer over ACP `session/update`s), `convert.ts` (ACP → assistant-ui `ThreadMessageLike`, the only file that knows assistant-ui types), `Sidebar.tsx` (thread, composer, tool cards that *mirror* decisions, audit tab). |
| `apps/editor/src/audit/log.ts` | `AuditLog`: stamps every consequential event, keeps the in-memory mirror, sends `_rad/audit` up the connection. |
| `apps/editor/src/fixtures/` + `apps/editor/fixtures/` | Synthetic cases (`meta.json` + `report.md` + `priors/*.md`), house templates, snippets; start-state rule (`demo.start`). |
| `apps/editor/src/commands/` | One command registry feeding `Commands ▾`, the in-report `/` menu and the composer `/`; deterministic editor commands (document · snippet). See [surface §2](./02-surface-architecture.md#2-surface-map). |
| `packages/acp-rad/src/` | `schema.ts` (zod for `_meta.rad`, statuses, clinical verbs, write outcome, audit record, error codes) · `markdown.ts` (Delta ⇄ canonical Markdown) · `sections.ts` (label-line partition) · `namespace.ts` (virtual paths, RO rules, manifest) · `store.ts` (`createReportStore`) · `hunks.ts` (line diff, `buildHunks`/`applyHunks`). Framework-free; the seed of the standard's reference implementation. |
| `apps/bridge/` | `src/server.ts`: anonymous `/acp?agent=<id>` validates Origin, atomically acquires a global lease, then spawns `agents.json[id]` and re-frames NDJSON ⇄ WS frames. `_rad/audit` → Redis in Vercel or `audit/{acc}.jsonl` locally; `/health` checks the admission store. `src/config.ts` makes Vercel startup fail closed; `BRIDGE_TRACE=1`. `scripts/smoke.ts`: headless live tracer. |
| `agents/rad-agent/src/rad_agent/` | `server.py` (`RadReportAgentServer`) · `permissions.py` (`PermissionRewritingClient`) · `backend.py` (`AcpClientBackend`) · `flags.py` (`raise_flag` tool → `_rad/flag`) · `skills.py` · `agent.py` (`build_agent` → `create_deep_agent`) · `config.py` (`RAD_MODEL`) · `prompts/system.md`, `prompts/skills/*.md` · `main.py`. stdout is the wire; logs to stderr. |

## 4. Components (C3) — inside `apps/editor`

```mermaid
flowchart TD
    App["App.tsx — composition root"]
    App --> RE["ReportEditor (Quill)"]
    App --> HC["HunkControls"]
    App --> SB["Sidebar (assistant-ui external store)"]
    App --> PS["ProposalStore"]
    App --> AL["AuditLog"]
    App --> CN["connectAgent()"]
    CN --> RS["ReportStore (createReportStore over stripOverlays(quill ops))"]
    CN --> PS
    CN --> AL
    PS -->|events: proposed · decided · answered · cancelled| App
    App -->|overlayOps / decideHunkOps / applyOps| RE
    RS --> PKG["acp-rad: markdown · sections · namespace · hunks"]
```

Data ownership, in one line each: **Quill** owns the document (overlays are Delta attributes on it); **ProposalStore** owns proposals, hunk states, grants and the pending permission promise; **sidebar store** owns only a mirror of `session/update`s; **AuditLog** owns the trail; **ReportStore** owns nothing — it is a pure view (canonical Markdown of the live buffer with overlays stripped) plus the namespace rules.

## 5. OOP & Class Architecture

```mermaid
classDiagram
    class ReportStore {
        +read(path) string
        +assertWritable(path)
        +reportMarkdown() string
        +manifest() string[]
    }
    class ProposalStore {
        +fromDiff(id, diff, currentFile) Proposal
        +fromWrite(id, path, content, currentFile) Proposal
        +decide(id, hunkId, verb)
        +decideAll(id, verb)
        +awaitPermission(id, options) Promise~PermissionAnswer~
        +peekGrant(path) Grant
        +takeGrant(path) Grant
        +outcomeFor(grant, content) applied|partial
        +cancelAll()
    }
    class AuditLog {
        +bind(ctx, sink)
        +record(event, fields)
        +records AuditRecord[]
    }
    class AgentServerACP { <<deepagents-acp>> }
    class RadReportAgentServer {
        +initialize() +_meta.rad caps
        +new_session() binds accession + manifest
        +ext_method(_rad/*)
        -_build_agent(ctx)
    }
    class PermissionRewritingClient {
        +request_permission() clinical verbs
    }
    class BackendProtocol { <<deepagents>> }
    class AcpClientBackend {
        +aread/als/aglob/agrep
        +aedit/awrite → fs/write_text_file
    }
    AgentServerACP <|-- RadReportAgentServer
    RadReportAgentServer o-- PermissionRewritingClient : wraps conn
    RadReportAgentServer ..> AcpClientBackend : per session
    BackendProtocol <|.. AcpClientBackend
```

Patterns, named: **Seam** — `ReportStore` is the one door to report content (v2-readiness: on ACP v2 it becomes MCP-over-ACP tools and nothing above it changes). **Proxy** — `PermissionRewritingClient` swaps deepagents' `approve/reject/approve_always` for the profile's clinical verbs without copying `_handle_interrupts`. **Adapter** — `AcpClientBackend` makes the editor's `fs/*` look like a deepagents filesystem; `ls`/`glob`/`grep` are answered from the session manifest since ACP v1 has no directory listing. **Overlay-as-attributes** — proposals are Quill formats (`ai-insert`/`ai-delete`) on the live Delta, stripped by `stripOverlays` before any read, so pending text is rendered but never *in* the buffer. **Reducer mirror** — the sidebar never owns a decision; assistant-ui gets no `onRespondToToolApproval`.

## 6. Key Flows

### 6.1 Prompt → proposal → human gate (Level 1, as built)

```mermaid
sequenceDiagram
    participant R as Radiologist
    participant E as Editor (Client)
    participant A as rad-agent
    participant M as LLM
    R->>E: "/impression" (composer or / menu)
    E->>A: session/prompt
    A->>E: fs/read_text_file(sections/findings.md)
    E-->>A: canonical Markdown (overlays stripped)
    A->>M: messages
    M-->>A: tool_call edit_file(old_string, new_string)
    A->>E: session/update tool_call{kind: edit, content: diff}
    E->>E: ProposalStore.fromDiff → hunks → overlayOps → Quill
    A->>E: session/request_permission (fresh id — matched by rawInput)
    R->>E: per hunk (shown as a change): Accept / Accept for review / Reject
    E-->>A: selected accept | accept_edit | reject  (+ grant{path, expected})
    A->>E: fs/read_text_file (served the proposal's BASE text while the grant is open)
    A->>E: fs/write_text_file(path, content)
    E-->>A: {_meta.rad.outcome: applied | partial, accepted[], discarded[]}
    A-->>E: stopReason end_turn
```

Grant rule (`connection.ts`): `final` ⇒ `-32003`; RO path ⇒ `-32003`; grant found and `canonical(content) === expected` ⇒ `applied`; grant found but differs (partial acceptance, or the agent wrote more than it showed) ⇒ `partial` — the buffer keeps the radiologist's per-hunk result; the agent's content never lands directly. No grant ⇒ **unsolicited write** (Level 0 / unasked `write_file`): synthesize hunks from current vs content, render, hold the request until decided, `-32010` if all discarded. Grant read-through lasts ≤ 60 s.

### 6.2 Editor command (deterministic, built slice 4)

```mermaid
sequenceDiagram
    participant R as Radiologist
    participant E as Editor
    R->>E: /template ct-brain-er (menu, / menu, or composer)
    alt buffer blank
        E->>E: instantiate(meta.json, template) → setContents(source: user)
    else buffer non-blank
        E->>E: ProposalStore.fromWrite("local:…", report.md, content, current) → overlay
        R->>E: per hunk Accept / Reject (no permission on the wire)
    end
    E->>E: audit command.template → ct-brain-er
```

Editor commands never touch the agent; they share the overlay machinery of §6.1 for the non-blank case (option C) and resolve locally.

### 6.3 Cancel

Editor sends `session/cancel`; `ProposalStore.cancelAll()` discards rendered hunks and answers every in-flight `request_permission` with `cancelled` (ACP contract); the agent returns `stopReason: cancelled`. The interrupted turn shows a *stopped* marker (slice 4).

### 6.4 QA flag (Level 2 method, built slice 5)

```mermaid
sequenceDiagram
    participant R as Radiologist
    participant E as Editor (Client)
    participant A as rad-agent
    R->>E: /qa
    E->>A: session/prompt "/qa" (expanded agent-side)
    A->>E: fs/read_text_file report.md · sections/*.md (numbered lines)
    A->>E: _rad/flag {kind, summary, locations[{path, line}]}
    E->>E: FlagStore.raise → f{n} · mark the line (ai-flag) · audit flag.raised
    E-->>A: {outcome: "acknowledged"}  (the Client acknowledges on receipt)
    A-->>E: "1 flag(s) raised" · stopReason end_turn
    R->>E: Acknowledge (flag card, sidebar)
    E->>E: clear the mark · audit flag.acknowledged
```

The agent's `raise_flag(kind, summary, locations)` tool (`flags.py`, pydantic `Literal` kinds) sends `_rad/flag`; the editor records it in the `FlagStore`, marks the located line, answers `acknowledged` **on receipt** (KS, 2026-08-30 — the turn never waits for a human; nothing is in flight on Stop), and renders a **flag card** in the sidebar — the one decision the sidebar owns. The radiologist's **Acknowledge** is local: it clears the mark and audits `flag.acknowledged`. No edit is ever made. `locations[].line` is the 1-based line of the file *as the agent read it*; the editor re-anchors it by an ordinal walk that counts like `canonicalLines`, then verifies the text (grant base text while a grant is open). Kinds: `discrepancy` · `omission` · `unsupported` · `critical_uncommunicated` (design 04 §3.5). The same path serves the QA gate at Prelim / Sign off (built, slice 6 — 04 §3.5): the editor sends `/qa` and counts the flags the `FlagStore` gained during that turn; the agent never knows it is a gate. During any `/qa` turn, and on a `final` report, the editor refuses agent writes outright (`permission.refused`, `fs.write.refused`).

## 7. Extension Points

| Seam | How |
|---|---|
| Another ACP agent | one entry in `apps/bridge/agents.json`; `?agent=<id>`. Level 0 needs the on-disk mirror + file-watch (slice 7). |
| Model / provider | `RAD_MODELS` (switchable in the app through `session/set_config_option` — plain ACP, no profile extension) or `RAD_MODEL`; `RAD_MODEL_BASE_URL` for any OpenAI-compatible endpoint; keys in a gitignored `.env` (`.env.example`). |
| New case / template / snippet | drop files under `apps/editor/fixtures/`; the loader globs them; `meta.json` binds the session. |
| New editor command | one entry in `EDITOR_COMMANDS` + a case in `runEditorCommand` (`commands/registry.ts`); pure function over canonical Markdown, unit-tested; `apply.ts` performs the effect. |
| New agent skill | one `prompts/skills/<name>.md` (frontmatter `description`, `hint`; body = expansion) — advertised and expanded by `RadReportAgentServer`; deepagents `skills=` later (routed through a `CompositeBackend` — the ACP backend cannot serve skill files). |
| New profile method | `_rad/*` via `ext_method`/`ext_notification` (agent) and generic `onRequest` (editor); schema in `packages/acp-rad`. |
| ACP v2 | re-expose `ReportStore` as MCP-over-ACP tools; editor and Quill code unchanged. |

## 8. The Profile as Exercised (deltas to the proposal)

| Proposal item | PoC decision |
|---|---|
| Virtual namespace (§4) | `/worklist/{acc}/{report.md, sections/{id}.md, meta.json}` RW*, `/priors/**`, `/templates/**`, `/snippets/**` RO. RW* = only via the proposal flow. `session/new._meta.rad.manifest` lists every readable path (v1 has no `ls`) and is *static* — always the five sections, so it cannot go stale. An absent section reads as `""` and is created, with its label, through the proposal flow (design 06 §6). |
| Canonical Markdown (§4.2) | **house label-line grammar**, not H2 headings: `**LABEL:** text` lines, `**Organ:** text` inside FINDINGS, `- ` impression items, blank line only before top-level labels, no headings. Sections `history · technique · comparison · findings · impression`; the title line precedes the first label (RO). Literal `*`/`_` are not escaped (`___` blanks, `E_V_M_` stay literal). |
| Session binding (§5) | `_meta.rad` on `session/new`: `accession, modality, region, protocol, setting, reportStatus, phiBoundary, manifest`. **`reportStatus ∈ {draft, preliminary, final}` + `shortPrelim: boolean`** (2026-08-30; replaces the 4-state enum). |
| Levels (§3) | inferred from `initialize.result._meta.rad`; absent ⇒ Level 0. Client supports all three at once. |
| Clinical verbs (§7.2) | `accept · accept_edit · reject` on the wire; no `allow_always` on writes, ever. UI words: *Accept · Accept for review · Reject*, on a *change* (the UI word for a hunk). |
| `_rad/section_patch` (§8.3) | **Dropped** — per-section files make `edit_file` field-precise; v1 has no custom content types. Codes may ride in `_meta.rad.codes`. |
| `_rad/focus_state` (§8.1) | Focus carried in `session/prompt._meta.rad.focus` (turn-based agent); the stream stays OPTIONAL for proactive agents. |
| Write outcome | `WriteTextFileResponse._meta.rad = {outcome: applied \| partial, accepted, discarded}` — new in the PoC. |
| `_rad/flag` (§8.2) | Agent → Client request `{sessionId, kind, summary ≤ 500, locations[{path, line?}]}`; response `{outcome: "acknowledged"}` means **the Client received and marked it** — `dismissed` and the human-on-the-wire acknowledgement are dropped (KS, 2026-08-30). `line` = 1-based line of the file as the agent read it. Requires `flags` both ways; the agent advertises `/qa` only to a client that negotiated it. |
| Errors (§10) | `-32003` forbidden (RO/final) · `-32004` not found · `-32010` proposal rejected · `-32011` canonicalization conflict. |
| Audit (§9.2) | Stamped by the Client; bridge persists Redis lists with a rolling 7-day TTL on Vercel and JSONL locally; never trusted from the agent. |
| Proposal-doc fixes pending | grammar → label-lines; drop §8.3; status enum; "Flutter Quill" → QuillJS; `ramaai-dev` → `radrama-ai`. |

Profile wording to carry into the standard: *Clients MAY offer deterministic commands; Agents advertise theirs.*

## 9. Key Abstractions

See [`CONTEXT.md`](../../CONTEXT.md) — the glossary is canonical; this doc uses its terms (Human gate, Proposal, Hunk — *change* in the UI —, Grant, Unreviewed text, Editor command, Skill, Short prelim, Fold-in, Sign-off = finalization).

## 10. Decisions Needed & Notes

Settled decisions from the 2026-08-29 grilling live in the archived draft's §11; the slice-4 decisions of 2026-08-30 (deterministic `/template`, instant editor inserts, option C on non-blank, home-anchored snippets, `shortPrelim` flag, mark renamed *unreviewed*, INV-1 named *Human gate*, hunk shown as *change*, verbs *Accept / Accept for review / Reject*) are recorded in the surface doc and the glossary. Open, attached to scheduled work:

- 💡 **Skills transport** (slice 5+): deepagents loads `skills=` through the backend, and ours is the ACP client backend — route `/skills/**` to a local `FilesystemBackend` via `CompositeBackend`, or advertise skills purely by prompt expansion. Decide at slice-5 planning.
- Model-visible partial outcome: deepagents' `EditResult` cannot carry `_meta`; after a `partial` the model learns the truth only by re-reading (the prompt says so). v0.2 candidate: a `_rad/` notification.
- `session/load` resume: out of v0.1. (`session/set_config_option` model switching landed in slice 6 — plain ACP, deepagents-acp's `models=` list, the editor's sidebar select.)
- Word-level hunks: kept as the alternative in ADR 0002.
