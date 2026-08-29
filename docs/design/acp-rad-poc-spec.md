---
summary: Design draft for the ACP-Rad PoC app — QuillJS report editor (browser ACP Client) + deepagents-acp agent (Python) over WebSocket; scope, flows, profile simplifications, repo layout.
read_when: Planning or building the PoC; deciding what of the ACP-Rad proposal the PoC implements; onboarding to the stack choice.
---

# ACP-Rad PoC — Design Draft v0.1

| | |
|---|---|
| **Status** | Draft for KS review — 2026-08-29 |
| **Parent** | [`acp-rad-protocol-proposal.md`](./acp-rad-protocol-proposal.md) (profile v0.1) |
| **Goal** | A working demo for radiology colleagues: radiologist prompts, agent proposes, every write is approved in the editor. |
| **Non-goal** | The standard itself. The PoC *exercises* the profile; consolidation into a Radiology-Editor-ACP spec comes later. |

All 💡 markers were settled in a grilling session on 2026-08-29; decisions are recorded inline as **Decided**. §11 lists them.

---

## 0. What the source surveys settled (2026-08-29)

Read from `~/OSS/ACP`, `~/OSS/Editor/quill`, `~/OSS/deepagents` at their current HEADs.

| Input | Finding | Consequence for the PoC |
|---|---|---|
| **ACP TS SDK** `@agentclientprotocol/sdk` 1.4.0 (schema v1.21) | Core has **zero `node:` imports**; `Stream` is Web Streams; `createWebSocketStream` defaults to `globalThis.WebSocket`. | The browser editor **is** the ACP Client — no server-side client, no protocol duplication. |
| **ACP transports** | WebSocket + Streamable-HTTP exist in *both* SDKs (RFD Active). Python WS profile works on Uvicorn. | Browser ⇄ WS ⇄ agent. A WS⇄stdio bridge is only needed to plug in stdio registry agents (Gemini CLI, Claude). |
| **ACP v1 vs v2** | v2 (alpha.3) **removes client `fs/*` and `terminal/*`**; v2's client surface = `request_permission`, `session/update`, `elicitation/*`. All registry agents, the Python SDK, and deepagents-acp are v1. | Build on **v1**. Isolate report access behind one `ReportStore` seam so it can be re-exposed as MCP-over-ACP tools when v2 lands (§5.4). |
| **ACP extensibility (v1)** | `_meta` everywhere; `_`-prefixed methods/notifications (TS: generic `.onRequest("_x/y")`; Python: `ext_method`/`ext_notification`). **Custom content types do not exist in v1** (`ToolCallContent::Other` is v2-only). | Proposal §8.3 `_rad/section_patch` as a *content type* is not expressible on v1 → §5.2 folds it away. |
| **QuillJS** 2.0.3 | No Markdown import/export, no suggestion/track-changes mode; custom inline blot is ~20 lines; `history.userOnly`, `source:'api'` semantics; trailing-`\n` and block-attr-on-newline gotchas. | Hand-write Delta⇄Markdown for the strict subset (~80 lines, deterministic, keeps `ai-draft` spans). |
| **deepagents-acp** 0.0.11 (alpha) | Does the two hard parts: LangGraph stream → `tool_call`/`tool_call_update`(diff)/`plan`; HITL interrupt ⇄ `session/request_permission` ⇄ resume. **Never calls client `fs/*`**; `allow_always` keyed by tool name; one active session per process. | Use it, **subclassed**: add `AcpClientBackend` (proxies to client `fs/*`), strip `allow_always`, deny writes outside `/worklist`. |
| **claude-agent-acp** 0.70.0 (`~/OSS/ACP/claude-agent-acp`, Zed/ACP reference adapter over Claude Agent SDK) | Emits `tool_call{kind:"edit", content:[{type:"diff", path, oldText, newText}]}` for Write/Edit, `session/request_permission` **before** every edit (options: `allow_once` "Yes", `allow_always` "Yes, allow all edits during this session", `reject_once` "No"), plan/slash-commands. **Does not route its own Read/Write/Edit through client `fs/*`** in 0.70 — `readTextFile`/`writeTextFile` exist only as an outward API for library embedders; tools hit the real disk. Validates `cwd` exists on disk. Auth = `claude /login` (already logged in here). | Best **Level 0** target: reference-quality shapes, source at hand, no extra auth. Requires the on-disk mirror (§8); the editor must **deny/hide `allow_always`** for writes (INV-1) and re-read the file after the turn (bridge file-watch or the adapter's `report_changed_files`). |
| **Local env** | Node 26, pnpm 10, uv 0.11; `gemini --experimental-acp` installed; Ollama has tool-capable `gpt-oss:20b`, `qwen3.5`, `gemma4`; OpenAI/Anthropic keys via `lb key run`. | All three provider paths demoable offline (Ollama) or hosted. |

---

## 1. The demo (what colleagues will see)

One screen: report editor left, agent sidebar right, a 3-case synthetic worklist on top.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Worklist: [CT brain – stroke] [CXR – routine] [CT chest – nodule +prior]│
├──────────────────────────────────┬─────────────────────────────────────┤
│ **EMERGENCY MDCT OF THE BRAIN**  │  ● rad-agent · L1 · gpt-5           │
│ **HISTORY:** Known case of HT …  │─────────────────────────────────────│
│ **COMPARISON:** None.            │  you: /impression                   │
│                                  │  agent: Reading FINDINGS… ▸ read    │
│ **FINDINGS:**                    │  agent: ▸ edit sections/impression  │
│ **Cerebral parenchyma:** Hypo…   │  ┌ Proposed change ──────────────┐  │
│ **Ventricles:** Normal size …    │  │ - - ...                       │  │
│                                  │  │ + - Acute infarct, left MCA   │  │
│ **IMPRESSION:**                  │  │ +   territory.                │  │
│ ░- Acute infarct, left MCA …░    │  │ + - No hemorrhagic transform. │  │
│ ░- No hemorrhagic transform.░    │  │ [Insert] [Insert as draft] [✗]│  │
│      ↑ ai-draft highlight        │  └───────────────────────────────┘  │
│                                  │  ⚠ QA: impression omits 8 mm nodule │
│                                  │─────────────────────────────────────│
│                                  │  [prompt…            ] [send] [stop]│
│                                  │  audit ▸ 14 events                  │
└──────────────────────────────────┴─────────────────────────────────────┘
```

Scripted scenarios, in order of demo value:

0. **Instantiate template** — open a blank ER CT brain study → `/template` → agent reads `meta.json` (modality, protocol, sex, dose) and `/templates/ct-brain-er.md`, proposes the filled skeleton (drops `[female]`-only lines for a male patient, fills technique/dose, leaves clinical `___` blanks) → one accept → report scaffolded in seconds. *This is the "why would I use this" moment for an ER shift.*
1. **Draft impression** — `/impression` → agent reads findings, proposes a diff to the IMPRESSION section → *Insert as draft* → text lands highlighted; radiologist edits a word → highlight clears on that run.
2. **Compare with prior** — "Compare with the prior CT" → read-only tool card on `/priors/…` → proposed COMPARISON text.
3. **QA pass** — `/qa` → agent finds a findings/impression discrepancy → alert card (`_rad/critical_finding`), no edit made.
3b. **Short prelim** — `/short-prelim` → agent inserts the matching SP snippet (`/snippets/sp-brain.md`) under IMPRESSION and proposes the "discussed with Dr." line with blanks for the radiologist to fill. Reflects the real ER lifecycle (short prelim → prelim → reviewed → final).
4. **Reject** — discard a proposal; agent continues the turn gracefully.
5. **Cancel** — stop mid-stream; pending permission resolves as cancelled.
6. *(stretch)* **Swap the agent** to `claude-agent-acp` (or `gemini --experimental-acp`) — same editor, Level 0, still gated.

---

## 2. Architecture

```
            browser (Vite + React + TS)                      localhost
┌─────────────────────────────────────────┐          ┌──────────────────────────┐
│  apps/editor  — the ACP CLIENT          │          │ apps/bridge (Node, ~80 l)│
│                                         │   WS     │  ws://…/acp?agent=<id>   │
│  ┌───────────┐  ┌────────────────────┐  │◄────────►│  spawn + pipe ndjson     │
│  │ Quill     │  │ acp client()       │  │  ndjson  │  (dumb pipe, no parsing) │
│  │ editor    │◄─┤ session/update     │  │          └────────┬─────────────────┘
│  │ ai-draft  │  │ request_permission │  │                   │ stdio
│  │ blot      │  │ fs/read, fs/write  │  │          ┌────────▼─────────────────┐
│  └─────▲─────┘  │ _rad/* ext         │  │          │ agents/rad-agent (uv)    │
│        │        └─────────▲──────────┘  │          │  AgentServerACP subclass │
│  ┌─────┴────────┐  ┌──────┴─────────┐   │          │  ├ AcpClientBackend ──┐  │
│  │ ReportStore  │  │ Sidebar UI     │   │          │  ├ HITL: write/edit   │  │
│  │ Delta⇄MD     │  │ chat·tools·plan│   │          │  ├ prompts/, tools    │  │
│  │ virtual fs   │  │ permission·QA  │   │          │  └ model: OpenAI-compat│  │
│  │ audit log    │  │ audit          │   │          └──────────────────────┼──┘
│  └──────────────┘  └────────────────┘   │       fs/read_text_file ◄───────┘
│  fixtures/ (3 synthetic cases)          │       fs/write_text_file (after permission)
└─────────────────────────────────────────┘
                       ▲                            ┌──────────────────────────┐
                       └── same WS, agent=gemini ──►│ gemini --experimental-acp│ (stretch, L0)
                                                    └──────────────────────────┘
```

Trust boundary: everything that enforces INV-1 (sign-off), RO paths, `final` lock, and audit lives in **`apps/editor`**. The agent is untrusted; the bridge is a pipe.

---

## 3. Components

### 3.1 `apps/editor` — ACP Client (Vite + React + TypeScript + QuillJS 2 + Tailwind)

| Module | Responsibility |
|---|---|
| `report/` | Quill mount (uncontrolled ref pattern), `AiDraft` inline blot (`data-proposal-id`), `history.userOnly`, `formats` whitelist, clear-draft-on-user-edit. |
| `acp-rad/` *(→ `packages/acp-rad`, §7)* | `ReportStore` (the one seam): `read(path)`, `propose(path, newText)`, `apply(proposalId, mode)`; Delta⇄Markdown (label-line grammar, §5.5); virtual namespace resolver + RO rules; error codes. |
| `audit/` | Editor stamps every `AuditRecord` (it is the trust boundary), keeps an in-memory mirror for the panel, and sends `_rad/audit` notifications to the bridge, which appends `audit/{accession}.jsonl` on disk. **Decided.** |
| `agent/` | `client()` wiring: handlers for `session/update`, `request_permission`, `fs/*`, `_rad/critical_finding`; `session/new` with `_meta.rad` (+ `manifest`: every readable virtual path, since ACP v1 has no `ls`); cancel. |
| `sidebar/` | Transcript (message + collapsed thought chunks), tool-call cards (kind, status, diff view), plan panel, **permission card** with clinical verbs, QA alert card, slash commands from `available_commands_update`, audit panel. |
| `fixtures/` | Derived from the real Ramathibodi templates in `_temp/` (structure only, synthetic content): 5 templates → `/templates/{ct-brain-er,ct-chest-er,ct-wa-er,cxr-pa,us-wa}.md`; snippets → `/snippets/{er-reviewed,er-not-reviewed,discuss-with-dr,sp-brain,sp-body,sp-chest}.md` (RO, new namespace entry); 3 filled synthetic cases (CT brain ER stroke · CXR PA with prior · CT chest ER nodule with prior) + 1 blank study for scenario 0; `meta.json` per case (age band, sex, modality, protocol, dose, setting). |

**Permission handling** — the Client is the permission authority for *all* levels:

```
request_permission(toolCall{diff}) ──► permission card ──► user picks
   accept        → grants[path] = {toolCallId, expectedContent, expiresAt: +60 s, singleUse}; reply optionId
   accept_edit   → same, markDraft=true
                   expectedContent = canonicalize(apply(diff.oldText→newText, currentSection))
   reject        → reply reject_once; no grant
fs/write_text_file(path, content) ──►
   grant present & canonicalize(content) == expectedContent & path ∈ RW & status ≠ final
             → ReportStore.apply(content, markDraft) → {} ; grant consumed
   no grant, or content ≠ expected  (unsolicited write, or agent wrote more than it showed)
             → open the same permission card from (current,new) → apply or -32010
   RO path / final → -32003
```

So proposal §4.3 ("write = proposal") becomes the **fallback**, not the only path — agents that ask first (deepagents-acp, Claude, Gemini) are not asked twice. **Decided:** path + expected-content match, single-use, 60 s TTL.

**`ai-draft` lifecycle — Decided:** a user edit anywhere in a line clears the mark on that whole line (organ line / bullet = the review unit); plus "Mark reviewed" per proposal (tool card) and "Mark all reviewed" (toolbar). Each clear is an audit event.

**Report status — Decided:** toolbar pill `short_prelim → preliminary → preliminary_reviewed → final`; **Finalize** locks Quill and the namespace (writes → `-32003`); `/qa` stays available read-only and may still raise `_rad/critical_finding`.

### 3.2 `apps/bridge` — WebSocket ⇄ stdio launcher (Node + `ws`)

`GET /acp?agent=rad|gemini|claude` → spawns the configured command (`agents.json`), pipes ndjson both ways, kills on socket close. No ACP parsing of agent traffic. One exception, editor-originated only: `_rad/audit` notifications are intercepted and appended to `audit/{accession}.jsonl` (they never reach the agent). This is the PoC's "agent registry" and what makes scenario 6 a one-line config change.

### 3.3 `agents/rad-agent` — Python (uv), `deepagents-acp` subclass

```
rad_agent/
├── main.py        run_agent(RadAgentServer(agent=build_agent, models=[...]))
├── server.py      class RadAgentServer(AgentServerACP):
│                    - captures conn + session_id → backend
│                    - _handle_interrupts: strips allow_always
│                    - ext_method/ext_notification: _rad/* (focus, critical_finding out)
├── backend.py     class AcpClientBackend(BackendProtocol): aread/awrite/aedit → client fs/*
│                    als/aglob/agrep → served from the session manifest (no ACP equivalent)
├── tools.py       raise_critical_finding(severity, summary, locations)  → conn.ext_method
├── prompts/       system.md (house style, section grammar, "you propose, the radiologist signs")
└── config.py      RAD_MODEL / RAD_MODEL_BASE_URL → BaseChatModel
```

`create_deep_agent(model, system_prompt, backend=CompositeBackend(default=AcpClientBackend, routes={"/scratch/": StateBackend()}), middleware=[FilesystemMiddleware(tools=["read_file","write_file","edit_file"])], interrupt_on={"write_file": {...approve,reject}, "edit_file": {...}}, permissions=[FilesystemPermission(operations=["write"], paths=["/priors/**","/templates/**"], mode="deny")])`. No `execute`, no todos.

Slash commands advertised via `available_commands_update`: `impression`, `qa`, `compare`, `proofread`.

### 3.4 `packages/acp-rad` — the profile, as code (TypeScript)

Zod schemas for `_meta.rad` (init caps, session binding, focus), `_rad/critical_finding`, error codes, section ids, plus the canonical Delta⇄Markdown serializer and namespace resolver. Framework-free. This is the seed of the future standard's reference implementation; `apps/editor` depends on it.

**Decided (KS, 2026-08-29):** day-1 package — pnpm makes it free and it forces the protocol/app line needed when consolidating the standard.

---

## 4. Key flows

**Prompt → proposal → sign-off** (Level 1, deepagents-acp):

```
Editor                         Bridge          rad-agent                         LLM
  │ session/prompt ["/impression"] ─────────────►│
  │   _meta.rad.focus = {section:"impression"}   │ tool: read_file(/…/sections/findings.md)
  │◄──── session/update tool_call(read) ─────────│
  │◄──── fs/read_text_file ──────────────────────│
  │ ReportStore.read → canonical MD ────────────►│──── messages ──────────────────►│
  │◄──── agent_message_chunk × n ────────────────│◄─── tool_call edit_file(...) ───│
  │◄──── tool_call(edit, diff old/new) ──────────│  (HITL interrupt)
  │◄──── session/request_permission ─────────────│
  │ [permission card] user → "Insert as draft"   │
  │ grants[path]=… ; reply selected:accept_edit ─►│  resume → edit_file executes
  │◄──── fs/write_text_file(path, content) ──────│
  │ grant ✓ → apply Delta, mark ai-draft, audit ─►│ {}
  │◄──── tool_call_update(completed) ────────────│
  │◄──── stopReason end_turn ────────────────────│
```

**QA alert** (Level 2 method, no edit): agent tool `raise_critical_finding` → `_rad/critical_finding` request → editor renders alert card, user acknowledges → `{outcome:"acknowledged"}` → audit.

**Cancel**: editor sends `session/cancel`; any in-flight permission is answered `cancelled` (ACP contract); agent returns `stopReason: cancelled`.

---

## 5. Profile decisions for the PoC (deltas to the proposal)

### 5.1 Implemented as proposed
Virtual namespace + canonical Markdown (§4), session binding `_meta.rad` (§5), capability negotiation + level inference (§6), INV-1 + clinical verbs + no `allow_always` on writes (§7), `_rad/critical_finding` (§8.2), terminal pruned (§8.4), `phiBoundary: research_synthetic`, client-side audit record (§9.2), error codes (§10).

### 5.2 Simplify: drop `_rad/section_patch` (§8.3) — Decided
Per-section virtual files already make `edit_file` on `/worklist/{acc}/sections/impression.md` a field-precise patch, and v1 has no custom `ToolCallContent` anyway. Codes (RadLex/ICD-10) can ride in `tool_call_update._meta.rad.codes`. **Decided:** Level 2 = `criticalFindings` + `codedContent`; `structuredPatch` retired. Re-introduce only as a v2 open-union content type if a real need appears.

### 5.3 Simplify: focus at prompt time, not a stream — Decided
Proposal §8.1 pushes `_rad/focus_state` as a debounced notification. The PoC agent is reactive (turn-based), so focus is only consumed at prompt time. **Decided:** carry it in `session/prompt._meta.rad.focus = {section, cursorOffset, selection}` on every prompt; `_rad/focus_state` stays specified as OPTIONAL for proactive agents (v0.2).

### 5.4 Constraint: v2-readiness via the `ReportStore` seam
All report access goes through `ReportStore`. On v1 it is exposed as `fs/*`; on v2 the same object becomes an MCP-over-ACP server (`read_section`, `propose_edit`) — the sidebar and Quill code never know. Not built now; enforced as a module boundary.

### 5.5 Canonical grammar: Rama label-lines, not H2 headings — Decided
The real templates (`_temp/reports/`) use `**LABEL:** text` lines, a blank line before `**FINDINGS:**`/`**IMPRESSION:**`, organ sub-fields as `**Organ:** text` lines inside FINDINGS, and `- ` bullets for impression items — no headings at all. Proposal §4.2's `## SECTION` scheme would make the demo look foreign. Proposed canonical Markdown v0.1 = **exactly this grammar**: one Quill line ⇄ one MD line; bold runs preserved; `- ` ordered/unordered bullets; blank line only before top-level section labels; `___` blanks are plain text. Section ids are inferred from the uppercase labels (`HISTORY`, `TECHNIQUE(S)`, `COMPARISON`, `FINDINGS`, `IMPRESSION`); the header block (contrast, complication, dose, phases) belongs to `technique`. Organ fields stay lines inside `findings.md` — `edit_file` with `old_string` = the organ line is already field-precise, so no per-organ paths (settles proposal open question 3). **Decided.** Section partition: `history` | `technique` (absorbs phases, contrast, complication, dose lines) | `comparison` | `findings` | `impression` (absorbs status snippets and the "discussed with Dr." footer). The title line is the text before the first section label (RO). Parse rules (slice 2): `**` opens bold only before a non-space and closes only after one (so the real snippet `** This is a PRELIMINARY…` stays literal); `_` is a marker only at a word boundary and never adjacent to another `_` (`___` blanks, `E_V_M_` stay literal); an unclosed opener unwinds to literal text. Fixtures are stored canonical (labels bolded, no trailing whitespace); the converter does not auto-bold unbolded labels.

### 5.6 Report lifecycle from the snippets
`reportStatus` should mirror the real ER lifecycle rather than `draft|preliminary|final`: `short_prelim | preliminary | preliminary_reviewed | final`. Status markers are *text snippets* in the report body (ER Reviewed / Not Reviewed); the Client owns the transition and the `final` write-lock. PoC: statuses are display-only except `final` (locks writes).

### 5.7 Fix in the proposal doc
- Companion line says "Flutter Quill client" → QuillJS (web). Flutter would forfeit the browser-safe TS SDK.
- "versioned in `ramaai-dev` org" → private `radrama-ai`.
- `-32010` returned to `fs/write_text_file` on rejection: keep, but note it is the *fallback* path (§3.1).

---

## 6. Model / provider configuration

`RAD_MODEL` selects the model; keys come from env (`lb key run --env anthropic-personal -- just agent`), never from files in the repo.

| Provider | `RAD_MODEL` | Notes |
|---|---|---|
| Ollama (default, offline demo) | `openai:gpt-oss:20b` + `RAD_MODEL_BASE_URL=http://localhost:11434/v1` | OpenAI-compatible shape; also `qwen3.5`. Pin base URL in config, not `OLLAMA_HOST`. |
| OpenAI | `openai:gpt-5` | via `OPENAI_API_KEY` |
| Anthropic | `anthropic:claude-sonnet-5` | LangChain provider string; not OpenAI-shaped but same code path |

**Decided (KS, 2026-08-29):** demo on hosted `gpt-5` / `claude-sonnet-5`; show the Ollama switch as the on-prem story. Synthetic data makes either safe.

---

## 7. Repository

```
acp-rad-poc/                      pnpm workspace + uv project; justfile at root
├── AGENTS.md  (CLAUDE.md → symlink)
├── CONTEXT.md                    glossary (domain-modeling skill), born with the first slice
├── justfile                      dev (bridge+editor+agent), test, gates
├── apps/
│   ├── editor/                   Vite + React + TS + Quill + Tailwind
│   └── bridge/                   Node + ws; agents.json
├── agents/
│   └── rad-agent/                uv; deepagents-acp subclass
├── packages/
│   └── acp-rad/                  profile schemas + Delta⇄MD + namespace (TS)
├── docs/{ideas,design,progress,dev,issues}
└── _playground/                  gitignored spikes (created at first spike)
```

**Gates.** Dry: `vitest` (Delta⇄MD round-trip property test, namespace/RO rules, grant matching), `pytest` (`AcpClientBackend` against a fake `Client`; `RadAgentServer` with a scripted fake LLM driving a headless `ClientSideConnection`), `tsc --noEmit`, `ruff`, `mypy`. Live: Playwright E2E of scenario 1 against Ollama. PR CI runs dry only.

**Git.** Not a repo yet; `git init` at first slice, private `radrama-ai` remote when it takes shape. Conventional Commits, GitHub Flow.

---

## 8. Scope

**In (v0.1 PoC):** scenarios 0–5 (incl. 3b); Finalize lock demo; fixtures drafted by the agent, reviewed by KS before the demo (**Decided**); English reports in Rama grammar (§5.5); Level 1 editor + agent with the L2 `critical_finding` method; 3 synthetic cases; Ollama/OpenAI/Anthropic switch; client-side audit panel + JSON export; cancel; `session/load` off.

**Stretch:** scenario 6 (Level 0) — target **`claude-agent-acp` first**, Gemini second. Requires a *materialized* on-disk mirror of the namespace (`materialize` script in `apps/bridge`), because registry agents read/write/glob the real disk and validate `cwd`; the bridge watches the mirror and pushes changes to the editor (`_bridge/file_changed` notification), which re-reads and re-marks `ai-draft`. The editor's permission card stays the gate; `allow_always` options are filtered out for writes (INV-1). Decided (KS, 2026-08-29): stretch, spike first.

*Spike 1b verdict (2026-08-29, `_playground/2026-08-29_level0-spike/NOTES.md`): feasible, ~1 day.* Additional Level 0 rules the spike established: the Client **pins `session/set_mode: default`** right after `session/new` (the agent otherwise inherits the host user's mode — `auto` approved a Bash rewrite of the report with no diff and no permission request); the bridge writes **`<mirror>/.claude/settings.json` denying `Bash`, `Write`, `WebFetch`, `WebSearch`, `NotebookEdit`** so edits go through `Edit` (which yields `diff` + permission); the Client **ignores Level 0 `available_commands_update`** (it lists the host user's personal skills); the edit `diff` arrives in `tool_call_update.content` *before* the permission request, correlated by `toolCallId`, so the permission card renders it; grant matching (§3.1) applies to the file-watch event. PHI: a Level 0 agent ships the whole file to its vendor — synthetic data or `onprem_full` only. **Also:** `session/load` resume; model dropdown via `session/set_config_option`.

**Out:** dictation/ASR; multi-accession sessions; structured-field (organ-form) documents; hospital AD auth; server-side audit store; PHI de-identification (synthetic only); v2 / MCP-over-ACP.

**Decided (KS, 2026-08-29):** Level 0 is stretch; half-day spike in `_playground/` first. Spike target = `claude-agent-acp` driven by the SDK's `examples/client.ts` against a temp dir containing `report.md`; record the exact `tool_call`/permission shapes it emits, since the sidebar must render both those and deepagents-acp's.

---

## 9. Build order (vertical slices)

1. **Tracer bullet** — editor mounts Quill with one fixture; bridge spawns rad-agent; `session/new` + `session/prompt` "hello" streams into the sidebar. *Proves the whole transport chain.*
1b. **Level 0 spike** (half day, `_playground/`) — `claude-agent-acp` over the same bridge, headless client, temp-dir `report.md`. Output: a `NOTES.md` with the wire shapes the sidebar must render. Early because it de-risks the permission-card and tool-card design before slice 3.
2. **ReportStore** — Delta⇄MD, namespace, `fs/read` served from Quill. Agent reads FINDINGS.
3. **Sign-off** — `edit_file` → diff card → permission card → `fs/write` → `ai-draft` blot → audit. *Scenario 1 done.*
4. **Priors + templates + reject + cancel** — scenarios 2, 4, 5.
5. **QA** — `_rad/critical_finding` tool + alert card. *Scenario 3.*
6. **Polish for demo** — worklist switcher, provider switch, audit export.
7. *(stretch)* Level 0 in the demo: materialize + file-watch in the bridge, `claude-agent-acp` (then Gemini) as selectable agents.

Each slice ends with its dry gates green and a checkbox in `docs/progress/overview-poc.md` (created at slice 1 from the approved plan).

---

## 10. Open questions

None blocking. Carried to `docs/progress/` at slice 1: whether `technique` should be split when non-ER templates (US-WA) have no technique block at all (probably: section absent ⇒ file absent, `-32004`).

## 11. Decision ledger (grilling, 2026-08-29)

| # | Decision | Where |
|---|---|---|
| 1 | English fixtures derived from `_temp/` templates; agent drafts, KS reviews | §3.1, §8 |
| 2 | `packages/acp-rad` from day 1 | §3.4 |
| 3 | Hosted demo model; Ollama shown as on-prem switch | §6 |
| 4 | Level 0 = stretch, spike first, `claude-agent-acp` before Gemini | §8, §9 |
| 5 | Canonical MD = Rama label-line grammar; 5 sections + RO title | §5.5 |
| 6 | `section_patch` folded; codes via `_meta.rad.codes` | §5.2 |
| 7 | Focus in `session/prompt._meta.rad.focus`; stream optional | §5.3 |
| 8 | Agent = Python `deepagents-acp` subclass (polyglot repo) | §3.3 |
| 9 | Grant match = path + expected content, single-use, 60 s | §3.1 |
| 10 | `ai-draft` clears per line on touch; + Mark reviewed / Mark all reviewed | §3.1 |
| 11 | Audit: editor stamps, bridge persists JSONL | §3.1, §3.2 |
| 12 | Status pill + Finalize lock; QA read-only on final | §3.1, §5.6 |
