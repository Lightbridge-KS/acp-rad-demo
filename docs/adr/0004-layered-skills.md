---
summary: ADR — a skill is an Agent Skills folder resolved across three layers (builtin → house → personal); ordinary skills are replaced by the last layer, a sealed one composes; the composition is served behind one readable path.
read_when: Touching `agents/rad-agent/src/rad_agent/skills.py`, `/skills/**` in the namespace, or the composer's `/` menu; deciding who may author or override a skill; asking why `/qa` behaves differently from the others.
---

# ADR 0004 — Skills as layered Agent-Skills folders

**Status:** accepted 2026-08-31 (KS). **Amends:** design 04 §1–2 (skills as prompt expansions), 03 §5 and §9 (the `skills=` transport 💡), 02 §2.2 (the composer's `/`). **Related:** ADR 0001, INV-1, INV-3.

## Decision

A **skill** is a directory `<name>/SKILL.md` in the [Agent Skills](https://agentskills.io) format — YAML frontmatter (`name`, `description`, optional `allowed-tools`, `metadata`) over a Markdown body. Three layers contribute, lowest precedence first:

| Layer | Ships with | Authored by | Served from |
|---|---|---|---|
| `builtin` | the agent | whoever authors the system prompt | the agent's own package, local disk |
| `house` | the client | the institution (PACS/RIS or its AI team) | `/skills/house/{name}/…`, read-only |
| `personal` | the client | the individual radiologist | `/skills/personal/{name}/…`, read-only |

**Ordinary skills override**: the last layer that defines a name wins outright. **A skill the builtin layer marks `sealed` composes**: the base body always loads and later layers are appended below it. `/qa` is sealed.

The three layers are folded into one synthetic `SKILL.md` per skill, served by `EffectiveSkillsBackend` at `/skills/effective/{name}/SKILL.md`. That path is what deepagents' `SkillsMiddleware` advertises, what the model reads, and what the eager resolver injects.

A skill is invoked by **mention** — `/name` written anywhere in an ordinary sentence — carried to the agent as an ACP `resource_link` beside the radiologist's own words.

## Why

**Authoring had one owner, and it was the wrong one for half the content.** A skill was a `prompts/skills/<name>.md` file inside the agent's package, expanded by a whole-prompt regex. A hospital could not add a skill; a radiologist certainly could not. But a skill is not one kind of thing: `/impression` is roughly technique (read order, the anti-anchoring precedence clause, edit granularity) plus policy (what a Ramathibodi impression contains). Technique belongs to whoever tuned the prompt; policy belongs to the institution.

**Base skills still ship with the agent** (KS, 2026-08-31). Skill text is coupled to the system prompt *by construction* — 04 §2 has each expansion **restating** contract items the prompt already carries. A house that authored base skills against a prompt it does not own and cannot read would produce text that drifts, duplicates, or contradicts, and nobody would find out until a proposal came back wrong. So the party that authors the context authors the base skills for it; the layers above extend and, where they must, override.

**Override is the escape hatch, not the main channel.** A house whose normal way to customize is to fork the base `SKILL.md` inherits a stale copy every time the agent author improves it. The intended first resort is *reference*: the house supplies data (a section profile, a template, a `references/` document) that the agent's skill reads. Override exists for the case parameterization genuinely cannot express.

**`/qa` is sealed because its failure mode is invisible.** A bad personal `/impression` produces a bad *proposal*, which the radiologist rejects — the human gate holds and the failure is visible. A bad personal `/qa` produces **a flag that never appears**: nothing renders, there is no pill to reject, and the change is standing rather than per-report. Absences are what audits catch years later, so the base checks are not replaceable.

## Why composition lives in a backend

deepagents' `SkillMetadata` carries frontmatter only — `path · name · description · license · compatibility · metadata · allowed_tools`. The parser discards everything after the closing `---`, and the model obtains the body by calling `read_file` on the advertised path.

So "append the later body to the sealed body" **cannot be a state transformation**: there is no body in the state to append to. Composition has to resolve behind a single readable path, and `/skills/effective/` is that path. It is also what the audit hashes — the text that actually steered the turn, rather than a list of files that happened to exist.

## Why a mention rather than a command

The old form required the *whole* prompt to match `^/name( arg)?$`. Skills are named mid-sentence in every chat surface a radiologist has used ("Please explain the /impression"), and the whole-prompt form cannot express that. It also forced skills to take arguments through `{arg}` substitution; with a mention, the argument sits in the radiologist's own sentence where the model can read it, and the skill file goes back to being a static document.

**An explicit mention is resolved eagerly**, server-side, before the model runs. Lazy discovery — letting the model decide whether the skill applies — is the right default for a skill the radiologist did *not* name, but a wrong default for one they did: a model that declines to load the house's impression policy still produces a plausible draft, and nothing in the result shows the policy never applied. That is a silent quality regression, not a visible error.

## Consequences

- **`/skills/**` is the only namespace subtree that is instructions** (INV-3, new). Everything else — report, priors, templates, snippets, `meta.json` — is data. This is stronger than the prompt-level sentence it replaces, because it is a path rule.
- **Moving authorship is not moving trust.** A house- or radiologist-authored skill is advisory; the agent stays untrusted whoever wrote its instructions, and INV-1 is untouched — every write still passes the human gate.
- **The audit gains context provenance.** `agent.{name,version,level}` identified the context only while one party owned it. Records now carry the model in force, the skill mentioned, and the client-served layers behind it — all of it stamped by the Client, never taken from the agent.
- **The `skills=` transport question (03 §9) is answered.** Not `CompositeBackend(default=…, routes={"/skills/": FilesystemBackend(local)})` as sketched, but one route to a *synthesized* backend. The builtin layer is deliberately **not** exposed as a path: a model that read it directly would get the un-composed base and silently miss the layers above — the failure sealing exists to prevent.
- **Two organizations can co-author.** `initialize._meta.rad.skillContract` publishes the surface a house author may rely on, so a skill can be written against an agent whose system prompt is not visible.
- **Reference material now has somewhere to live** (`references/`), which the prompt-expansion mechanism could not carry.

## Alternatives rejected

- **House owns every skill, agent ships none.** Maximal portability — one folder overlaid onto any ACP-Rad agent — but it separates skill text from the prompt it restates. Rejected on the coupling argument above. What survives is the true, narrower claim: *house policy* is portable across agents, not every skill.
- **Composition by rewriting `skills_metadata`** after the middleware's `before_agent`. Impossible: no body in the metadata (above).
- **A hard seal** — refuse a later layer that names a sealed skill. Simpler and safer, but leaves an institution unable to add a QA check it is regulated to perform. Additive composition keeps the base guaranteed while allowing extension; that an extension must not negate a base check is stated in the base body itself and is prompt-level only, not enforceable.
- **Directive text in the composer** (`:command[/qa]{name=qa}`, the library default). Machine-readable, but noise in a plain `<textarea>` and something to strip again before sending. Plain `/name` makes a menu-picked mention and a hand-typed one identical by construction.
