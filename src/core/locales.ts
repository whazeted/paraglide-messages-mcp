import nodeFs from "node:fs";
import path from "node:path";
import { MESSAGE_FILE_SCHEMA, parseDirectProject } from "./direct.js";

/**
 * Locale management: adding/removing entries in the `locales` array of
 * `project.inlang/settings.json`, plus seeding or deleting the corresponding
 * message file for message-format projects.
 *
 * This deliberately edits settings.json directly instead of going through
 * ProjectStorage: both storage paths read settings fresh from that file on
 * every call (the server is stateless), so the edit takes effect immediately.
 * Locale tags are taken as-is apart from trimming — the server is not
 * opinionated about tag formats; agents use whatever convention the project
 * already follows.
 */

// type aliases (not interfaces) so they satisfy the MCP SDK's
// Record<string, unknown> constraint on structuredContent
export type AddLocaleResult = {
	locale: string;
	/** the project's locales after the change */
	locales: string[];
	/** true when an empty message file was seeded for the new locale */
	messageFileCreated: boolean;
};

export type RemoveLocaleResult = {
	locale: string;
	/** the project's locales after the change */
	locales: string[];
	/** non-empty translations that existed in the removed locale */
	discardedTranslations: number;
	/** true when the locale's message file was deleted */
	messageFileDeleted: boolean;
};

export function addLocale(
	projectPath: string,
	locale: string
): AddLocaleResult {
	const tag = locale.trim();
	if (tag.length === 0) {
		throw new Error("locale must not be empty");
	}

	const { settings, settingsPath, locales } = readSettings(projectPath);
	if (locales.includes(tag)) {
		throw new Error(`locale '${tag}' is already in the project`);
	}

	settings.locales = [...locales, tag];
	writeSettings(settingsPath, settings);

	// seed an empty message file for message-format projects so the locale is
	// visible to the compiler and editors immediately; other plugins create
	// their files on first save
	let messageFileCreated = false;
	const direct = parseDirectProject(projectPath);
	if (direct) {
		const filePath = direct.fileFor(tag);
		if (!nodeFs.existsSync(filePath)) {
			nodeFs.mkdirSync(path.dirname(filePath), { recursive: true });
			nodeFs.writeFileSync(
				filePath,
				JSON.stringify({ $schema: MESSAGE_FILE_SCHEMA }, null, "\t")
			);
			messageFileCreated = true;
		}
	}

	return {
		locale: tag,
		locales: settings.locales as string[],
		messageFileCreated,
	};
}

export function removeLocale(
	projectPath: string,
	locale: string,
	discardedTranslations: number
): RemoveLocaleResult {
	const tag = locale.trim();
	const { settings, settingsPath, locales } = readSettings(projectPath);
	if (!locales.includes(tag)) {
		throw new Error(
			`unknown locale '${tag}'. Project locales: ${locales.join(", ")}`
		);
	}
	if (settings.baseLocale === tag) {
		throw new Error(
			`'${tag}' is the project's base locale and cannot be removed`
		);
	}

	// delete the message file first (while the locale is still resolvable),
	// then update settings
	let messageFileDeleted = false;
	const direct = parseDirectProject(projectPath);
	if (direct) {
		const filePath = direct.fileFor(tag);
		if (nodeFs.existsSync(filePath)) {
			nodeFs.rmSync(filePath);
			messageFileDeleted = true;
		}
	}

	settings.locales = locales.filter((l) => l !== tag);
	writeSettings(settingsPath, settings);

	return {
		locale: tag,
		locales: settings.locales as string[],
		discardedTranslations,
		messageFileDeleted,
	};
}

function readSettings(projectPath: string): {
	settings: Record<string, unknown>;
	settingsPath: string;
	locales: string[];
} {
	const settingsPath = path.join(projectPath, "settings.json");
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(nodeFs.readFileSync(settingsPath, "utf8"));
	} catch (error) {
		throw new Error(
			`cannot read project settings at ${settingsPath}: ${(error as Error).message}`
		);
	}
	const locales = settings.locales;
	if (!Array.isArray(locales) || !locales.every((l) => typeof l === "string")) {
		throw new Error(`invalid 'locales' array in ${settingsPath}`);
	}
	return { settings, settingsPath, locales };
}

function writeSettings(
	settingsPath: string,
	settings: Record<string, unknown>
): void {
	// tab indentation, matching the inlang convention for settings.json
	nodeFs.writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"));
}
