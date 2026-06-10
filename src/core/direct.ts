import nodeFs from "node:fs";
import path from "node:path";
import { flatten, unflatten } from "flat";
import { MESSAGE_FORMAT_PLUGIN_KEY } from "./project.js";
import type {
	LocaleMessages,
	MessagesSnapshot,
	MessageValue,
} from "./types.js";

/**
 * Direct file access for inlang message-format projects.
 *
 * The inlang SDK loads every message of every locale into an internal SQLite
 * database on `loadProjectFromDirectory`, and `saveProjectToDirectory`
 * rewrites every locale file — per-call cost grows with total project size
 * (see PERFORMANCE.md). For the by far most common setup, the message-format
 * plugin, the message files are plain JSON in a known location, so this
 * module reads and writes them directly. Projects using other plugins (or
 * a multi-file `pathPattern`) keep going through the SDK.
 */

export const MESSAGE_FILE_SCHEMA =
	"https://inlang.com/schema/inlang-message-format";

export interface DirectProject {
	baseLocale: string;
	locales: string[];
	pluginKey: string;
	sort?: "asc" | "desc";
	fileFor(locale: string): string;
}

/**
 * Returns direct file access for the project, or null when the project must
 * go through the SDK instead. Direct access requires:
 *
 * - `plugin.inlang.messageFormat` settings with a single string `pathPattern`
 *   (a `pathPattern` array means multiple files per locale — SDK territory)
 * - no other import/export plugin module configured that could take
 *   precedence (lint-rule modules are fine)
 * - the `PARAGLIDE_MCP_FORCE_SDK` escape hatch not being set
 */
export function resolveDirectProject(
	projectPath: string
): DirectProject | null {
	if (process.env.PARAGLIDE_MCP_FORCE_SDK) {
		return null;
	}
	return parseDirectProject(projectPath);
}

/**
 * Same as resolveDirectProject but without the escape-hatch check — for
 * callers that need the message file *location* regardless of whether
 * message reads/writes go through the SDK (e.g. locale management seeding
 * or deleting a locale file).
 */
export function parseDirectProject(
	projectPath: string
): DirectProject | null {
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(
			nodeFs.readFileSync(path.join(projectPath, "settings.json"), "utf8")
		);
	} catch {
		// unreadable settings: let the SDK produce its usual error
		return null;
	}

	const baseLocale = settings.baseLocale;
	const locales = settings.locales;
	if (
		typeof baseLocale !== "string" ||
		!Array.isArray(locales) ||
		!locales.every((l) => typeof l === "string")
	) {
		return null;
	}

	const pluginSettings = settings[MESSAGE_FORMAT_PLUGIN_KEY] as
		| { pathPattern?: unknown; sort?: unknown }
		| undefined;
	const pathPattern = pluginSettings?.pathPattern;
	if (typeof pathPattern !== "string" || !pathPattern.includes("{locale}")) {
		return null;
	}

	// another plugin module could be the preferred import/export plugin —
	// only the SDK can resolve that, so don't guess
	const modules = (settings.modules ?? []) as string[];
	const foreignPlugin = modules.some(
		(m) => m.includes("plugin-") && !m.includes("plugin-message-format")
	);
	if (foreignPlugin) {
		return null;
	}

	const sort = pluginSettings?.sort;
	// pathPattern is relative to the parent of the project directory,
	// matching the SDK's absolutePathFromProject
	const root = path.dirname(path.resolve(projectPath));
	return {
		baseLocale,
		locales,
		pluginKey: MESSAGE_FORMAT_PLUGIN_KEY,
		...(sort === "asc" || sort === "desc" ? { sort } : {}),
		fileFor: (locale: string) =>
			path.resolve(root, pathPattern.replace("{locale}", locale)),
	};
}

/**
 * Reads all locale files and flattens them to `key -> value`, producing the
 * same snapshot shape as the SDK export path in service.ts. Missing locale
 * files count as empty (a locale freshly added to settings.json).
 */
export function readDirectSnapshot(project: DirectProject): MessagesSnapshot {
	const snapshot: MessagesSnapshot = {};
	for (const locale of project.locales) {
		snapshot[locale] = readLocaleFile(project.fileFor(locale));
	}
	return snapshot;
}

function readLocaleFile(filePath: string): LocaleMessages {
	let raw: string;
	try {
		raw = nodeFs.readFileSync(filePath, "utf8");
	} catch {
		return {};
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
	return flatten(json, { safe: true }) as LocaleMessages;
}

/**
 * Merges the accepted translations into the target locale's message file and
 * writes only that file. Output matches the message-format plugin's export:
 * `$schema` first, tab indentation, optional recursive key sort.
 */
export function writeDirectLocale(
	project: DirectProject,
	locale: string,
	accepted: Record<string, MessageValue>
): void {
	const filePath = project.fileFor(locale);
	writeLocaleFile(project, filePath, {
		...readLocaleFile(filePath),
		...accepted,
	});
}

/**
 * Removes `deletions` from and merges `additions` into one locale's message
 * file. Locale files that the mutation does not touch keep their exact byte
 * content (no rewrite).
 */
export function mutateDirectLocale(
	project: DirectProject,
	locale: string,
	additions: LocaleMessages,
	deletions: string[]
): void {
	const filePath = project.fileFor(locale);
	const messages = readLocaleFile(filePath);

	const affectedDeletions = deletions.filter((key) => key in messages);
	if (affectedDeletions.length === 0 && Object.keys(additions).length === 0) {
		return;
	}

	for (const key of affectedDeletions) {
		delete messages[key];
	}
	writeLocaleFile(project, filePath, { ...messages, ...additions });
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
