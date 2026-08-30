"""``RadReportAgentServer`` — deepagents-acp's ``AgentServerACP`` plus the ACP-Rad profile.

Profile additions ride in ``_meta.rad`` (ACP v1 has no other extension slot):

- ``initialize`` result advertises the agent's rad capabilities (Level 1 by presence).
- ``session/new`` binds the session to an accession from the client's ``_meta.rad`` and
  advertises the skills (``available_commands_update``, design 04 §1).
- ``session/prompt`` expands ``/skill [arg]`` into the skill's authored text.
- ``_rad/flag`` is sent *to* the client by the ``raise_flag`` tool (``rad_agent.flags``) when
  the client negotiated ``flags``; incoming ``_rad/*`` requests route to ``ext_method`` (none).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from acp.exceptions import RequestError
from acp.helpers import update_available_commands
from acp.schema import (
    AudioContentBlock,
    ClientCapabilities,
    EmbeddedResourceContentBlock,
    ImageContentBlock,
    Implementation,
    InitializeResponse,
    NewSessionResponse,
    PromptResponse,
    ResourceContentBlock,
    TextContentBlock,
)
from deepagents_acp.server import AgentServerACP, AgentSessionContext
from langgraph.graph.state import CompiledStateGraph

from rad_agent import AGENT_NAME, PROFILE_VERSION
from rad_agent.agent import build_agent
from rad_agent.backend import AcpClientBackend
from rad_agent.config import model_options, model_spec
from rad_agent.flags import make_raise_flag_tool
from rad_agent.permissions import PermissionRewritingClient
from rad_agent.skills import Skill, advertise, expand, load_skills

log = logging.getLogger(__name__)

RAD_META_KEY = "rad"

#: What this agent implements of the profile. ``flags`` ⇒ Level 2 (rad-native).
AGENT_RAD_CAPS: dict[str, Any] = {
    "profileVersion": PROFILE_VERSION,
    "focusState": False,
    "flags": True,
    "codedContent": [],
}


def rad_meta(kwargs: dict[str, Any]) -> dict[str, Any] | None:
    """Extract ``_meta.rad`` from a handler's ``**kwargs``.

    The Python SDK router spreads the request's ``_meta`` *contents* into kwargs
    (``acp.utils.model_to_kwargs``), so ``_meta.rad`` arrives as ``kwargs["rad"]``.
    A nested ``field_meta``/``_meta`` dict is also accepted for direct calls.
    """
    rad = kwargs.get(RAD_META_KEY)
    if isinstance(rad, dict):
        return rad
    for key in ("field_meta", "_meta"):
        meta = kwargs.get(key)
        if isinstance(meta, dict) and isinstance(meta.get(RAD_META_KEY), dict):
            return meta[RAD_META_KEY]
    return None


class RadReportAgentServer(AgentServerACP):
    """AgentServerACP speaking the ACP-Rad profile.

    The agent graph is built per session (deepagents-acp calls the factory lazily at the
    first prompt) with an ``AcpClientBackend`` bound to that session, so the model's file
    tools are served by the editor.
    """

    def __init__(self, **kwargs: Any) -> None:
        # `models=` makes deepagents-acp advertise a `model` select in `session/new`'s
        # configOptions and honour `session/set_config_option` (rebuilding the graph with
        # `context.model`) — the provider switch is plain ACP, nothing profile-specific.
        super().__init__(agent=self._build_agent, models=model_options(), **kwargs)
        self.session_rad: dict[str, dict[str, Any]] = {}
        self.client_rad_caps: dict[str, Any] | None = None
        self._current_session_id: str | None = None
        self.skills: dict[str, Skill] = load_skills()
        self._background: set[asyncio.Task[None]] = set()

    def on_connect(self, conn: Any) -> None:
        """Wrap the connection so permission requests carry the clinical verbs."""
        super().on_connect(PermissionRewritingClient(conn))

    # deepagents-acp's AgentSessionContext carries no session id; capture it here.
    def _reset_agent(self, session_id: str) -> None:
        self._current_session_id = session_id
        super()._reset_agent(session_id)

    def _build_agent(self, context: AgentSessionContext) -> CompiledStateGraph:
        session_id = self._current_session_id
        if session_id is None:  # pragma: no cover — deepagents-acp always resets first
            raise RuntimeError("agent factory called without a session")
        rad = self.session_rad.get(session_id, {})
        manifest = rad.get("manifest") or []
        if not manifest:
            log.warning("session %s has no manifest; ls/glob/grep will be empty", session_id)
        backend = AcpClientBackend(self._conn, session_id, list(manifest))
        # Profile tools only when the client negotiated the capability (a Level-1 client
        # would answer `_rad/flag` with method-not-found).
        tools = [make_raise_flag_tool(self._conn, session_id)] if self._client_has("flags") else []
        return build_agent(context, backend=backend, accession=rad.get("accession"), tools=tools)

    def _client_has(self, cap: str) -> bool:
        return bool((self.client_rad_caps or {}).get(cap))

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: ClientCapabilities | None = None,
        client_info: Implementation | None = None,
        **kwargs: Any,
    ) -> InitializeResponse:
        response = await super().initialize(
            protocol_version, client_capabilities, client_info, **kwargs
        )
        self.client_rad_caps = rad_meta(kwargs)
        log.info(
            "initialize: client=%s rad caps=%s",
            client_info.name if client_info else "?",
            self.client_rad_caps,
        )
        return response.model_copy(
            update={
                "agent_info": Implementation(name=AGENT_NAME, version="0.1.0"),
                "field_meta": {RAD_META_KEY: {**AGENT_RAD_CAPS, "model": model_spec()}},
            }
        )

    async def new_session(
        self,
        cwd: str,
        additional_directories: list[Any] | None = None,
        mcp_servers: list[Any] | None = None,  # McpServer variants; passed through untouched
        **kwargs: Any,
    ) -> NewSessionResponse:
        response = await super().new_session(cwd, additional_directories, mcp_servers, **kwargs)
        rad = rad_meta(kwargs)
        if rad is not None:
            self.session_rad[response.session_id] = rad
        log.info(
            "session/new: id=%s cwd=%s accession=%s",
            response.session_id,
            cwd,
            rad.get("accession") if rad else None,
        )
        self._advertise_skills(response.session_id)
        return response

    def _advertise_skills(self, session_id: str) -> None:
        """Send ``available_commands_update`` once the ``session/new`` response is on its way.

        Scheduled as a task so the response precedes the notification for strict clients.
        Tests may construct the server without a connection — then there is nobody to tell.
        """
        conn = getattr(self, "_conn", None)
        send = getattr(conn, "session_update", None)
        if send is None or not self.skills:
            return
        update = update_available_commands(advertise(self.skills, self.client_rad_caps))
        task = asyncio.create_task(send(session_id=session_id, update=update))
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def prompt(  # type: ignore[override]  # deepagents-acp and acp.Agent order the params differently; the router passes keywords
        self,
        prompt: list[
            TextContentBlock
            | ImageContentBlock
            | AudioContentBlock
            | ResourceContentBlock
            | EmbeddedResourceContentBlock
        ],
        session_id: str,
        message_id: str | None = None,
        **kwargs: Any,
    ) -> PromptResponse:
        """A ``/skill [arg]`` prompt becomes the skill's authored text; anything else passes."""
        blocks = list(prompt)
        for i, block in enumerate(blocks):
            if isinstance(block, TextContentBlock):
                expanded = expand(block.text, self.skills)
                if expanded != block.text:
                    log.info("skill %s expanded (%d chars)", block.text.split()[0], len(expanded))
                    blocks[i] = block.model_copy(update={"text": expanded})
                break
        return await super().prompt(
            prompt=blocks, session_id=session_id, message_id=message_id, **kwargs
        )

    async def ext_method(self, name: str, payload: dict[str, Any]) -> Any:
        """Handle ``_``-prefixed requests. Nothing implemented yet (slice 5 adds rad tools)."""
        del payload
        raise RequestError.method_not_found(f"_{name}")

    async def ext_notification(self, name: str, payload: dict[str, Any]) -> None:
        """Ignore unknown ``_``-prefixed notifications, per ACP."""
        log.debug("ignoring ext notification _%s: %s", name, payload)
