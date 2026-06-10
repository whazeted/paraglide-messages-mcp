import nodeFs from "node:fs";
import path from "node:path";
import {
	loadProjectFromDirectory,
	saveProjectToDirectory,
	type InlangProject,
} from "@inlang/sdk";
import messageFormatPlugin from "@inlang/plugin-message-format";

export const MESSAGE_FORMAT_PLUGIN_KEY = "plugin.inlang.messageFormat";

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
		if (!nodeFs.existsSync(resolved)) {
			throw new Error(`inlang project not found at ${resolved}`);
		}
		return resolved;
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

/**
 * Loads the project, runs `fn`, and always closes the project afterwards.
 *
 * The project is loaded per operation instead of being kept open. This keeps
 * the server stateless: external edits (paraglide compiler, the user editing
 * messages/*.json, git operations) are always picked up, and nothing is lost
 * when the npx process is killed.
 */
export async function withProject<T>(
	projectPath: string,
	fn: (project: InlangProject) => Promise<T>
): Promise<T> {
	const project = await loadProject(projectPath);
	try {
		return await fn(project);
	} finally {
		await project.close().catch(() => {
			// closing failures must not mask the actual result/error
		});
	}
}

/**
 * Loads the project from disk. If no import/export plugin could be loaded
 * (e.g. offline and the CDN plugin is not cached yet) but the project is
 * configured for the inlang message format, the bundled
 * @inlang/plugin-message-format is provided as a fallback.
 */
async function loadProject(projectPath: string): Promise<InlangProject> {
	const project = await loadProjectFromDirectory({
		path: projectPath,
		fs: nodeFs,
	});

	const plugins = await project.plugins.get();
	const hasImportExport = plugins.some(
		(plugin) => plugin.importFiles || plugin.exportFiles
	);
	if (hasImportExport) {
		return project;
	}

	const settings = await project.settings.get();
	const usesMessageFormat =
		settings[MESSAGE_FORMAT_PLUGIN_KEY] !== undefined ||
		(settings.modules ?? []).some((m) => m.includes("plugin-message-format"));

	if (!usesMessageFormat) {
		await project.close().catch(() => {});
		throw new Error(
			"the inlang project has no import/export plugin. Check the 'modules' " +
				"array in settings.json and your network connection."
		);
	}

	await project.close().catch(() => {});
	return await loadProjectFromDirectory({
		path: projectPath,
		fs: nodeFs,
		providePlugins: [messageFormatPlugin],
	});
}

/** Persists the project, including plugin-exported message files. */
export async function saveProject(
	project: InlangProject,
	projectPath: string
): Promise<void> {
	await saveProjectToDirectory({
		fs: nodeFs.promises as never,
		project,
		path: projectPath,
	});
}

/** Picks the plugin key used for import/export round-trips. */
export async function pickPluginKey(project: InlangProject): Promise<string> {
	const plugins = await project.plugins.get();
	const importExport = plugins.filter(
		(plugin) => plugin.importFiles && plugin.exportFiles
	);
	const preferred = importExport.find(
		(plugin) => (plugin.key ?? plugin.id) === MESSAGE_FORMAT_PLUGIN_KEY
	);
	const chosen = preferred ?? importExport[0];
	const key = chosen?.key ?? chosen?.id;
	if (!key) {
		throw new Error(
			"no plugin with importFiles/exportFiles found in the project"
		);
	}
	return key;
}

function safeReadDir(dir: string): nodeFs.Dirent[] {
	try {
		return nodeFs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}
