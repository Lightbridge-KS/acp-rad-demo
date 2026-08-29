"""AcpClientBackend against a fake ACP client."""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from acp.exceptions import RequestError

from rad_agent.backend import WRITE_REFUSED, AcpClientBackend

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


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def read_text_file(self, session_id, path, line=None, limit=None):
        self.calls.append((session_id, path))
        if path not in FILES:
            raise RequestError(-32004, f"not found: {path}")
        return _Resp(FILES[path])


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


async def test_writes_are_refused(backend: AcpClientBackend) -> None:
    w = await backend.awrite("/worklist/A/report.md", "x")
    e = await backend.aedit("/worklist/A/report.md", "a", "b")
    assert w.error == WRITE_REFUSED and e.error == WRITE_REFUSED
