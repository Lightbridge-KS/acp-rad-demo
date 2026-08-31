/**
 * The Client's skill layers as fixtures: conformance to the Agent Skills spec (agentskills.io)
 * and the key shape `ReportStoreDeps.skills` addresses (`{layer}/{name}/{file}`).
 *
 * The nesting is why `collection()`/`idOf` cannot serve these — those flatten a path to its
 * basename, so every `SKILL.md` would collide on one key. These tests pin that they do not.
 */
import { describe, expect, it } from "vitest";
import { houseSkills, personalSkills, personas, skillFiles } from "./index.ts";

/** `name:` from a `---` frontmatter block; `null` when the block or the key is missing. */
function frontmatterName(text: string): string | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return m ? (/^name:\s*(\S+)\s*$/m.exec(m[1]!)?.[1] ?? null) : null;
}

function skillDirOf(key: string): string {
  return key.split("/")[0]!;
}

const everySkillFile = (): [string, string][] => [
  ...Object.entries(houseSkills).map(([k, v]) => [`house/${k}`, v] as [string, string]),
  ...Object.entries(personalSkills).flatMap(([p, files]) => Object.entries(files).map(([k, v]) => [`personal/${p}/${k}`, v] as [string, string])),
];

describe("skill fixtures", () => {
  it("there are skills to serve, in both layers", () => {
    expect(Object.keys(houseSkills).length).toBeGreaterThan(0);
    expect(personas.length).toBeGreaterThan(1); // two personas is what makes the switch demonstrable
  });

  it("every SKILL.md declares a name equal to its directory (spec, and upstream enforces it)", () => {
    const skillMds = everySkillFile().filter(([key]) => key.endsWith("/SKILL.md"));
    expect(skillMds.length).toBeGreaterThan(0);
    for (const [key, text] of skillMds) {
      const dir = key.slice(0, -"/SKILL.md".length).split("/").pop()!;
      expect(frontmatterName(text), key).toBe(dir);
    }
  });

  it("every SKILL.md carries a description — without one the skill is silently skipped upstream", () => {
    for (const [key, text] of everySkillFile().filter(([k]) => k.endsWith("/SKILL.md"))) {
      expect(/^description:\s*\S/m.test(text), key).toBe(true);
    }
  });

  it("skill names obey the spec: lowercase, hyphens only, no leading or trailing hyphen", () => {
    for (const [key] of everySkillFile()) {
      const name = key.endsWith("/SKILL.md") ? key.slice(0, -"/SKILL.md".length).split("/").pop()! : skillDirOf(key);
      expect(name, key).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
      expect(name, key).not.toContain("--");
    }
  });

  it("ships no scripts — the namespace is virtual and has no execution surface", () => {
    for (const [key] of everySkillFile()) expect(key, key).toMatch(/\.md$/);
  });
});

describe("skillFiles", () => {
  it("mounts the house layer plus exactly one persona, keyed the way the namespace addresses them", () => {
    const files = skillFiles(personas[0]);
    for (const key of Object.keys(files)) expect(key).toMatch(/^(house|personal)\/[a-z0-9-]+\//);
    expect(Object.keys(files).some((k) => k.startsWith("house/"))).toBe(true);
    expect(Object.keys(files).some((k) => k.startsWith("personal/"))).toBe(true);
    // The persona id is not in the served path: the agent sees a personal layer, not who owns it.
    for (const key of Object.keys(files)) expect(key).not.toContain(`/${personas[0]}/`);
  });

  it("distinct personas mount distinct layers — this is what the demo switch shows", () => {
    const a = skillFiles(personas[0]);
    const b = skillFiles(personas[1]);
    expect(a).not.toEqual(b);
    // …while the house layer is identical under both.
    const house = (f: Record<string, string>) => Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith("house/")));
    expect(house(a)).toEqual(house(b));
  });

  it("no persona serves the house layer alone", () => {
    const files = skillFiles(undefined);
    expect(Object.keys(files).every((k) => k.startsWith("house/"))).toBe(true);
  });

  it("an unknown persona mounts no personal layer rather than throwing", () => {
    expect(Object.keys(skillFiles("nobody")).every((k) => k.startsWith("house/"))).toBe(true);
  });

  it("SKILL.md files do not collide across skills or layers", () => {
    const files = skillFiles(personas[0]);
    const skillMds = Object.keys(files).filter((k) => k.endsWith("/SKILL.md"));
    expect(new Set(skillMds).size).toBe(skillMds.length);
    expect(skillMds.length).toBeGreaterThan(1); // the collision `idOf` would have caused
  });
});
