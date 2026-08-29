"""AcpClientBackend against a fake ACP client."""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from acp.exceptions import RequestError

from rad_agent.backend import AcpClientBackend

FINDINGS = "**FINDINGS:**\n**Liver:** Normal.\n**Spleen:** Normal.\n"
FILES = {
    "/worklist/A/report.md": f"**TITLE**\n\n{FINDINGS}",
    "/worklist/A/sections/findings.md": FINDINGS,
    "/worklist/A/meta.json": '{"accession": "A"}\n',
    "/priors/index.md": "(no priors)\n",
    "/templates/cxr-pa.md": "**CHEST (PA UPRIGHT)**\n",
}


@dataclass
class _Resp:
    content: str


@dataclass
class _WriteResp:
    field_meta: dict | None = None


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.files = dict(FILES)
        self.writes: list[tuple[str, str]] = []
        self.write_meta: dict | None = {"rad": {"outcome": "applied"}}
        self.refuse_writes_to: set[str] = {"/templates/cxr-pa.md"}

    async def read_text_file(self, session_id, path, line=None, limit=None):
        self.calls.append((session_id, path))
        if path not in self.files:
            raise RequestError(-32004, f"not found: {path}")
        return _Resp(self.files[path])

    async def write_text_file(self, session_id, path, content):
        if path in self.refuse_writes_to:
            raise RequestError(-32003, f"read-only: {path}")
        self.writes.append((path, content))
        self.files[path] = content
        return _WriteResp(self.write_meta)


@pytest.fixture
def backend() -> AcpClientBackend:
    return AcpClientBackend(FakeClient(), "sess-1", list(FILES))


async def test_aread_proxies_to_client_with_session_id(backend: AcpClientBackend) -> None:
    r = await backend.aread("/worklist/A/sections/findings.md")
    assert r.error is None and r.file_data is not None
    assert r.file_data["content"].startswith("**FINDINGS:**")
    assert r.start_line == 1 and r.end_line == 3 and r.total_lines == 3
    assert backend._conn.calls == [("sess-1", "/worklist/A/sections/findings.md")]  # type: ignore[attr-defined]


async def test_aread_paginates(backend: AcpClientBackend) -> None:
    r = await backend.aread("/worklist/A/sections/findings.md", offset=1, limit=1)
    assert r.file_data is not None and r.file_data["content"] == "**Liver:** Normal.\n"
    assert (r.start_line, r.end_line, r.next_offset) == (2, 2, 2)


async def test_aread_maps_client_error_to_result(backend: AcpClientBackend) -> None:
    r = await backend.aread("/worklist/A/sections/liver.md")
    assert r.file_data is None
    assert r.error is not None and "not found" in r.error


async def test_als_lists_immediate_children_and_dirs(backend: AcpClientBackend) -> None:
    root = await backend.als("/")
    assert root.error is None
    assert [e["path"] for e in root.entries or []] == ["/priors/", "/templates/", "/worklist/"]
    wl = await backend.als("/worklist/A")
    assert [e["path"] for e in wl.entries or []] == [
        "/worklist/A/meta.json",
        "/worklist/A/report.md",
        "/worklist/A/sections/",
    ]
    missing = await backend.als("/nope")
    assert missing.error is not None


async def test_aglob_matches_manifest(backend: AcpClientBackend) -> None:
    r = await backend.aglob("**/*.md", "/worklist/A")
    assert [m["path"] for m in r.matches or []] == [
        "/worklist/A/report.md",
        "/worklist/A/sections/findings.md",
    ]
    absolute = await backend.aglob("/templates/*.md")
    assert [m["path"] for m in absolute.matches or []] == ["/templates/cxr-pa.md"]


async def test_agrep_reads_candidates_and_honours_max_count(backend: AcpClientBackend) -> None:
    r = await backend.agrep(r"\*\*Liver:\*\*", "/worklist/A")
    assert r.error is None
    assert {(m["path"], m["line"]) for m in r.matches or []} == {
        ("/worklist/A/report.md", 4),
        ("/worklist/A/sections/findings.md", 2),
    }
    capped = await backend.agrep("Normal", "/", max_count=1)
    assert len(capped.matches or []) == 1 and capped.truncated is True
    bad = await backend.agrep("(", "/")
    assert bad.error is not None


async def test_awrite_goes_through_the_client(backend: AcpClientBackend) -> None:
    r = await backend.awrite("/worklist/A/sections/findings.md", "**FINDINGS:**\nnew\n")
    assert r.error is None and r.path == "/worklist/A/sections/findings.md"
    writes = backend._conn.writes  # type: ignore[attr-defined]
    assert writes == [("/worklist/A/sections/findings.md", "**FINDINGS:**\nnew\n")]


async def test_aedit_is_read_modify_write(backend: AcpClientBackend) -> None:
    path = "/worklist/A/sections/findings.md"
    r = await backend.aedit(path, "**Liver:** Normal.", "**Liver:** Enlarged.")
    assert r.error is None and r.occurrences == 1
    ((path, content),) = backend._conn.writes  # type: ignore[attr-defined]
    assert path == "/worklist/A/sections/findings.md"
    assert content == "**FINDINGS:**\n**Liver:** Enlarged.\n**Spleen:** Normal.\n"


async def test_aedit_errors_are_returned_not_raised(backend: AcpClientBackend) -> None:
    missing = await backend.aedit("/worklist/A/sections/findings.md", "nope", "x")
    assert missing.error is not None and "not found" in missing.error
    ambiguous = await backend.aedit("/worklist/A/sections/findings.md", "Normal.", "x")
    assert ambiguous.error is not None and "2 times" in ambiguous.error
    path = "/worklist/A/sections/findings.md"
    replaced = await backend.aedit(path, "Normal.", "x", replace_all=True)
    assert replaced.error is None and replaced.occurrences == 2
    unknown_file = await backend.aedit("/worklist/A/sections/liver.md", "a", "b")
    assert unknown_file.error is not None


async def test_client_refusal_surfaces_as_error(backend: AcpClientBackend) -> None:
    r = await backend.awrite("/templates/cxr-pa.md", "x")
    assert r.error is not None and "read-only" in r.error
    assert backend._conn.writes == []  # type: ignore[attr-defined]
