import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import extension from "../index.js";
import { parseSource } from "../src/source.js";
import { discoverMcpConfigPaths, resolvePlugin } from "../src/plugin.js";
import {
	collectPluginMcpServers,
	readPluginMcpServers,
	cleanupLegacyMcpState,
	getProjectMcpConfigPath,
} from "../src/mcp.js";
import type { ResolvedPlugin } from "../src/types.js";

const tmpDir = join(homedir(), ".pi-cc-plugins-mcp-test-tmp");

function createMockPi() {
	const handlers: Record<string, Function> = {};
	const flags = new Map<string, boolean | string>();
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
		registerMcpServer: vi.fn(),
	};
	return { mockPi, handlers, flags };
}

function createMockCtx(cwd: string) {
	return {
		cwd,
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

function writeJson(filePath: string, value: unknown): void {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createPlugin(name: string, files: Record<string, unknown>): string {
	const pluginDir = join(tmpDir, name);
	mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
	writeJson(join(pluginDir, ".claude-plugin", "plugin.json"), { name });

	for (const [relativePath, value] of Object.entries(files)) {
		writeJson(join(pluginDir, relativePath), value);
	}

	return pluginDir;
}

function pluginFixture(name: string, mcpConfigPaths: string[]): ResolvedPlugin {
	return {
		rootDir: join(tmpDir, name),
		name,
		skillPaths: [],
		agentPaths: [],
		mcpConfigPaths,
		source: parseSource(`local:${join(tmpDir, name)}`),
	};
}

function legacySidecarPath(projectDir: string): string {
	return join(projectDir, ".pi", "mcp.cc-plugins.json");
}

beforeEach(() => {
	mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("discoverMcpConfigPaths", () => {
	it("discovers mcp.json, .mcp.json, and manifest mcp paths in order", () => {
		const pluginDir = createPlugin("mcp-plugin", {
			"mcp.json": { mcpServers: { first: { command: "first" } } },
			".mcp.json": { mcpServers: { second: { command: "second" } } },
			"custom/mcp.json": { mcpServers: { third: { command: "third" } } },
		});
		writeJson(join(pluginDir, ".claude-plugin", "plugin.json"), {
			name: "mcp-plugin",
			mcp: "./custom/mcp.json",
		});

		expect(discoverMcpConfigPaths(pluginDir)).toEqual([
			join(pluginDir, "mcp.json"),
			join(pluginDir, ".mcp.json"),
			join(pluginDir, "custom", "mcp.json"),
		]);
	});

	it("ignores manifest mcp paths outside the plugin root", () => {
		const pluginDir = createPlugin("unsafe-plugin", {
			"mcp.json": { mcpServers: { safe: { command: "safe" } } },
		});
		writeJson(join(pluginDir, ".claude-plugin", "plugin.json"), {
			name: "unsafe-plugin",
			mcp: "../outside.json",
		});
		writeJson(join(tmpDir, "outside.json"), { mcpServers: { unsafe: { command: "unsafe" } } });

		expect(discoverMcpConfigPaths(pluginDir)).toEqual([
			join(pluginDir, "mcp.json"),
		]);
	});

	it("adds discovered MCP config paths to resolved plugins", () => {
		const pluginDir = createPlugin("resolved-plugin", {
			"mcp.json": { mcpServers: { server: { command: "server" } } },
		});
		const plugin = resolvePlugin(parseSource(`local:${pluginDir}`));

		expect(plugin.mcpConfigPaths).toEqual([join(pluginDir, "mcp.json")]);
	});
});

describe("readPluginMcpServers", () => {
	it("extracts only object-shaped MCP server definitions", () => {
		const configPath = join(tmpDir, "servers.json");
		writeJson(configPath, {
			settings: { directTools: true },
			imports: ["cursor"],
			mcpServers: {
				valid: { command: "npx", args: ["server"] },
				invalid: null,
			},
		});

		const result = readPluginMcpServers(configPath);

		expect(Object.keys(result.servers)).toEqual(["valid"]);
		expect(result.servers.valid.command).toBe("npx");
		expect(result.warnings).toHaveLength(1);
	});

	it("supports mcp-servers as a compatibility key", () => {
		const configPath = join(tmpDir, "servers.json");
		writeJson(configPath, {
			"mcp-servers": {
				compat: { command: "compat" },
			},
		});

		expect(Object.keys(readPluginMcpServers(configPath).servers)).toEqual(["compat"]);
	});
});

describe("collectPluginMcpServers", () => {
	it("namespaces servers and lets later config files win for duplicate original names", () => {
		const firstPath = join(tmpDir, "first.json");
		const secondPath = join(tmpDir, "second.json");
		writeJson(firstPath, { mcpServers: { browser: { command: "first" } } });
		writeJson(secondPath, { mcpServers: { browser: { command: "second" } } });

		const result = collectPluginMcpServers([
			pluginFixture("My Plugin", [firstPath, secondPath]),
		]);

		expect(result.servers).toHaveLength(1);
		expect(result.servers[0].generatedName).toBe("my-plugin__browser");
		expect(result.servers[0].definition.command).toBe("second");
	});

	it("warns and keeps the first definition for generated name collisions", () => {
		const firstPath = join(tmpDir, "first.json");
		const secondPath = join(tmpDir, "second.json");
		writeJson(firstPath, { mcpServers: { "foo-bar": { command: "first" } } });
		writeJson(secondPath, { mcpServers: { "foo_bar": { command: "second" } } });

		const result = collectPluginMcpServers([
			pluginFixture("plugin", [firstPath]),
			pluginFixture("plugin", [secondPath]),
		]);

		expect(result.servers).toHaveLength(1);
		expect(result.servers[0].definition.command).toBe("first");
		expect(result.warnings[0]).toContain("collides");
	});
});

describe("cleanupLegacyMcpState", () => {
	it("is a no-op when no legacy sidecar exists", () => {
		const projectDir = join(tmpDir, "clean-project");

		expect(cleanupLegacyMcpState(projectDir)).toEqual([]);
		expect(existsSync(getProjectMcpConfigPath(projectDir))).toBe(false);
	});

	it("removes managed entries, preserves user entries, and deletes the sidecar", () => {
		const projectDir = join(tmpDir, "legacy-project");
		const configPath = getProjectMcpConfigPath(projectDir);
		writeJson(configPath, {
			custom: true,
			mcpServers: {
				manual: { command: "manual" },
				"my-plugin__browser": { command: "browser" },
				"my-plugin__docs": { command: "docs" },
			},
		});
		writeJson(legacySidecarPath(projectDir), {
			version: 1,
			entries: [
				{ name: "my-plugin__browser", pluginName: "my-plugin", originalName: "browser", configPath: "/tmp/x" },
				{ name: "my-plugin__docs", pluginName: "my-plugin", originalName: "docs", configPath: "/tmp/y" },
			],
		});

		expect(cleanupLegacyMcpState(projectDir)).toEqual([]);

		const written = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(written.custom).toBe(true);
		expect(written.mcpServers).toEqual({ manual: { command: "manual" } });
		expect(existsSync(legacySidecarPath(projectDir))).toBe(false);
	});

	it("deletes the project mcp.json when nothing is left after cleanup", () => {
		const projectDir = join(tmpDir, "empty-legacy-project");
		const configPath = getProjectMcpConfigPath(projectDir);
		writeJson(configPath, {
			mcpServers: {
				"my-plugin__browser": { command: "browser" },
			},
		});
		writeJson(legacySidecarPath(projectDir), {
			version: 1,
			entries: [
				{ name: "my-plugin__browser", pluginName: "my-plugin", originalName: "browser", configPath: "/tmp/x" },
			],
		});

		cleanupLegacyMcpState(projectDir);

		expect(existsSync(configPath)).toBe(false);
		expect(existsSync(legacySidecarPath(projectDir))).toBe(false);
	});

	it("warns and still deletes the sidecar when it cannot be parsed", () => {
		const projectDir = join(tmpDir, "broken-sidecar-project");
		const configPath = getProjectMcpConfigPath(projectDir);
		writeJson(configPath, {
			mcpServers: { manual: { command: "manual" } },
		});
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(legacySidecarPath(projectDir), "not json", "utf-8");

		const warnings = cleanupLegacyMcpState(projectDir);

		expect(warnings).toHaveLength(1);
		expect(existsSync(legacySidecarPath(projectDir))).toBe(false);
		expect(JSON.parse(readFileSync(configPath, "utf-8")).mcpServers.manual.command).toBe("manual");
	});
});

describe("extension MCP lifecycle", () => {
	it("registers plugin servers with pi's built-in MCP support", () => {
		const projectDir = join(tmpDir, "register-project");
		const pluginDir = createPlugin("MCP Plugin", {
			"mcp.json": { mcpServers: { browser: { command: "browser" } } },
		});
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeJson(join(projectDir, ".pi", "settings.json"), {
			ccPlugins: [`local:${pluginDir}`],
		});
		const globalSettingsPath = join(tmpDir, "global-settings.json");
		writeJson(globalSettingsPath, {});

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		expect(mockPi.registerMcpServer).toHaveBeenCalledWith("mcp-plugin__browser", { command: "browser" });
		expect(existsSync(getProjectMcpConfigPath(projectDir))).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("1 MCP server(s)"),
			"info",
		);
	});

	it("warns when a server registration fails", () => {
		const projectDir = join(tmpDir, "invalid-server-project");
		const pluginDir = createPlugin("bad-mcp-plugin", {
			"mcp.json": { mcpServers: { legacy: { type: "sse", url: "https://example.com/sse" } } },
		});
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeJson(join(projectDir, ".pi", "settings.json"), {
			ccPlugins: [`local:${pluginDir}`],
		});
		const globalSettingsPath = join(tmpDir, "global-settings.json");
		writeJson(globalSettingsPath, {});

		const { mockPi, handlers } = createMockPi();
		mockPi.registerMcpServer.mockImplementation(() => {
			throw new Error('Invalid MCP server config "bad-mcp-plugin__legacy": sse is not supported');
		});
		extension(mockPi as any, { globalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		expect(mockPi.registerMcpServer).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("bad-mcp-plugin__legacy"),
			"warning",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("MCP server(s)"),
			"info",
		);
	});

	it("cleans legacy managed entries on session_start", () => {
		const projectDir = join(tmpDir, "migration-project");
		const pluginDir = createPlugin("plain-plugin", {
			".claude-plugin/plugin.json": { name: "plain-plugin" },
		});
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeJson(join(projectDir, ".pi", "settings.json"), {
			ccPlugins: [`local:${pluginDir}`],
		});
		const configPath = getProjectMcpConfigPath(projectDir);
		writeJson(configPath, {
			mcpServers: {
				manual: { command: "manual" },
				"my-plugin__browser": { command: "browser" },
			},
		});
		writeJson(legacySidecarPath(projectDir), {
			version: 1,
			entries: [
				{ name: "my-plugin__browser", pluginName: "my-plugin", originalName: "browser", configPath: "/tmp/x" },
			],
		});
		const globalSettingsPath = join(tmpDir, "global-settings.json");
		writeJson(globalSettingsPath, {});

		const { mockPi, handlers } = createMockPi();
		extension(mockPi as any, { globalSettingsPath });

		const ctx = createMockCtx(projectDir);
		handlers["session_start"]({}, ctx);

		const written = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(written.mcpServers).toEqual({ manual: { command: "manual" } });
		expect(existsSync(legacySidecarPath(projectDir))).toBe(false);
		expect(mockPi.registerMcpServer).not.toHaveBeenCalled();
	});
});
