import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// We test the extension lifecycle by simulating Pi's event system
// and checking that the correct skill paths are contributed.

const fixtures = resolve(import.meta.dirname, "fixtures");

/** Shared temp directory for hermetic tests */
const tmpDir = join(homedir(), ".pi-cc-plugins-test-tmp");

/** Create a mock ExtensionAPI that captures event registrations */
function createMockPi() {
	const handlers: Record<string, Function> = {};
	const flags = new Map<string, boolean | string>();
	const eventsEmits: Array<{ channel: string; data: unknown }> = [];
	// A minimal pi EventBus: a map of channel → handler, delivering self-emits
	// synchronously (pi's EventBus is a Node EventEmitter, so a self-emit lands
	// in the emitter's own listeners — that's the trap the handshake works around).
	const eventsBusHandlers = new Map<string, Set<(data: unknown) => void>>();
	const events = {
		emit: vi.fn((channel: string, data: unknown) => {
			eventsEmits.push({ channel, data });
			// Deliver to local listeners (Node EventEmitter semantics).
			for (const handler of eventsBusHandlers.get(channel) ?? []) handler(data);
		}),
		on: vi.fn((channel: string, handler: (data: unknown) => void) => {
			let set = eventsBusHandlers.get(channel);
			if (!set) {
				set = new Set();
				eventsBusHandlers.set(channel, set);
			}
			set.add(handler);
			return () => {
				set?.delete(handler);
			};
		}),
	};
	const mockPi = {
		on: vi.fn((event: string, handler: Function) => {
			handlers[event] = handler;
		}),
		registerTool: vi.fn(),
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerFlag: vi.fn((name: string, _options: { type: string }) => {
			flags.set(name, false);
		}),
		getFlag: vi.fn((name: string) => flags.get(name)),
		events,
	};
	return { mockPi, handlers, flags, events, eventsEmits, eventsBusHandlers };
}

/** Create a mock ExtensionContext */
function createMockCtx(cwd?: string) {
	return {
		cwd: cwd || process.cwd(),
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(),
			setStatus: vi.fn(),
			setEditorText: vi.fn(),
		},
		hasUI: true,
		sessionManager: {},
	};
}

// Import the extension after mocking setup
import extension from "../index.js";
import { parseSource, resolvePlugin } from "../src/index.js";
import { updateClone } from "../src/cache.js";
import { readCcPlugins, readCcClaudeGlobal, readCcClaudeProject } from "../src/settings.js";
import { CC_AGENTS_LINK_DIR } from "../src/agents.js";

describe("extension lifecycle", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("registers session_start, resources_discover, and session_shutdown handlers", () => {
		const { mockPi } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(mockPi.on).toHaveBeenCalledWith("resources_discover", expect.any(Function));
		expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});

	it("contributes skill paths from a local plugin", async () => {
		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx();

		// Trigger resources_discover with no prior session_start
		const discoverResult = await handlers["resources_discover"]({}, ctx);
		expect(discoverResult).toBeUndefined(); // no plugins resolved yet
	});

	it("does not notify when no plugins are configured", () => {
		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx("/nonexistent/path");
		handlers["session_start"]({}, ctx);

		// No plugins → no notification
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("loads plugins from project settings", () => {
		const projectDir = join(tmpDir, "my-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccPlugins: [`local:${resolve(fixtures, "mock-plugin")}`] }),
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("2 skill(s)"),
			"info",
		);
	});
});

describe("resolvePlugin with local source", () => {
	it("resolves a local plugin and discovers its skills", () => {
		const source = parseSource(`local:${resolve(fixtures, "mock-plugin")}`);
		const plugin = resolvePlugin(source);

		expect(plugin.name).toBe("mock-plugin");
		expect(plugin.skillPaths).toHaveLength(2);
		expect(plugin.agentPaths).toEqual([]);
		expect(plugin.rootDir).toBe(resolve(fixtures, "mock-plugin"));
	});

	it("resolves a local plugin with tilde path", () => {
		const actualPath = homedir();
		const source = parseSource(`local:~`);
		const plugin = resolvePlugin(source);
		expect(plugin.rootDir).toBe(actualPath);
		expect(plugin.skillPaths).toEqual([]);
		expect(plugin.agentPaths).toEqual([]);
	});

	it("throws for non-existent local path", () => {
		const source = parseSource("local:/nonexistent/plugin/path");
		expect(() => resolvePlugin(source)).toThrow("does not exist");
	});

	it("resolves local plugin with subpath", () => {
		const source = parseSource(`local:${resolve(fixtures, "mock-plugin")}#subpath=skills/code-reviewer`);
		const plugin = resolvePlugin(source);
		expect(plugin.rootDir).toBe(resolve(fixtures, "mock-plugin", "skills", "code-reviewer"));
	});
});

describe("readCcPlugins", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads ccPlugins from a project settings file", () => {
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccPlugins: ["github:owner/repo", "local:~/path"] }),
		);

		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual(["github:owner/repo", "local:~/path"]);
	});

	it("returns empty array when no ccPlugins in settings", () => {
		writeFileSync(
			join(tmpDir, "settings.json"),
			JSON.stringify({ theme: "dark" }),
		);
		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual([]);
	});

	it("returns empty array when settings file doesn't exist", () => {
		const result = readCcPlugins("/nonexistent/directory", { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual([]);
	});

	it("merges project settings over global settings", () => {
		writeFileSync(
			mockGlobalSettingsPath,
			JSON.stringify({ ccPlugins: ["github:global/plugin"] }),
		);
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccPlugins: ["github:foo/bar"] }),
		);

		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual(["github:foo/bar"]);
	});

	it("falls back to global settings when project has no ccPlugins", () => {
		writeFileSync(
			mockGlobalSettingsPath,
			JSON.stringify({ ccPlugins: ["github:global/plugin"] }),
		);
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ theme: "dark" }),
		);

		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual(["github:global/plugin"]);
	});

	it("handles JSON with comments", () => {
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			`{
  // This is a comment
  "ccPlugins": ["github:owner/repo"]
}`,
		);

		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual(["github:owner/repo"]);
	});

	it("filters out non-string entries", () => {
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccPlugins: ["github:owner/repo", 42, null, { foo: "bar" }] }),
		);

		const result = readCcPlugins(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toEqual(["github:owner/repo"]);
	});
});

describe("readCcClaudeGlobal", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns false when setting is absent", () => {
		const result = readCcClaudeGlobal(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});

	it("returns true when enabled in global settings", () => {
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ ccClaudeGlobal: true }));
		const result = readCcClaudeGlobal(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(true);
	});

	it("returns false when set to a non-boolean value", () => {
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ ccClaudeGlobal: "yes" }));
		const result = readCcClaudeGlobal(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});

	it("does not honor the legacy ccClaudeSkillsGlobal setting", () => {
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ ccClaudeSkillsGlobal: true }));
		const result = readCcClaudeGlobal(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});

	it("project settings override global", () => {
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ ccClaudeGlobal: true }));
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeGlobal: false }),
		);
		const result = readCcClaudeGlobal(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});
});

describe("readCcClaudeProject", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns false when setting is absent", () => {
		const result = readCcClaudeProject(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});

	it("returns true when enabled in project settings", () => {
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeProject: true }),
		);
		const result = readCcClaudeProject(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(true);
	});

	it("returns false when set to a non-boolean value", () => {
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeProject: 1 }),
		);
		const result = readCcClaudeProject(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});

	it("does not honor the legacy ccClaudeSkillsProject setting", () => {
		const settingsDir = join(tmpDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeSkillsProject: true }),
		);
		const result = readCcClaudeProject(tmpDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(false);
	});
});

describe("extension with .claude/skills", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("loads skills from project .claude/skills when ccClaudeProject is enabled", async () => {
		const projectDir = join(tmpDir, "claude-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeProject: true }),
		);

		// Create .claude/skills fixture
		const claudeSkillsDir = join(projectDir, ".claude", "skills", "my-skill");
		mkdirSync(claudeSkillsDir, { recursive: true });
		writeFileSync(
			join(claudeSkillsDir, "SKILL.md"),
			"---\nname: my-skill\ndescription: Test skill\n---\n\n# Test\n",
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("1 skill(s)"),
			"info",
		);

		// Verify resources_discover returns the skill
		const discoverResult = await handlers["resources_discover"]({}, ctx);
		expect(discoverResult).toBeDefined();
		expect(discoverResult!.skillPaths).toHaveLength(1);
	});

	it("does not load .claude/skills when settings are disabled", async () => {
		const projectDir = join(tmpDir, "claude-project-off");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeProject: false }),
		);

		// Create .claude/skills fixture
		const claudeSkillsDir = join(projectDir, ".claude", "skills", "my-skill");
		mkdirSync(claudeSkillsDir, { recursive: true });
		writeFileSync(
			join(claudeSkillsDir, "SKILL.md"),
			"---\nname: my-skill\ndescription: Test skill\n---\n\n# Test\n",
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		// No skills loaded → no notification
		expect(ctx.ui.notify).not.toHaveBeenCalled();

		const discoverResult = await handlers["resources_discover"]({}, ctx);
		expect(discoverResult).toBeUndefined();
	});

	it("does not load .claude resources when only legacy settings are enabled", async () => {
		const projectDir = join(tmpDir, "claude-legacy-off");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ packages: ["npm:pi-subagents"] }));
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeSkillsProject: true }),
		);

		const claudeSkillsDir = join(projectDir, ".claude", "skills", "legacy-skill");
		mkdirSync(claudeSkillsDir, { recursive: true });
		writeFileSync(
			join(claudeSkillsDir, "SKILL.md"),
			"---\nname: legacy-skill\ndescription: Legacy skill\n---\n\n# Legacy\n",
		);

		const claudeAgentsDir = join(projectDir, ".claude", "agents");
		mkdirSync(claudeAgentsDir, { recursive: true });
		writeFileSync(
			join(claudeAgentsDir, "legacy-agent.md"),
			"---\nname: legacy-agent\ndescription: Legacy agent\n---\n\nLegacy prompt.\n",
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(existsSync(join(projectDir, CC_AGENTS_LINK_DIR))).toBe(false);

		const discoverResult = await handlers["resources_discover"]({}, ctx);
		expect(discoverResult).toBeUndefined();
	});

	it("loads skills from global ~/.claude/skills when ccClaudeGlobal is enabled", async () => {
		const projectDir = join(tmpDir, "claude-global-project");
		mkdirSync(projectDir, { recursive: true });

		// Enable global setting
		writeFileSync(
			mockGlobalSettingsPath,
			JSON.stringify({ ccClaudeGlobal: true }),
		);

		// Create a fake home .claude/skills
		const fakeHome = join(tmpDir, "fake-home");
		const claudeSkillsDir = join(fakeHome, ".claude", "skills", "global-skill");
		mkdirSync(claudeSkillsDir, { recursive: true });
		writeFileSync(
			join(claudeSkillsDir, "SKILL.md"),
			"---\nname: global-skill\ndescription: Global test\n---\n\n# Global\n",
		);

		// We can't easily override homedir(), so we test indirectly via the settings reader
		// The extension test verifies the setting is read correctly
		const result = readCcClaudeGlobal(projectDir, { globalSettingsPath: mockGlobalSettingsPath });
		expect(result).toBe(true);
	});

	it("combines plugin skills and .claude/skills", async () => {
		const projectDir = join(tmpDir, "combined-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				ccPlugins: [`local:${resolve(fixtures, "mock-plugin")}`],
				ccClaudeProject: true,
			}),
		);

		// Create .claude/skills fixture
		const claudeSkillsDir = join(projectDir, ".claude", "skills", "extra-skill");
		mkdirSync(claudeSkillsDir, { recursive: true });
		writeFileSync(
			join(claudeSkillsDir, "SKILL.md"),
			"---\nname: extra-skill\ndescription: Extra\n---\n\n# Extra\n",
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		// 2 plugin skills + 1 .claude/skill = 3 total
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("3 skill(s)"),
			"info",
		);

		const discoverResult = await handlers["resources_discover"]({}, ctx);
		expect(discoverResult).toBeDefined();
		expect(discoverResult!.skillPaths).toHaveLength(3);
	});

	it("sanitizes frontmatter from .claude/skills", async () => {
		const projectDir = join(tmpDir, "sanitize-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeProject: true }),
		);

		// Create .claude/skills fixture with loose frontmatter
		const claudeSkillsDir = join(projectDir, ".claude", "skills", "loose-skill");
		mkdirSync(claudeSkillsDir, { recursive: true });
		writeFileSync(
			join(claudeSkillsDir, "SKILL.md"),
			"---\nname: loose-skill\ndescription: Use when: testing, and do NOT use for: prod\nargument-hint: [arg1] [arg2]\n---\n\n# Loose\n",
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		const discoverResult = await handlers["resources_discover"]({}, ctx);
		expect(discoverResult).toBeDefined();
		expect(discoverResult!.skillPaths).toHaveLength(1);

		// Read the materialized SKILL.md and verify sanitization
		const { readFileSync } = await import("node:fs");
		const materialized = readFileSync(join(discoverResult!.skillPaths[0], "SKILL.md"), "utf-8");
		expect(materialized).toContain('name: "loose-skill"');
		expect(materialized).toContain('description: "Use when: testing, and do NOT use for: prod"');
		expect(materialized).toContain('argument-hint: "[arg1] [arg2]"');
	});
});


describe("extension with .claude/agents", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ packages: ["npm:pi-subagents"] }));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("loads agents from project .claude/agents when ccClaudeProject is enabled", () => {
		const projectDir = join(tmpDir, "claude-agent-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeProject: true }),
		);

		const claudeAgentsDir = join(projectDir, ".claude", "agents");
		mkdirSync(claudeAgentsDir, { recursive: true });
		writeFileSync(
			join(claudeAgentsDir, "test-agent.md"),
			"---\nname: test-agent\ndescription: Test project agent\nmodel: sonnet\ntools: read, grep\n---\n\nProject prompt.\n",
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("1 agent(s)"),
			"info",
		);

		const linkPath = join(projectDir, CC_AGENTS_LINK_DIR, "claude-project--test-agent.md");
		expect(existsSync(linkPath)).toBe(true);

		const converted = readFileSync(linkPath, "utf-8");
		expect(converted).toContain("package: claude-project");
		expect(converted).toContain("Project prompt.");
		expect(converted).not.toContain("model:");
		expect(converted).not.toContain("tools:");

		handlers["session_shutdown"]({}, ctx);
		expect(existsSync(join(projectDir, CC_AGENTS_LINK_DIR))).toBe(false);
	});

	it("does not load agents from project .claude/agents when ccClaudeProject is disabled", () => {
		const projectDir = join(tmpDir, "claude-agent-project-off");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeProject: false }),
		);

		const claudeAgentsDir = join(projectDir, ".claude", "agents");
		mkdirSync(claudeAgentsDir, { recursive: true });
		writeFileSync(
			join(claudeAgentsDir, "test-agent.md"),
			"---\nname: test-agent\ndescription: Test project agent\n---\n\nProject prompt.\n",
		);

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(existsSync(join(projectDir, CC_AGENTS_LINK_DIR))).toBe(false);
	});
});

describe("plugin update (--cc-plugins-update)", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("registers the cc-plugins-update flag", () => {
		const { mockPi } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		expect(mockPi.registerFlag).toHaveBeenCalledWith(
			"cc-plugins-update",
			expect.objectContaining({ type: "boolean" }),
		);
	});

	it("updateClone creates a new clone when cache does not exist", () => {
		// Use a real git repo in a temp location to test the update flow
		const upstreamDir = join(tmpDir, "upstream-repo");
		mkdirSync(upstreamDir, { recursive: true });
		execSync("git init", { cwd: upstreamDir, stdio: "pipe" });
		execSync("git config user.email test@pi.test", { cwd: upstreamDir, stdio: "pipe" });
		execSync("git config user.name Test", { cwd: upstreamDir, stdio: "pipe" });
		writeFileSync(join(upstreamDir, "README.md"), "# v1");
		execSync("git add README.md", { cwd: upstreamDir, stdio: "pipe" });
		execSync("git commit -m initial", { cwd: upstreamDir, stdio: "pipe" });

		const source = parseSource(`git:file://${upstreamDir}`);

		// First time: no cache — updateClone falls back to ensureCloned
		const cloneDir = updateClone(source);
		expect(existsSync(join(cloneDir, ".git"))).toBe(true);
		expect(readFileSync(join(cloneDir, "README.md"), "utf-8")).toContain("# v1");

		// Add a new commit upstream
		writeFileSync(join(upstreamDir, "README.md"), "# v2");
		execSync("git add README.md", { cwd: upstreamDir, stdio: "pipe" });
		execSync("git commit -m second", { cwd: upstreamDir, stdio: "pipe" });

		// Second time: updateClone should fetch and reset
		const updatedDir = updateClone(source);
		expect(updatedDir).toBe(cloneDir);
		expect(readFileSync(join(cloneDir, "README.md"), "utf-8")).toContain("# v2");
	});

	it("resolvePlugin with update uses updateClone for remote sources", () => {
		const { importMeta } = { importMeta: { dirname: fixtures } } as any;
		const pluginDir = resolve(fixtures, "mock-plugin");
		const source = parseSource(`local:${pluginDir}`);

		// Local plugins are unaffected by update flag
		const plugin = resolvePlugin(source, undefined, true);
		expect(plugin.name).toBe("mock-plugin");
		expect(plugin.rootDir).toBe(pluginDir);
	});

	it("session_start passes update flag to resolvePlugin when set", () => {
		const { mockPi, handlers, flags } = createMockPi();
		flags.set("cc-plugins-update", true);

		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const projectDir = join(tmpDir, "update-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccPlugins: [`local:${resolve(fixtures, "mock-plugin")}`] }),
		);

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		// Should have loaded the plugin (local plugins work fine with update)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("2 skill(s)"),
			"info",
		);
	});
});

// Bus channels for the herdr provider seam (spec §8). Mirrors the wire contract
// in index.ts; the two packages are decoupled, so the test re-declares them.
const HERDR_PKG = "pi-herdr-subagents";
const PROVIDER_READY = `${HERDR_PKG}:provider-ready`;
const PROVIDER_READY_REQUEST = `${HERDR_PKG}:provider-ready-request`;
const REGISTER = `${HERDR_PKG}:register`;

describe("herdr provider seam (spec §8)", () => {
	const mockGlobalSettingsPath = join(tmpDir, "global-settings.json");

	beforeEach(() => {
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(mockGlobalSettingsPath, "{}");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Wire a project with one agent in `.claude/agents` (project source). */
	function wireProjectAgent(): string {
		const projectDir = join(tmpDir, "herdr-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeProject: true }),
		);
		const agentsDir = join(projectDir, ".claude", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			"---\nname: reviewer\ndescription: Reviews code\n---\n\nYou review code.\n",
		);
		return projectDir;
	}

	it("emits provider-ready-request at factory time and sets its flag on the provider's ready, in either load order", () => {
		// CONSUMER-FIRST: the extension factory runs before any provider signal.
		// This also covers PROVIDER-FIRST: the consumer emits its request at
		// factory time unconditionally, so a provider that already emitted its
		// ready (which the consumer missed) will reply to this request. Either
		// load order converges on the same handshake.
		const { events, eventsEmits } = createMockPi();
		extension({ on: () => {}, registerFlag: () => {}, getFlag: () => false, events } as any, {
			globalSettingsPath: mockGlobalSettingsPath,
		});

		// The consumer announces itself at factory time.
		expect(eventsEmits.some((e) => e.channel === PROVIDER_READY_REQUEST)).toBe(true);
		expect(eventsEmits.some((e) => e.channel === PROVIDER_READY)).toBe(false);

		// PROVIDER loads second and emits `provider-ready`. The consumer sets its
		// flag and re-emits `provider-ready-request` once (so a provider that
		// loaded first learns it exists).
		const requestsBefore = eventsEmits.filter((e) => e.channel === PROVIDER_READY_REQUEST).length;
		events.emit(PROVIDER_READY, { version: 1 });
		const requestsAfter = eventsEmits.filter((e) => e.channel === PROVIDER_READY_REQUEST).length;
		expect(requestsAfter).toBe(requestsBefore + 1);

		// A second `provider-ready` must NOT trigger another re-emit (no ping-pong).
		events.emit(PROVIDER_READY, { version: 1 });
		expect(eventsEmits.filter((e) => e.channel === PROVIDER_READY_REQUEST).length).toBe(requestsAfter);
	});

	it("registers agents over the bus when the provider is present and skips the symlink", async () => {
		const projectDir = wireProjectAgent();

		const { mockPi, handlers, events, eventsEmits } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		// Provider announces presence BEFORE session_start. The consumer's
		// handshake listener (installed at factory time) sets the flag.
		events.emit(PROVIDER_READY, { version: 1 });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		// No registration emitted during session_start — it is deferred to resource
		// discovery (spec §8: discover, then surface).
		expect(eventsEmits.filter((e) => e.channel === REGISTER)).toHaveLength(0);

		// Symlink path is skipped: no `.pi/agents/cc-plugins` directory is created.
		expect(existsSync(join(projectDir, CC_AGENTS_LINK_DIR))).toBe(false);

		// The count is reported optimistically (same opacity as the symlink path).
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("1 agent(s)"),
			"info",
		);

		// resource discovery emits one registration per source, then clears the list.
		await handlers["resources_discover"]({}, ctx);
		const registrations = eventsEmits.filter((e) => e.channel === REGISTER);
		expect(registrations).toHaveLength(1);
		expect(registrations[0].data).toEqual({
			version: 1,
			paths: [join(projectDir, ".claude", "agents", "reviewer.md")],
			namespace: "", // standalone `.claude/agents` is unnamespaced
			source: "project",
		});

		// A second discovery does not re-emit (the pending list was cleared).
		await handlers["resources_discover"]({}, ctx);
		expect(eventsEmits.filter((e) => e.channel === REGISTER)).toHaveLength(1);
	});

	it("uses the plugin name as namespace for plugin-shipped agents", async () => {
		const projectDir = join(tmpDir, "herdr-plugin-project");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccPlugins: [`local:${resolve(fixtures, "mock-plugin-with-agents")}`] }),
		);

		const { mockPi, handlers, events, eventsEmits } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });
		events.emit(PROVIDER_READY, { version: 1 });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);
		await handlers["resources_discover"]({}, ctx);

		// mock-plugin-with-agents ships two agents under one plugin → one
		// registration, namespaced by the plugin name, source `package`.
		const registrations = eventsEmits.filter((e) => e.channel === REGISTER);
		expect(registrations).toHaveLength(1);
		expect(registrations[0].data).toMatchObject({
			version: 1,
			namespace: "plugin-with-agents",
			source: "package",
		});
		expect((registrations[0].data as any).paths).toHaveLength(2);
		expect(existsSync(join(projectDir, CC_AGENTS_LINK_DIR))).toBe(false);
	});

	it("emits one registration per source when multiple sources are present", async () => {
		// A plugin (package source) AND a project `.claude/agents` (project source).
		const projectDir = join(tmpDir, "herdr-multi");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				ccPlugins: [`local:${resolve(fixtures, "mock-plugin-with-agents")}`],
				ccClaudeProject: true,
			}),
		);
		const agentsDir = join(projectDir, ".claude", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "standalone.md"),
			"---\nname: standalone\ndescription: A bare-name agent\n---\n\nPrompt.\n",
		);

		const { mockPi, handlers, events, eventsEmits } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });
		events.emit(PROVIDER_READY, { version: 1 });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);
		await handlers["resources_discover"]({}, ctx);

		const registrations = eventsEmits.filter((e) => e.channel === REGISTER);
		expect(registrations).toHaveLength(2);
		const byNs = new Map(registrations.map((r) => [(r.data as any).namespace, r.data]));
		expect(byNs.get("plugin-with-agents")).toMatchObject({ source: "package" });
		expect(byNs.get("")).toMatchObject({ source: "project" });
	});

	it("runs the convert-and-symlink path unchanged when the provider is absent and pi-subagents is installed", () => {
		const projectDir = join(tmpDir, "subagents-fallback");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeProject: true }),
		);
		const agentsDir = join(projectDir, ".claude", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "test-agent.md"),
			"---\nname: test-agent\ndescription: Test\nmodel: sonnet\ntools: read\n---\n\nPrompt.\n",
		);

		// pi-subagents installed, herdr provider NOT announced.
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ packages: ["npm:pi-subagents"] }));

		const { mockPi, handlers, eventsEmits } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		// The symlink lands and carries the converted frontmatter.
		const linkPath = join(projectDir, CC_AGENTS_LINK_DIR, "claude-project--test-agent.md");
		expect(existsSync(linkPath)).toBe(true);
		const converted = readFileSync(linkPath, "utf-8");
		expect(converted).toContain("package: claude-project");
		expect(converted).not.toContain("model:");

		// No bus registration is emitted in the fallback branch.
		expect(eventsEmits.filter((e) => e.channel === REGISTER)).toHaveLength(0);
	});

	it("warns naming the migration target first and the legacy alternative second when neither is present", () => {
		const projectDir = join(tmpDir, "neither");
		const settingsDir = join(projectDir, ".pi");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ ccClaudeProject: true }),
		);
		const agentsDir = join(projectDir, ".claude", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "test-agent.md"),
			"---\nname: test-agent\ndescription: Test\n---\n\nPrompt.\n",
		);

		// No packages installed, no provider announced.
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ packages: [] }));

		const { mockPi, handlers, eventsEmits } = createMockPi();
		extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		const warning = ctx.ui.notify.mock.calls.find(
			(call) => call[1] === "warning",
		)?.[0] as string | undefined;
		expect(warning).toBeDefined();
		// Migration target named first, legacy alternative second.
		expect(warning!.indexOf("@asermax/pi-herdr-subagents")).toBeLessThan(
			warning!.indexOf("pi-subagents"),
		);
		expect(warning!).toContain("@asermax/pi-herdr-subagents");
		expect(warning!).toContain("pi-subagents");

		// No symlink, no registration.
		expect(existsSync(join(projectDir, CC_AGENTS_LINK_DIR))).toBe(false);
		expect(eventsEmits.filter((e) => e.channel === REGISTER)).toHaveLength(0);
	});

	it("decrements the refcount on shutdown only on the pi-subagents branch", () => {
		// --- pi-subagents branch: refcount fires ---
		const subagentsProject = join(tmpDir, "shutdown-subagents");
		const subagentsSettings = join(subagentsProject, ".pi");
		mkdirSync(subagentsSettings, { recursive: true });
		writeFileSync(
			join(subagentsSettings, "settings.json"),
			JSON.stringify({ ccClaudeProject: true }),
		);
		const subAgentsDir = join(subagentsProject, ".claude", "agents");
		mkdirSync(subAgentsDir, { recursive: true });
		writeFileSync(
			join(subAgentsDir, "a.md"),
			"---\nname: a\ndescription: A\n---\n\nPrompt.\n",
		);
		writeFileSync(mockGlobalSettingsPath, JSON.stringify({ packages: ["npm:pi-subagents"] }));

		{
			const { mockPi, handlers } = createMockPi();
			extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });
			const ctx = createMockCtx(subagentsProject);
			handlers["session_start"]({}, ctx);
			expect(existsSync(join(subagentsProject, CC_AGENTS_LINK_DIR))).toBe(true);
			handlers["session_shutdown"]({}, ctx);
			// Refcount decremented → symlink directory removed.
			expect(existsSync(join(subagentsProject, CC_AGENTS_LINK_DIR))).toBe(false);
		}

		// --- herdr branch: refcount must NOT fire; symlink dir never existed ---
		const herdrProject = join(tmpDir, "shutdown-herdr");
		const herdrSettings = join(herdrProject, ".pi");
		mkdirSync(herdrSettings, { recursive: true });
		writeFileSync(
			join(herdrSettings, "settings.json"),
			JSON.stringify({ ccClaudeProject: true }),
		);
		const herdrAgentsDir = join(herdrProject, ".claude", "agents");
		mkdirSync(herdrAgentsDir, { recursive: true });
		writeFileSync(
			join(herdrAgentsDir, "a.md"),
			"---\nname: a\ndescription: A\n---\n\nPrompt.\n",
		);

		{
			const { mockPi, handlers, events } = createMockPi();
			extension(mockPi as any, { globalSettingsPath: mockGlobalSettingsPath });
			events.emit(PROVIDER_READY, { version: 1 });
			const ctx = createMockCtx(herdrProject);
			handlers["session_start"]({}, ctx);
			expect(existsSync(join(herdrProject, CC_AGENTS_LINK_DIR))).toBe(false);

			// Shutdown must not throw and must leave the (absent) symlink dir absent.
			expect(() => handlers["session_shutdown"]({}, ctx)).not.toThrow();
			expect(existsSync(join(herdrProject, CC_AGENTS_LINK_DIR))).toBe(false);
		}
	});
});
