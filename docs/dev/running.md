---
summary: How to install, run, test, and switch LLM providers for the ACP-Rad Demo (bridge + editor + rad-agent).
read_when: Starting the app, running gates, changing RAD_MODEL, or debugging the transport chain.
---

# Running the demo

## Install

```sh
just install          # pnpm install + uv sync --project agents/rad-agent
```

## Run

```sh
just dev              # bridge (ws://localhost:8787/acp) + editor (http://localhost:5173)
```

The bridge spawns the agent **per WebSocket connection** from `apps/bridge/agents.json`:
`?agent=rad` (default, our Python agent), `?agent=claude`, `?agent=gemini` (Level 0 spike targets).

The editor picks its case from the page URL until the worklist lands (slice 6): `http://localhost:5173/?case=<id>` with `ct-brain-er-stroke` (default; impression blanked), `ct-brain-er-blank` (scenario 0), `cxr-pa-prior` and `ct-chest-er-nodule-prior` (priors for `/compare`), `ct-wa-er-stone` (a planted laterality discrepancy for `/qa`, scenario 3). Fixtures live in `apps/editor/fixtures/<id>/` — `meta.json`, `report.md`, `priors/<accession>.md` + `priors/index.md`; all synthetic.

```
browser editor ──ws frames──► bridge ──ndjson lines──► agent (stdio)
  ACP Client                 dumb pipe               ACP Agent
```

Agent logs go to **stderr** (shown in the bridge's terminal); stdout is the JSON-RPC wire.

## Model / provider

`agents/rad-agent` reads:

| Variable | Default | Meaning |
|---|---|---|
| `RAD_MODELS` | unset | Comma-separated LangChain provider strings the session can **switch between in the app** (the model select in the sidebar header); the first is the default |
| `RAD_MODEL` | `openai:gpt-5.6-terra` | A single provider string (`openai:…`, `anthropic:…`); used when `RAD_MODELS` is unset |
| `RAD_MODEL_BASE_URL` | unset | If set, uses `ChatOpenAI(base_url=…)` — any OpenAI-compatible endpoint (Ollama: `http://localhost:11434/v1`). Global: every entry of `RAD_MODELS` then goes to that endpoint, so a list mixes hosted models *or* Ollama models, not both |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | — | Provider keys; falls back to `ollama` when a base URL is set |
| `RAD_LOG_LEVEL` | `INFO` | Python logging level (stderr) |

Keys never live in the repo. Put them in a **`.env` at the repo root** (gitignored; `cp .env.example .env` and fill in what you use) — the agent reads it at start through `python-dotenv`, so `just dev` and `just smoke` need no shell setup. Plain environment variables work too and override the file:

```sh
just dev                                                                    # keys + model from .env
RAD_MODEL=anthropic:claude-sonnet-5 just dev                                # one model
RAD_MODELS=openai:gpt-5.6-terra,anthropic:claude-sonnet-5 just dev          # switchable in the app
RAD_MODEL=openai:gpt-oss:20b RAD_MODEL_BASE_URL=http://localhost:11434/v1 just dev   # offline, Ollama, no key
```

**Switching in the app** is plain ACP: the agent advertises a `model` select in `session/new`'s `configOptions` (always, even with one entry), the sidebar header renders it, and a change sends `session/set_config_option` — the agent rebuilds its graph for that session (its chat memory starts over; the transcript in the sidebar stays). The choice is per session: a worklist switch or a reload returns to the default. Audited as `session.config → model=<spec>`.


## Gates

```sh
just check            # dry: tsc, vitest, ruff, mypy, pytest
just smoke            # live: starts the bridge, runs a headless ACP client end-to-end (needs an LLM)

`just smoke` starts its own bridge on 8787 — stop `just dev` first, or run `cd apps/bridge && node scripts/smoke.ts` against the running bridge (which already carries the key). Stage 2 of the smoke opens a second session on `ct-chest-er-nodule-prior` and checks the skills advertisement and `/compare`.
```

## Tracing the wire

`BRIDGE_TRACE=1 just dev` logs one line per JSON-RPC frame in each direction (method and id only,
never params) — the quickest way to see whether a `session/update`, `request_permission` or
`fs/write_text_file` actually crossed the bridge.

## Audit trail

The editor stamps an `AuditRecord` for every consequential event (reads, proposals, per-hunk
decisions, permission answers, writes with their outcome, draft clears, cancels) and sends it up
the ACP connection as a `_rad/audit` notification. The bridge intercepts those frames — the one
thing it ever parses — and appends them to **`audit/{accession}.jsonl`** at the repo root
(`AUDIT_DIR` overrides; gitignored). The sidebar's *Audit* tab shows the same records live.

## Troubleshooting

- **`OpenAIConnectionError: Connection error` with a hosted provider, while Ollama works** — check the
  cause chain; `SSLCertVerificationError: OSStatus -26276` means the `openai` SDK (macOS system trust
  store) is rejecting an intercepting proxy's certificate. Seen when the agent is launched from inside a
  sandboxed agent shell (Claude Code's egress proxy). Run the bridge/agent from a normal terminal.
- **Two agents spawn per page load in dev** — React StrictMode mounts twice; the first connection is
  closed immediately. Expected; production builds spawn once.
- **Agent stdout is the wire** — any `print()` in the agent corrupts JSON-RPC framing. Log to stderr.
