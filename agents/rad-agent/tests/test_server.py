"""RadAgentServer profile behaviour, exercised by direct method calls (no wire)."""

from __future__ import annotations

import pytest
from acp.exceptions import RequestError
from acp.schema import Implementation

from rad_agent.server import AGENT_RAD_CAPS, RadAgentServer, rad_meta


def _server() -> RadAgentServer:
    def build_agent(_context):  # never called in these tests
        raise AssertionError("agent factory should not run at initialize/new_session")

    return RadAgentServer(agent=build_agent)


async def test_initialize_advertises_rad_caps_and_agent_info() -> None:
    server = _server()
    # The SDK router spreads _meta contents into kwargs: _meta.rad → rad=...
    response = await server.initialize(
        1,
        client_info=Implementation(name="test-client", version="0"),
        rad={"profileVersion": "0.1", "focusState": True},
    )
    assert response.protocol_version == 1
    assert response.agent_info is not None and response.agent_info.name == "rad-agent"
    assert response.field_meta is not None
    rad = response.field_meta["rad"]
    assert {k: rad[k] for k in AGENT_RAD_CAPS} == AGENT_RAD_CAPS
    assert isinstance(rad["model"], str) and rad["model"]
    assert server.client_rad_caps == {"profileVersion": "0.1", "focusState": True}


async def test_initialize_serializes_meta_under_alias() -> None:
    response = await _server().initialize(1)
    wire = response.model_dump(by_alias=True, exclude_none=True)
    assert wire["_meta"]["rad"]["profileVersion"] == "0.1"


async def test_new_session_binds_accession_from_meta() -> None:
    server = _server()
    response = await server.new_session(
        "/worklist/ACC0000001",
        mcp_servers=[],
        rad={"accession": "ACC0000001", "modality": "CT"},
    )
    assert server.session_rad[response.session_id]["accession"] == "ACC0000001"


async def test_new_session_without_meta_is_level0_friendly() -> None:
    server = _server()
    response = await server.new_session("/tmp/anything", mcp_servers=[])
    assert response.session_id
    assert response.session_id not in server.session_rad


async def test_ext_method_is_not_found() -> None:
    with pytest.raises(RequestError):
        await _server().ext_method("rad/unknown", {})


def test_rad_meta_accepts_spread_and_nested_forms() -> None:
    assert rad_meta({"rad": {"a": 1}}) == {"a": 1}  # what the SDK router actually passes
    assert rad_meta({"field_meta": {"rad": {"a": 1}}}) == {"a": 1}
    assert rad_meta({"_meta": {"rad": {"a": 1}}}) == {"a": 1}
    assert rad_meta({"rad": "not-a-dict"}) is None
    assert rad_meta({"field_meta": {"other": 1}}) is None
    assert rad_meta({}) is None
