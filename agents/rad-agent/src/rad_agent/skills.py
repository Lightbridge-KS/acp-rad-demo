"""Skills — Agent Skills folders (agentskills.io) resolved across three layers.

A skill is a ``<name>/SKILL.md`` directory: YAML frontmatter (``name``, ``description``, optional
``allowed-tools`` and ``metadata``) and a Markdown body of instructions. Three layers contribute,
in precedence order:

===========  =========================================  ==================================
``builtin``  ships with this agent, on local disk        the party that authors the prompt
``house``    served by the Client at ``/skills/house/``  the institution
``personal`` served by the Client, active persona        the individual radiologist
===========  =========================================  ==================================

Ordinary skills **override**: the last layer that defines a name wins outright. A skill the
builtin layer marks ``sealed`` **composes**: the base body always loads and later layers are
appended below it. That asymmetry exists because the failure modes differ — a bad personal
``/impression`` yields a bad proposal the radiologist rejects, while a bad personal ``/qa`` yields
a flag that never appears, and an absence is not reviewable.

The composition is materialized as one synthetic ``SKILL.md`` per skill, served by
``EffectiveSkillsBackend`` at ``/skills/effective/``. That is deliberate: deepagents'
``SkillMetadata`` carries frontmatter only — never the body — so the model reads the body itself
from the advertised path. Composition therefore has to resolve behind a single readable path, and
this is that path. It is also the text the audit trail hashes: what actually steered the turn.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from acp.schema import AvailableCommand, AvailableCommandInput, UnstructuredCommandInput
from deepagents.backends.protocol import (
    FILE_NOT_FOUND,
    BackendProtocol,
    FileDownloadResponse,
    FileInfo,
    LsResult,
    ReadResult,
)
from deepagents.backends.utils import slice_read_response

log = logging.getLogger(__name__)

BUILTIN_SKILLS_DIR = Path(__file__).parent / "prompts" / "skills"

#: Precedence, lowest first. `builtin` is local; the other two come from the Client's namespace.
LAYERS: tuple[str, ...] = ("builtin", "house", "personal")
CLIENT_LAYERS: tuple[str, ...] = ("house", "personal")

#: Where the composed skills are mounted for the agent's own file tools.
EFFECTIVE_ROOT = "/skills/effective/"

_FRONTMATTER_RE = re.compile(r"\A---\n(?P<head>.*?)\n---\n(?P<body>.*)\Z", re.S)
#: A client skill path in the session manifest: `/skills/{layer}/{name}/SKILL.md`.
_CLIENT_SKILL_RE = re.compile(
    rf"^/skills/({'|'.join(CLIENT_LAYERS)})/([a-z0-9][a-z0-9-]*)/SKILL\.md$"
)


def _truthy(value: Any) -> bool:
    """YAML `true`, but also the string a stringifying parser would hand us."""
    return value is True or (
        isinstance(value, str) and value.strip().lower() in {"true", "1", "yes"}
    )


@dataclass(frozen=True)
class SkillFile:
    """One layer's contribution to a skill."""

    layer: str
    meta: dict[str, Any]
    body: str

    @property
    def extras(self) -> dict[str, Any]:
        """The free-form `metadata:` mapping; the only place the spec allows our own keys."""
        raw = self.meta.get("metadata")
        return raw if isinstance(raw, dict) else {}


@dataclass(frozen=True)
class EffectiveSkill:
    """What the agent actually offers for one name, after every layer has had its say."""

    name: str
    description: str
    body: str
    hint: str | None
    requires: str | None
    sealed: bool
    #: Which layers contributed, in precedence order — the audit answers "whose instructions?".
    layers: tuple[str, ...]
    allowed_tools: tuple[str, ...]

    @property
    def digest(self) -> str:
        """Content hash of the composed body — the audit's answer to "which version ran?"."""
        return hashlib.sha256(self.body.encode("utf-8")).hexdigest()[:16]

    @property
    def path(self) -> str:
        return f"{EFFECTIVE_ROOT}{self.name}/SKILL.md"

    def document(self) -> str:
        """The synthetic `SKILL.md`: re-emitted frontmatter over the composed body.

        `requires` is deliberately dropped — it has already been applied, and a capability the
        client did not negotiate is not the model's business.
        """
        head: dict[str, Any] = {"name": self.name, "description": self.description}
        if self.allowed_tools:
            head["allowed-tools"] = list(self.allowed_tools)
        front = yaml.safe_dump(head, sort_keys=False, allow_unicode=True, width=10**6)
        return f"---\n{front}---\n{self.body}"


def parse_skill_file(layer: str, text: str) -> SkillFile:
    """Split `SKILL.md` into frontmatter and body. Raises `ValueError` on anything malformed."""
    m = _FRONTMATTER_RE.match(text)
    if m is None:
        raise ValueError("missing YAML frontmatter")
    try:
        meta = yaml.safe_load(m.group("head"))
    except yaml.YAMLError as exc:
        raise ValueError(f"invalid YAML frontmatter: {exc}") from exc
    if not isinstance(meta, dict):
        raise ValueError("frontmatter is not a mapping")
    if not str(meta.get("name", "")).strip():
        raise ValueError("frontmatter needs a name")
    if not str(meta.get("description", "")).strip():
        raise ValueError("frontmatter needs a description")
    return SkillFile(layer=layer, meta=meta, body=m.group("body").strip())


def compose(name: str, sources: Sequence[SkillFile]) -> EffectiveSkill:
    """Fold one skill's layers into what the agent offers.

    `sources` must be in precedence order (lowest first) and non-empty. Sealing is a property of
    the **base** layer alone: a later layer cannot seal itself, or it could lock out the layers
    above it — the opposite of what sealing is for.
    """
    base = sources[0]
    winner = sources[-1]
    sealed = base.layer == "builtin" and _truthy(base.extras.get("sealed"))
    if sealed:
        body = "\n\n".join(s.body for s in sources if s.body)
        head, layers = base, tuple(s.layer for s in sources)
    else:
        body, head, layers = winner.body, winner, (winner.layer,)
    raw_tools = head.meta.get("allowed-tools")
    tools = (
        tuple(str(t) for t in raw_tools)
        if isinstance(raw_tools, list)
        else tuple(str(raw_tools).split())
        if isinstance(raw_tools, str)
        else ()
    )
    hint = head.extras.get("hint")
    requires = head.extras.get("requires")
    return EffectiveSkill(
        name=name,
        description=str(head.meta["description"]).strip(),
        body=body,
        hint=str(hint) if hint else None,
        requires=str(requires) if requires else None,
        sealed=sealed,
        layers=layers,
        allowed_tools=tools,
    )


def load_builtin(directory: Path = BUILTIN_SKILLS_DIR) -> dict[str, SkillFile]:
    """Every `<name>/SKILL.md` shipped with this agent. A malformed one is skipped, loudly."""
    out: dict[str, SkillFile] = {}
    for skill_md in sorted(directory.glob("*/SKILL.md")):
        name = skill_md.parent.name
        try:
            parsed = parse_skill_file("builtin", skill_md.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.error("builtin skill %s: %s; skipping", name, exc)
            continue
        if parsed.meta["name"] != name:
            log.error("builtin skill %s declares name=%r; skipping", name, parsed.meta["name"])
            continue
        out[name] = parsed
    return out


def client_skill_paths(manifest: Sequence[str]) -> dict[str, list[tuple[str, str]]]:
    """`{skill name: [(layer, path), …]}` for every client-served `SKILL.md` in the manifest.

    The manifest is the enumeration — it is sent once at `session/new` and lists every readable
    path, so no extra listing round-trip is needed to discover what the Client offers.
    """
    found: dict[str, list[tuple[str, str]]] = {}
    for path in manifest:
        m = _CLIENT_SKILL_RE.match(path)
        if m:
            found.setdefault(m.group(2), []).append((m.group(1), path))
    return found


def advertise(
    skills: Mapping[str, EffectiveSkill], client_caps: Mapping[str, Any] | None = None
) -> list[AvailableCommand]:
    """The `available_commands_update` payload, in name order."""
    del client_caps  # `requires` is applied during resolution; nothing unmet survives to here.
    return [
        AvailableCommand(
            name=s.name,
            description=s.description,
            input=AvailableCommandInput(UnstructuredCommandInput(hint=s.hint)) if s.hint else None,
        )
        for s in sorted(skills.values(), key=lambda s: s.name)
    ]


def mentioned_skills(text: str, names: Sequence[str]) -> list[str]:
    """Skill names mentioned as `/name` anywhere in `text`, in order of appearance, deduplicated.

    Anywhere, not only at the start: a mention rides inside an ordinary sentence ("please run
    /qa on this"). The `/` must open the string or follow whitespace, so `dd/mm` and `2/5` never
    match — the same rule the editor's own `/` menus use.
    """
    known = set(names)
    out: list[str] = []
    for m in re.finditer(r"(?:(?<=\s)|\A)/([a-z][a-z-]*)", text):
        name = m.group(1)
        if name in known and name not in out:
            out.append(name)
    return out


def skill_name_from_path(path: str) -> str | None:
    """The skill a `/skills/effective/<name>/SKILL.md` link points at, if it is one."""
    m = re.match(rf"^{re.escape(EFFECTIVE_ROOT)}([a-z0-9][a-z0-9-]*)/SKILL\.md$", path)
    return m.group(1) if m else None


class EffectiveSkillsBackend(BackendProtocol):
    """Serves the composed skills at `/skills/effective/` (paths arrive with that prefix stripped).

    Only three methods are needed: `als` and `adownload_files` are what `SkillsMiddleware` calls
    to discover skills, and `aread` is what the model's `read_file` calls to load one. Resolution
    is lazy and cached for the life of the session — the manifest it derives from is itself fixed
    at `session/new`, so there is nothing to invalidate.
    """

    def __init__(
        self,
        *,
        client: BackendProtocol,
        manifest: Sequence[str],
        caps: Mapping[str, Any] | None = None,
        builtin_dir: Path = BUILTIN_SKILLS_DIR,
    ) -> None:
        self._client = client
        self._manifest = list(manifest)
        self._caps = dict(caps or {})
        self._builtin_dir = builtin_dir
        self._skills: dict[str, EffectiveSkill] | None = None
        self._lock = asyncio.Lock()

    async def skills(self) -> dict[str, EffectiveSkill]:
        """Resolve once, then serve from cache; concurrent callers await the same resolution."""
        async with self._lock:
            if self._skills is None:
                self._skills = await self._resolve()
            return self._skills

    async def _resolve(self) -> dict[str, EffectiveSkill]:
        builtin = load_builtin(self._builtin_dir)
        client = client_skill_paths(self._manifest)

        # One batch for every client-served SKILL.md, then fold layer by layer.
        wanted = [
            (name, layer, path) for name, entries in client.items() for layer, path in entries
        ]
        fetched: dict[tuple[str, str], str] = {}
        if wanted:
            responses = await self._client.adownload_files([p for _, _, p in wanted])
            for (name, layer, path), resp in zip(wanted, responses, strict=True):
                if resp.error or resp.content is None:
                    log.warning("skill %s/%s at %s: %s", layer, name, path, resp.error)
                    continue
                try:
                    fetched[(name, layer)] = resp.content.decode("utf-8")
                except UnicodeDecodeError:
                    log.warning("skill %s/%s at %s is not UTF-8; skipping", layer, name, path)

        out: dict[str, EffectiveSkill] = {}
        for name in sorted(set(builtin) | set(client)):
            sources: list[SkillFile] = []
            for layer in LAYERS:
                if layer == "builtin":
                    if name in builtin:
                        sources.append(builtin[name])
                    continue
                text = fetched.get((name, layer))
                if text is None:
                    continue
                try:
                    parsed = parse_skill_file(layer, text)
                except ValueError as exc:
                    log.warning("skill %s/%s: %s; skipping that layer", layer, name, exc)
                    continue
                sources.append(parsed)
            if not sources:
                continue
            skill = compose(name, sources)
            if skill.requires and not self._caps.get(skill.requires):
                # Hidden from the model *and* the advertisement: a skill whose tool the client
                # never negotiated would send the model after a tool that is not bound.
                log.info("skill %s needs client capability %r; omitting", name, skill.requires)
                continue
            out[name] = skill
        log.info(
            "skills resolved: %s",
            ", ".join(f"{s.name}[{'+'.join(s.layers)}]" for s in out.values()) or "(none)",
        )
        return out

    # -- BackendProtocol -------------------------------------------------------

    async def als(self, path: str) -> LsResult:
        skills = await self.skills()
        p = path if path.endswith("/") else f"{path}/"
        if p == "/":
            # `is_dir` is what SkillsMiddleware filters on, and it is optional on FileInfo —
            # omitting it yields zero skills silently.
            entries: list[FileInfo] = [
                {"path": f"/{name}/", "is_dir": True} for name in sorted(skills)
            ]
            return LsResult(entries=entries)
        name = p.strip("/")
        if name in skills:
            return LsResult(entries=[{"path": f"/{name}/SKILL.md", "is_dir": False}])
        return LsResult(error=f"Directory '{path}' not found")

    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        text = await self._document(file_path)
        if text is None:
            return ReadResult(error=f"not found: {EFFECTIVE_ROOT.rstrip('/')}{file_path}")
        return slice_read_response({"content": text, "encoding": "utf-8"}, offset, limit)

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        out: list[FileDownloadResponse] = []
        for path in paths:
            text = await self._document(path)
            out.append(
                FileDownloadResponse(
                    path=path,
                    content=None if text is None else text.encode("utf-8"),
                    error=None if text is not None else FILE_NOT_FOUND,
                )
            )
        return out

    async def _document(self, path: str) -> str | None:
        """The composed `SKILL.md` for a stripped path like `/qa/SKILL.md`."""
        m = re.match(r"^/([a-z0-9][a-z0-9-]*)/SKILL\.md$", path)
        if not m:
            return None
        skill = (await self.skills()).get(m.group(1))
        return skill.document() if skill else None


__all__ = [
    "EFFECTIVE_ROOT",
    "EffectiveSkill",
    "EffectiveSkillsBackend",
    "SkillFile",
    "advertise",
    "compose",
    "load_builtin",
    "mentioned_skills",
    "parse_skill_file",
    "skill_name_from_path",
]
