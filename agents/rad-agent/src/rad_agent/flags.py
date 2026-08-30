"""``raise_flag`` — the agent's second channel (design 04 §3.5, proposal §8.2).

A proposal may change bytes; a flag may not. The model calls ``raise_flag(kind, summary,
locations)``; the tool sends a ``_rad/flag`` request to the client, which records the flag,
marks the located line and answers ``{"outcome": "acknowledged"}`` on receipt. The radiologist's
own acknowledgement is a local act on the client, never seen here.

The schema, not the prompt, keeps style out: ``kind`` is a ``Literal`` of the four profile kinds,
so a fifth kind is a validation error the model reads and corrects. Like the backend, the tool
*returns* every failure as text — an exception raised inside a tool escapes the graph and kills
the ``session/prompt`` handler.
"""

from __future__ import annotations

import logging
from typing import Any, Literal, Protocol

from acp.exceptions import RequestError
from langchain_core.tools import BaseTool, tool
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

#: Passed to the connection's ``ext_method``, which prepends the ``_`` → ``_rad/flag`` on the wire.
FLAG_METHOD = "rad/flag"

FlagKind = Literal["discrepancy", "omission", "unsupported", "critical_uncommunicated"]

METHOD_NOT_FOUND = -32601


class FlagLocation(BaseModel):
    """One line the flag concerns."""

    path: str = Field(
        description="Virtual path of the file, e.g. /worklist/ACC0000001/sections/impression.md"
    )
    line: int | None = Field(
        default=None, ge=1, description="1-based line of that file as read_file showed it"
    )


class FlagArgs(BaseModel):
    """Arguments of ``raise_flag``; ``kind`` is closed by the profile."""

    kind: FlagKind = Field(
        description=(
            "discrepancy: the report contradicts itself · omission: a critical or clinically "
            "significant finding is missing from the IMPRESSION · unsupported: an IMPRESSION item "
            "has no basis in FINDINGS · critical_uncommunicated: a critical finding with no record "
            "of communication"
        )
    )
    summary: str = Field(
        min_length=1, max_length=500, description="One sentence naming what is wrong and where"
    )
    locations: list[FlagLocation] = Field(
        default_factory=list, description="The lines concerned; the first one is highlighted"
    )


class _ExtClient(Protocol):
    """The slice of the ACP connection the tool needs (keeps tests free of the SDK)."""

    async def ext_method(self, method: str, params: dict[str, Any]) -> Any: ...


RAISE_FLAG_DESCRIPTION = (
    "Raise a QA flag for the radiologist about this report: a discrepancy, an omission from the "
    "impression, an unsupported impression item, or an uncommunicated critical finding. A flag "
    "changes nothing in the report; the radiologist reads and acknowledges it. Never use it for "
    "style or wording."
)


def make_raise_flag_tool(conn: _ExtClient, session_id: str) -> BaseTool:
    """Build the per-session ``raise_flag`` tool bound to one ACP connection."""

    @tool("raise_flag", args_schema=FlagArgs, description=RAISE_FLAG_DESCRIPTION)
    async def raise_flag(
        kind: FlagKind, summary: str, locations: list[FlagLocation] | None = None
    ) -> str:
        params: dict[str, Any] = {
            "sessionId": session_id,
            "kind": kind,
            "summary": summary,
            "locations": [
                loc if isinstance(loc, dict) else loc.model_dump(exclude_none=True)
                for loc in locations or []
            ],
        }
        try:
            result = await conn.ext_method(FLAG_METHOD, params)
        except RequestError as exc:
            log.warning("flag rejected by the client: %s", exc)
            if exc.code == METHOD_NOT_FOUND:
                return "this client does not accept flags — describe the issue in chat instead"
            return f"flag rejected by the client: {exc}"
        except ConnectionError as exc:
            return f"flag not delivered: connection lost ({exc})"
        except Exception as exc:  # noqa: BLE001 — never raise across the tool boundary
            log.exception("_rad/flag failed")
            return f"flag not delivered: {type(exc).__name__}: {exc}"
        outcome = result.get("outcome") if isinstance(result, dict) else None
        if outcome != "acknowledged":
            return f"flag not acknowledged by the client (outcome={outcome!r})"
        log.info("flag raised (%s): %s", kind, summary)
        return f"flag raised ({kind}): acknowledged"

    return raise_flag


__all__ = ["FLAG_METHOD", "FlagArgs", "FlagLocation", "make_raise_flag_tool"]
