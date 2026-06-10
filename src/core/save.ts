import {
	isEmptyValue,
	isValidMessageValue,
	messageValueError,
	validateTranslation,
} from "./format.js";
import { unknownLocaleError } from "./queries.js";
import { collectKeys, type ProjectSnapshot } from "./storage.js";
import type {
	MessagesSnapshot,
	MessageValue,
	SaveResultItem,
	TranslationInput,
} from "./types.js";

/** Validation and result-building for save_translations. */

// type alias (not interface) so it satisfies the MCP SDK's
// Record<string, unknown> constraint on structuredContent
export type SaveSummary = {
	results: SaveResultItem[];
	saved: number;
	failed: number;
	remainingForLocale: number;
};

/**
 * Validates a save batch against the current snapshot. Pure: returns the
 * per-item results plus the accepted `key -> value` map to persist.
 */
export function validateBatch(
	context: ProjectSnapshot,
	args: {
		targetLocale: string;
		translations: TranslationInput[];
		allowNewKeys?: boolean;
		skipValidation?: boolean;
	}
): { results: SaveResultItem[]; accepted: Record<string, MessageValue> } {
	const { baseLocale, locales, snapshot } = context;
	const allKeys = collectKeys(snapshot);

	const targetLocale = args.targetLocale;
	if (!locales.includes(targetLocale)) {
		throw unknownLocaleError(targetLocale, locales);
	}

	const results: SaveResultItem[] = [];
	const accepted: Record<string, MessageValue> = {};

	const seen = new Set<string>();
	for (const item of args.translations) {
		if (seen.has(item.key)) {
			results.push({
				key: item.key,
				status: "error",
				error: "duplicate key in this call",
			});
			continue;
		}
		seen.add(item.key);

		if (!allKeys.has(item.key) && !args.allowNewKeys) {
			results.push({
				key: item.key,
				status: "error",
				error:
					"unknown message key — keys must come from get_translation_batch/list_message_keys. " +
					"Pass allowNewKeys=true only when intentionally creating a new message.",
			});
			continue;
		}

		const source = snapshot[baseLocale]?.[item.key];
		if (
			source !== undefined &&
			targetLocale !== baseLocale &&
			!args.skipValidation
		) {
			const validation = validateTranslation(source, item.value);
			if (validation.errors.length > 0) {
				results.push({
					key: item.key,
					status: "error",
					error: validation.errors.join("; "),
				});
				continue;
			}
			accepted[item.key] = item.value;
			results.push({
				key: item.key,
				status: "saved",
				...(validation.warnings.length > 0 && {
					warnings: validation.warnings,
				}),
			});
		} else {
			// new key, base-locale edit, or skipValidation: only structural
			// validation applies
			if (!isValidMessageValue(item.value)) {
				results.push({
					key: item.key,
					status: "error",
					error: messageValueError(item.value),
				});
				continue;
			}
			accepted[item.key] = item.value;
			results.push({ key: item.key, status: "saved" });
		}
	}

	return { results, accepted };
}

/**
 * Builds the save result. `remainingForLocale` is computed by merging the
 * accepted values into the pre-save snapshot in memory — equivalent to
 * re-exporting the project after the save, without paying for it.
 */
export function summarizeSave(
	context: ProjectSnapshot,
	targetLocale: string,
	results: SaveResultItem[],
	accepted: Record<string, MessageValue>
): SaveSummary {
	const after: MessagesSnapshot = {
		...context.snapshot,
		[targetLocale]: { ...context.snapshot[targetLocale], ...accepted },
	};
	const remainingForLocale = [...collectKeys(after)].filter((key) => {
		const source = after[context.baseLocale]?.[key];
		if (isEmptyValue(source)) return false;
		return isEmptyValue(after[targetLocale]?.[key]);
	}).length;

	const saved = results.filter((r) => r.status === "saved").length;
	return {
		results,
		saved,
		failed: results.length - saved,
		remainingForLocale,
	};
}
