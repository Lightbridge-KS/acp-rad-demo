"""``AcpClientBackend`` — deepagents' file tools served by the ACP client's ``fs/*``.

The editor (ACP Client) owns the report; this backend never touches a real filesystem.
``read_file`` → ``fs/read_text_file``. ACP v1 has no listing call, so ``ls``/``glob`` answer
from the manifest the client sent in ``session/new._meta.rad.manifest`` and ``grep`` reads each
candidate through the client. Writes are refused here until the proposal flow lands (slice 3).

Only the async methods are overridden: ``BackendProtocol`` has no abstract methods and the
filesystem middleware calls ``a*`` variants. Backends return raw text; the middleware adds line
numbers. Errors are *returned* (``*Result(error=…)``), never raised across the tool boundary.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Protocol

from acp.exceptions import RequestError
from deepagents.backends.protocol import (
    BackendProtocol,
    EditResult,
    FileInfo,
    GlobResult,
    GrepMatch,
    GrepResult,
    LsResult,
    ReadResult,
    WriteResult,
)
from deepagents.backends.utils import slice_read_response
from wcmatch import glob as wcglob

log = logging.getLogger(__name__)

WRITE_REFUSED = "writes are proposals; not available yet"


class _ReadResponse(Protocol):
    content: str


class _FsClient(Protocol):
    """The slice of ``acp.Client`` this backend needs (keeps tests free of the SDK)."""

    async def read_text_file(
        self, session_id: str, path: str, line: int | None = None, limit: int | None = None
    ) -> _ReadResponse: ...


class AcpClientBackend(BackendProtocol):
    """Proxy deepagents file operations to an ACP client over one session."""

    def __init__(self, conn: _FsClient, session_id: str, manifest: list[str]) -> None:
        self._conn = conn
        self.session_id = session_id
        self.manifest: list[str] = sorted(set(manifest))

    # -- reads ---------------------------------------------------------------

    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        content = await self._fetch(file_path)
        if content is None:
            return ReadResult(error=self._last_error)
        return slice_read_response({"content": content, "encoding": "utf-8"}, offset, limit)

    async def als(self, path: str) -> LsResult:
        prefix = _dir_prefix(path)
        entries: dict[str, FileInfo] = {}
        for p in self.manifest:
            if not p.startswith(prefix):
                continue
            head, sep, _rest = p[len(prefix) :].partition("/")
            if sep:
                d = f"{prefix}{head}/"
                entries.setdefault(d, {"path": d, "is_dir": True})
            else:
                entries[p] = {"path": p, "is_dir": False}
        if not entries and prefix != "/":
            return LsResult(error=f"Directory '{path}' not found")
        return LsResult(entries=sorted(entries.values(), key=lambda e: e["path"]))

    async def aglob(self, pattern: str, path: str | None = None) -> GlobResult:
        root = _dir_prefix(path or "/")
        full = pattern if pattern.startswith("/") else f"{root}{pattern}"
        matches: list[FileInfo] = [
            {"path": p, "is_dir": False}
            for p in self.manifest
            if wcglob.globmatch(p, full, flags=wcglob.GLOBSTAR)
        ]
        return GlobResult(matches=matches)

    async def agrep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
    ) -> GrepResult:
        try:
            rx = re.compile(pattern)
        except re.error as exc:
            return GrepResult(error=f"invalid regex: {exc}")
        root = _dir_prefix(path or "/")
        candidates = [p for p in self.manifest if p.startswith(root) or p == (path or "")]
        if glob:
            g = glob if glob.startswith("/") else f"**/{glob}"
            candidates = [p for p in candidates if wcglob.globmatch(p, g, flags=wcglob.GLOBSTAR)]
        matches: list[GrepMatch] = []
        truncated = False
        for p in candidates:
            content = await self._fetch(p)
            if content is None:
                continue
            for i, line in enumerate(content.splitlines(), start=1):
                if rx.search(line):
                    matches.append({"path": p, "line": i, "text": line})
                    if max_count is not None and len(matches) >= max_count:
                        truncated = True
                        break
            if truncated:
                break
        return GrepResult(matches=matches, truncated=truncated)

    # -- writes (refused in this slice) --------------------------------------

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        del content
        return WriteResult(error=WRITE_REFUSED, path=file_path)

    async def aedit(
        self, file_path: str, old_string: str, new_string: str, replace_all: bool = False
    ) -> EditResult:
        del old_string, new_string, replace_all
        return EditResult(error=WRITE_REFUSED, path=file_path)

    # -- internals -------------------------------------------------------------

    _last_error: str = "read failed"

    async def _fetch(self, path: str) -> str | None:
        """Whole-file read through the client; ``None`` on error (message in ``_last_error``)."""
        try:
            resp = await self._conn.read_text_file(session_id=self.session_id, path=path)
        except RequestError as exc:
            self._last_error = str(exc) or f"read failed ({exc.code})"
            return None
        except ConnectionError as exc:
            self._last_error = f"connection lost: {exc}"
            return None
        except Exception as exc:  # noqa: BLE001 — never raise across the tool boundary
            log.exception("fs/read_text_file failed for %s", path)
            self._last_error = f"{type(exc).__name__}: {exc}"
            return None
        return resp.content


def _dir_prefix(path: str) -> str:
    """Normalize a directory path to a prefix ending in '/'; '' and '/' both mean the root."""
    p = path.strip()
    if p in ("", "/"):
        return "/"
    return p if p.endswith("/") else f"{p}/"


__all__: list[str] = ["AcpClientBackend", "WRITE_REFUSED"]
_ = Any  # keep typing import used for future signature widening
