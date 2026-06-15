import nodeFs from "node:fs";
import path from "node:path";

/**
 * Resolves the path of the inlang project directory.
 *
 * Order: explicit path (file or dir) > `<cwd>/project.inlang` >
 * first `*.inlang` directory found one level deep (covers monorepo-ish
 * layouts like `./apps/web/project.inlang`).
 */
export function discoverProjectPath(args: {
	cwd: string;
	explicitPath?: string;
}): string {
	if (args.explicitPath) {
		const resolved = path.resolve(args.cwd, args.explicitPath);
		let stat: nodeFs.Stats;
		try {
			stat = nodeFs.statSync(resolved);
		} catch {
			throw new Error(`inlang project not found at ${resolved}`);
		}
		return stat.isFile() ? path.dirname(resolved) : resolved;
	}

	const defaultPath = path.join(args.cwd, "project.inlang");
	if (nodeFs.existsSync(defaultPath)) {
		return defaultPath;
	}

	const candidates: string[] = [];
	for (const entry of safeReadDir(args.cwd)) {
		if (entry.isDirectory() && entry.name.endsWith(".inlang")) {
			candidates.push(path.join(args.cwd, entry.name));
		}
		if (
			entry.isDirectory() &&
			!entry.name.startsWith(".") &&
			entry.name !== "node_modules"
		) {
			for (const nested of safeReadDir(path.join(args.cwd, entry.name))) {
				if (nested.isDirectory() && nested.name.endsWith(".inlang")) {
					candidates.push(path.join(args.cwd, entry.name, nested.name));
				}
			}
		}
	}

	if (candidates.length === 1) {
		return candidates[0]!;
	}
	if (candidates.length > 1) {
		throw new Error(
			`multiple inlang projects found (${candidates.join(", ")}). ` +
				`Pass --project <path> to select one.`
		);
	}
	throw new Error(
		`no inlang project found in ${args.cwd}. Pass --project <path/to/project.inlang>.`
	);
}

function safeReadDir(dir: string): nodeFs.Dirent[] {
	try {
		return nodeFs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}
