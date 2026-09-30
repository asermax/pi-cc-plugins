import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeSkillName } from "./skills.js";
import type { McpServerEntry, PluginMcpServer, ResolvedPlugin } from "./types.js";

const MCP_CONFIG_PATH = ".pi/mcp.json";
const LEGACY_SIDECAR_PATH = ".pi/mcp.cc-plugins.json";

export function getProjectMcpConfigPath(projectRoot: string): string {
	return join(projectRoot, MCP_CONFIG_PATH);
}

export function normalizeMcpName(name: string, fallbackName: string): string {
	return normalizeSkillName(name, fallbackName);
}

export function readPluginMcpServers(configPath: string): { servers: Record<string, McpServerEntry>; warnings: string[] } {
	const raw = readJsonObject(configPath);
	const rawServers = raw.mcpServers ?? raw["mcp-servers"];
	const warnings: string[] = [];
	const servers: Record<string, McpServerEntry> = {};

	if (rawServers == null) return { servers, warnings };

	if (!isRecord(rawServers)) {
		return {
			servers,
			warnings: [`${configPath}: ignored non-object mcpServers`],
		};
	}

	for (const [name, definition] of Object.entries(rawServers)) {
		if (isRecord(definition)) {
			servers[name] = definition;
			continue;
		}

		warnings.push(`${configPath}: ignored non-object MCP server "${name}"`);
	}

	return { servers, warnings };
}

export function collectPluginMcpServers(plugins: ResolvedPlugin[]): { servers: PluginMcpServer[]; warnings: string[] } {
	const servers: PluginMcpServer[] = [];
	const warnings: string[] = [];
	const seenGeneratedNames = new Map<string, PluginMcpServer>();

	for (const plugin of plugins) {
		const byOriginalName = new Map<string, { definition: McpServerEntry; configPath: string }>();

		for (const configPath of plugin.mcpConfigPaths) {
			try {
				const parsed = readPluginMcpServers(configPath);
				warnings.push(...parsed.warnings);

				for (const [originalName, definition] of Object.entries(parsed.servers)) {
					byOriginalName.set(originalName, { definition, configPath });
				}
			} catch (err: any) {
				warnings.push(`${configPath}: ${err?.message || err}`);
			}
		}

		for (const [originalName, { definition, configPath }] of byOriginalName) {
			const generatedName = `${normalizeMcpName(plugin.name, "plugin")}__${normalizeMcpName(originalName, "server")}`;
			const server: PluginMcpServer = {
				pluginName: plugin.name,
				originalName,
				generatedName,
				definition,
				configPath,
			};
			const existing = seenGeneratedNames.get(generatedName);

			if (existing) {
				warnings.push(
					`MCP server "${generatedName}" from ${configPath} collides with ${existing.configPath}; keeping the first definition`,
				);
				continue;
			}

			seenGeneratedNames.set(generatedName, server);
			servers.push(server);
		}
	}

	return { servers, warnings };
}

/**
 * Remove managed MCP entries written by the old pi-mcp-adapter file merge:
 * entries listed in the `.pi/mcp.cc-plugins.json` sidecar are deleted from
 * `.pi/mcp.json` and the sidecar itself is removed.
 */
export function cleanupLegacyMcpState(projectRoot: string): string[] {
	const warnings: string[] = [];
	const sidecarPath = join(projectRoot, LEGACY_SIDECAR_PATH);

	if (!existsSync(sidecarPath)) return warnings;

	try {
		const configPath = getProjectMcpConfigPath(projectRoot);
		const managedNames = readLegacyManagedNames(sidecarPath);
		const raw = readJsonObject(configPath, true);

		if (managedNames.size > 0 && isRecord(raw.mcpServers)) {
			for (const name of managedNames) {
				delete raw.mcpServers[name];
			}

			if (Object.keys(raw.mcpServers).length === 0) {
				delete raw.mcpServers;
			}

			if (Object.keys(raw).length === 0) {
				rmSync(configPath, { force: true });
			} else {
				writeJsonObjectIfChanged(configPath, raw);
			}
		}
	} catch (err: any) {
		warnings.push(`${sidecarPath}: ${err?.message || err}`);
	}

	rmSync(sidecarPath, { force: true });
	return warnings;
}

function readLegacyManagedNames(sidecarPath: string): Set<string> {
	const raw = readJsonObject(sidecarPath);
	const names = new Set<string>();

	if (!Array.isArray(raw.entries)) return names;

	for (const entry of raw.entries) {
		if (isRecord(entry) && typeof entry.name === "string") {
			names.add(entry.name);
		}
	}

	return names;
}

function readJsonObject(filePath: string, emptyWhenMissing = false): Record<string, unknown> {
	if (!existsSync(filePath)) {
		if (emptyWhenMissing) return {};
		throw new Error("file does not exist");
	}

	const raw = JSON.parse(readFileSync(filePath, "utf-8"));
	if (!isRecord(raw)) {
		throw new Error("expected a JSON object");
	}

	return raw;
}

function writeJsonObjectIfChanged(filePath: string, raw: unknown): boolean {
	const nextText = `${JSON.stringify(raw, null, 2)}\n`;
	const currentText = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";

	if (currentText === nextText) return false;

	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(tmpPath, nextText, "utf-8");
	renameSync(tmpPath, filePath);
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
