---
summary: Tracker for the ACP-Rad PoC — slices 1–7 as checkboxes, Now/Next, deferred items, confirmed contracts.
read_when: Starting any session on this repo; before planning a slice; when landing work (tick boxes, add SHAs).
---

# ACP-Rad PoC — progress

Design: [`../design/acp-rad-poc-spec.md`](../design/acp-rad-poc-spec.md) (build order §9, decision ledger §11).

## Milestones

- [x] **1. Tracer bullet** (2026-08-29, `9d41220`) — repo bootstrap; editor mounts Quill with one fixture; browser ACP client ⇄ WS bridge ⇄ rad-agent (stdio); `initialize`/`session/new` carry `_meta.rad`; prompt streams into the sidebar. Verified: `just check` green; `just smoke` OK on Ollama `gpt-oss:20b` and hosted `gpt-5`; browser round-trip via Chrome; unknown `?agent=` closes with 4004.
- [x] **1b. Level 0 spike** (2026-08-29, `_playground/2026-08-29_level0-spike/NOTES.md`) — `claude-agent-acp` 0.70.0 over the same bridge (`?agent=claude`), two runs. Feasible for the demo. Never uses client `fs/*`; edits the real disk; inherits the host user's permission mode (`auto` ⇒ silent approval, run 1 edited via Bash with no diff/permission); with `session/set_mode: default` the Edit path yields `tool_call_update{diff}` → `request_permission{Deny, Allow Once, Always Allow}` → file on disk. Rules graduated to design §8 and *Confirmed contracts*.
- [x] **2. ReportStore** (2026-08-29, `d573f05`) — Delta⇄Markdown (label-line grammar, 72 tests incl. round-trip over 12 real files), virtual namespace + RO rules, `fs/read_text_file` served from live Quill; manifest at `session/new`; `AcpClientBackend` (ls/read/glob/grep over the client, writes refused). Verified: `just check` green; `just smoke` OK on Ollama and hosted `gpt-5` (read tool → `fs/read_text_file` → organ label); browser: bold labels render, hand-edited line is served live to the agent.
- [x] **3. Sign-off** (2026-08-29, `cf0d6d3`) — inline tracked changes in Quill (line-level hunks, ADR 0002; `ai-insert`/`ai-delete` overlays stripped from the buffer), per-hunk Insert / Insert as draft / Discard, permission answered from the decisions (clinical verbs on the wire via `PermissionRewritingClient`), grant read-through + `applied`/`partial` write outcome, `ai-draft` marks with per-line clear + Mark all reviewed, audit JSONL via the bridge, sidebar on `@assistant-ui/react` 0.15.17 (ADR 0001), `RadReportAgentServer` rename, demo start-state (impression blanked). Verified: `just check` green (85 + 24 + 23 tests); `just smoke` OK on Ollama and hosted (edit → permission → write → landed); browser scenario 1 with `gpt-5.6-terra`: overlay → typing while pending → Insert as draft → amber → per-line clear → Mark all reviewed → second proposal → Discard; audit trail on disk.
- [ ] **4. Priors, templates, reject, cancel** — scenarios 2, 4, 5; `/template` (scenario 0); `/short-prelim` (3b).
- [ ] **5. QA** — `raise_critical_finding` tool → `_rad/critical_finding` → alert card. Scenario 3.
- [ ] **6. Demo polish** — worklist switcher (3 cases), status pill + Finalize lock, provider switch, audit panel.
- [ ] **7. (stretch) Level 0 in the demo** (~1 day) — materialize mirror + file-watch (`_bridge/file_changed`) in the bridge; `<mirror>/.claude/settings.json` denying Bash/Write/WebFetch; editor pins `session/set_mode: default`, filters `allow_always`, ignores L0 `available_commands_update`; grant-matching applied to the file-watch event. `claude-agent-acp` first; Gemini only if time allows.

## Now / Next

- **Now:** slice 4 — `Commands ▾` + in-editor `/` menu (snippets · skills), `/template`, `/short-prelim-*`, priors + `/compare`, cancel polish.
- **Next:** slice 5 (`_rad/critical_finding` QA alert).

## Deferred

- ~~assistant-ui as the sidebar frontend~~ — **resolved 2026-08-29: ADOPT-PARTIAL** (KS). See `docs/adr/0001-sidebar-on-assistant-ui.md`; spike record `_playground/2026-08-29_assistant-ui-spike/NOTES.md`. Lands in slice 3.
- **Rename `RadAgent*` → `RadReportAgent*`** (KS, 2026-08-29: "implies the purpose more precisely"; timing free). Do it at the start of slice 3 (`server.py` class, `main.py`, tests, logs); the package/CLI name `rad-agent` can stay.
- **Wireframe taste adjustments** (KS, 2026-08-29, applied to the canvas): no action bar — commands live behind a `Commands ▾` menu in the editor toolbar and a Notion-style in-editor `/` menu (Suggested · Snippets = instant editor inserts · Skills = agent proposals); the sidebar composer's `/` opens the same list. Slice 3/4 build this instead of a bar.
- Fixture `ct-brain-er-stroke` (refined by KS) now carries a filled IMPRESSION; scenario 1 (draft impression) needs an empty one. Resolve at slice 3: a cleared-impression variant or an in-demo "clear section" action.
- Revise `docs/ideas/acp-rad-protocol-proposal.md` to match the design: §4.2 grammar → label-lines; drop §8.3 `section_patch`; §5 `reportStatus` enum; companion line "Flutter Quill" → QuillJS; `ramaai-dev` → `radrama-ai`.
- Canonical grammar v0.1 does not escape literal `*`/`_` (reports don't use them). Revisit only if a real report needs it.
- Local `gpt-oss:20b` occasionally answers without calling `read_file`; the smoke prompt now says "use your read_file tool". Hosted models are deterministic here.
- `session/load` resume; model dropdown via `session/set_config_option`.
- **Model-visible partial outcome** (v0.2): deepagents' `EditResult` cannot carry `_meta`, so after a partial accept the tool result still says "replaced 1 instance"; the agent learns the truth only by re-reading (the prompt says so). Fix candidate: a `_rad/` notification or an `edit_file` result annotation.
- Word-level hunks (ADR 0002 alternative) if whole-line strike/insert proves noisy for one-word edits.
- Dev-only nit: React StrictMode's double effect opens two ACP sessions per load, so `audit/*.jsonl` gets two `session.new` records in dev; production builds spawn once.

## Confirmed contracts

- Bridge framing: one JSON-RPC message per WebSocket frame ⇄ one NDJSON line on the agent's stdio. The bridge never parses ACP.
- `_meta.rad` is the only extension slot on `initialize`, `session/new`, `session/prompt` (ACP v1; no root fields).
- Python SDK (`agent-client-protocol` 0.12.1) **spreads `_meta` contents into handler kwargs** (`acp.utils.model_to_kwargs`): `_meta.rad` arrives as `kwargs["rad"]`, not `field_meta`. Responses carry `_meta` via `field_meta=`.
- `initialize.result._meta.rad.model` is informational (display/audit); the agent reports its `RAD_MODEL`.
- `deepagents-acp` calls the agent factory lazily at the first prompt, not at `session/new`.
- **Level 0 agents (spike 1b):** a registry agent's permission gating is governed by the *host user's* settings and the model's tool choice, not by the Client. The Client therefore (a) pins `session/set_mode: default` after `session/new` when `modes` is advertised, (b) filters `allow_always` from write permissions (INV-1), (c) ignores their `available_commands_update` (host-skill leak), (d) learns of edits from the on-disk mirror, not `fs/write_text_file`. The `diff` for an edit arrives in `tool_call_update.content` *before* `session/request_permission`, correlated by `toolCallId`.
- Unknown `sessionUpdate` kinds (`usage_update`, `config_option_update`) pass through the TS SDK; the sidebar must tolerate them.
- **Slice 3:** (a) deepagents-acp sends the edit `diff` on `tool_call` *before* `session/request_permission`, but the permission request carries a **fresh uuid**, not the tool call id — correlate by `rawInput` (`file_path` + `old_string`/`new_string`). (b) `edit_file` never gets a completion update — a resolved permission ends the card. (c) The backend does read-modify-write; while a grant is open the editor serves the proposal's base text for that path (≤ 60 s) so the agent's edit reproduces what it showed; the write is then `applied` (equals the decided buffer) or `partial`, returned in `WriteTextFileResponse._meta.rad`. (d) Clinical verbs (`accept` / `accept_edit` / `reject`) go on the wire by wrapping the ACP client connection (`PermissionRewritingClient`), mapped back to deepagents' `approve`/`reject`. (e) `BRIDGE_TRACE=1` logs frame methods/ids both ways — the bridge stays a pipe otherwise, except `_rad/audit` persistence.
- **Slice 2:** `session/new._meta.rad.manifest: string[]` lists every readable virtual path (ACP v1 has no `ls`); `ls`/`glob` answer from it, `grep` reads candidates. Converter API is `Op[]`-based (no runtime Delta class; `quill-delta` is a type-only dep) so Quill's Delta and the package never need the same class. Absent section ⇒ absent file ⇒ `-32004` (US-WA has no `technique`). Every `fs/write_text_file` → `-32003` until the proposal flow (slice 3). Parse rule: `**` opens bold only before a non-space, closes only after one; `_` only at word boundaries and never adjacent to `_`; an unclosed opener unwinds to literal text.

## Open questions

- (none attached to scheduled work)
