import nodeFs from "node:fs";
import path from "node:path";
import { parseDirectProject, seedDirectLocale } from "./direct.js";
import { unknownLocaleError } from "./queries.js";

/**
 * Locale management: adding/removing entries in the `locales` array of
 * `project.inlang/settings.json`, plus seeding or deleting the corresponding
 * message file.
 *
 * This deliberately edits settings.json directly instead of going through
 * storage.ts: every operation reads settings fresh from that file (the
 * server is stateless), so the edit takes effect immediately.
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
	// resolve the message file location before touching settings, so an
	// unsupported project errors without leaving a half-applied change
	const direct = parseDirectProject(projectPath, settings);

	const next = [...locales, tag];
	settings.locales = next;
	writeSettings(settingsPath, settings);

	// seed an empty message file so the locale is visible to the compiler
	// and editors immediately
	const messageFileCreated = seedDirectLocale(direct, tag);

	return { locale: tag, locales: next, messageFileCreated };
}

export function removeLocale(
	projectPath: string,
	locale: string
): Omit<RemoveLocaleResult, "discardedTranslations"> {
	const tag = locale.trim();
	const { settings, settingsPath, locales } = readSettings(projectPath);
	if (!locales.includes(tag)) {
		throw unknownLocaleError(tag, locales);
	}
	if (settings.baseLocale === tag) {
		throw new Error(
			`'${tag}' is the project's base locale and cannot be removed`
		);
	}

	// delete the message file first (while the locale is still resolvable),
	// then update settings
	let messageFileDeleted = false;
	const direct = parseDirectProject(projectPath, settings);
	const filePath = direct.fileFor(tag);
	if (nodeFs.existsSync(filePath)) {
		nodeFs.rmSync(filePath);
		messageFileDeleted = true;
	}

	const next = locales.filter((l) => l !== tag);
	settings.locales = next;
	writeSettings(settingsPath, settings);

	return { locale: tag, locales: next, messageFileDeleted };
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
