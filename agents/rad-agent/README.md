# rad-agent

The ACP-Rad **agent**: a `deepagents-acp` subclass that speaks the ACP-Rad profile (`_meta.rad`) over stdio. The bridge spawns it per WebSocket connection (`uv run --project agents/rad-agent rad-agent`).

- `rad_agent/server.py` — `RadReportAgentServer`: profile negotiation, accession binding, `_rad/*` routing.
- `rad_agent/agent.py` — the deep-agent graph (`create_deep_agent`).
- `rad_agent/config.py` — `RAD_MODEL` / `RAD_MODEL_BASE_URL` → model.
- `rad_agent/prompts/system.md` — system prompt.

stdout is the JSON-RPC wire; log to stderr only. See `docs/dev/running.md` for env vars and gates.
