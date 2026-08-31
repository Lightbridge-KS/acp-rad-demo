"""``RadReportAgentServer`` — deepagents-acp's ``AgentServerACP`` plus the ACP-Rad profile.

Profile additions ride in ``_meta.rad`` (ACP v1 has no other extension slot):

- ``initialize`` result advertises the agent's rad capabilities (Level 1 by presence).
- ``session/new`` binds the session to an accession from the client's ``_meta.rad``, resolves
  the skill layers over that session's namespace and advertises them
  (``available_commands_update``, design 04 §1).
- ``session/prompt`` loads the instructions of every skill the radiologist mentioned, before the
  model runs — a mention is deterministic, not a suggestion the model may decline.
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
from deepagents.backends.composite import CompositeBackend
from deepagents_acp.server import AgentServerACP, AgentSessionContext
from langgraph.graph.state import CompiledStateGraph

from rad_agent import AGENT_NAME, PROFILE_VERSION
from rad_agent.agent import build_agent
from rad_agent.backend import AcpClientBackend
from rad_agent.config import model_options, model_spec
from rad_agent.flags import make_raise_flag_tool
from rad_agent.permissions import PermissionRewritingClient
from rad_agent.skills import (
    EFFECTIVE_ROOT,
    EffectiveSkillsBackend,
    advertise,
    mentioned_skills,
    skill_name_from_path,
)

log = logging.getLogger(__name__)

RAD_META_KEY = "rad"


def _uri_path(uri: str) -> str:
    """The namespace path inside a resource link — `file://` is optional and carries no meaning."""
    return uri[len("file://") :] if uri.startswith("file://") else uri


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
        #: One skills backend per session — it caches the layer resolution, and the manifest it
        #: resolves from is itself fixed at `session/new`, so there is nothing to invalidate.
        self._skills: dict[str, EffectiveSkillsBackend] = {}
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
        client = AcpClientBackend(self._conn, session_id, list(manifest))
        # The composed skills are agent-side: the Client serves its own `house`/`personal`
        # layers as ordinary read-only paths, but the *composition* of those with `builtin` is
        # ours, and it must live behind one readable path for the model to load it.
        skills = self._skills_backend(session_id)
        backend = (
            CompositeBackend(default=client, routes={EFFECTIVE_ROOT: skills})
            if skills is not None
            else client
        )
        # Profile tools only when the client negotiated the capability (a Level-1 client
        # would answer `_rad/flag` with method-not-found).
        tools = [make_raise_flag_tool(self._conn, session_id)] if self._client_has("flags") else []
        return build_agent(context, backend=backend, accession=rad.get("accession"), tools=tools)

    def _client_has(self, cap: str) -> bool:
        return bool((self.client_rad_caps or {}).get(cap))

    def _skills_backend(self, session_id: str) -> EffectiveSkillsBackend | None:
        """The session's skills backend, created on first use and cached.

        ``None`` before the connection exists (tests build the server bare) — the agent then
        simply offers no skills rather than failing.
        """
        existing = self._skills.get(session_id)
        if existing is not None:
            return existing
        conn = getattr(self, "_conn", None)
        if conn is None or not hasattr(conn, "read_text_file"):
            return None
        manifest = list(self.session_rad.get(session_id, {}).get("manifest") or [])
        backend = EffectiveSkillsBackend(
            client=AcpClientBackend(conn, session_id, manifest),
            manifest=manifest,
            caps=self.client_rad_caps,
        )
        self._skills[session_id] = backend
        return backend

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

        Scheduled as a task so the response precedes the notification for strict clients, and
        because resolving the layers now costs one round-trip back to the client for every
        ``SKILL.md`` it serves. Tests may construct the server without a connection — then there
        is nobody to tell.
        """
        conn = getattr(self, "_conn", None)
        send = getattr(conn, "session_update", None)
        backend = self._skills_backend(session_id)
        if send is None or backend is None:
            return
        task = asyncio.create_task(self._resolve_and_advertise(session_id, backend, send))
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _resolve_and_advertise(
        self, session_id: str, backend: EffectiveSkillsBackend, send: Any
    ) -> None:
        """Resolve the layers, then tell the client what this agent can do for it.

        The advertisement is built from the *resolved* skills, so it already reflects the
        institution's and the radiologist's layers and hides anything whose client capability
        was never negotiated. A failure here costs the command menu, never the session.
        """
        try:
            skills = await backend.skills()
        except Exception:  # noqa: BLE001 — a broken skill layer must not kill the session
            log.exception("skill resolution failed for session %s; advertising none", session_id)
            return
        if not skills:
            return
        update = update_available_commands(advertise(skills, self.client_rad_caps))
        await send(session_id=session_id, update=update)

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
        """Load the instructions of every skill the radiologist mentioned, before the model runs.

        The radiologist's own words are never rewritten — the skill text is prepended as its own
        block. A mention is **resolved, not suggested**: a model that decided to skip loading
        the house's impression policy would produce a plausible, unguided draft, and nothing
        about the result would show that the policy never applied.

        Discovery stays lazy the other way round: with no mention, the model may still read any
        skill the middleware listed, on its own judgement.
        """
        blocks = list(prompt)
        preamble = await self._skill_preamble(blocks, session_id)
        if preamble is not None:
            blocks.insert(0, TextContentBlock(type="text", text=preamble))
        return await super().prompt(
            prompt=blocks, session_id=session_id, message_id=message_id, **kwargs
        )

    async def _skill_preamble(self, blocks: list[Any], session_id: str) -> str | None:
        """The instruction text for the skills this prompt mentions, or ``None`` for none."""
        backend = self._skills_backend(session_id)
        if backend is None:
            return None
        try:
            skills = await backend.skills()
        except Exception:  # noqa: BLE001 — a broken layer degrades to "no skill", never a crash
            log.exception("skill resolution failed for session %s", session_id)
            return None
        if not skills:
            return None

        names: list[str] = []
        for block in blocks:
            found: list[str] = []
            if isinstance(block, ResourceContentBlock):
                # An ACP resource_link is how the editor sends a `/mention` structurally.
                name = skill_name_from_path(_uri_path(block.uri))
                found = [name] if name else []
            elif isinstance(block, TextContentBlock):
                # …and this catches a hand-typed `/impression`, which must behave identically.
                found = mentioned_skills(block.text, list(skills))
            names.extend(n for n in found if n in skills and n not in names)
        if not names:
            return None

        parts = []
        for name in names:
            skill = skills[name]
            log.info(
                "skill %s loaded: layers=%s digest=%s chars=%d",
                skill.name,
                "+".join(skill.layers),
                skill.digest,
                len(skill.body),
            )
            layers = "+".join(skill.layers)
            parts.append(f'<skill name="{skill.name}" layers="{layers}">\n{skill.body}\n</skill>')
        return (
            "The radiologist invoked the skill(s) below. Follow them for this turn; they are "
            "already composed for this institution and this radiologist, so do not read them "
            "again.\n\n" + "\n\n".join(parts)
        )

    async def ext_method(self, name: str, payload: dict[str, Any]) -> Any:
        """Handle ``_``-prefixed requests. Nothing implemented yet (slice 5 adds rad tools)."""
        del payload
        raise RequestError.method_not_found(f"_{name}")

    async def ext_notification(self, name: str, payload: dict[str, Any]) -> None:
        """Ignore unknown ``_``-prefixed notifications, per ACP."""
        log.debug("ignoring ext notification _%s: %s", name, payload)
