/**
 * Source string parsing.
 *
 * Supported formats:
 *   github:owner/repo
 *   github:owner/repo#subpath=some/dir
 *   git:github.com/user/repo
 *   git:github.com/user/repo#subpath=some/dir
 *   local:/absolute/path
 *   local:~/relative/path
 *   local:./relative/path
 */
import { SOURCE_TYPES, type ParsedSource, type SourceType } from "./types.js";

/**
 * Parse a ccPlugins source string into a structured representation.
 */
export function parseSource(raw: string): ParsedSource {
	const [main, fragment] = splitFragment(raw);

	for (const [type, prefix] of Object.entries(SOURCE_TYPES)) {
		if (main.startsWith(prefix)) {
			const ref = main.slice(prefix.length);
			if (!ref) {
				throw new Error(`Invalid ${type} source: "${raw}" — expected "${prefix}<value>"`);
			}
			if (type === "github" && !ref.includes("/")) {
				throw new Error(`Invalid ${type} source: "${raw}" — expected "github:owner/repo"`);
			}
			return { type: type as SourceType, ref, subpath: fragment, raw };
		}
	}

	throw new Error(
		`Unknown source format: "${raw}" — expected ${Object.values(SOURCE_TYPES).map((p) => `"${p}..."`).join(", ")}`,
	);
}

/**
 * Split a source string into the main part and the #subpath= fragment.
 * Returns [main, subpath | undefined].
 */
function splitFragment(raw: string): [string, string | undefined] {
	const hashIdx = raw.indexOf("#subpath=");
	if (hashIdx === -1) return [raw, undefined];
	return [raw.slice(0, hashIdx), raw.slice(hashIdx + "#subpath=".length)];
}
