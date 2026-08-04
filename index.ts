/**
 * pi-cc-plugins — Use Claude Code plugins (skills & agents) directly in Pi
 *
 * Reads plugin sources from Pi's settings.json, clones missing repos into
 * an XDG cache directory, and exposes their skills/ directories via the
 * resources_discover event so Pi loads them natively.
 *
 * When pi-subagents is installed, also discovers agents/ directories in
 * plugins and converts them to pi-subagents format via symlinks in
 * .pi/agents/cc-plugins/.
 *
 * Settings (in ~/.pi/agent/settings.json or .pi/settings.json):
 *
 *   {
 *     "ccPlugins": [
 *       "github:pleaseai/claude-code-plugins",
 *       "github:pleaseai/claude-code-plugins#subpath=plugins/vue",
 *       "git:github.com/user/custom-plugin",
 *       "local:~/my-plugins/dev-plugin"
 *     ]
 *   }
 *
 * Install:
 *   pi install git:git@github.com:asermax/pi-cc-plugins
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedPlugin } from "./src/types.js";
import { parseSource } from "./src/source.js";
import { isMcpAdapterInstalled, readCcPlugins, readCcClaudeGlobal, readCcClaudeProject } from "./src/settings.js";
import { discoverAgentPaths, resolvePlugin } from "./src/plugin.js";
import { materializeSkillPaths, materializeStandaloneSkillPath, walkSkillDir } from "./src/skills.js";
import {
	parseCcAgent,
	convertCcAgent,
	writeCachedAgent,
	linkAgents,
	unlinkAgents,
	incrementRefcount,
	cleanupStaleSymlinks,
	isSubagentsInstalled,
} from "./src/agents.js";
import { hasManagedMcpState, syncProjectMcpConfig } from "./src/mcp.js";

export { parseSource } from "./src/source.js";
export { readCcPlugins, readCcClaudeGlobal, readCcClaudeProject, readPiPackages, isMcpAdapterInstalled, readJsonFile } from "./src/settings.js";
export { getCacheBaseDir, getCloneDir, ensureCloned, updateClone } from "./src/cache.js";
export { resolvePlugin, readPluginName, discoverSkillPaths, discoverAgentPaths, discoverMcpConfigPaths } from "./src/plugin.js";
export { materializeSkillPaths, materializeStandaloneSkillPath, walkSkillDir, sanitizeSkillMarkdown, normalizeSkillName } from "./src/skills.js";
export type { ParsedSource, ResolvedPlugin, ParsedAgent, McpServerEntry, PluginMcpServer, ManagedMcpEntry, ManagedMcpSidecar, McpSyncResult } from "./src/types.js";
export {
	parseFrontmatter,
	parseCcAgent,
	convertCcAgent,
	writeCachedAgent,
	linkAgents,
	unlinkAgents,
	incrementRefcount,
	cleanupStaleSymlinks,
	isSubagentsInstalled,
} from "./src/agents.js";
export {
	getProjectMcpConfigPath,
	getProjectMcpSidecarPath,
	hasManagedMcpState,
	normalizeMcpName,
	readPluginMcpServers,
	collectPluginMcpServers,
	syncProjectMcpConfig,
} from "./src/mcp.js";

// Bus channels for the herdr provider seam (spec §8). The two packages are
// decoupled in both directions — the channel names are a wire contract, not an
// import. Prefix is the unscoped package name, matching the provider side
// (herdr-subagents, ticket #21).
const HERDR_PKG = "pi-herdr-subagents";
const PROVIDER_READY = `${HERDR_PKG}:provider-ready`;
const PROVIDER_READY_REQUEST = `${HERDR_PKG}:provider-ready-request`;
const REGISTER = `${HERDR_PKG}:register`;

/** Options accepted by the extension entry point. */
export interface ExtensionOptions {
	/** Override the global settings path (for testing). */
	globalSettingsPath?: string;
}

/**
 * Where an agent definition came from, mapping onto the provider's precedence
 * rank (spec §8). Plugins ship as `package`; a standalone `.claude/agents`
 * directory ships as `user` (home) or `project` (cwd).
 */
type AgentSourceKind = "project" | "user" | "package";

interface AgentSource {
	packageName: string;
	cacheSlug: string;
	agentPaths: string[];
	/** Namespace for bus registration: the plugin name for plugin-shipped agents,
	 * empty for a standalone `.claude/agents` directory (spec §7/§8). */
	namespace: string;
	/** Precedence-rank source: project, user, or package. */
	source: AgentSourceKind;
}

export default function (pi: ExtensionAPI, options?: ExtensionOptions) {
	// Register CLI flag for updating cached plugins
	pi.registerFlag("cc-plugins-update", {
		type: "boolean",
		description: "Update cached plugin repos before loading (git fetch + hard reset)",
	});

	/** Cached resolved plugins for the current session */
	let resolvedPlugins: ResolvedPlugin[] = [];
	/** Materialized skill paths from .claude/skills (not from plugins) */
	let claudeSkillPaths: string[] = [];
	/** Agent sources from .claude/agents (not from plugins) */
	let claudeAgentSources: AgentSource[] = [];
	/** Track whether we incremented the refcount for this session */
	let hasRefcount = false;
	/** Track the cwd for cleanup on shutdown */
	let sessionCwd: string | null = null;
	/** True once the herdr provider announced presence on the bus. */
	let herdrProviderPresent = false;
	/** Agent sources discovered during session_start but not yet registered over
	 *  the bus; flushed one per source in the resources_discover handler. */
	let pendingRegistrations: AgentSource[] = [];
	/** Bus listener unsubs, drained on session_shutdown. */
	const unsubs: Array<() => void> = [];

	/** Read ccPlugins using the configured or overridden global settings path. */
	const getPlugins = (cwd: string) => readCcPlugins(cwd, { globalSettingsPath: options?.globalSettingsPath });

	/** Read ccClaude* settings. */
	const getSettingsOpts = (cwd: string) => ({ globalSettingsPath: options?.globalSettingsPath });

	/**
	 * Discover and materialize skills from a .claude/skills directory.
	 * Returns an array of materialized cache paths.
	 */
	const loadClaudeSkills = (skillsDir: string, namespace: string, sourceId: string): string[] => {
		if (!existsSync(skillsDir)) return [];

		const discovered: string[] = [];
		walkSkillDir(skillsDir, discovered);

		return discovered.map((skillPath) =>
			materializeStandaloneSkillPath(namespace, sourceId, skillsDir, skillPath),
		);
	};

	const loadClaudeAgents = (
		claudeDir: string,
		packageName: string,
		source: AgentSourceKind,
	): AgentSource | null => {
		const agentPaths = discoverAgentPaths(claudeDir);
		if (agentPaths.length === 0) return null;
		// Standalone `.claude/agents` is unnamespaced (spec §7): the provider keys
		// on (source, namespace), and an empty namespace marks a bare-name agent.
		return { packageName, cacheSlug: packageName, agentPaths, namespace: "", source };
	};

	// Consumer side of the presence handshake (spec §8). The provider
	// (herdr-subagents, ticket #21) emits `provider-ready` and listens for
	// `provider-ready-request`; this side is its symmetric mirror. Both sides act
	// at factory time, where load order is not guaranteed, so each emits its own
	// signal AND listens for the other's.
	//
	// SELF-EMIT TRAP — pi's EventBus is a Node EventEmitter, so a self-emit is
	// delivered to the emitter's own listeners. Each side emits ONLY the signal
	// it OWNS and listens only for the one it does not, or the provider would
	// falsely mark itself present. The consumer therefore:
	//   - emits `provider-ready-request` (its own signal);
	//   - listens for `provider-ready`; on seeing it sets the flag and re-emits
	//     `provider-ready-request` ONCE.
	// The one-shot re-emit is required so a provider that loaded FIRST (and
	// missed this request) learns the consumer exists; it is guarded so the two
	// sides cannot ping-pong. The flag is correct by session start.
	unsubs.push(
		pi.events.on(PROVIDER_READY, () => {
			const wasPresent = herdrProviderPresent;
			herdrProviderPresent = true;
			if (!wasPresent) pi.events.emit(PROVIDER_READY_REQUEST, {});
		}),
	);

	// Announce ourselves. A provider that loaded before us already emitted its
	// `provider-ready`, which the listener above caught; a provider that loads
	// after us replies via this request.
	pi.events.emit(PROVIDER_READY_REQUEST, {});

	pi.on("session_start", async (_event, ctx) => {
		sessionCwd = ctx.cwd;
		resolvedPlugins = [];
		claudeSkillPaths = [];
		claudeAgentSources = [];
		hasRefcount = false;
		pendingRegistrations = [];

		const ccPlugins = getPlugins(ctx.cwd);
		const settingsOpts = getSettingsOpts(ctx.cwd);

		// --- Load .claude directories ---
		const ccClaudeGlobal = readCcClaudeGlobal(ctx.cwd, settingsOpts);
		const ccClaudeProject = readCcClaudeProject(ctx.cwd, settingsOpts);

		if (ccClaudeGlobal) {
			const globalClaudeDir = join(homedir(), ".claude");
			const globalClaudeSkillsDir = join(globalClaudeDir, "skills");
			const materialized = loadClaudeSkills(globalClaudeSkillsDir, "claude-global", "~/.claude/skills");
			claudeSkillPaths.push(...materialized);

			const agentSource = loadClaudeAgents(globalClaudeDir, "claude-global", "user");
			if (agentSource) claudeAgentSources.push(agentSource);
		}

		if (ccClaudeProject) {
			const projectClaudeDir = join(ctx.cwd, ".claude");
			const projectClaudeSkillsDir = join(projectClaudeDir, "skills");
			const materialized = loadClaudeSkills(projectClaudeSkillsDir, "claude-project", ".claude/skills");
			claudeSkillPaths.push(...materialized);

			const agentSource = loadClaudeAgents(projectClaudeDir, "claude-project", "project");
			if (agentSource) claudeAgentSources.push(agentSource);
		}

		// --- Load ccPlugins ---
		const errors: string[] = [];
		const warnings: string[] = [];

		for (const raw of ccPlugins) {
			try {
				const source = parseSource(raw);
				const plugin = resolvePlugin(source, ctx.cwd, pi.getFlag("cc-plugins-update") as boolean | undefined);
				plugin.skillPaths = materializeSkillPaths(plugin);
				resolvedPlugins.push(plugin);
			} catch (err: any) {
				errors.push(`  ${raw}: ${err?.message || err}`);
			}
		}

		// --- MCP handling (from ccPlugins) ---
		let mcpServerCount = 0;
		const totalMcpConfigPaths = resolvedPlugins.reduce(
			(sum, plugin) => sum + plugin.mcpConfigPaths.length,
			0,
		);

		if (totalMcpConfigPaths > 0 || hasManagedMcpState(ctx.cwd)) {
			if (!isMcpAdapterInstalled({ globalSettingsPath: options?.globalSettingsPath })) {
				if (totalMcpConfigPaths > 0) {
					ctx.ui.notify(
						`cc-plugins: found ${totalMcpConfigPaths} MCP config(s) in configured Claude plugins but pi-mcp-adapter is not installed. ` +
						`Install it with: pi install npm:pi-mcp-adapter`,
						"warning",
					);
				}
			} else {
				try {
					const result = syncProjectMcpConfig(ctx.cwd, resolvedPlugins);
					mcpServerCount = result.writtenCount;
					warnings.push(...result.warnings.map((warning) => `  mcp ${warning}`));
				} catch (err: any) {
					errors.push(`  mcp: ${err?.message || err}`);
				}
			}
		}

		// --- Agent handling (from ccPlugins and standalone .claude/agents) ---
		let agentCount = 0;
		const pluginAgentSources: AgentSource[] = resolvedPlugins.map((plugin) => ({
			packageName: plugin.name,
			cacheSlug: plugin.source.ref.replace(/[\/\\]/g, "--"),
			agentPaths: plugin.agentPaths,
			namespace: plugin.name,
			source: "package",
		}));
		const agentSources = [...pluginAgentSources, ...claudeAgentSources];
		const totalAgentPaths = agentSources.reduce(
			(sum, source) => sum + source.agentPaths.length,
			0,
		);

		if (totalAgentPaths > 0) {
			if (herdrProviderPresent) {
				// herdr-wins: register Claude-format paths over the bus,
				// no conversion. Registration happens during resource discovery (the
				// provider's listener is guaranteed present by then); here we queue
				// the sources and report the count optimistically, mirroring the
				// opacity the symlink path already has.
				pendingRegistrations = agentSources;
				agentCount = totalAgentPaths;
			} else if (isSubagentsInstalled({ globalSettingsPath: options?.globalSettingsPath })) {
				// Increment refcount to protect symlinks from concurrent session cleanup
				incrementRefcount(ctx.cwd);
				hasRefcount = true;

				// Clean stale symlinks from sources no longer configured
				const currentPackageNames = new Set(agentSources.map((source) => source.packageName));
				cleanupStaleSymlinks(ctx.cwd, currentPackageNames);

				// Convert and cache agents, then create symlinks
				const cachedAgents: Array<{ pluginName: string; agentName: string; cachedPath: string }> = [];

				for (const source of agentSources) {
					for (const agentPath of source.agentPaths) {
						try {
							const parsed = parseCcAgent(agentPath);
							if (!parsed) continue;

							const converted = convertCcAgent(parsed, source.packageName);
							const cachedPath = writeCachedAgent(source.cacheSlug, parsed.name, converted);

							cachedAgents.push({
								pluginName: source.packageName,
								agentName: parsed.name,
								cachedPath,
							});
							agentCount++;
						} catch (err: any) {
							errors.push(`  agent ${agentPath}: ${err?.message || err}`);
						}
					}
				}

				if (cachedAgents.length > 0) {
					linkAgents(ctx.cwd, cachedAgents);
				}
			} else {
				// Neither provider present (spec §8). Name the migration target
				// first, the legacy alternative second.
				ctx.ui.notify(
					`cc-plugins: found ${totalAgentPaths} agent(s) in configured Claude sources but no agent provider is installed. ` +
					`Install @asermax/pi-herdr-subagents (recommended) or pi-subagents (legacy).`,
					"warning",
				);
			}
		}

		// --- Notification ---
		const pluginSkillCount = resolvedPlugins.reduce((sum, p) => sum + p.skillPaths.length, 0);
		const claudeSkillCount = claudeSkillPaths.length;
		const totalSkillCount = pluginSkillCount + claudeSkillCount;

		if (totalSkillCount > 0 || agentCount > 0 || mcpServerCount > 0 || resolvedPlugins.length > 0) {
			const parts: string[] = [];
			if (totalSkillCount > 0) parts.push(`${totalSkillCount} skill(s)`);
			if (agentCount > 0) parts.push(`${agentCount} agent(s)`);
			if (mcpServerCount > 0) parts.push(`${mcpServerCount} MCP server(s)`);
			if (resolvedPlugins.length > 0) parts.push(`${resolvedPlugins.length} plugin(s)`);
			ctx.ui.notify(`cc-plugins: loaded ${parts.join(" and ")}`, "info");
		}

		if (warnings.length > 0) {
			ctx.ui.notify(
				`cc-plugins: ${warnings.length} warning(s):\n${warnings.join("\n")}`,
				"warning",
			);
		}

		if (errors.length > 0) {
			ctx.ui.notify(
				`cc-plugins: ${errors.length} error(s):\n${errors.join("\n")}`,
				"warning",
			);
		}
	});

	pi.on("resources_discover", async (_event, _ctx) => {
		// Register agent sources queued during session_start over the herdr bus
		// Fire-and-forget: no acknowledgement, and the count was
		// already reported optimistically during session_start. Emitting here is
		// an unconstrained side effect, necessary because the discovery result
		// type cannot carry agents. Every extension factory completes before any
		// lifecycle handler fires, so the provider's `register` listener is
		// guaranteed present.
		if (pendingRegistrations.length > 0) {
			for (const source of pendingRegistrations) {
				pi.events.emit(REGISTER, {
					version: 1,
					paths: source.agentPaths,
					namespace: source.namespace,
					source: source.source,
				});
			}
			pendingRegistrations = [];
		}

		const pluginSkillPaths = resolvedPlugins.flatMap((p) => p.skillPaths);
		const allSkillPaths = [...pluginSkillPaths, ...claudeSkillPaths];
		if (allSkillPaths.length === 0) return undefined;
		return { skillPaths: allSkillPaths };
	});

	pi.on("session_shutdown", () => {
		// The refcount decrement fires only on the pi-subagents branch:
		// the herdr branch skips the symlink and owns no refcount.
		if (hasRefcount && sessionCwd) {
			unlinkAgents(sessionCwd);
			hasRefcount = false;
		}

		// Drain the bus handshake listener. Failing one unsub must not abort the rest.
		while (unsubs.length > 0) {
			const unsub = unsubs.pop();
			if (!unsub) continue;
			try {
				unsub();
			} catch {
				// A failing unsubscribe must not abort cleanup of the rest.
			}
		}
	});
}
