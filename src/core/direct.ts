import nodeFs from "node:fs";
import path from "node:path";
import { flatten, unflatten } from "flat";
import type { LocaleMessages, MessagesSnapshot } from "./types.js";

/**
 * Direct file access for inlang message-format projects — the only storage
 * backend. The message files are plain JSON in a known location
 * (`pathPattern`), so every read and write goes straight to those files; all
 * I/O is synchronous, which makes each tool call atomic with respect to
 * concurrent per-locale agents in the same process (see PERFORMANCE.md).
 * Projects using other inlang plugins or a multi-file `pathPattern` are not
 * supported (see COMPATIBILITY.md).
 */

export const MESSAGE_FORMAT_PLUGIN_KEY = "plugin.inlang.messageFormat";

const MESSAGE_FILE_SCHEMA = "https://inlang.com/schema/inlang-message-format";

const UNSUPPORTED_PROJECT =
	"paraglide-messages-mcp only supports inlang message-format projects: settings.json " +
	`must configure "${MESSAGE_FORMAT_PLUGIN_KEY}" with a single string ` +
	'pathPattern containing "{locale}", and no other import/export plugin ' +
	"module. See COMPATIBILITY.md.";

export interface DirectProject {
	baseLocale: string;
	locales: string[];
	sort?: "asc" | "desc";
	fileFor(locale: string): string;
}

/**
 * Per-file cache of parsed locale files, validated by stat (mtime + size) on
 * every read and updated write-through on every save. This is what lets N
 * concurrent per-locale agents share ONE parsed copy of the base locale
 * instead of each re-parsing it on every call: the first reader parses, every
 * later call (any agent, any service instance) pays only a statSync.
 *
 * Statelessness is preserved observably — every read still stats the file,
 * so external edits (compiler, editor, git) invalidate the entry and are
 * picked up. The cached message maps are shared across calls and MUST be
 * treated as immutable; all consumers copy before mutating
 * (see mutateDirectLocale).
 */
interface CacheEntry {
	mtimeMs: number;
	size: number;
	messages: LocaleMessages;
}

const fileCache = new Map<string, CacheEntry>();

/**
 * Resolves direct file access for the project, throwing a descriptive error
 * when the project is not a supported message-format setup:
 *
 * - `plugin.inlang.messageFormat` settings with a single string `pathPattern`
 *   (a `pathPattern` array means multiple files per locale — unsupported)
 * - no other import/export plugin module configured that could take
 *   precedence (lint-rule modules are fine)
 *
 * Pass `settings` when the caller has already parsed settings.json to avoid
 * a second read.
 */
export function parseDirectProject(
	projectPath: string,
	settings?: Record<string, unknown>
): DirectProject {
	if (settings === undefined) {
		const settingsPath = path.join(projectPath, "settings.json");
		try {
			settings = JSON.parse(
				nodeFs.readFileSync(settingsPath, "utf8")
			) as Record<string, unknown>;
		} catch (error) {
			throw new Error(
				`cannot read project settings at ${settingsPath}: ${(error as Error).message}`
			);
		}
	}

	const baseLocale = settings.baseLocale;
	const locales = settings.locales;
	if (
		typeof baseLocale !== "string" ||
		!Array.isArray(locales) ||
		!locales.every((l) => typeof l === "string")
	) {
		throw new Error(
			"invalid settings.json: baseLocale must be a string and locales an array of strings"
		);
	}

	const pluginSettings = settings[MESSAGE_FORMAT_PLUGIN_KEY] as
		| { pathPattern?: unknown; sort?: unknown }
		| undefined;
	const pathPattern = pluginSettings?.pathPattern;
	if (typeof pathPattern !== "string" || !pathPattern.includes("{locale}")) {
		throw new Error(UNSUPPORTED_PROJECT);
	}

	// another plugin module would be the preferred import/export plugin —
	// without the SDK that cannot be honored, so reject instead of guessing
	const modules = (settings.modules ?? []) as string[];
	const foreignPlugin = modules.some(
		(m) => m.includes("plugin-") && !m.includes("plugin-message-format")
	);
	if (foreignPlugin) {
		throw new Error(UNSUPPORTED_PROJECT);
	}

	const sort = pluginSettings?.sort;
	// pathPattern is relative to the parent of the project directory,
	// matching the SDK's absolutePathFromProject
	const root = path.dirname(path.resolve(projectPath));
	return {
		baseLocale,
		locales,
		...(sort === "asc" || sort === "desc" ? { sort } : {}),
		fileFor: (locale: string) =>
			path.resolve(root, pathPattern.replace("{locale}", locale)),
	};
}

/**
 * Reads locale files and flattens them to `key -> value`, producing the
 * same snapshot shape as the SDK export path in service.ts. Missing locale
 * files count as empty (a locale freshly added to settings.json). Pass
 * `locales` to read a subset — per-locale operations (the translate loop)
 * only need the base and target files, not every locale in the project.
 */
export function readDirectSnapshot(
	project: DirectProject,
	locales: string[] = project.locales
): MessagesSnapshot {
	const snapshot: MessagesSnapshot = {};
	for (const locale of locales) {
		snapshot[locale] = readLocaleFile(project.fileFor(locale));
	}
	return snapshot;
}

function readLocaleFile(filePath: string): LocaleMessages {
	let stat: nodeFs.Stats;
	try {
		stat = nodeFs.statSync(filePath);
	} catch {
		// missing file counts as empty (a locale freshly added to settings)
		fileCache.delete(filePath);
		return {};
	}
	const cached = fileCache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.messages;
	}

	let raw: string;
	try {
		raw = nodeFs.readFileSync(filePath, "utf8");
	} catch (error) {
		throw new Error(
			`cannot read message file ${filePath}: ${(error as Error).message}`
		);
	}
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`invalid JSON in message file ${filePath}: ${(error as Error).message}`
		);
	}
	delete json.$schema;
	// safe: true keeps variant arrays intact
	const messages = flatten(json, { safe: true }) as LocaleMessages;
	// the stat was taken before the read: if the file changed in between, the
	// stored mtime is older than the content and the next read re-parses
	fileCache.set(filePath, {
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		messages,
	});
	return messages;
}

/** Reads one locale's message file, flattened to `key -> value`. */
export function readDirectLocale(
	project: DirectProject,
	locale: string
): LocaleMessages {
	return readLocaleFile(project.fileFor(locale));
}

/**
 * Removes `deletions` from and merges `additions` into one locale's message
 * file. `current` is the locale's already-loaded messages (from the snapshot
 * read at the start of the call) so the file is not read a second time.
 * Locale files that the mutation does not touch keep their exact byte
 * content (no rewrite). Output matches the message-format plugin's export:
 * `$schema` first, tab indentation, optional recursive key sort.
 */
export function mutateDirectLocale(
	project: DirectProject,
	locale: string,
	current: LocaleMessages,
	additions: LocaleMessages,
	deletions: string[]
): void {
	const affectedDeletions = deletions.filter((key) => key in current);
	if (affectedDeletions.length === 0 && Object.keys(additions).length === 0) {
		return;
	}

	const messages = { ...current };
	for (const key of affectedDeletions) {
		delete messages[key];
	}
	writeLocaleFile(project, project.fileFor(locale), {
		...messages,
		...additions,
	});
}

/**
 * Creates an empty message file for a locale (just the `$schema` header), in
 * the same format as every other write. No-op when the file already exists.
 */
export function seedDirectLocale(
	project: DirectProject,
	locale: string
): boolean {
	const filePath = project.fileFor(locale);
	if (nodeFs.existsSync(filePath)) {
		return false;
	}
	writeLocaleFile(project, filePath, {});
	return true;
}

function writeLocaleFile(
	project: DirectProject,
	filePath: string,
	messages: LocaleMessages
): void {
	let content = unflatten(messages) as Record<string, unknown>;
	if (project.sort) {
		content = sortKeysDeep(content, project.sort) as Record<string, unknown>;
	}

	nodeFs.mkdirSync(path.dirname(filePath), { recursive: true });
	nodeFs.writeFileSync(
		filePath,
		JSON.stringify({ $schema: MESSAGE_FILE_SCHEMA, ...content }, null, "\t")
	);
	// write-through: the next read of this file is a cache hit
	const stat = nodeFs.statSync(filePath);
	fileCache.set(filePath, {
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		messages,
	});
}

/** Recursive key sort, mirroring the plugin's sortMessageKeys/sortObjectKeys. */
function sortKeysDeep(value: unknown, direction: "asc" | "desc"): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sortKeysDeep(entry, direction));
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const sorted: Record<string, unknown> = {};
	const entries = Object.entries(value).sort(([a], [b]) =>
		direction === "desc" ? b.localeCompare(a) : a.localeCompare(b)
	);
	for (const [key, entry] of entries) {
		sorted[key] = sortKeysDeep(entry, direction);
	}
	return sorted;
}
