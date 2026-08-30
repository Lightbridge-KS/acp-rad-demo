"""Skills — the commands the agent advertises, as prompt expansions (design 04 §1).

One ``prompts/skills/<name>.md`` per skill: a two-key frontmatter (``description``,
optional ``hint``) and a body that replaces ``/<name> [arg]`` at prompt time, with
``{arg}`` substituted. Adding a skill is adding a file; nothing else registers it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from acp.schema import AvailableCommand, AvailableCommandInput, UnstructuredCommandInput

SKILLS_DIR = Path(__file__).parent / "prompts" / "skills"

#: ``/name`` or ``/name arg…`` — anything else is not a skill invocation.
INVOCATION_RE = re.compile(r"^/(?P<name>[a-z][a-z-]*)(?:\s+(?P<arg>.+))?$", re.S)
_FRONTMATTER_RE = re.compile(r"\A---\n(?P<head>.*?)\n---\n(?P<body>.*)\Z", re.S)


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    body: str
    hint: str | None = None

    def expand(self, arg: str | None) -> str:
        """The prompt text the model receives for ``/name arg``."""
        return self.body.replace("{arg}", arg or "").strip()


def parse_skill(name: str, text: str) -> Skill:
    """Parse one skill file: ``---`` frontmatter with ``key: value`` lines, then the body."""
    m = _FRONTMATTER_RE.match(text)
    if m is None:
        raise ValueError(f"skill {name!r}: missing frontmatter")
    meta: dict[str, str] = {}
    for line in m.group("head").splitlines():
        key, sep, value = line.partition(":")
        if not sep:
            raise ValueError(f"skill {name!r}: bad frontmatter line {line!r}")
        meta[key.strip()] = value.strip()
    if not meta.get("description"):
        raise ValueError(f"skill {name!r}: frontmatter needs a description")
    return Skill(
        name=name, description=meta["description"], body=m.group("body"), hint=meta.get("hint")
    )


def load_skills(directory: Path = SKILLS_DIR) -> dict[str, Skill]:
    """Every ``*.md`` in ``directory``, keyed by file stem, in name order."""
    skills = {
        p.stem: parse_skill(p.stem, p.read_text(encoding="utf-8"))
        for p in sorted(directory.glob("*.md"))
    }
    return skills


def advertise(skills: dict[str, Skill]) -> list[AvailableCommand]:
    """The ``available_commands_update`` payload for these skills."""
    return [
        AvailableCommand(
            name=s.name,
            description=s.description,
            input=AvailableCommandInput(UnstructuredCommandInput(hint=s.hint)) if s.hint else None,
        )
        for s in skills.values()
    ]


def expand(text: str, skills: dict[str, Skill]) -> str:
    """Replace a ``/name [arg]`` prompt by the skill's body; anything else passes through."""
    m = INVOCATION_RE.match(text.strip())
    if m is None:
        return text
    skill = skills.get(m.group("name"))
    if skill is None:
        return text
    arg = m.group("arg")
    return skill.expand(arg.strip() if arg else None)
