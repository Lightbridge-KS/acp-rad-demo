# ACP-Rad: Radiology Report Editing Profile for the Agent Client Protocol

| | |
|---|---|
| **Status** | Draft Proposal v0.1 |
| **Author** | Kittipos Sirivongrungson (Lightbridge-KS), RAMAAI R&D |
| **Date** | 2026-08-29 |
| **Base protocol** | Agent Client Protocol (ACP), protocolVersion 1, JSON-RPC 2.0 |
| **Extension mechanisms used** | `_meta` fields · `_`-prefixed custom methods · custom capabilities at `initialize` (all sanctioned by ACP extensibility rules) |
| **License intent** | Apache-2.0, versioned in `ramaai-dev` org |

---

## 1. Motivation

ACP standardizes how an editing environment (Client) hosts an autonomous writing agent (Agent): streaming updates, proposed diffs, and a human permission gate. These are precisely the primitives a radiology report editor needs — the radiologist, not the agent, signs the report.

However, ACP assumes an IDE editing source-code files. A radiology report editor differs in five ways:

1. The document is a **database record bound to an accession number**, not a file in a workspace.
2. The document has **clinical structure** (sections; sometimes fixed organ fields) that plain text diffs handle lossily.
3. Every agent interaction is a **medico-legal event** requiring an audit trail (PDPA, hospital QMS).
4. The write path must be **proposal-only by construction** — an agent must never be able to place text into a signed report without explicit human acceptance.
5. Some agent outputs are **flags, not edits** (e.g., a QA agent spotting a findings/impression discrepancy).

ACP-Rad is a *profile*: a set of conventions, extensions, and prunings over vanilla ACP such that

- any registry ACP agent (Claude Code, Codex CLI, Gemini CLI, …) works at a baseline level with zero modification, and
- a rad-aware agent can negotiate richer, field-precise, coded, auditable behavior.

## 2. Terminology

| Term | Meaning |
|---|---|
| **Client** | The report editor host application (owns UI, sessions, permissions, data access). The rich-text widget (Flutter Quill, Tiptap, …) is a rendering surface *inside* the Client, not the Client itself. |
| **Agent** | The AI writing/QA process, spawned as a subprocess (stdio) or reached via gateway (WebSocket, when ACP remote transport stabilizes). |
| **Report buffer** | The canonical Markdown serialization of one report (§4). |
| **Accession** | The study identifier binding a session to a piece of work. |
| **Profile level** | Negotiated conformance tier (§3). |

Key words MUST / SHOULD / MAY follow RFC 2119.

## 3. Conformance ladder

Capability negotiation at `initialize` places every Agent on exactly one level. Higher levels degrade gracefully to lower ones.

```
Level 0  "Vanilla"      Any ACP agent, unmodified.
                        Sees a small virtual filesystem of
                        Markdown reports. Proposes plain diffs.

Level 1  "Rad-aware"    Understands focus state and clinical
                        permission verbs. Still text-diff based.

Level 2  "Rad-native"   Emits structured section patches with
                        optional clinical codes; may raise
                        QA flags.
```

The Client MUST support all three levels simultaneously. The Agent's level is inferred from the `_meta.rad` capabilities it advertises (§6); absence of `_meta.rad` ⇒ Level 0.

## 4. Virtual document namespace

The profile keeps ACP's file-path seam (`fs/read_text_file`, `fs/write_text_file`, `Diff.path`) but defines a virtual namespace the Client resolves to database records. This is what lets Level 0 agents work unmodified.

### 4.1 Path scheme

All paths are absolute (ACP requirement) under a session-scoped virtual root:

```
/worklist/{accession}/report.md          current report, full buffer (RW*)
/worklist/{accession}/sections/{id}.md   one section (RW*)
/worklist/{accession}/meta.json          study metadata, de-identified (RO)
/priors/{accession}/report.md            prior report (RO)
/priors/index.md                         list of available priors (RO)
/templates/{template-id}.md              house-style template (RO)
```

`*` RW means *writable via the proposal flow only* (§7). Section ids are lowercase snake_case: `clinical_history`, `technique`, `comparison`, `findings`, `impression` (institutions MAY extend).

### 4.2 Canonical Markdown serialization

The Client MUST round-trip its native document model (e.g., Quill Delta) to a canonical Markdown subset:

- `## SECTION NAME` — H2 headings delimit sections, uppercase display names.
- Numbered lists for enumerated impressions.
- Plain paragraphs elsewhere. No HTML, no tables, no footnotes in v0.1.
- Exactly one blank line between blocks; LF line endings; file ends with single LF.

Canonicalization MUST be deterministic: `serialize(parse(serialize(x))) == serialize(x)`. Determinism is what makes agent-produced diffs apply cleanly.

### 4.3 Read/write rules

- `fs/read_text_file` on any listed path returns the canonical serialization at call time.
- `fs/write_text_file` on an RO path MUST fail with JSON-RPC error `-32003` (Forbidden).
- `fs/write_text_file` on an RW path MUST NOT mutate the document directly. It enters the proposal flow (§7): the Client computes a diff against the current buffer, renders it, and applies it only on user acceptance. From the Agent's perspective the call succeeds when the user accepts; a rejection returns error `-32010` (see §10).
- Paths outside the namespace MUST fail with `-32004` (Not Found). The Client MUST NOT expose any real filesystem.

## 5. Session binding

`session/new` binds one session to one accession via `_meta`:

```json
{
  "method": "session/new",
  "params": {
    "cwd": "/worklist/ACC1234567",
    "mcpServers": [],
    "_meta": {
      "rad": {
        "accession": "ACC1234567",
        "modality": "CT",
        "region": "brain",
        "protocol": "noncontrast",
        "setting": "ER",
        "reportStatus": "draft",
        "phiBoundary": "deidentified_egress"
      }
    }
  }
}
```

Rules:

- One session ↔ one accession. Switching studies means `session/new` (or `session/load` of a previously suspended session for that accession).
- `cwd` MUST be the study's virtual root, so Level 0 agents naturally scope themselves.
- `reportStatus ∈ {draft, preliminary, final}`. When `final`, the Client MUST reject all write proposals (`-32003`) regardless of user action; QA/read-only sessions remain possible.
- `phiBoundary` declares what the Client guarantees about data crossing to the Agent (§9).
- Clients SHOULD support `session/load` to resume interrupted drafting — interruption is the normal case in clinical reading.

## 6. Capability negotiation

### 6.1 Client → Agent (`initialize.params`)

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": { "readTextFile": true, "writeTextFile": true }
  },
  "_meta": {
    "rad": {
      "profileVersion": "0.1",
      "focusState": true,
      "structuredPatch": true,
      "flags": true,
      "clinicalPermissionVerbs": true,
      "codedContent": ["RadLex", "ICD10"]
    }
  }
}
```

Note the pruning: `terminal` is not advertised. A conforming ACP-Rad Client MUST NOT advertise terminal capabilities, and MUST refuse `terminal/*` calls with `-32601` (Method not found).

### 6.2 Agent → Client (`initialize.result`)

The Agent echoes the subset it implements:

```json
{
  "protocolVersion": 1,
  "agentCapabilities": { "loadSession": true },
  "_meta": {
    "rad": {
      "profileVersion": "0.1",
      "focusState": true,
      "structuredPatch": true,
      "flags": false
    }
  }
}
```

Level = 0 if `_meta.rad` absent; 1 if present without `structuredPatch`/`flags`; 2 otherwise.

## 7. Proposal flow and permission model

### 7.1 Invariant

> **INV-1 (Sign-off invariant).** No byte enters the report buffer except through a `session/request_permission` round-trip resolved by an affirmative user selection, applied by the Client.

This holds for all levels, including Level 0 `fs/write_text_file` calls (§4.3). It is an architectural property of the Client; the Agent is untrusted with respect to it.

### 7.2 Clinical permission verbs

When `clinicalPermissionVerbs` is negotiated, Clients present these standard options:

```json
"options": [
  { "optionId": "accept",       "kind": "allow_once",
    "name": "Insert into report" },
  { "optionId": "accept_edit",  "kind": "allow_once",
    "name": "Insert as editable draft" },
  { "optionId": "reject",       "kind": "reject_once",
    "name": "Discard" }
]
```

- `accept` — apply the patch verbatim.
- `accept_edit` — apply the patch and place the cursor inside it, visually marked as unreviewed draft until the radiologist touches or explicitly clears the mark. This is the expected common path.
- `reject` — discard; Agent receives the outcome and SHOULD continue the turn gracefully.

For Level 0 agents the same options are shown; the Agent simply sees a generic allow/reject outcome.

### 7.3 Auto-acceptance

Prohibited. The Client MUST NOT offer `allow_always` kinds for write operations on report buffers. (`allow_always` MAY be offered for read-only operations such as prior retrieval, at the institution's discretion.)

## 8. Rad extension methods and content types

All extensions live under the `_rad/` method prefix and `_rad/*` content-type discriminators, per ACP extensibility rules.

### 8.1 `_rad/focus_state` — Client → Agent notification

Pushed on debounced changes (recommended ≥ 300 ms debounce) so the Agent always knows where the radiologist is working. Requires negotiated `focusState`.

```json
{
  "method": "_rad/focus_state",
  "params": {
    "sessionId": "sess_abc",
    "section": "findings",
    "cursorOffset": 412,
    "selection": null,
    "activeImage": { "series": 3, "instance": 47 }
  }
}
```

Schema (language-independent, TS-type notation):

```ts
type FocusState = {
  sessionId: string;
  section: SectionId | null;
  cursorOffset: number | null;   // 0-based offset in canonical MD of section
  selection: { start: number; end: number } | null;
  activeImage?: { series: number; instance: number };
};
```

### 8.2 `_rad/flag` — Agent → Client request

For QA flags — the agent found the report wanting; a *critical finding* in the radiology sense is an imaging finding, never this message. A *request* (not notification) so the Client's acknowledgment is itself auditable. Requires negotiated `flags`. The Client MUST render it as a flag card and MUST NOT auto-edit anything in response.

```json
{
  "method": "_rad/flag",
  "params": {
    "sessionId": "sess_abc",
    "kind": "discrepancy",
    "summary": "Impression omits the incidental 8 mm lung nodule described in FINDINGS.",
    "locations": [
      { "path": "/worklist/ACC1234567/sections/findings.md", "line": 12 }
    ]
  }
}
```

```ts
type Flag = {
  sessionId: string;
  kind: "discrepancy" | "omission" | "unsupported" | "critical_uncommunicated";
  summary: string;                 // human-readable, ≤ 500 chars
  locations?: { path: string; line?: number }[];
};
type FlagResponse = {
  outcome: "acknowledged" | "dismissed";
};
```

### 8.3 `_rad/section_patch` — ToolCallContent variant

Level 2 field-precise edit, carried inside standard `tool_call` / `tool_call_update` content arrays alongside (or instead of) ACP `diff` blocks. Requires negotiated `structuredPatch`.

```json
{
  "type": "_rad/section_patch",
  "section": "impression",
  "op": "replace",
  "newText": "1. Acute infarction, left MCA territory.\n2. No hemorrhagic transformation.",
  "codes": [
    { "system": "RadLex", "code": "RID5824", "display": "acute infarct" }
  ]
}
```

```ts
type SectionPatch = {
  type: "_rad/section_patch";
  section: SectionId;
  op: "replace" | "append" | "insert_at";
  offset?: number;                 // required iff op == "insert_at"
  newText: string;                 // canonical MD fragment
  codes?: { system: "RadLex" | "ICD10"; code: string; display?: string }[];
};
```

Fallback rule: an Agent that has not negotiated `structuredPatch` MUST express edits as plain ACP `diff` blocks against the virtual `.md` paths; Clients MUST accept both forms from Level 2 agents.

### 8.4 Pruned surface

| ACP feature | ACP-Rad status |
|---|---|
| `terminal/*` (5 methods) | MUST NOT be advertised or served |
| `ToolKind: delete`, `move` | Agents SHOULD NOT use; Clients render as generic `other` |
| `plan` updates | Optional; Clients MAY render minimally |
| Real filesystem access | Prohibited — namespace of §4 only |

## 9. PHI boundary and audit

### 9.1 PHI boundary declarations (`phiBoundary`)

| Value | Client guarantee |
|---|---|
| `deidentified_egress` | All content crossing to the Agent is scrubbed of direct identifiers (name, HN, DOB → tokens); `meta.json` carries age band, sex, modality, protocol only. Client re-hydrates tokens for display locally. |
| `onprem_full` | Agent and model run entirely inside the hospital boundary; identified data may cross the seam. |
| `research_synthetic` | Data is synthetic or IRB-approved research data. |

Agents MUST treat `phiBoundary` as informational; enforcement is entirely Client-side (the Agent is untrusted).

### 9.2 Audit record

The Client MUST persist an append-only audit record for every: session lifecycle event, `fs/*` call, tool_call reported, permission round-trip, `_rad/flag` round-trip. Stamped Client-side (never trusted from Agent input):

```ts
type AuditRecord = {
  ts: string;                      // ISO 8601, client clock
  sessionId: string;
  accession: string;
  actor: { userId: string; role: "radiologist" | "resident" | "system" };
  agent: { name: string; version: string; level: 0 | 1 | 2 };
  event: string;                   // e.g. "fs/read", "permission.accept_edit"
  path?: string;
  argsHash?: string;               // SHA-256 of raw params
  outcome?: string;
};
```

## 10. Error codes

Reuses JSON-RPC and ACP ranges; adds a small profile range:

| Code | Meaning |
|---|---|
| `-32003` | Forbidden (RO path write; `final` report; PHI policy) |
| `-32004` | Not found (path outside namespace) |
| `-32010` | Proposal rejected by user (returned to a pending `fs/write_text_file`) |
| `-32011` | Canonicalization conflict — buffer changed since the diff's base; Agent SHOULD re-read and re-propose |

## 11. Security considerations

- The Agent is untrusted: all invariants (INV-1, RO paths, PHI scrubbing, audit) are Client-enforced.
- Prompt-injection surface: prior reports and templates are data; Clients SHOULD label them as untrusted content when embedding into `session/prompt` resource blocks, and Agents SHOULD treat embedded document content as data, not instructions.
- Transport: stdio subprocess inherits the host user's OS boundary. For remote deployment, adopt ACP's Streamable HTTP/WebSocket transport when stabilized, terminated at an authenticating gateway that also stamps audit records; transports may be layered (browser ⇄ WS ⇄ gateway ⇄ stdio ⇄ agent).

## 12. Open questions (v0.2 candidates)

1. Multi-report sessions (e.g., CT chest + abdomen read together) — one session with two accession roots, or two sessions?
2. Dictation integration — should interim ASR text flow through `_rad/focus_state` or a dedicated stream?
3. Structured-field documents (US abdomen 7-organ form) — promote fields to first-class paths (`/sections/liver.md`) vs. `section_patch` only?
4. Coded-content round-trip — do accepted codes persist into the report data model, and in what shape?
5. Alignment with ACP `elicitation/create` for protocol clarification dialogs ("contrast or non-contrast?") — profile guidance needed once elicitation modes stabilize upstream.

---

*End of proposal. Companion document: `acp-rad-poc-spec.md` (implementation PoC, Flutter Quill client + TypeScript agent).*
