/**
 * Symlink-aware filesystem checks.
 *
 * readdirSync Dirents describe the entry itself (lstat semantics), so a
 * symlink to a directory reports isDirectory() as false. Plugin sources
 * commonly symlink skills and agents to shared directories, so these
 * helpers stat through symlinks instead.
 */
import { realpathSync, statSync } from "node:fs";

export function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Resolve through symlinks, returning null when the target is unreachable. */
export function realPathOrNull(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}
