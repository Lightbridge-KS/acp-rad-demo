"""The deep agent graph behind the ACP server."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from deepagents import FilesystemPermission, create_deep_agent
from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents_acp.server import AgentSessionContext
from langchain_core.tools import BaseTool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph.state import CompiledStateGraph

from rad_agent.config import resolve_model

SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "system.md").read_text(encoding="utf-8")

#: File tools exposed to the model. Writes are proposals: HITL interrupts them so the editor
#: shows the diff and asks the radiologist before anything runs.
FS_TOOLS = ["ls", "read_file", "glob", "grep", "edit_file", "write_file"]
WRITE_TOOLS = ["edit_file", "write_file"]

#: Read-only zones (defense in depth; the editor refuses these writes too).
READ_ONLY_PATHS = ["/priors/**", "/templates/**", "/snippets/**"]


def build_agent(
    context: AgentSessionContext,
    *,
    backend: BackendProtocol,
    accession: str | None,
    tools: Sequence[BaseTool] = (),
) -> CompiledStateGraph:
    """Factory called by ``RadReportAgentServer`` at the first prompt of a session.

    The backend is bound to that session's ACP connection, so every file tool the model
    calls is served by the editor (``fs/read_text_file`` / ``fs/write_text_file``) rather
    than a real filesystem. ``tools`` adds profile tools bound to the same session
    (``raise_flag`` when the client accepts flags); none of them writes, so none is interrupted.
    """
    files_note = (
        "\n\n## Files\n"
        f"Your working root is `{context.cwd}` (accession {accession or 'unknown'}). "
        "The report is `report.md`; each section is also a file under `sections/` "
        "(history, technique, comparison, findings, impression). Read the section you need "
        "before answering — never guess its content. `/priors/`, `/templates/` and `/snippets/` "
        "are read-only reference material. Use `ls` on `/` to see everything available.\n\n"
        "## Editing\n"
        "Propose edits with `edit_file` on the section file (`sections/impression.md`, …), "
        "one section per call, using the exact current line(s) as `old_string`. Prefer "
        "`edit_file` over `write_file`. The radiologist reviews every proposal as tracked "
        "changes and may accept only part of it — re-read the section before building on an "
        "edit, and never claim an edit is in the report until you have read it back."
    )
    return create_deep_agent(
        model=resolve_model(),
        tools=list(tools),
        system_prompt=SYSTEM_PROMPT + files_note,
        backend=backend,
        middleware=[
            FilesystemMiddleware(
                backend=backend,
                tools=FS_TOOLS,  # type: ignore[arg-type]
                tool_token_limit_before_evict=None,  # never spill to /large_tool_results
            )
        ],
        interrupt_on={tool: {"allowed_decisions": ["approve", "reject"]} for tool in WRITE_TOOLS},
        permissions=[
            FilesystemPermission(operations=["write"], paths=READ_ONLY_PATHS, mode="deny")
        ],
        checkpointer=MemorySaver(),
    )
