import { collectKeys, type ProjectSnapshot } from "./storage.js";
import { unknownLocaleError } from "./queries.js";
import type { DeleteResultItem, LocaleMessages } from "./types.js";

/** Validation and result-building for key mutation tools. */

// type aliases (not interfaces) so they satisfy the MCP SDK's
// Record<string, unknown> constraint on structuredContent
export type DeleteSummary = {
	results: DeleteResultItem[];
	deleted: number;
	failed: number;
};

export type RenameSummary = {
	key: string;
	newKey: string;
	/** locales that had a value under the old key and were rewritten */
	updatedLocales: string[];
};

export type RemoveOrphansSummary = {
	sourceLocale: string;
	targetLocales: string[];
	results: Array<{
		locale: string;
		deleted: number;
		keys: string[];
	}>;
	deleted: number;
};

/**
 * Validates a delete batch against the current snapshot. Pure: returns the
 * keys to remove from every locale plus the finished summary.
 */
export function planDeleteMessages(
	context: ProjectSnapshot,
	keys: string[]
): { deletions: string[]; summary: DeleteSummary } {
	const allKeys = collectKeys(context.snapshot);

	const results: DeleteResultItem[] = [];
	const deletions: string[] = [];

	const seen = new Set<string>();
	for (const key of keys) {
		if (seen.has(key)) {
			results.push({
				key,
				status: "error",
				error: "duplicate key in this call",
			});
			continue;
		}
		seen.add(key);

		if (!allKeys.has(key)) {
			results.push({
				key,
				status: "error",
				error:
					"unknown message key — keys must come from list_message_keys/get_messages",
			});
			continue;
		}

		deletions.push(key);
		results.push({ key, status: "deleted" });
	}

	return {
		deletions,
		summary: {
			results,
			deleted: deletions.length,
			failed: results.length - deletions.length,
		},
	};
}

/**
 * Validates a rename against the current snapshot. Pure: returns the per-locale
 * values to write under the new key (the old key is deleted by the caller).
 * Renames are all-or-nothing — a single bad argument throws instead of
 * producing a half-renamed message.
 */
export function planRenameMessage(
	context: ProjectSnapshot,
	args: { key: string; newKey: string }
): { additions: Record<string, LocaleMessages>; summary: RenameSummary } {
	const { key, newKey } = args;
	const allKeys = collectKeys(context.snapshot);

	if (newKey.length === 0) {
		throw new Error("newKey must not be empty");
	}
	if (key === newKey) {
		throw new Error("newKey must differ from key");
	}
	if (!allKeys.has(key)) {
		throw new Error(
			`unknown message key '${key}' — keys must come from list_message_keys/get_messages`
		);
	}
	if (allKeys.has(newKey)) {
		throw new Error(
			`message key '${newKey}' already exists — delete it first or pick another name`
		);
	}

	const additions: Record<string, LocaleMessages> = {};
	const updatedLocales: string[] = [];
	for (const locale of context.locales) {
		const value = context.snapshot[locale]?.[key];
		if (value === undefined) continue;
		additions[locale] = { [newKey]: value };
		updatedLocales.push(locale);
	}

	return { additions, summary: { key, newKey, updatedLocales } };
}

/**
 * Finds keys present in target locale files but absent from the source locale
 * file, returning per-locale deletions. An empty source value still counts as
 * present; this tool removes true target-only keys, not untranslated source
 * keys.
 */
export function planRemoveOrphanMessages(
	context: ProjectSnapshot,
	args: {
		sourceLocale?: string;
		targetLocales?: string[];
		prefix?: string;
	}
): {
	localeDeletions: Record<string, string[]>;
	summary: RemoveOrphansSummary;
} {
	const sourceLocale = args.sourceLocale ?? context.baseLocale;
	if (!context.locales.includes(sourceLocale)) {
		throw unknownLocaleError(sourceLocale, context.locales);
	}

	const targetLocales = args.targetLocales ?? context.locales.filter(
		(locale) => locale !== sourceLocale
	);
	if (targetLocales.length === 0) {
		throw new Error("targetLocales must include at least one locale");
	}
	const seen = new Set<string>();
	for (const locale of targetLocales) {
		if (!context.locales.includes(locale)) {
			throw unknownLocaleError(locale, context.locales);
		}
		if (locale === sourceLocale) {
			throw new Error("targetLocales must not include sourceLocale");
		}
		if (seen.has(locale)) {
			throw new Error(`duplicate target locale "${locale}"`);
		}
		seen.add(locale);
	}

	const sourceKeys = new Set(Object.keys(context.snapshot[sourceLocale] ?? {}));
	const localeDeletions: Record<string, string[]> = {};
	const results: RemoveOrphansSummary["results"] = [];

	for (const locale of targetLocales) {
		const keys = Object.keys(context.snapshot[locale] ?? {})
			.filter((key) => !sourceKeys.has(key))
			.filter((key) => (args.prefix ? key.startsWith(args.prefix) : true))
			.sort();
		if (keys.length > 0) {
			localeDeletions[locale] = keys;
		}
		results.push({ locale, deleted: keys.length, keys });
	}

	return {
		localeDeletions,
		summary: {
			sourceLocale,
			targetLocales,
			results,
			deleted: results.reduce((sum, result) => sum + result.deleted, 0),
		},
	};
}
