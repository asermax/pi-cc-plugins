import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { basename, join, resolve } from "node:path";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { discoverSkillPaths, readPluginName } from "../src/plugin.js";

const fixtures = resolve(import.meta.dirname, "fixtures");

describe("discoverSkillPaths", () => {
	it("discovers skills from a standard plugin layout", () => {
		const pluginDir = resolve(fixtures, "mock-plugin");
		const paths = discoverSkillPaths(pluginDir);

		expect(paths).toHaveLength(2);
		expect(paths).toContain(resolve(pluginDir, "skills", "code-reviewer"));
		expect(paths).toContain(resolve(pluginDir, "skills", "pdf-processor"));
	});

	it("discovers skills from a plugin without a manifest", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-no-manifest");
		const paths = discoverSkillPaths(pluginDir);

		expect(paths).toHaveLength(1);
		expect(paths).toContain(resolve(pluginDir, "skills", "greeter"));
	});

	it("uses custom skills path from plugin.json", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-custom-skills");
		const paths = discoverSkillPaths(pluginDir);

		expect(paths).toHaveLength(1);
		expect(paths).toContain(resolve(pluginDir, "custom-dir", "deep-reviewer"));
	});

	it("returns empty array when plugin has no skills directory", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-no-skills");
		const paths = discoverSkillPaths(pluginDir);

		expect(paths).toEqual([]);
	});

	it("returns empty array for a non-existent directory", () => {
		const paths = discoverSkillPaths("/non/existent/path");
		expect(paths).toEqual([]);
	});
});

describe("discoverSkillPaths with symlinks", () => {
	const tmpDir = join(homedir(), ".pi-cc-plugins-test-symlink-skills");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("discovers skill directories that are symlinks", () => {
		const targetDir = join(tmpDir, "shared", "linked-skill");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "SKILL.md"), "---\nname: linked-skill\n---\n\nBody\n");

		const pluginDir = join(tmpDir, "plugin");
		mkdirSync(join(pluginDir, "skills"), { recursive: true });
		symlinkSync("../../shared/linked-skill", join(pluginDir, "skills", "linked-skill"));

		const paths = discoverSkillPaths(pluginDir);
		expect(paths).toEqual([join(pluginDir, "skills", "linked-skill")]);
	});

	it("discovers skills behind a symlinked SKILL.md file", () => {
		const sourceSkillDir = join(tmpDir, "source-skill");
		mkdirSync(sourceSkillDir, { recursive: true });
		writeFileSync(join(sourceSkillDir, "SKILL.md"), "---\nname: file-link\n---\n\nBody\n");

		const pluginDir = join(tmpDir, "plugin-file-link");
		const skillDir = join(pluginDir, "skills", "file-link");
		mkdirSync(skillDir, { recursive: true });
		symlinkSync(join(sourceSkillDir, "SKILL.md"), join(skillDir, "SKILL.md"));

		const paths = discoverSkillPaths(pluginDir);
		expect(paths).toEqual([skillDir]);
	});

	it("does not loop when a symlink points back to an ancestor", () => {
		const pluginDir = join(tmpDir, "loop-plugin");
		const skillDir = join(pluginDir, "skills", "real-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: real-skill\n---\n\nBody\n");

		symlinkSync(pluginDir, join(pluginDir, "skills", "loop"));

		const paths = discoverSkillPaths(pluginDir);
		expect(paths).toHaveLength(1);
		expect(basename(paths[0])).toBe("real-skill");
	});
});

describe("readPluginName", () => {
	it("reads name from .claude-plugin/plugin.json", () => {
		const pluginDir = resolve(fixtures, "mock-plugin");
		expect(readPluginName(pluginDir)).toBe("mock-plugin");
	});

	it("falls back to directory name when no manifest exists", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-no-manifest");
		expect(readPluginName(pluginDir)).toBe("mock-plugin-no-manifest");
	});

	it("falls back to directory name when manifest has no name", () => {
		const pluginDir = resolve(fixtures, "mock-plugin-custom-skills");
		expect(readPluginName(pluginDir)).toBe("custom-skills-plugin");
	});
});
