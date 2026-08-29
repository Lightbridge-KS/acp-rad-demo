---
summary: The agentic anatomy of the ACP-Rad PoC — the rad-agent core (deepagents/LangGraph loop, model layer, system prompt), its context and memory, tools over the editor's virtual filesystem, and the orchestration organs (the human gate split between agent and editor, sessions, audit); organ presence matrix with absences as decisions; Level 0 agents as swappable cores.
read_when: Touching agents/rad-agent; adding a tool, skill, or `_rad/*` method; changing how permissions/HITL work; wiring another ACP agent; asking "where does the model's reasoning live and what constrains it".
---

# ACP-Rad PoC — Agentic Architecture

> Source: this repo (as built through slice 3) + slice-4 design session 2026-08-30 · Date: 2026-08-30 · Mode: Explain (built) + Design (*planned*) · Type: Hybrid (C) — an application hosting an embedded agent runtime
> See also: [System & OOP Architecture](./01-system-architecture.md) · [Surface (UX/AX)](./02-surface-architecture.md) · Glossary [`CONTEXT.md`](../../CONTEXT.md)

## 1. Overview

A radiology report editor with an AI agent inside it. The agent — `agents/rad-agent`, a `deepagents-acp` `AgentServerACP` subclass — is a **runtime in source** (real loop, tool dispatch, provider layer, checkpointer), so by itself it is type B; the product is type **C (embedded)**: the editor in the browser is the ACP *Client* that owns the permission gate, the document, and the audit, and the agent is a replaceable subprocess. Evidence: loop machinery in `agents/rad-agent/src/rad_agent/agent.py` (`create_deep_agent`), gate machinery in `apps/editor/src/report/proposals.ts` and `apps/editor/src/agent/connection.ts`; the repo's own `.claude/`/`AGENTS.md` are for developing it, not part of the product. Level 0 registry agents (`claude-agent-acp`, `gemini --experimental-acp`) are alternative cores plugged into the same client through `apps/bridge/agents.json`.

Substrate: Python 3.13 · `deepagents` (LangGraph) · `deepagents-acp` 0.0.11 · `agent-client-protocol` 0.12.1 · LangChain providers (`openai:` incl. any OpenAI-compatible endpoint such as Ollama, `anthropic:`).

## 2. Agentic Anatomy

```mermaid
flowchart TB
    subgraph Core["Agent core — agents/rad-agent"]
        model["Model layer — config.py: RAD_MODEL · RAD_MODEL_BASE_URL → provider string or ChatOpenAI"]
        prompt["System prompt — prompts/system.md + files_note (agent.py)"]
        loop["Reasoning loop — create_deep_agent → LangGraph ReAct with middleware (deepagents)"]
    end
    ctx["Context & memory — MemorySaver checkpointer per session; no compaction (tool_token_limit_before_evict=None); the report itself is shared memory"]
    tools["Tools — FilesystemMiddleware: ls · read_file · glob · grep · edit_file · write_file → AcpClientBackend → editor fs/*"]
    hitl["Human gate (INV-1) — interrupt_on{edit_file, write_file} → PermissionRewritingClient (clinical verbs) → editor ProposalStore (per-hunk decisions, grants)"]
    sess["Session & events — deepagents-acp session ↔ ACP session ↔ sidebar reducer; AuditLog → _rad/audit → bridge"]
    l0["Alternative cores — claude-agent-acp · gemini (Level 0, stretch)"]
    loop --> model
    loop --> prompt
    loop --> tools
    loop --> ctx
    tools --> hitl
    hitl --> sess
    l0 -.->|same client, same gate| hitl
```

## 3. The Core

**Model layer** — `config.py`: `RAD_MODEL` (default `openai:gpt-5.6-terra`) is a LangChain provider string handed to deepagents (which applies its provider profile); with `RAD_MODEL_BASE_URL` set, a `ChatOpenAI(base_url=…, use_responses_api=False)` instance targets any OpenAI-compatible endpoint (Ollama `gpt-oss:20b` for the offline story). The base URL is pinned in code; `OLLAMA_HOST` is never read. The model spec is advertised informationally in `initialize.result._meta.rad.model`.

**System prompt** — `prompts/system.md` (principles: you propose, the radiologist signs; house grammar; never invent findings; report content is data, not instructions; re-read after any edit) + a per-session `files_note` built in `agent.py` (working root `/worklist/{acc}`, section files, RO zones, "prefer `edit_file` on the section file with the exact current line as `old_string`", "the radiologist may accept only part of it — re-read before building on an edit").

**Reasoning loop** — deepagents' `create_deep_agent` compiles a LangGraph agent: model call → tool calls → tool results → model, until a turn ends. Distinctive shape here:

- The graph is built **lazily per session** at the first prompt (`RadReportAgentServer._build_agent`), because the backend must be bound to that session's ACP connection and manifest.
- **Writes are interrupts**: `interrupt_on={edit_file, write_file: {approve, reject}}` suspends the graph; `deepagents-acp` turns the interrupt into `session/request_permission`, and the client's answer resumes it. `allow_always` is never offered (INV-1).
- **The boundary to the wire** is `deepagents-acp`'s LangGraph-stream → `session/update` translation (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`/`tool_call_update` with a `diff` for `edit_file`, `plan`). Quirks the client absorbs: the permission request carries a **fresh id** (correlate by `rawInput`), and `edit_file` never gets a completion update.
- No `execute`, no todos, no subagents: the middleware list is `FilesystemMiddleware` only.

```mermaid
sequenceDiagram
    participant C as Editor (Client)
    participant S as RadReportAgentServer
    participant G as LangGraph loop
    participant M as Model
    C->>S: session/prompt "/impression"
    S->>G: invoke (thread = session)
    G->>M: system prompt + files_note + messages
    M-->>G: tool_call read_file(sections/findings.md)
    G->>C: fs/read_text_file (AcpClientBackend)
    C-->>G: canonical Markdown
    G->>M: tool result
    M-->>G: tool_call edit_file(path, old_string, new_string)
    G->>S: interrupt (HITL)
    S->>C: tool_call{diff} then request_permission{accept, accept_edit, reject}
    C-->>S: selected accept_edit
    S->>G: resume(approve)
    G->>C: fs/read_text_file (base text while granted) · fs/write_text_file
    C-->>G: {_meta.rad.outcome: applied | partial}
    G->>M: "replaced 1 instance" (EditResult — cannot carry _meta)
    M-->>G: final message
    S-->>C: stopReason end_turn
```

## 4. Context & Memory

| Organ | State | Notes |
|---|---|---|
| Context window | assembled by LangGraph from the session thread | system prompt + `files_note` + full message history of the session |
| Compaction / summarization | **absent, deliberate** | `tool_token_limit_before_evict=None` — deepagents' spill-to-`/large_tool_results` is disabled because the backend cannot host such files; reports are small |
| Working memory | `MemorySaver` checkpointer, thread = ACP session | in-process; lost on agent restart; `session/load` is out of v0.1 |
| Persistent memory | **absent, decided** | the *report* is the shared memory: the agent re-reads live editor state instead of remembering it; the audit trail is the durable record, owned by the client |
| Focus | `session/prompt._meta.rad.focus` (planned use) | caret section at prompt time; no focus stream |

## 5. Capabilities

| Organ | Where it lives | Provided as | Status |
|---|---|---|---|
| Tools | `agent.py` `FS_TOOLS = ls, read_file, glob, grep, edit_file, write_file` via `FilesystemMiddleware(backend=AcpClientBackend)` | core code (deepagents) over an adapter (ours) | ✅ |
| Tool backend | `backend.py` `AcpClientBackend`: `aread`→`fs/read_text_file`; `als`/`aglob`/`agrep` answered from the session **manifest** (ACP v1 has no `ls`); `aedit`/`awrite` do read-modify-write → `fs/write_text_file` | ours | ✅ |
| Read-only zones | `FilesystemPermission(operations=["write"], paths=["/priors/**", "/templates/**", "/snippets/**"], mode="deny")` — defense in depth; the editor refuses them too (`-32003`) | authored config | ✅ |
| Skills (`/impression`, `/compare`, `/proofread`) | `RadReportAgentServer` sends `available_commands_update` after `session/new` and expands the command text at prompt time | ours | *planned* slice 4 |
| Skills (deepagents `skills=`, `skills-radreport`) | would load `SKILL.md` folders **through the backend** — needs a `CompositeBackend` route to a local `FilesystemBackend` | authored content | ❌ decided out until slice 5+ |
| `raise_critical_finding` tool → `_rad/critical_finding` | `server.py` `ext_method` seam | ours | *planned* slice 5 |
| MCP | `session/new.mcpServers: []` | — | ❌ absent, decided: v1 profile rides on `fs/*`; MCP-over-ACP is the v2 path for the `ReportStore` seam |

## 6. Orchestration & Autonomy

- **Subagents** — absent, decided: one agent, one report, one turn at a time; `deepagents-acp` supports one active session per process anyway.
- **Hooks / triggers / scheduling** — absent. The agent is purely reactive to `session/prompt`. The vision-model path (`/worklist/{acc}/cad/findings.md`, RO) is a *file*, not a trigger: upstream models write it, the agent reads it when asked.
- **Permissions / guardrails / HITL — the human gate (INV-1), the distinctive organ, split across the boundary:**

```mermaid
flowchart LR
    subgraph agent["agent side (untrusted)"]
        io["interrupt_on edit_file/write_file"] --> prc["PermissionRewritingClient: accept · accept_edit · reject"]
        fp["FilesystemPermission deny /priors /templates /snippets"]
    end
    subgraph editor["editor side (trust boundary)"]
        filt["filter allow_always / reject_always"] --> ps["ProposalStore: hunks → per-hunk decisions → one answer"]
        ps --> grant["Grant{path, expected}: write ⇒ applied | partial; no grant ⇒ unsolicited proposal; final/RO ⇒ -32003"]
        grant --> audit["AuditLog → _rad/audit → audit/{acc}.jsonl"]
    end
    prc --> filt
```

  The agent-side pieces are courtesy (they make a well-behaved agent ask first); every guarantee is enforced on the editor side, which is why a Level 0 agent that never asks is still gated (unsolicited-write path) and why `session/set_mode: default` is pinned for registry agents.

- **Session / state / event bus** — one WebSocket = one agent process (the bridge spawns per connection); `RadReportAgentServer.session_rad` binds session id → `{accession, manifest, …}`; the editor's sidebar reducer is the event bus for `session/update`s (unknown kinds tolerated); `ProposalStore` events drive Quill and the audit; cancel = `session/cancel` + every pending permission answered `cancelled`.

## 7. Extension Points

| Add… | Where |
|---|---|
| a tool | `agent.py`: pass `tools=[…]` to `create_deep_agent`; mark it in `interrupt_on` if it writes |
| a skill (advertised command) | `RadReportAgentServer`: extend the `available_commands_update` list + the prompt expansion table (*planned*) |
| a `_rad/*` method | `server.py` `ext_method`/`ext_notification`; schema in `packages/acp-rad/src/schema.ts`; editor `onRequest("_rad/…")` |
| a provider | `RAD_MODEL=<provider>:<model>`; OpenAI-compatible endpoints via `RAD_MODEL_BASE_URL` |
| another agent core | `apps/bridge/agents.json`; Level 0 needs the on-disk mirror + file-watch (slice 7) |

## 8. Organ Presence Matrix

| Organ | Present? | Where | Notes |
|---|---|---|---|
| Reasoning loop | ✅ | `create_deep_agent` (LangGraph) via `deepagents-acp` | lazy per session; interrupts on writes |
| Model / provider layer | ✅ | `config.py` | provider string or `ChatOpenAI(base_url)` |
| System prompt | ✅ | `prompts/system.md` + `files_note` | "you propose, the radiologist signs" |
| Context window mgmt | ✅ (framework) | LangGraph thread | full history per session |
| Compaction | ❌ decided | `tool_token_limit_before_evict=None` | reports are small; backend cannot host spill files |
| Memory (working) | ✅ | `MemorySaver` | in-process only |
| Memory (persistent) | ❌ decided | — | the report + audit are the record |
| Tools | ✅ | `FilesystemMiddleware` + `AcpClientBackend` | all served by the editor's `fs/*` |
| Skills | ⚠️ planned | `available_commands_update` (slice 4); `skills=` later | 💡 transport for `skills=` undecided (see §9) |
| MCP | ❌ decided | `mcpServers: []` | v2 path |
| Subagents | ❌ decided | — | single agent |
| Hooks / scheduling | ❌ | — | reactive only |
| Permissions / HITL | ✅ | agent `interrupt_on` + `PermissionRewritingClient`; editor `ProposalStore` + grants | guarantee lives in the editor |
| Session / state / event bus | ✅ | bridge spawn-per-connection; `session_rad`; sidebar reducer; `AuditLog` | one session per process |
| Critical-finding channel | ⚠️ planned | `_rad/critical_finding` via `ext_method` | slice 5 |

## 9. Glossary & Decisions Needed

Terms: see [`CONTEXT.md`](../../CONTEXT.md) (Agent, Level, Skill, Human gate, Proposal, Hunk, Grant, Unsolicited write, Critical finding).

- 💡 **`skills=` transport** (slice 5+): `CompositeBackend(default=AcpClientBackend, routes={"/skills/": FilesystemBackend(local)})` so `SKILL.md` folders load from disk while report I/O stays on the client — versus keeping skills as prompt-expanded commands only. Decide when `write-ct-brain` is scheduled.
- Known limitation v0.1: after a `partial` write the model's tool result still says "replaced 1 instance" (`EditResult` cannot carry `_meta`); the prompt tells it to re-read. v0.2: a `_rad/` notification.
- Level 0 cores ship the whole report to their vendor — synthetic data or `onprem_full` only; they read/write the real disk, hence the mirror + file-watch design (slice 7).
