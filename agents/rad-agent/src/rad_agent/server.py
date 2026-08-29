"""``RadAgentServer`` — deepagents-acp's ``AgentServerACP`` plus the ACP-Rad profile.

Profile additions ride in ``_meta.rad`` (ACP v1 has no other extension slot):

- ``initialize`` result advertises the agent's rad capabilities (Level 1 by presence).
- ``session/new`` binds the session to an accession from the client's ``_meta.rad``.
- ``_rad/*`` extension methods are routed to ``ext_method`` (none implemented yet).
"""

from __future__ import annotations

import logging
from typing import Any

from acp.exceptions import RequestError
from acp.schema import (
    ClientCapabilities,
    Implementation,
    InitializeResponse,
    NewSessionResponse,
)
from deepagents_acp.server import AgentServerACP

from rad_agent import AGENT_NAME, PROFILE_VERSION
from rad_agent.config import model_spec

log = logging.getLogger(__name__)

RAD_META_KEY = "rad"

#: What this agent implements of the profile. Level = 1 (present, no L2 caps) for now;
#: ``criticalFindings`` flips to True in slice 5.
AGENT_RAD_CAPS: dict[str, Any] = {
    "profileVersion": PROFILE_VERSION,
    "focusState": False,
    "criticalFindings": False,
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


class RadAgentServer(AgentServerACP):
    """AgentServerACP speaking the ACP-Rad profile."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.session_rad: dict[str, dict[str, Any]] = {}
        self.client_rad_caps: dict[str, Any] | None = None

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
        return response

    async def ext_method(self, name: str, payload: dict[str, Any]) -> Any:
        """Handle ``_``-prefixed requests. Nothing implemented yet (slice 5 adds rad tools)."""
        del payload
        raise RequestError.method_not_found(f"_{name}")

    async def ext_notification(self, name: str, payload: dict[str, Any]) -> None:
        """Ignore unknown ``_``-prefixed notifications, per ACP."""
        log.debug("ignoring ext notification _%s: %s", name, payload)
