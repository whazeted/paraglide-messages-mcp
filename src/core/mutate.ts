import { collectKeys, type ProjectSnapshot } from "./storage.js";
import type { DeleteResultItem, LocaleMessages } from "./types.js";

/** Validation and result-building for delete_messages and rename_message. */

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

/**
 * Validates a delete batch against the current snapshot. Pure: returns the
 * per-item results plus the keys to remove from every locale.
 */
export function planDeleteMessages(
	context: ProjectSnapshot,
	keys: string[]
): { results: DeleteResultItem[]; deletions: string[] } {
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

	return { results, deletions };
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
