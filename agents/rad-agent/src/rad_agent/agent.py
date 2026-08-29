"""The deep agent graph behind the ACP server."""

from __future__ import annotations

from pathlib import Path

from deepagents import create_deep_agent
from deepagents.backends import StateBackend
from deepagents_acp.server import AgentSessionContext
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph.state import CompiledStateGraph

from rad_agent.config import resolve_model

SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "system.md").read_text(encoding="utf-8")


def build_agent(context: AgentSessionContext) -> CompiledStateGraph:
    """Factory called by ``AgentServerACP`` at the first prompt of a session.

    Slice 1: default deepagents tool stack over an in-memory backend. Slice 2 swaps in
    ``AcpClientBackend`` (report access through the editor's ``fs/*``) and prunes tools.
    """
    del context  # cwd/mode/model unused until the backend swap
    return create_deep_agent(
        model=resolve_model(),
        system_prompt=SYSTEM_PROMPT,
        backend=StateBackend(),
        checkpointer=MemorySaver(),
    )
