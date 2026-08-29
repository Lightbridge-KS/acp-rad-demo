---
summary: Tracker for the ACP-Rad PoC — slices 1–7 as checkboxes, Now/Next, deferred items, confirmed contracts.
read_when: Starting any session on this repo; before planning a slice; when landing work (tick boxes, add SHAs).
---

# ACP-Rad PoC — progress

Design: [`../design/acp-rad-poc-spec.md`](../design/acp-rad-poc-spec.md) (build order §9, decision ledger §11).

## Milestones

- [x] **1. Tracer bullet** (2026-08-29, `9d41220`) — repo bootstrap; editor mounts Quill with one fixture; browser ACP client ⇄ WS bridge ⇄ rad-agent (stdio); `initialize`/`session/new` carry `_meta.rad`; prompt streams into the sidebar. Verified: `just check` green; `just smoke` OK on Ollama `gpt-oss:20b` and hosted `gpt-5`; browser round-trip via Chrome; unknown `?agent=` closes with 4004.
- [x] **1b. Level 0 spike** (2026-08-29, `_playground/2026-08-29_level0-spike/NOTES.md`) — `claude-agent-acp` 0.70.0 over the same bridge (`?agent=claude`), two runs. Feasible for the demo. Never uses client `fs/*`; edits the real disk; inherits the host user's permission mode (`auto` ⇒ silent approval, run 1 edited via Bash with no diff/permission); with `session/set_mode: default` the Edit path yields `tool_call_update{diff}` → `request_permission{Deny, Allow Once, Always Allow}` → file on disk. Rules graduated to design §8 and *Confirmed contracts*.
- [ ] **2. ReportStore** — Delta⇄Markdown (label-line grammar), virtual namespace + RO rules, `fs/read_text_file` served from Quill; `AcpClientBackend` in the agent; agent reads FINDINGS.
- [ ] **3. Sign-off** — `edit_file` → diff card → permission card (clinical verbs) → grant (path + expected content) → `fs/write_text_file` → `ai-draft` blot → audit (editor stamps, bridge persists JSONL). Scenario 1.
- [ ] **4. Priors, templates, reject, cancel** — scenarios 2, 4, 5; `/template` (scenario 0); `/short-prelim` (3b).
- [ ] **5. QA** — `raise_critical_finding` tool → `_rad/critical_finding` → alert card. Scenario 3.
- [ ] **6. Demo polish** — worklist switcher (3 cases), status pill + Finalize lock, provider switch, audit panel.
- [ ] **7. (stretch) Level 0 in the demo** (~1 day) — materialize mirror + file-watch (`_bridge/file_changed`) in the bridge; `<mirror>/.claude/settings.json` denying Bash/Write/WebFetch; editor pins `session/set_mode: default`, filters `allow_always`, ignores L0 `available_commands_update`; grant-matching applied to the file-watch event. `claude-agent-acp` first; Gemini only if time allows.

## Now / Next

- **Now:** slice 2 (ReportStore).
- **Next:** slice 3 (sign-off flow) — also the moment to evaluate assistant-ui (Deferred).

## Deferred

- **assistant-ui as the sidebar frontend** (KS idea, 2026-08-29) — evaluate `@assistant-ui/react` (cloned at `~/OSS/ChatUi/assistant-ui`, see its `_docs/`) as a replacement for the hand-rolled sidebar. Explore **at slice 3**, when the sidebar grows tool cards, permission cards, and plan rendering — that is where a chat-UI library earns or fails its keep. Feasibility questions to answer then: can its runtime be driven from ACP `session/update` (`useExternalStoreRuntime` / `useLocalRuntime`), can `tool_call` + `request_permission` map onto its tool-call UI and human-in-the-loop parts, and does it stay framework-light in Vite. Not before slice 3 — don't explore yet.
- Fixture `ct-brain-er-stroke` (refined by KS) now carries a filled IMPRESSION; scenario 1 (draft impression) needs an empty one. Resolve at slice 3: a cleared-impression variant or an in-demo "clear section" action.
- Revise `docs/ideas/acp-rad-protocol-proposal.md` to match the design: §4.2 grammar → label-lines; drop §8.3 `section_patch`; §5 `reportStatus` enum; companion line "Flutter Quill" → QuillJS; `ramaai-dev` → `radrama-ai`.
- Absent-section rule (e.g. US-WA has no technique block): section absent ⇒ file absent ⇒ `-32004`. Decide at slice 2.
- `session/load` resume; model dropdown via `session/set_config_option`.

## Confirmed contracts

- Bridge framing: one JSON-RPC message per WebSocket frame ⇄ one NDJSON line on the agent's stdio. The bridge never parses ACP.
- `_meta.rad` is the only extension slot on `initialize`, `session/new`, `session/prompt` (ACP v1; no root fields).
- Python SDK (`agent-client-protocol` 0.12.1) **spreads `_meta` contents into handler kwargs** (`acp.utils.model_to_kwargs`): `_meta.rad` arrives as `kwargs["rad"]`, not `field_meta`. Responses carry `_meta` via `field_meta=`.
- `initialize.result._meta.rad.model` is informational (display/audit); the agent reports its `RAD_MODEL`.
- `deepagents-acp` calls the agent factory lazily at the first prompt, not at `session/new`.
- **Level 0 agents (spike 1b):** a registry agent's permission gating is governed by the *host user's* settings and the model's tool choice, not by the Client. The Client therefore (a) pins `session/set_mode: default` after `session/new` when `modes` is advertised, (b) filters `allow_always` from write permissions (INV-1), (c) ignores their `available_commands_update` (host-skill leak), (d) learns of edits from the on-disk mirror, not `fs/write_text_file`. The `diff` for an edit arrives in `tool_call_update.content` *before* `session/request_permission`, correlated by `toolCallId`.
- Unknown `sessionUpdate` kinds (`usage_update`, `config_option_update`) pass through the TS SDK; the sidebar must tolerate them.

## Open questions

- (none attached to scheduled work)
