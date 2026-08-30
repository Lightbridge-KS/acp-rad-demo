"""Skills: one file per skill, advertised at session/new, expanded at prompt time."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from rad_agent.server import RadReportAgentServer
from rad_agent.skills import SKILLS_DIR, advertise, expand, load_skills, parse_skill


def test_every_skill_file_parses_and_is_advertised() -> None:
    skills = load_skills()
    names = sorted(p.stem for p in SKILLS_DIR.glob("*.md"))
    assert list(skills) == names == ["compare", "impression", "proofread", "qa"]
    # `/qa` needs the client's `flags` capability: hidden without it, advertised with it.
    assert skills["qa"].requires == "flags"
    assert [a.name for a in advertise(skills)] == ["compare", "impression", "proofread"]
    assert [a.name for a in advertise(skills, {"flags": False})] == [
        "compare",
        "impression",
        "proofread",
    ]
    ads = advertise(skills, {"profileVersion": "0.1", "flags": True})
    assert [a.name for a in ads] == names
    by_name = {a.name: a for a in ads}
    assert by_name["compare"].input is not None
    assert by_name["compare"].input.root.hint == "[prior accession]"
    assert by_name["impression"].input is None
    assert all(a.description for a in ads)


def test_parse_skill_frontmatter_and_body() -> None:
    s = parse_skill("x", "---\ndescription: Do x\nhint: [thing]\n---\nBody with {arg}.\n")
    assert (s.description, s.hint, s.requires) == ("Do x", "[thing]", None)
    assert parse_skill("q", "---\ndescription: Q\nrequires: flags\n---\nbody").requires == "flags"
    assert s.expand("A1") == "Body with A1."
    assert s.expand(None) == "Body with ."
    with pytest.raises(ValueError):
        parse_skill("bad", "no frontmatter")
    with pytest.raises(ValueError):
        parse_skill("bad", "---\nhint: only\n---\nbody")


def test_expand_substitutes_and_passes_unknown_text_through() -> None:
    skills = load_skills()
    assert expand("/compare ACC0000011", skills).startswith("Read `meta.json`")
    assert "`ACC0000011`" in expand("/compare ACC0000011", skills)
    assert expand("/impression", skills) == skills["impression"].expand(None)
    for text in ("/nope", "hello /compare", "compare", "/Compare"):
        assert expand(text, skills) == text


async def test_new_session_advertises_skills_after_the_response() -> None:
    sent: list[tuple[str, object]] = []

    class FakeConn:
        async def session_update(self, session_id: str, update: object, **kwargs: object) -> None:
            sent.append((session_id, update))

    server = RadReportAgentServer()
    server._conn = FakeConn()  # type: ignore[assignment]
    created = await server.new_session("/worklist/ACC1", mcp_servers=[], rad={"accession": "ACC1"})
    assert sent == []  # scheduled, not yet sent
    await asyncio.sleep(0)
    assert len(sent) == 1
    session_id, update = sent[0]
    assert session_id == created.session_id
    assert update.session_update == "available_commands_update"
    assert [c.name for c in update.available_commands] == ["compare", "impression", "proofread"]


async def test_new_session_advertises_qa_when_the_client_accepts_flags() -> None:
    sent: list[object] = []

    class FakeConn:
        async def session_update(self, session_id: str, update: object, **kwargs: object) -> None:
            sent.append(update)

    server = RadReportAgentServer()
    server._conn = FakeConn()  # type: ignore[assignment]
    server.client_rad_caps = {"profileVersion": "0.1", "flags": True}
    await server.new_session("/worklist/ACC1", mcp_servers=[], rad={"accession": "ACC1"})
    await asyncio.sleep(0)
    assert [c.name for c in sent[0].available_commands] == [
        "compare",
        "impression",
        "proofread",
        "qa",
    ]  # type: ignore[attr-defined]


async def test_new_session_without_a_connection_is_silent() -> None:
    server = RadReportAgentServer()
    server._conn = object()  # type: ignore[assignment]
    await server.new_session("/worklist/ACC1", mcp_servers=[], rad={"accession": "ACC1"})


async def test_prompt_expands_the_first_text_block(monkeypatch: pytest.MonkeyPatch) -> None:
    from acp.schema import TextContentBlock
    from deepagents_acp.server import AgentServerACP

    seen: dict[str, object] = {}

    async def fake_prompt(self, prompt, session_id, message_id=None, **kwargs):  # type: ignore[no-untyped-def]
        seen["prompt"] = prompt
        seen["session_id"] = session_id
        return "ok"

    monkeypatch.setattr(AgentServerACP, "prompt", fake_prompt)
    server = RadReportAgentServer()
    blocks = [TextContentBlock(type="text", text="/impression")]
    await server.prompt(prompt=blocks, session_id="s1")
    out = seen["prompt"]
    assert isinstance(out, list) and out[0].text == server.skills["impression"].expand(None)
    assert seen["session_id"] == "s1"
    plain = [TextContentBlock(type="text", text="what does the report say?")]
    await server.prompt(prompt=plain, session_id="s1")
    assert seen["prompt"][0].text == "what does the report say?"


def test_skill_files_live_in_the_package() -> None:
    assert (Path(SKILLS_DIR) / "compare.md").exists()
