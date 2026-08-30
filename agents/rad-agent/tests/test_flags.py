"""``raise_flag``: one ``_rad/flag`` request per call; every failure comes back as text."""

from __future__ import annotations

from typing import Any

import pytest
from acp.exceptions import RequestError
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from pydantic import ValidationError

from rad_agent.flags import FLAG_METHOD, FlagArgs, make_raise_flag_tool

GOOD = {
    "kind": "discrepancy",
    "summary": "FINDINGS describe a right UPJ stone; IMPRESSION says left.",
    "locations": [{"path": "/worklist/ACC1/sections/impression.md", "line": 2}],
}


ACK: dict[str, Any] = {"outcome": "acknowledged"}


class FakeConn:
    def __init__(self, result: Any = ACK, raises: BaseException | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.result = result
        self.raises = raises

    async def ext_method(self, method: str, params: dict[str, Any]) -> Any:
        self.calls.append((method, params))
        if self.raises is not None:
            raise self.raises
        return self.result


async def test_raise_flag_sends_rad_flag_with_the_session_and_returns_acknowledged() -> None:
    conn = FakeConn()
    tool = make_raise_flag_tool(conn, "s1")
    assert tool.name == "raise_flag"
    out = await tool.ainvoke(GOOD)
    assert out == "flag raised (discrepancy): acknowledged"
    assert conn.calls == [
        (
            FLAG_METHOD,
            {
                "sessionId": "s1",
                "kind": "discrepancy",
                "summary": GOOD["summary"],
                "locations": [{"path": "/worklist/ACC1/sections/impression.md", "line": 2}],
            },
        )
    ]
    assert FLAG_METHOD == "rad/flag"  # the connection prepends the `_`


def test_the_schema_closes_the_kinds() -> None:
    assert FlagArgs.model_validate(GOOD).kind == "discrepancy"
    with pytest.raises(ValidationError):
        FlagArgs.model_validate({**GOOD, "kind": "style"})
    with pytest.raises(ValidationError):
        FlagArgs.model_validate({**GOOD, "summary": "x" * 501})
    with pytest.raises(ValidationError):
        FlagArgs.model_validate({**GOOD, "locations": [{"path": "/x", "line": 0}]})


async def test_a_bad_kind_reaches_the_model_as_an_error_message_not_an_exception() -> None:
    conn = FakeConn()
    # The real path: LangGraph's ToolNode with its default error handling, inside a graph.
    graph = StateGraph(MessagesState)
    graph.add_node("tools", ToolNode([make_raise_flag_tool(conn, "s1")]))
    graph.add_edge(START, "tools")
    graph.add_edge("tools", END)
    call = {
        "name": "raise_flag",
        "args": {**GOOD, "kind": "style"},
        "id": "c1",
        "type": "tool_call",
    }
    state = await graph.compile().ainvoke({"messages": [AIMessage(content="", tool_calls=[call])]})
    msg = state["messages"][-1]
    assert isinstance(msg, ToolMessage) and msg.status == "error"
    assert "discrepancy" in str(msg.content)  # the allowed kinds are named
    assert conn.calls == []  # nothing crossed the wire


@pytest.mark.parametrize(
    ("raises", "expect"),
    [
        (RequestError.method_not_found("_rad/flag"), "does not accept flags"),
        (RequestError.invalid_params({"summary": "too long"}), "rejected by the client"),
        (ConnectionError("pipe closed"), "connection lost"),
        (RuntimeError("boom"), "RuntimeError: boom"),
    ],
)
async def test_failures_come_back_as_text(raises: BaseException, expect: str) -> None:
    tool = make_raise_flag_tool(FakeConn(raises=raises), "s1")
    out = await tool.ainvoke(GOOD)
    assert expect in out


async def test_an_unexpected_outcome_is_reported() -> None:
    tool = make_raise_flag_tool(FakeConn(result={"outcome": "dismissed"}), "s1")
    assert "not acknowledged" in await tool.ainvoke(GOOD)
    tool = make_raise_flag_tool(FakeConn(result=None), "s1")
    assert "not acknowledged" in await tool.ainvoke(GOOD)
