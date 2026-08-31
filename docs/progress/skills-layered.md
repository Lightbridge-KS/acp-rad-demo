---
summary: Tracker for layered skills — S1 namespace + fixtures, S2 agent loading over the namespace, S3 composer mentions, S4 personas + audit provenance, S5 skill contract + references, S6 docs. Skills become Agent-Skills folders resolved across builtin → house → personal.
read_when: Working on `/skills/**`, `EffectiveSkillsBackend`, the composer `/` mention, or audit context provenance; landing a step (tick boxes, add SHAs); asking who owns a skill or how one is loaded.
---

# ACP-Rad Demo — layered skills

Parent: [`overview-demo.md`](./overview-demo.md) · Design: [`04-skills`](../design/04-skills.md) · [`03-agentic-architecture`](../design/03-agentic-architecture.md) · glossary [`CONTEXT.md`](../../CONTEXT.md). Plan approved 2026-08-31 (`~/.claude/plans/glimmering-snuggling-wave.md`).

Steps are **S1–S6** — the parent tracker's slice numbers mean something else.

## Why

A skill today is a whole-prompt regex substitution (`skills.py:22`): the agent's package is the only
place a skill can live, invocation must consume the entire prompt, and the load is invisible to the
client. This replaces that with **Agent Skills-spec folders** (`<name>/SKILL.md`, agentskills.io)
resolved across three layers, discoverable by the agent's own `ls`/`read_file`, invocable as an
in-sentence `/mention`, and recorded in the audit trail.

**Ownership model** (KS, 2026-08-31). The party that authors the system prompt authors the **base**
skills consistent with its own context; the institution **overrides and extends**; the individual
**extends**. Skill text is coupled to the system prompt by construction — 04 §2 has the expansion
*restating* contract items the prompt already carries — so base skills ship with the agent rather
than with the house.

Real-world shapes this must serve: **S1** one team owns editor + deterministic documents + harness +
prompt + skills; **S2** the PACS/RIS team owns editor + deterministic documents while an AI
Engineering team owns harness + prompt + skills. In both, the radiologist customizes.

## Milestones

- [x] **S1. Namespace + fixtures** (2026-08-31) — `ResolvedPath` gains `skill{layer,name,file}`; `SKILL_LAYERS = house | personal` (`builtin` ships with the agent and is deliberately absent from the Client's namespace); `SKILL_NAME` enforces the spec's grammar at the boundary, and the `references/` segment grammar admits no `..`; `store.ts` read case keyed by `skillKey()`; `buildManifest.skills` optional; `ReportStoreDeps.skills` as a **flat map** keyed `{layer}/{name}/{file}` — three nested levels would have bought nothing. `houseSkills` / `personalSkills` / `personas` / `skillFiles(persona)` in `fixtures/index.ts`, siblings of `collection()` as planned. Fixtures: `house/qa` (middle of the sealed compose chain), `personal/dr-a/impression` (override), `personal/dr-b/qa` (append). Verified: `just check` green (183 + 10 + 127 TS, 47 py); +16 store/namespace tests, +10 fixture-conformance tests.
  **Pulled forward from S4:** the `?radiologist=` selector, because it removed an interim default rather than adding work. The persona is part of the `Workspace` key — a personal layer swapped under a live session would leave the agent holding a **manifest that lies**, since it is sent once at `session/new` — so a persona switch restarts the session and goes through the same inline discard-confirm as a case switch (`Target` is now `case | persona`). The persona id is **not** in the served path: the agent sees `/skills/personal/…`, never who owns it.
- [x] **S2. Agent loading over the namespace** (2026-08-31) — `skills.py` rewritten from a whole-prompt regex loader into layer resolution + composition + `EffectiveSkillsBackend`; the four builtin skills migrate to `prompts/skills/<name>/SKILL.md` with YAML frontmatter and lose `{arg}` (the argument now lives in the radiologist's own sentence, where the model can read it); `AcpClientBackend.adownload_files`; `CompositeBackend` routes `/skills/effective/` to the synthesized layer; advertisement built from the *resolved* skills; `expand()` replaced by eager mention resolution. `pyyaml` + `types-pyyaml` added. Verified: `just check` green (183 + 10 + 127 TS, 85 py — 47 → 85); the middleware integration test proves discovery through the composite route and that the advertised path resolves to the composed body.
  **Deviations from the plan, both deliberate:**
  - **No `/skills/builtin/` route.** The plan exposed the builtin layer for transparency. It is not exposed: a model that read `/skills/builtin/qa/SKILL.md` would get the *un-composed* base and silently miss the house and personal checks — precisely the failure sealing exists to prevent. `EffectiveSkillsBackend` reads builtin from local disk internally instead.
  - **`_fetch_result` returns `(content, error, missing)`.** A first cut mapped `-32004` to the literal `file_not_found` inside the shared read path, which regressed the message the *model* sees on an ordinary missing read — caught by `test_aread_maps_client_error_to_result`. The two callers want different things from the same failure, so the flag is separate from the message.
- [x] **S3. Composer mentions** (2026-08-31) — the composer's `/` switches from `unstable_useSlashCommandAdapter` + `.Action` (which *ran* the skill) to `unstable_useMentionAdapter` + `.Directive` with a formatter serializing to plain `/name`, so picking a skill **inserts a mention** and the sentence around it survives. `mentionedSkills` / `effectiveSkillPath` land in `packages/acp-rad/src/skills.ts` — profile-as-code, shared by the write lock and the wire. `isQaPrompt` is no longer start-anchored. Verified: `just check` green (189 + 10 + 129 TS, 85 py).
  **`AgentPort` did not widen** (plan said it would). `connection.ts` tracks the advertised names from `available_commands_update` and derives the mentions from the outgoing text itself, so `prompt(text)` stays one argument and no call site changed. The upside is bigger than the diff saved: a hand-typed `/impression` and a menu-picked one are the same thing *by construction*, rather than two paths that must be kept in agreement.
  **`Sidebar.onCommand` is gone.** With mentions there is nothing for the composer to *run* — the radiologist picks, keeps typing, then sends.
- [ ] **S4. Audit provenance** — `zAuditRecord` and `AuditFields` gain model spec, skill layer and body hash; `skill` added to `AUDIT_FAMILIES` (and the missing `short_prelim` fixed). *(Personas landed in S1.)*
- [ ] **S5. Skill contract + references** — `_meta.rad.skillContract` at `initialize` with a mismatch warning; one skill carrying `references/` material loaded on demand.
- [ ] **S6. Docs** — ADR 0004; 04 §1–2 rewritten; 03 §5/§9 (resolve the 💡, correct the defense-in-depth claim); 01 invariants (INV-3) + §7; 02 §2.2/§2.3; 05 namespace + manifest; protocol §5.3/§7/§9; `CONTEXT.md` **Skill**; parent tracker.

## Now / Next

- **Now:** S4 — audit context provenance (model spec, skill layer, body hash).
- **Next:** S5–S6 in order. `just smoke` has not been re-run since S2; the live gate needs port 8787 and a hosted model, and its assertions want extending to the layer switch. Nothing here is parallelizable across steps — each leaves `just check` green and the demo runnable.

## Deferred

- **The mention chip.** The screenshots' styled blue token needs a rich composer input via the `ComposerInputPluginRegistry` seam; the composer is a plain `<textarea>` (`react-textarea-autosize`) and `@assistant-ui/react-lexical` is not installed. We ship the mention as plain `/name` text — the same behaviour, no colour. Defer with the Settings UI.
- **The Settings menu** in the editor's left sidebar (KS, 2026-08-31) — where a radiologist would author their personal layer, choose a model, and append a personal preamble. The personal layer ships seeded by fixture; authoring it is deferred.
- **Personal system-prompt preamble.** Append-only, never a replacement — a radiologist who can replace the prompt can delete *never invent a finding* and the report still looks normal. Not built; the rule is recorded here so it is not relitigated.
- **In-report inline mentions.** The in-report `/` invokes skills as whole-turn commands. An inline mention there is expensive: `deltaToMarkdown` skips embeds so a chip would be invisible to the canonical buffer, `CommandEffect` has no insert-at-offset kind, and the skill branch discards the surrounding sentence by construction.

## Confirmed contracts

- **`SkillMetadata` carries no body.** deepagents' middleware holds `path · name · description · license · compatibility · metadata · allowed_tools` and discards everything after the frontmatter; the model gets the body only by calling `read_file` on the advertised path. Additive composition therefore cannot be a state transformation — it must resolve behind **one readable path**. This is why composition lives in a backend.
- **`metadata` values are stringified.** `_validate_metadata` coerces keys and values with `str()`, so YAML `sealed: true` arrives as `"True"`. A `sealed` check must normalize case; `is True` never fires.
- **`als` must set `is_dir`.** It is `NotRequired` on `FileInfo`, and a backend that omits it yields **zero skills silently** — no warning, no error. The most likely quiet failure mode.
- **An exception out of skill loading fails the whole turn.** Neither of the middleware's list helpers has a `try/except`; a backend that *raises* rather than returning an error takes the agent down with it. `adownload_files` must return `file_not_found` — the only error string the middleware special-cases.
- **`allowed-tools` is advisory.** Parsed and rendered into the prompt, never enforced anywhere in deepagents. Capability gating is ours: a skill whose `metadata.requires` the client did not negotiate is omitted from the effective layer entirely, so it is invisible to both the advertisement and the model.
- **Moving authorship is not moving trust.** A house- or radiologist-authored skill is advisory; the agent stays untrusted whoever wrote its instructions, and INV-1 is untouched — every write still passes the human gate.
- **Safety skills compose, they never replace.** `/qa` is `sealed`: later layers append extra checks onto the builtin body. A bad personal `/impression` produces a bad proposal the radiologist rejects; a bad personal `/qa` produces **a flag that never appears** — the failure is an absence, and absences do not show up in review.
- **The composed body is the unit of provenance.** `SkillMetadata` has no body, so nothing upstream can tell you what actually steered a turn. `EffectiveSkill.digest` hashes the *composed* text, which is why the base and the extended forms of the same skill are distinguishable in the audit — a per-layer hash would not be.
- **A mention is resolved, not suggested.** The eager path exists because the failure of the lazy one is invisible: a model that decides not to load the house's impression policy still produces a plausible draft, and nothing in the result shows the policy never applied. Discovery stays lazy in the other direction, where the model's judgement is the point.
- **The write lock cannot be start-anchored.** `isQaPrompt` gates whether the agent may write during a turn. Once a mention rides inside prose, *"please run /qa on this"* must trip it — an anchored test would let the agent edit the report during the one check that is only allowed to flag it.
