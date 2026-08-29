"""The deep agent graph behind the ACP server."""

from __future__ import annotations

from pathlib import Path

from deepagents import create_deep_agent
from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents_acp.server import AgentSessionContext
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph.state import CompiledStateGraph

from rad_agent.config import resolve_model

SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "system.md").read_text(encoding="utf-8")

#: Read-only tool set for this slice; ``write_file``/``edit_file`` join in slice 3.
READ_TOOLS = ["ls", "read_file", "glob", "grep"]


def build_agent(
    context: AgentSessionContext, *, backend: BackendProtocol, accession: str | None
) -> CompiledStateGraph:
    """Factory called by ``RadAgentServer`` at the first prompt of a session.

    The backend is bound to that session's ACP connection, so every file tool the model
    calls is served by the editor (``fs/read_text_file``) rather than a real filesystem.
    """
    files_note = (
        "\n\n## Files\n"
        f"Your working root is `{context.cwd}` (accession {accession or 'unknown'}). "
        "The report is `report.md`; each section is also a file under `sections/` "
        "(history, technique, comparison, findings, impression). Read the section you need "
        "before answering — never guess its content. `/priors/`, `/templates/` and `/snippets/` "
        "are read-only reference material. Use `ls` on `/` to see everything available."
    )
    return create_deep_agent(
        model=resolve_model(),
        system_prompt=SYSTEM_PROMPT + files_note,
        backend=backend,
        middleware=[
            FilesystemMiddleware(
                backend=backend,
                tools=READ_TOOLS,  # type: ignore[arg-type]
                tool_token_limit_before_evict=None,  # never spill to /large_tool_results
            )
        ],
        checkpointer=MemorySaver(),
    )
