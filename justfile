# ACP-Rad Demo — task runner (polyglot: pnpm workspace + uv project)

set shell := ["zsh", "-cu"]

agent_dir := "agents/rad-agent"

default:
    @just --list

# Install everything (Node workspace + Python agent)
install:
    pnpm install
    uv sync --project {{agent_dir}}

# Run bridge + editor together (agent is spawned by the bridge per connection)
dev:
    pnpm dev

# Bridge only (ws://localhost:8787/acp)
bridge:
    pnpm --filter bridge dev

# Editor only (http://localhost:5173)
editor:
    pnpm --filter editor dev

# Run the rad-agent on stdio (for manual JSON-RPC poking)
agent:
    uv run --project {{agent_dir}} rad-agent

# Dry gates: typecheck + unit tests, TS and Python
check:
    pnpm typecheck
    pnpm test
    uv run --project {{agent_dir}} ruff check {{agent_dir}}
    uv run --project {{agent_dir}} ruff format --check {{agent_dir}}
    uv run --project {{agent_dir}} mypy {{agent_dir}}/src
    uv run --project {{agent_dir}} pytest {{agent_dir}} -q

# Live gate: start the bridge, run the headless tracer smoke, stop the bridge
smoke:
    #!/usr/bin/env zsh
    set -euo pipefail
    node apps/bridge/src/index.ts &
    BR=$!
    trap 'kill $BR 2>/dev/null || true' EXIT
    for i in {1..50}; do curl -sf localhost:8787/health >/dev/null && break; sleep 0.2; done
    (cd apps/bridge && node scripts/smoke.ts)
