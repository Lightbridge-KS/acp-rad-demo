"""Entry point: serve the rad-agent over stdio (the bridge spawns this)."""

from __future__ import annotations

import asyncio
import logging
import os
import sys

from acp import run_agent
from dotenv import load_dotenv

from rad_agent.agent import build_agent
from rad_agent.config import model_spec
from rad_agent.server import RadAgentServer


def main() -> None:
    load_dotenv()
    # stdout is the JSON-RPC wire; every log line must go to stderr.
    logging.basicConfig(
        stream=sys.stderr,
        level=os.environ.get("RAD_LOG_LEVEL", "INFO"),
        format="[rad-agent] %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger(__name__).info("starting; model=%s", model_spec())
    # AgentServerACP leaves optional ACP methods (authenticate, fork/list/resume/close
    # session) unimplemented; the SDK router answers them with "method not found".
    # deepagents-acp instantiates it the same way — runtime-safe, only mypy objects.
    server = RadAgentServer(agent=build_agent)  # type: ignore[abstract]
    asyncio.run(run_agent(server))


if __name__ == "__main__":
    main()
