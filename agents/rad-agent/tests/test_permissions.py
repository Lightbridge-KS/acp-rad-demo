"""PermissionRewritingClient: clinical verbs out, deepagents decisions back."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from acp.schema import PermissionOption

from rad_agent.permissions import CLINICAL_OPTIONS, PermissionRewritingClient


@dataclass
class _Outcome:
    outcome: str
    option_id: str | None = None


@dataclass
class _Response:
    outcome: _Outcome


@dataclass
class _ToolCall:
    tool_call_id: str = "call-1"


@dataclass
class FakeInner:
    answer: str | None = "accept_edit"
    seen: list[dict[str, Any]] = field(default_factory=list)

    async def request_permission(self, session_id, tool_call, options, **kwargs):
        self.seen.append({"session_id": session_id, "options": options, "kwargs": kwargs})
        if self.answer is None:
            return _Response(_Outcome("cancelled"))
        return _Response(_Outcome("selected", self.answer))

    async def read_text_file(self, session_id, path, line=None, limit=None):
        return f"delegated:{path}"


DEEPAGENTS_OPTIONS = [
    PermissionOption(option_id="approve", name="Approve", kind="allow_once"),
    PermissionOption(option_id="reject", name="Reject", kind="reject_once"),
    PermissionOption(option_id="approve_always", name="Always allow", kind="allow_always"),
]


async def test_options_are_replaced_by_the_clinical_trio() -> None:
    inner = FakeInner()
    client = PermissionRewritingClient(inner)
    await client.request_permission("s", _ToolCall(), DEEPAGENTS_OPTIONS)
    sent = inner.seen[0]["options"]
    assert [o.option_id for o in sent] == ["accept", "accept_edit", "reject"]
    assert [o.kind for o in sent] == ["allow_once", "allow_once", "reject_once"]
    assert all(o.kind != "allow_always" for o in sent)
    assert sent == CLINICAL_OPTIONS


async def test_accept_variants_map_to_approve_and_reject_to_reject() -> None:
    for verb, expected in [("accept", "approve"), ("accept_edit", "approve"), ("reject", "reject")]:
        client = PermissionRewritingClient(FakeInner(answer=verb))
        r = await client.request_permission("s", _ToolCall(), DEEPAGENTS_OPTIONS)
        assert r.outcome.option_id == expected


async def test_unknown_verb_is_treated_as_reject() -> None:
    client = PermissionRewritingClient(FakeInner(answer="approve_always"))
    r = await client.request_permission("s", _ToolCall(), DEEPAGENTS_OPTIONS)
    assert r.outcome.option_id == "reject"


async def test_cancelled_passes_through() -> None:
    client = PermissionRewritingClient(FakeInner(answer=None))
    r = await client.request_permission("s", _ToolCall(), DEEPAGENTS_OPTIONS)
    assert r.outcome.outcome == "cancelled" and r.outcome.option_id is None


async def test_other_methods_delegate() -> None:
    client = PermissionRewritingClient(FakeInner())
    assert await client.read_text_file("s", "/x") == "delegated:/x"
