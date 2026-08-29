# acp-rad-poc

PoC: a radiology report editor (QuillJS, browser) hosting an AI agent through the **Agent Client Protocol (ACP)**, extended by the **ACP-Rad** profile. The radiologist prompts; the agent proposes; every write is approved in the editor. Demo target: radiology colleagues at Ramathibodi. Later: the profile consolidates into a separate standard.

## Read first

- `CONTEXT.md` — the glossary; use its terms for every name and label.
- `docs/design/01-system-architecture.md` — C1–C3, key flows, the profile as exercised, invariants.
- `docs/design/02-surface-architecture.md` — what the radiologist and the agent see: commands, `/` menu, the human gate, lifecycle.
- `docs/design/03-agentic-architecture.md` — the agent's organs: loop, tools over `fs/*`, the HITL gate split across the boundary.
- `docs/progress/overview-poc.md` — where we are; update it as slices land.
- `docs/ideas/acp-rad-protocol-proposal.md` — the profile proposal (draft; deltas listed in design 01 §8). Original one-file draft: `docs/archive/design/acp-rad-poc-spec.md` (§0 survey, §11 ledger).
- `docs/dev/running.md` — how to run and switch models.

## Layout

```
apps/editor      Vite + React 19 + TS + QuillJS 2 + Tailwind 4 — the ACP CLIENT (browser). Owns INV-1 (human gate), RO rules, audit.
apps/bridge      Node 26 + ws — WebSocket ⇄ stdio launcher for ACP agents (dumb pipe; agents.json). Runs TS natively, no build.
agents/rad-agent Python 3.13 (uv) — deepagents-acp subclass; the ACP AGENT. stdout is the wire: log to stderr only.
packages/acp-rad TS, framework-free — the profile as code (zod schemas for _meta.rad, section ids, error codes).
docs/            design · progress · dev · ideas
_playground/     gitignored spikes (session dirs with NOTES.md); _temp/ is gitignored raw material.
```

## Commands

`just` lists recipes. `just install` · `just dev` (bridge + editor) · `just check` (dry gates) · `just smoke` (live tracer, needs an LLM).

## Conventions

- Protocol: ACP **v1** (`protocolVersion: 1`). Profile extensions ride only in `_meta.rad` and `_rad/*` methods — never new root fields.
- Report grammar: Ramathibodi label-lines (`**HISTORY:** …`, `**Organ:** …`, `- ` bullets), no headings. Sections: history · technique · comparison · findings · impression.
- The agent is untrusted. Anything that enforces an invariant lives in `apps/editor`.
- No PHI, ever. Fixtures are synthetic (`phiBoundary: research_synthetic`).
- TS: strict, explicit types at boundaries, `import type`. Python: ruff + mypy, NumPy docstrings for public API.
- Conventional Commits; direct commits to `main` in this early phase.
