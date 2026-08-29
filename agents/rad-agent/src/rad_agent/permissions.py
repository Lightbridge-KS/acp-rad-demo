"""Clinical permission verbs on the wire (proposal §7.2).

deepagents-acp hardcodes ``approve`` / ``reject`` / ``approve_always`` inside its
``_handle_interrupts``. Rather than copy that method, the server wraps the ACP client
connection: every ``session/request_permission`` goes out with the profile's three verbs
(no ``allow_always`` — INV-1) and the radiologist's answer is mapped back to what
deepagents-acp expects. Everything else is delegated untouched.
"""

from __future__ import annotations

import logging
from typing import Any

from acp.schema import PermissionOption

log = logging.getLogger(__name__)

CLINICAL_OPTIONS: list[PermissionOption] = [
    PermissionOption(option_id="accept", name="Insert into report", kind="allow_once"),
    PermissionOption(option_id="accept_edit", name="Insert as editable draft", kind="allow_once"),
    PermissionOption(option_id="reject", name="Discard", kind="reject_once"),
]

#: Radiologist's verb → deepagents HITL decision type.
VERB_TO_DECISION: dict[str, str] = {
    "accept": "approve",
    "accept_edit": "approve",
    "reject": "reject",
}


class PermissionRewritingClient:
    """Proxy over ``acp.Client`` that speaks clinical verbs to the editor."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    async def request_permission(
        self, session_id: str, tool_call: Any, options: list[PermissionOption], **kwargs: Any
    ) -> Any:
        del options  # deepagents' approve/reject/approve_always are replaced wholesale
        response = await self._inner.request_permission(
            session_id=session_id, tool_call=tool_call, options=list(CLINICAL_OPTIONS), **kwargs
        )
        outcome = getattr(response, "outcome", None)
        option_id = getattr(outcome, "option_id", None)
        if outcome is not None and option_id is not None:
            mapped = VERB_TO_DECISION.get(option_id)
            if mapped is None:
                log.warning("unknown permission verb %r; treating as reject", option_id)
                mapped = "reject"
            log.info("permission %s → %s (%s)", tool_call.tool_call_id, option_id, mapped)
            outcome.option_id = mapped
        else:
            log.info("permission %s → cancelled", tool_call.tool_call_id)
        return response

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)
