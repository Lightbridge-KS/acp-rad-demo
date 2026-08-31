"""Skills: Agent Skills folders resolved across builtin → house → personal.

Layering, sealing, capability gating, the synthetic `/skills/effective/` backend, and the two
ways a skill reaches a turn — a mention (resolved eagerly, here) or the model's own judgement
(lazy, via SkillsMiddleware, not exercised here).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import pytest
from acp.schema import ResourceContentBlock, TextContentBlock

from rad_agent.server import RadReportAgentServer
from rad_agent.skills import (
    BUILTIN_SKILLS_DIR,
    EffectiveSkillsBackend,
    SkillFile,
    advertise,
    client_skill_paths,
    compose,
    load_builtin,
    mentioned_skills,
    parse_skill_file,
    skill_name_from_path,
)

HOUSE_QA = "---\nname: qa\ndescription: house checks\n---\nAlso check the prelim marker.\n"
PERSONAL_QA = "---\nname: qa\ndescription: my checks\n---\nAlso check lesion sizes.\n"
PERSONAL_IMPRESSION = "---\nname: impression\ndescription: mine\n---\nEnd with a recommendation.\n"


@dataclass
class _Resp:
    content: str


class FakeConn:
    """The slice of the ACP client the skills path uses: one read, one notification."""

    def __init__(self, files: dict[str, str] | None = None) -> None:
        self.files = files or {}
        self.sent: list[object] = []
        self.reads: list[str] = []

    async def read_text_file(self, session_id: str, path: str, **kwargs: object) -> _Resp:
        del session_id, kwargs
        self.reads.append(path)
        if path not in self.files:
            from acp.exceptions import RequestError

            raise RequestError(-32004, f"not found: {path}")
        return _Resp(content=self.files[path])

    async def session_update(self, session_id: str, update: object, **kwargs: object) -> None:
        del session_id, kwargs
        self.sent.append(update)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def test_parse_skill_file_reads_frontmatter_and_body() -> None:
    parsed = parse_skill_file(
        "house", "---\nname: qa\ndescription: d\nmetadata:\n  hint: '[x]'\n---\nBody.\n"
    )
    assert parsed.meta["name"] == "qa"
    assert parsed.body == "Body."
    assert parsed.extras == {"hint": "[x]"}


@pytest.mark.parametrize(
    "text",
    [
        "no frontmatter at all\n",
        "---\nname: qa\n---\nbody\n",  # no description
        "---\ndescription: d\n---\nbody\n",  # no name
        "---\n- not a mapping\n---\nbody\n",
        "---\nname: [unclosed\n---\nbody\n",
    ],
)
def test_parse_skill_file_rejects_malformed(text: str) -> None:
    with pytest.raises(ValueError):
        parse_skill_file("house", text)


def test_every_builtin_skill_parses_and_names_its_directory() -> None:
    builtin = load_builtin()
    assert sorted(builtin) == ["compare", "impression", "proofread", "qa"]
    for name, skill in builtin.items():
        assert skill.meta["name"] == name  # upstream requires it; a mismatch only warns there
        assert skill.body.strip()
    assert (BUILTIN_SKILLS_DIR / "compare" / "SKILL.md").exists()


# ---------------------------------------------------------------------------
# Composition — the reason this design exists
# ---------------------------------------------------------------------------


def _file(layer: str, name: str, body: str, **extras: object) -> SkillFile:
    meta: dict[str, object] = {"name": name, "description": f"{layer} {name}"}
    if extras:
        meta["metadata"] = extras
    return SkillFile(layer=layer, meta=meta, body=body)


def test_an_ordinary_skill_is_replaced_by_the_last_layer() -> None:
    s = compose(
        "impression",
        [_file("builtin", "impression", "base"), _file("personal", "impression", "mine")],
    )
    assert s.body == "mine"
    assert s.layers == ("personal",)
    assert s.sealed is False
    assert s.description == "personal impression"


def test_a_sealed_skill_composes_every_layer_in_order() -> None:
    s = compose(
        "qa",
        [
            _file("builtin", "qa", "base checks", sealed=True),
            _file("house", "qa", "house checks"),
            _file("personal", "qa", "my checks"),
        ],
    )
    assert s.sealed is True
    assert s.body == "base checks\n\nhouse checks\n\nmy checks"
    assert s.layers == ("builtin", "house", "personal")
    # The base layer keeps ownership of the identity, so a later layer cannot restate the purpose.
    assert s.description == "builtin qa"


def test_the_base_body_survives_even_when_later_layers_are_present() -> None:
    s = compose(
        "qa",
        [_file("builtin", "qa", "NEVER SKIP THIS", sealed=True), _file("personal", "qa", "mine")],
    )
    assert s.body.startswith("NEVER SKIP THIS")


def test_only_the_base_layer_may_seal() -> None:
    # Otherwise a middle layer could seal itself and lock out the layer above it — the inverse
    # of what sealing is for.
    s = compose("qa", [_file("house", "qa", "house", sealed=True), _file("personal", "qa", "mine")])
    assert s.sealed is False
    assert s.body == "mine"


def test_a_layer_that_exists_alone_is_served_alone() -> None:
    s = compose("house-only", [_file("house", "house-only", "just this")])
    assert s.body == "just this"
    assert s.layers == ("house",)


def test_sealed_accepts_the_string_a_stringifying_parser_would_hand_us() -> None:
    for value in (True, "true", "True", "yes", "1"):
        s = compose(
            "qa", [_file("builtin", "qa", "base", sealed=value), _file("personal", "qa", "mine")]
        )
        assert s.sealed is True, value
    for value in (False, "false", "no", ""):
        s = compose(
            "qa", [_file("builtin", "qa", "base", sealed=value), _file("personal", "qa", "mine")]
        )
        assert s.sealed is False, value


def test_the_composed_document_is_itself_a_valid_skill_file() -> None:
    s = compose("qa", [_file("builtin", "qa", "base", sealed=True), _file("house", "qa", "extra")])
    reparsed = parse_skill_file("effective", s.document())
    assert reparsed.meta["name"] == "qa"
    assert reparsed.body == "base\n\nextra"


def test_the_digest_tracks_the_composed_body_not_the_base() -> None:
    base = compose("qa", [_file("builtin", "qa", "base", sealed=True)])
    extended = compose(
        "qa", [_file("builtin", "qa", "base", sealed=True), _file("house", "qa", "extra")]
    )
    assert base.digest != extended.digest  # the audit can tell the two turns apart


def test_a_description_with_yaml_punctuation_survives_the_round_trip() -> None:
    src = SkillFile(
        layer="builtin", meta={"name": "qa", "description": "Check: sizes, sides — 60 mL"}, body="b"
    )
    assert (
        parse_skill_file("x", compose("qa", [src]).document()).meta["description"]
        == "Check: sizes, sides — 60 mL"
    )


# ---------------------------------------------------------------------------
# Discovery and gating
# ---------------------------------------------------------------------------


def test_client_skill_paths_reads_the_manifest() -> None:
    found = client_skill_paths(
        [
            "/worklist/ACC1/report.md",
            "/skills/house/qa/SKILL.md",
            "/skills/personal/qa/SKILL.md",
            "/skills/personal/impression/SKILL.md",
            "/skills/house/qa/references/guide.md",  # not a SKILL.md
            "/skills/builtin/qa/SKILL.md",  # never client-served
        ]
    )
    assert found == {
        "qa": [
            ("house", "/skills/house/qa/SKILL.md"),
            ("personal", "/skills/personal/qa/SKILL.md"),
        ],
        "impression": [("personal", "/skills/personal/impression/SKILL.md")],
    }


async def _backend(
    files: dict[str, str], caps: dict[str, object] | None = None
) -> EffectiveSkillsBackend:
    from rad_agent.backend import AcpClientBackend

    conn = FakeConn(files)
    return EffectiveSkillsBackend(
        client=AcpClientBackend(conn, "s1", list(files)),
        manifest=list(files),
        caps=caps,
    )


async def test_resolution_folds_the_client_layers_onto_the_builtin_ones() -> None:
    backend = await _backend(
        {
            "/skills/house/qa/SKILL.md": HOUSE_QA,
            "/skills/personal/impression/SKILL.md": PERSONAL_IMPRESSION,
        },
        caps={"flags": True},
    )
    skills = await backend.skills()
    assert sorted(skills) == ["compare", "impression", "proofread", "qa"]
    assert skills["qa"].layers == ("builtin", "house")
    assert "Also check the prelim marker." in skills["qa"].body
    assert skills["impression"].layers == ("personal",)
    assert skills["impression"].body == "End with a recommendation."
    assert skills["compare"].layers == ("builtin",)


async def test_a_skill_whose_capability_was_not_negotiated_is_omitted_entirely() -> None:
    # Not merely unadvertised: listing it would send the model after a tool that is not bound.
    without = await (await _backend({})).skills()
    assert "qa" not in without
    with_flags = await (await _backend({}, caps={"flags": True})).skills()
    assert "qa" in with_flags


async def test_a_malformed_client_layer_is_skipped_and_the_base_survives() -> None:
    backend = await _backend(
        {"/skills/house/qa/SKILL.md": "garbage, no frontmatter\n"}, caps={"flags": True}
    )
    skills = await backend.skills()
    assert skills["qa"].layers == ("builtin",)
    assert skills["qa"].body.startswith("Read `report.md`")


async def test_resolution_happens_once_however_many_callers_ask() -> None:
    from rad_agent.backend import AcpClientBackend

    conn = FakeConn({"/skills/house/qa/SKILL.md": HOUSE_QA})
    backend = EffectiveSkillsBackend(
        client=AcpClientBackend(conn, "s1", ["/skills/house/qa/SKILL.md"]),
        manifest=["/skills/house/qa/SKILL.md"],
        caps={"flags": True},
    )
    await asyncio.gather(backend.skills(), backend.skills(), backend.skills())
    assert conn.reads.count("/skills/house/qa/SKILL.md") == 1


# ---------------------------------------------------------------------------
# The synthetic backend — what SkillsMiddleware and read_file actually call
# ---------------------------------------------------------------------------


async def test_als_lists_a_directory_per_skill_and_marks_it_a_directory() -> None:
    # `is_dir` is optional on FileInfo; omitting it makes the middleware find zero skills, silently.
    result = await (await _backend({}, caps={"flags": True})).als("/")
    assert result.error is None
    assert all(e["is_dir"] for e in result.entries or [])
    assert {e["path"] for e in result.entries or []} == {
        "/compare/",
        "/impression/",
        "/proofread/",
        "/qa/",
    }


async def test_adownload_files_returns_the_composed_document_in_order() -> None:
    backend = await _backend({"/skills/house/qa/SKILL.md": HOUSE_QA}, caps={"flags": True})
    responses = await backend.adownload_files(
        ["/qa/SKILL.md", "/nope/SKILL.md", "/compare/SKILL.md"]
    )
    assert [r.path for r in responses] == ["/qa/SKILL.md", "/nope/SKILL.md", "/compare/SKILL.md"]
    assert b"Also check the prelim marker." in (responses[0].content or b"")
    # The literal the middleware treats as "not a skill" rather than a fault worth warning about.
    assert responses[1].error == "file_not_found"
    assert responses[1].content is None


async def test_aread_serves_the_same_text_read_file_would_get() -> None:
    backend = await _backend({}, caps={"flags": True})
    result = await backend.aread("/qa/SKILL.md")
    assert result.error is None
    assert "raise_flag" in str(result.file_data)
    assert (await backend.aread("/nope/SKILL.md")).error


# ---------------------------------------------------------------------------
# Mentions
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("/impression", ["impression"]),
        ("Please explain the /impression", ["impression"]),  # mid-sentence, the Claude.ai shape
        ("please run /qa on this", ["qa"]),
        ("/compare ACC0000011", ["compare"]),
        ("/impression then /qa", ["impression", "qa"]),
        ("/qa /qa", ["qa"]),  # deduplicated
        ("what does the report say?", []),
        ("/nope", []),  # unknown names are not mentions
        ("the study on dd/mm/yyyy", []),  # a slash inside a word never opens a mention
        ("scan 2/5 shows", []),
    ],
)
def test_mentioned_skills(text: str, expected: list[str]) -> None:
    assert mentioned_skills(text, ["impression", "compare", "proofread", "qa"]) == expected


def test_skill_name_from_path() -> None:
    assert skill_name_from_path("/skills/effective/qa/SKILL.md") == "qa"
    assert skill_name_from_path("/skills/house/qa/SKILL.md") is None
    assert skill_name_from_path("/skills/effective/qa/references/x.md") is None


def test_advertise_lists_resolved_skills_with_their_hints() -> None:
    skills = {
        "compare": compose("compare", [_file("builtin", "compare", "b", hint="[prior accession]")]),
        "impression": compose("impression", [_file("builtin", "impression", "b")]),
    }
    ads = advertise(skills)
    assert [a.name for a in ads] == ["compare", "impression"]
    assert ads[0].input.root.hint == "[prior accession]"
    assert ads[1].input is None


# ---------------------------------------------------------------------------
# The server: advertisement at session/new, resolution at prompt time
# ---------------------------------------------------------------------------


async def _session(
    conn: FakeConn, caps: dict[str, object] | None = None
) -> tuple[RadReportAgentServer, str]:
    server = RadReportAgentServer()
    server._conn = conn  # type: ignore[assignment]
    if caps is not None:
        server.client_rad_caps = caps
    created = await server.new_session(
        "/worklist/ACC1", mcp_servers=[], rad={"accession": "ACC1", "manifest": list(conn.files)}
    )
    return server, created.session_id


async def test_new_session_advertises_the_resolved_skills_after_the_response() -> None:
    conn = FakeConn()
    server, session_id = await _session(conn)
    assert conn.sent == []  # scheduled, not yet sent: the response goes first
    del server
    for _ in range(4):
        await asyncio.sleep(0)
    assert len(conn.sent) == 1
    update = conn.sent[0]
    assert update.session_update == "available_commands_update"  # type: ignore[attr-defined]
    assert [c.name for c in update.available_commands] == ["compare", "impression", "proofread"]  # type: ignore[attr-defined]
    del session_id


async def test_qa_is_advertised_only_when_the_client_accepts_flags() -> None:
    conn = FakeConn()
    await _session(conn, caps={"profileVersion": "0.1", "flags": True})
    for _ in range(4):
        await asyncio.sleep(0)
    assert [c.name for c in conn.sent[0].available_commands] == [  # type: ignore[attr-defined]
        "compare",
        "impression",
        "proofread",
        "qa",
    ]


async def test_a_house_skill_reaches_the_advertisement() -> None:
    house_only = "---\nname: triage\ndescription: house only\n---\nDo it.\n"
    conn = FakeConn({"/skills/house/triage/SKILL.md": house_only})
    await _session(conn)
    for _ in range(4):
        await asyncio.sleep(0)
    ads = {c.name: c.description for c in conn.sent[0].available_commands}  # type: ignore[attr-defined]
    assert ads["triage"] == "house only"


async def test_new_session_without_a_connection_is_silent() -> None:
    server = RadReportAgentServer()
    server._conn = object()  # type: ignore[assignment]
    await server.new_session("/worklist/ACC1", mcp_servers=[], rad={"accession": "ACC1"})


async def test_a_mention_loads_the_skill_and_keeps_the_radiologist_s_words(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deepagents_acp.server import AgentServerACP

    seen: dict[str, object] = {}

    async def fake_prompt(self, prompt, session_id, message_id=None, **kwargs):  # type: ignore[no-untyped-def]
        seen["prompt"] = prompt
        seen["session_id"] = session_id
        return "ok"

    monkeypatch.setattr(AgentServerACP, "prompt", fake_prompt)
    conn = FakeConn({"/skills/personal/impression/SKILL.md": PERSONAL_IMPRESSION})
    server, session_id = await _session(conn)

    await server.prompt(
        prompt=[TextContentBlock(type="text", text="Please explain the /impression")],
        session_id=session_id,
    )
    blocks = seen["prompt"]
    assert isinstance(blocks, list) and len(blocks) == 2
    assert "End with a recommendation." in blocks[0].text
    assert 'layers="personal"' in blocks[0].text
    assert blocks[1].text == "Please explain the /impression"  # never rewritten
    assert seen["session_id"] == session_id


async def test_a_prompt_with_no_mention_is_passed_through_untouched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deepagents_acp.server import AgentServerACP

    seen: dict[str, object] = {}

    async def fake_prompt(self, prompt, session_id, message_id=None, **kwargs):  # type: ignore[no-untyped-def]
        seen["prompt"] = prompt
        return "ok"

    monkeypatch.setattr(AgentServerACP, "prompt", fake_prompt)
    conn = FakeConn()
    server, session_id = await _session(conn)
    await server.prompt(
        prompt=[TextContentBlock(type="text", text="what does the report say?")],
        session_id=session_id,
    )
    assert [b.text for b in seen["prompt"]] == ["what does the report say?"]  # type: ignore[union-attr]


async def test_a_resource_link_mention_resolves_the_same_way(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deepagents_acp.server import AgentServerACP

    seen: dict[str, object] = {}

    async def fake_prompt(self, prompt, session_id, message_id=None, **kwargs):  # type: ignore[no-untyped-def]
        seen["prompt"] = prompt
        return "ok"

    monkeypatch.setattr(AgentServerACP, "prompt", fake_prompt)
    conn = FakeConn()
    server, session_id = await _session(conn)
    await server.prompt(
        prompt=[
            TextContentBlock(type="text", text="have a look"),
            ResourceContentBlock(
                type="resource_link", name="impression", uri="/skills/effective/impression/SKILL.md"
            ),
        ],
        session_id=session_id,
    )
    blocks = seen["prompt"]
    assert "Propose the IMPRESSION as `- ` items" in blocks[0].text  # type: ignore[index]


async def test_a_sealed_skill_arrives_composed_at_prompt_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deepagents_acp.server import AgentServerACP

    seen: dict[str, object] = {}

    async def fake_prompt(self, prompt, session_id, message_id=None, **kwargs):  # type: ignore[no-untyped-def]
        seen["prompt"] = prompt
        return "ok"

    monkeypatch.setattr(AgentServerACP, "prompt", fake_prompt)
    conn = FakeConn(
        {"/skills/house/qa/SKILL.md": HOUSE_QA, "/skills/personal/qa/SKILL.md": PERSONAL_QA}
    )
    server, session_id = await _session(conn, caps={"flags": True})
    await server.prompt(prompt=[TextContentBlock(type="text", text="/qa")], session_id=session_id)
    loaded = seen["prompt"][0].text  # type: ignore[index]
    assert 'layers="builtin+house+personal"' in loaded
    assert "raise_flag" in loaded  # base
    assert "Also check the prelim marker." in loaded  # house
    assert "Also check lesion sizes." in loaded  # personal


async def test_skills_middleware_discovers_them_through_the_composite_route() -> None:
    """End to end: what the middleware finds, and whether the path it advertises resolves.

    Two silent failure modes live here. `als` entries must carry `is_dir` or discovery yields
    zero skills with no error at all; and the path the middleware renders into the system prompt
    is whatever `ls` reported, so it must come back re-prefixed with the route or the model would
    be told to `read_file` a path that does not exist.
    """
    from deepagents.backends.composite import CompositeBackend
    from deepagents.middleware.skills import SkillsMiddleware

    from rad_agent.agent import SKILLS_PROMPT
    from rad_agent.backend import AcpClientBackend
    from rad_agent.skills import EFFECTIVE_ROOT

    conn = FakeConn({"/skills/house/qa/SKILL.md": HOUSE_QA})
    client = AcpClientBackend(conn, "s1", list(conn.files))
    effective = EffectiveSkillsBackend(
        client=client, manifest=list(conn.files), caps={"flags": True}
    )
    backend = CompositeBackend(default=client, routes={EFFECTIVE_ROOT: effective})

    middleware = SkillsMiddleware(
        backend=backend, sources=[EFFECTIVE_ROOT], system_prompt=SKILLS_PROMPT
    )
    update = await middleware.abefore_agent({}, None, None)
    assert update is not None
    metadata = update["skills_metadata"]
    assert sorted(m["name"] for m in metadata) == ["compare", "impression", "proofread", "qa"]
    assert "skills_load_errors" not in update

    qa = next(m for m in metadata if m["name"] == "qa")
    assert qa["path"] == f"{EFFECTIVE_ROOT}qa/SKILL.md"
    # The model would call read_file on exactly that path — it must resolve, and it must be the
    # composition, not the base alone.
    read = await backend.aread(qa["path"])
    assert read.error is None
    assert "Also check the prelim marker." in str(read.file_data)
