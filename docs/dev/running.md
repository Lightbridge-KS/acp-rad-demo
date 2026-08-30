---
summary: How to install, run, containerize, test, and switch LLM providers for the ACP-Rad Demo (bridge + editor + rad-agent).
read_when: Starting or deploying the app, running gates, changing RAD_MODEL, or debugging the transport chain.
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

The header's worklist select opens any case; `http://localhost:5173/?case=<id>` deep-links one and stays in sync: `ct-brain-er-stroke` (default; impression blanked), `ct-brain-er-blank` (scenario 0), `cxr-pa-prior` and `ct-chest-er-nodule-prior` (priors for `/compare`), `ct-wa-er-stone` (a planted laterality discrepancy for `/qa`, scenario 3). Fixtures live in `apps/editor/fixtures/<id>/` — `meta.json`, `report.md`, `priors/<accession>.md` + `priors/index.md`; all synthetic.

```
browser editor ──ws frames──► bridge ──ndjson lines──► agent (stdio)
  ACP Client                 dumb pipe               ACP Agent
```

Agent logs go to **stderr** (shown in the bridge's terminal); stdout is the JSON-RPC wire.

## Docker Compose

The root `Dockerfile` has two final targets: `editor` builds the Vite app and serves it from
nginx; `bridge` combines Node 26 with the locked Python 3.13 rad-agent environment because the
bridge spawns one agent subprocess per WebSocket. `compose.yaml` runs both:

```sh
cp .env.example .env      # add the provider configuration you use
just up                    # docker compose up --build
# open http://127.0.0.1:8080
just down                  # containers/network removed; audit volume retained
```

nginx serves one browser origin: `/` is the static editor; `/health` and the
upgraded `/acp` WebSocket proxy to `bridge:8787`. The editor derives `ws://` or `wss://` from
`window.location`; the native Vite server proxies the same paths during `just dev`.
`VITE_BRIDGE_URL` remains an escape hatch and is intentionally unset on Vercel.

Compose publishes the app to `127.0.0.1:8080` by default and the bridge to loopback port 8787
only for the repository smoke client. Override `APP_PORT` or `BRIDGE_HOST_PORT` if those ports
are occupied. For a Tailscale-only demo, bind the app to that machine's Tailscale address:

```sh
APP_HOST=<tailscale-ip> just up
```

There is **no app-level authentication or TLS termination** in Compose. Keep this deployment on
localhost or behind Tailscale; the Vercel deployment supplies TLS but is likewise anonymous.
The one-process memory adapter still limits the bridge to ten agent sockets. The container registry
contains only `rad-agent`; the deferred Level 0 Claude/Gemini agents are intentionally absent.

Provider variables are read from `.env` and explicitly passed to the bridge. For Ollama on the
Docker host, use `RAD_MODEL_BASE_URL=http://host.docker.internal:11434/v1` rather than
`localhost`. Audit JSONL is stored in the named `audit-data` volume and survives `just down`;
`docker compose down -v` is the explicit destructive reset.

## Model / provider

`agents/rad-agent` reads:

| Variable | Default | Meaning |
|---|---|---|
| `RAD_MODELS` | unset | Comma-separated LangChain provider strings the session can **switch between in the app** (the model select in the sidebar header); the first is the default |
| `RAD_MODEL` | `openai:gpt-5.6-terra` | A single provider string (`openai:…`, `anthropic:…`); used when `RAD_MODELS` is unset |
| `RAD_MODEL_BASE_URL` | unset | If set, uses `ChatOpenAI(base_url=…)` — any OpenAI-compatible endpoint (Ollama: `http://localhost:11434/v1`). Global: every entry of `RAD_MODELS` then goes to that endpoint, so a list mixes hosted models *or* Ollama models, not both |
| `AI_GATEWAY_API_KEY` | unset | Preferred credential whenever `RAD_MODEL_BASE_URL` is set; Production Vercel uses a dedicated budgeted key |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | — | Local/direct-provider keys; `OPENAI_API_KEY` is the base-URL fallback, then `ollama` |
| `RAD_LOG_LEVEL` | `INFO` | Python logging level (stderr) |

Keys never live in the repo. Put them in a **`.env` at the repo root** (gitignored; `cp .env.example .env` and fill in what you use) — the agent reads it at start through `python-dotenv`, so `just dev` and `just smoke` need no shell setup. Plain environment variables work too and override the file:

```sh
just dev                                                                    # keys + model from .env
RAD_MODEL=anthropic:claude-sonnet-5 just dev                                # one model
RAD_MODELS=openai:gpt-5.6-terra,anthropic:claude-sonnet-5 just dev          # switchable in the app
RAD_MODEL=openai:gpt-oss:20b RAD_MODEL_BASE_URL=http://localhost:11434/v1 just dev   # offline, Ollama, no key
```

**Switching in the app** is plain ACP: the agent advertises a `model` select in `session/new`'s `configOptions` (always, even with one entry), the sidebar header renders it, and a change sends `session/set_config_option` — the agent rebuilds its graph for that session (its chat memory starts over; the transcript in the sidebar stays). The choice is per session: a worklist switch or a reload returns to the default. Audited as `session.config → model=<spec>`.

On any unexpected WebSocket close, unfinished proposals are cancelled and the running turn ends as
an error. The report, transcript, flags, and in-memory audit remain in the browser. Reconnection is
never automatic: click **Reconnect agent** to create a fresh ACP/agent session with no restored agent
memory. Hosted setup and rotation procedures are in [`docs/deploy/vercel.md`](../deploy/vercel.md).


## Gates

```sh
just check            # dry: tsc, vitest, ruff, mypy, pytest
just smoke            # live: starts the bridge, runs a headless ACP client end-to-end (needs an LLM)
```

`just smoke` starts its own bridge on 8787 — stop `just dev` first, or run `cd apps/bridge && node scripts/smoke.ts` against the running bridge (which already carries the key). Stage 2 of the smoke opens a second session on `ct-chest-er-nodule-prior` and checks the skills advertisement and `/compare`.

Against Compose, keep the services running and use the second form: port 8787 is published only
on loopback for this purpose.

## Slides

```sh
just slides           # presentation/_output/acp-rad-demo.{html,pdf}
```

Quarto revealjs (`presentation/`). The PDF goes through Reveal's own print route — Chrome headless on
`?print-pdf` with `--window-size` set (the default 800×600 window shrinks every slide). `decktape` is
not used: its bundled Chrome for Testing fails to launch here, and its capture clips mermaid labels.

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
On Vercel the sink is instead an environment-scoped Redis list with a rolling seven-day TTL.

## Troubleshooting

- **`OpenAIConnectionError: Connection error` with a hosted provider, while Ollama works** — check the
  cause chain; `SSLCertVerificationError: OSStatus -26276` means the `openai` SDK (macOS system trust
  store) is rejecting an intercepting proxy's certificate. Seen when the agent is launched from inside a
  sandboxed agent shell (Claude Code's egress proxy). Run the bridge/agent from a normal terminal.
- **Two agents spawn per page load in dev** — React StrictMode mounts twice; the first connection is
  closed immediately. Expected; production builds spawn once.
- **Agent stdout is the wire** — any `print()` in the agent corrupts JSON-RPC framing. Log to stderr.
