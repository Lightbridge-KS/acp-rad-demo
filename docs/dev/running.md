---
summary: How to install, run, test, and switch LLM providers for the ACP-Rad PoC (bridge + editor + rad-agent).
read_when: Starting the app, running gates, changing RAD_MODEL, or debugging the transport chain.
---

# Running the PoC

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

```
browser editor ──ws frames──► bridge ──ndjson lines──► agent (stdio)
  ACP Client                 dumb pipe               ACP Agent
```

Agent logs go to **stderr** (shown in the bridge's terminal); stdout is the JSON-RPC wire.

## Model / provider

`agents/rad-agent` reads:

| Variable | Default | Meaning |
|---|---|---|
| `RAD_MODEL` | `openai:gpt-5` | LangChain provider string (`openai:…`, `anthropic:…`) |
| `RAD_MODEL_BASE_URL` | unset | If set, uses `ChatOpenAI(base_url=…)` — any OpenAI-compatible endpoint (Ollama: `http://localhost:11434/v1`) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | — | Provider keys; falls back to `ollama` when a base URL is set |
| `RAD_LOG_LEVEL` | `INFO` | Python logging level (stderr) |

Keys never live in the repo. Inject personal keys per run:

```sh
lb key run --env openai-personal -- just dev
lb key run --env anthropic-personal -- env RAD_MODEL=anthropic:claude-sonnet-5 just dev
RAD_MODEL=openai:gpt-oss:20b RAD_MODEL_BASE_URL=http://localhost:11434/v1 just dev   # offline, Ollama
```

A `.env` in `agents/rad-agent/` is also read (`python-dotenv`), gitignored.

## Gates

```sh
just check            # dry: tsc, vitest, ruff, mypy, pytest
just smoke            # live: starts the bridge, runs a headless ACP client end-to-end (needs an LLM)
```

## Troubleshooting

- **`OpenAIConnectionError: Connection error` with a hosted provider, while Ollama works** — check the
  cause chain; `SSLCertVerificationError: OSStatus -26276` means the `openai` SDK (macOS system trust
  store) is rejecting an intercepting proxy's certificate. Seen when the agent is launched from inside a
  sandboxed agent shell (Claude Code's egress proxy). Run the bridge/agent from a normal terminal.
- **Two agents spawn per page load in dev** — React StrictMode mounts twice; the first connection is
  closed immediately. Expected; production builds spawn once.
- **Agent stdout is the wire** — any `print()` in the agent corrupts JSON-RPC framing. Log to stderr.
