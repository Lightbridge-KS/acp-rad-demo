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

# Build and run the containerized demo (editor at http://127.0.0.1:8080 by default)
up:
    docker compose up --build

# Stop the containerized demo; the audit volume is retained
down:
    docker compose down

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

# Slides: Quarto revealjs → HTML, then PDF through Reveal's own print route (Chrome headless, ?print-pdf)
slides:
    #!/usr/bin/env zsh
    set -euo pipefail
    quarto render presentation
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    (cd presentation/_output && python3 -m http.server 8123 >/dev/null 2>&1 &)
    trap 'pkill -f "http.server 8123" 2>/dev/null || true' EXIT
    for i in {1..25}; do curl -sf localhost:8123/acp-rad-demo.html >/dev/null && break; sleep 0.2; done
    "$CHROME" --headless=new --disable-gpu --window-size=1400,900 --no-pdf-header-footer \
      --virtual-time-budget=20000 --print-to-pdf=presentation/_output/acp-rad-demo.pdf \
      'http://localhost:8123/acp-rad-demo.html?print-pdf' 2>/dev/null
    echo "→ presentation/_output/acp-rad-demo.{html,pdf}"
