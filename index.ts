/**
 * pi-cc-plugins — Use Claude Code plugins (skills) directly in Pi
 *
 * Reads plugin sources from Pi's settings.json, clones missing repos into
 * an XDG cache directory, and exposes their skills/ directories via the
 * resources_discover event so Pi loads them natively.
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedPlugin } from "./src/types.js";
import { parseSource } from "./src/source.js";
import { readCcPlugins } from "./src/settings.js";
import { resolvePlugin } from "./src/plugin.js";

export { parseSource } from "./src/source.js";
export { readCcPlugins, readJsonFile } from "./src/settings.js";
export { getCacheBaseDir, getCloneDir, ensureCloned } from "./src/cache.js";
export { resolvePlugin, readPluginName, discoverSkillPaths } from "./src/plugin.js";
export type { ParsedSource, ResolvedPlugin } from "./src/types.js";

export default function (pi: ExtensionAPI) {
	/** Cached resolved plugins for the current session */
	let resolvedPlugins: ResolvedPlugin[] = [];

	pi.on("session_start", async (_event, ctx) => {
		resolvedPlugins = [];

		const ccPlugins = readCcPlugins(ctx.cwd);
		if (ccPlugins.length === 0) return;

		const errors: string[] = [];

		for (const raw of ccPlugins) {
			try {
				const source = parseSource(raw);
				const plugin = resolvePlugin(source, ctx.cwd);
				resolvedPlugins.push(plugin);
			} catch (err: any) {
				errors.push(`  ${raw}: ${err?.message || err}`);
			}
		}

		if (resolvedPlugins.length > 0) {
			const skillCount = resolvedPlugins.reduce(
				(sum, p) => sum + p.skillPaths.length,
				0,
			);
			ctx.ui.notify(
				`cc-plugins: loaded ${skillCount} skill(s) from ${resolvedPlugins.length} plugin(s)`,
				"info",
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
		const skillPaths = resolvedPlugins.flatMap((p) => p.skillPaths);
		if (skillPaths.length === 0) return undefined;
		return { skillPaths };
	});
}
