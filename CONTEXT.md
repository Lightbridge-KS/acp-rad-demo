---
summary: Ubiquitous language — the domain glossary for the ACP-Rad Demo (report, proposal & human gate, commands, lifecycle, agent & protocol terms).
read_when:
  - introducing, renaming, or disambiguating a domain term
  - naming a type, class, module, command, or UI label after a domain concept
---

# ACP-Rad

A radiology report editor hosting an AI agent through the Agent Client Protocol: the radiologist writes and decides; the agent proposes. One bounded context.

## Actors

**Radiologist**:
The human who owns the report and every byte in it — resident or attending. The only actor whose acts put text into the report.
_Avoid_: user, physician, author

**Resident**:
A radiologist-in-training who may draft and issue a preliminary report but not sign off.

**Attending**:
A staff radiologist who may sign off, and whose review of a resident's report the ER markers record.

**Agent**:
The AI process that reads the report and proposes changes. Untrusted; never writes directly.
_Avoid_: assistant, copilot, model (the model is what the agent runs on)

**Client**:
The report editor — the ACP peer that owns the document, the human gate, and the audit.
_Avoid_: frontend, host

**Level**:
An agent's conformance tier to the profile: 0 vanilla ACP, 1 rad-aware (clinical verbs, focus), 2 rad-native (flags, codes).

## Study & report

**Study**:
One imaging examination, identified by its accession, for which one report is written.
_Avoid_: case (fixture-only word), exam

**Accession**:
The study identifier that binds one agent session to one report.

**Report**:
The document being written for a study — title line plus five sections.
_Avoid_: note, document

**Report buffer**:
The report as it currently stands in the editor — the only text that exists; proposals are not in it.

**Section**:
One of the five parts of a report: history, technique, comparison, findings, impression. The unit an agent reads and proposes against.

**Label line**:
A line that opens with a bold label — a section label (`**FINDINGS:**`) or an organ line (`**Ventricles:** …`). The house grammar has no headings.

**Canonical Markdown**:
The one serialization of a report both peers read: label lines, `- ` impression items, no headings, no escaping.

**Prior**:
An earlier study's report available for comparison. Read-only.

**Template**:
A house skeleton for a study type (e.g. ER CT brain), with `___` clinical blanks and sex-conditional lines. Read-only source; instantiated into a report.

**Snippet**:
A short house text with a fixed home in the report — the ER markers and the discussed-with line. Read-only source.
_Avoid_: quick text, boilerplate

**Study metadata**:
The de-identified facts about a study the agent and commands may use: modality, region, protocol, setting, sex, age band, dose, template id.

**Namespace**:
The virtual file tree through which the agent sees the report, its metadata, priors, templates and snippets.
_Avoid_: filesystem, workspace

**Manifest**:
The list of every path in the namespace an agent may read, sent when a session opens.

## Proposal & human gate

**Proposal**:
What the agent asks to change in one section or the whole report — one or more hunks, rendered in the report as tracked changes until the radiologist decides each.
_Avoid_: edit, diff (the diff is the wire form), change (that is one hunk, in the UI)

**Hunk**:
The unit of decision inside a proposal: a contiguous run of changed lines (the diff term). Each hunk is accepted, accepted for review, or rejected on its own. Shown to the radiologist as a **change** (as in Word's tracked changes) — the UI word, never the code word.
_Avoid_: chunk, suggestion, edit

**Overlay**:
The visible rendering of pending hunks in the report — old lines struck, new lines shown — that is never part of the report buffer.
_Avoid_: tracked changes (the look), ghost text

**Decision**:
What the radiologist does to a hunk: **Accept** (lands as their own text), **Accept for review** (lands unreviewed), **Reject**. Same words in the UI and, in snake case, on the wire.
_Avoid_: insert/discard, approve/deny

**Clinical verb**:
The wire form of a decision an agent receives: `accept`, `accept_edit`, `reject`. Never "always".

**Human gate**:
The invariant (INV-1) that no byte enters the report buffer except through the radiologist's explicit act — typing, a decision on a hunk, or an editor command.
_Avoid_: sign-off (that is finalization), approval gate, HITL

**Unreviewed text**:
AI-proposed text that was accepted for review and has not yet been touched by the radiologist. Shown amber; clears line by line on edit or all at once.
_Avoid_: draft (a report status), AI draft, highlight

**Grant**:
The Client's memory that a decided proposal may be written by the agent: the path and the exact content the buffer now holds. Single-use, short-lived.

**Write outcome**:
What the Client tells the agent after a write: **applied** (the agent wrote what landed) or **partial** (the radiologist kept only part; re-read before building on it).

**Unsolicited write**:
A write no proposal preceded — typically from a Level 0 agent. It becomes a proposal before anything lands.

**Conflict**:
A hunk whose anchor can no longer be found because the radiologist changed those lines; the agent re-reads and re-proposes.

**Non-interference**:
The invariant that the radiologist's typing never blocks and is never overwritten while proposals are pending.

## Commands

**Command**:
A named action invoked by `/name` from the Commands menu or the in-report `/` menu; a skill can also be invoked from the sidebar composer, an editor command never can — the chat box is the agent's channel. Two kinds: editor command and skill.

**Editor command**:
A deterministic command the editor performs itself, instantly, without the agent. Two classes: document command and snippet command.
_Avoid_: local command, macro

**Document command**:
An editor command that produces the whole report buffer: `/template`, `/short-prelim`. Instant on a blank buffer; tracked changes on a non-blank one.

**Snippet command**:
An editor command that places one snippet at its home: `/er-reviewed`, `/er-not-reviewed`, `/discuss-with-dr`.

**Skill**:
A command the agent advertises and performs; its result is a proposal.
_Avoid_: agent command, slash command, tool (a tool is what the agent calls internally)

**Home**:
The fixed place in the report where a snippet belongs regardless of where the command was summoned — the impression head or the report end.
_Avoid_: anchor (a hunk's anchor is a different thing)

**Suggested**:
The context-aware group at the top of the command menu — the commands that fit the caret's section, a blank buffer, or the presence of priors.

## Lifecycle

**Report status**:
Where a report is in its life: **draft** → **preliminary** (optional) → **final**. Transitions are explicit acts of the radiologist.
_Avoid_: stage, state

**Short prelim**:
A preliminary communication consisting of the region's short-prelim paragraph and any critical findings, issued as the whole report buffer before the full report is written. A property of the report, not a status; it may coexist with draft.
_Avoid_: SP report, quick report

**Fold-in**:
What happens to a short prelim when the full report is scaffolded over it: its paragraph (minus "A full report will follow.") is placed after the impression items, before the discussed-with line, and the short-prelim flag clears.

**ER marker**:
The "ER Reviewed" / "ER Not Reviewed" snippet at the impression head, recording whether the attending reviewed a resident's report. Body text; changes no status. The two are mutually exclusive.

**Discussed-with line**:
The closing snippet recording which clinician the findings were discussed with, and when. Always the last block of a report.

**Sign-off**:
The attending's act that makes a report final and locks the buffer against every agent write.
_Avoid_: finalize, sign (as a status)

**Critical finding**:
An urgent imaging finding that must reach the clinician promptly — intracranial hemorrhage, acute large-territory infarct, aortic dissection, acute pulmonary embolism, pneumothorax, and their kin. What a short prelim lists and the discussed-with line records. Radiology meaning only.
_Avoid_: using it for anything the agent raises (that is a flag)

**QA gate**:
The check the editor runs when the radiologist issues a Prelim or signs off: first deterministic (not empty, no pending changes, no unreviewed text, no template blanks), then advisory (`/qa` → flags). Never blocks: the radiologist may proceed over open flags or without the agent — the *… anyway* button is the override, and the override is audited (`qa.overridden`, `qa.skipped`).
_Avoid_: validation, pre-commit hook, blocker

## Agent & protocol

**ACP**:
The Agent Client Protocol (v1) — the JSON-RPC contract between Client and Agent that everything here rides on.

**ACP-Rad profile**:
The radiology extension of ACP: the namespace, canonical Markdown, clinical verbs, levels, flags, audit — carried only in `_meta.rad` and `_rad/*` methods.
_Avoid_: the standard (that comes later), extension

**Bridge**:
The pipe that connects the browser Client to an agent's stdio. It parses nothing except the audit it persists.
_Avoid_: server, backend, gateway

**Session**:
One agent conversation bound to one accession, opened when the editor connects and closed with it.

**Focus**:
Where the radiologist's caret is, sent with a prompt so the agent knows which section is meant.

**Flag**:
What the agent raises when QA finds the report wanting: a kind, a one-line summary, the lines concerned. Rendered as a flag card with the line marked; changes nothing in the report. On the wire the Client acknowledges *receipt*; the radiologist acknowledges the *card*, which clears the mark.
_Avoid_: critical finding (that is an imaging finding), alert (the card), finding (the section), issue, warning

**Flag kind**:
Why a flag was raised — `discrepancy` (the report contradicts itself), `omission` (a critical or clinically significant finding missing from the impression), `unsupported` (an impression item with no basis in the findings), `critical_uncommunicated` (a critical finding with no record of communication). The only four; style has no kind.

**PHI boundary**:
The declared class of data an agent may see; this demo is `research_synthetic` — no real patient data, ever.

**Audit record**:
One entry in the trail of consequential events — reads, proposals, decisions, writes with their outcome, review clears, commands, cancels — stamped by the Client and never trusted from the agent.
