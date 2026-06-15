import {
	isEmptyValue,
	isValidMessageValue,
	messageValueError,
	validateTranslation,
} from "./format.js";
import { unknownLocaleError } from "./queries.js";
import { collectKeys, type ProjectSnapshot } from "./storage.js";
import type { MessageValue, SaveResultItem, TranslationInput } from "./types.js";

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
 * The save-result fields a batch tool reports when translations were submitted
 * for autosaving alongside the fetch. `allSaved` is the single signal an agent
 * checks to know its submitted work landed: true iff nothing was rejected.
 */
export type SaveFields = {
	saved: number;
	failed: number;
	saveResults: SaveResultItem[];
	allSaved: boolean;
};

export type SaveArgs = {
	targetLocale: string;
	sourceLocale?: string;
	translations: TranslationInput[];
	allowNewKeys?: boolean;
	skipValidation?: boolean;
};

/**
 * The shared save core behind both save_translations and the batch tools'
 * autosave: validates the batch against the snapshot and returns the per-item
 * results, the accepted `key -> value` map to persist, and the summary. The
 * caller is responsible for actually writing `accepted` (via mutateKeys).
 */
export function runSave(
	context: ProjectSnapshot,
	args: SaveArgs
): { results: SaveResultItem[]; accepted: Record<string, MessageValue>; summary: SaveSummary } {
	const { results, accepted } = validateBatch(context, args);
	const summary = summarizeSave(
		context,
		args.targetLocale,
		args.sourceLocale,
		results,
		accepted
	);
	return { results, accepted, summary };
}

/**
 * Returns a snapshot with `accepted` merged into the target locale, i.e. the
 * project state as it will be once the save is written. The batch tools page
 * the *next* batch against this so a just-saved key is no longer reported as
 * untranslated (translate loop) or carries its fresh value as `existingTarget`
 * (retranslate loop).
 */
export function withAccepted(
	context: ProjectSnapshot,
	targetLocale: string,
	accepted: Record<string, MessageValue>
): ProjectSnapshot {
	return {
		...context,
		snapshot: {
			...context.snapshot,
			[targetLocale]: { ...(context.snapshot[targetLocale] ?? {}), ...accepted },
		},
	};
}

/**
 * Validates a save batch against the current snapshot. Pure: returns the
 * per-item results plus the accepted `key -> value` map to persist.
 *
 * The snapshot may be scoped to source + target locale (see ReadOptions), so
 * the unknown-key check covers keys present in either of those — a key that
 * exists only in some third locale needs `allowNewKeys`.
 */
export function validateBatch(
	context: ProjectSnapshot,
	args: {
		targetLocale: string;
		sourceLocale?: string;
		translations: TranslationInput[];
		allowNewKeys?: boolean;
		skipValidation?: boolean;
	}
): { results: SaveResultItem[]; accepted: Record<string, MessageValue> } {
	const { baseLocale, locales, snapshot } = context;

	const targetLocale = args.targetLocale;
	if (!locales.includes(targetLocale)) {
		throw unknownLocaleError(targetLocale, locales);
	}
	const sourceLocale = args.sourceLocale ?? baseLocale;
	if (!locales.includes(sourceLocale)) {
		throw unknownLocaleError(sourceLocale, locales);
	}
	const allKeys = args.allowNewKeys
		? undefined
		: collectKeys({
				[sourceLocale]: snapshot[sourceLocale] ?? {},
				[targetLocale]: snapshot[targetLocale] ?? {},
			});

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

		if (allKeys && !allKeys.has(item.key)) {
			results.push({
				key: item.key,
				status: "error",
				error:
					"unknown message key — keys must come from get_translation_batch/list_message_keys. " +
					"Pass allowNewKeys=true only when intentionally creating a new message.",
			});
			continue;
		}

		const source = snapshot[sourceLocale]?.[item.key];
		if (
			source !== undefined &&
			targetLocale !== sourceLocale &&
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
	sourceLocale: string | undefined,
	results: SaveResultItem[],
	accepted: Record<string, MessageValue>
): SaveSummary {
	const resolvedSourceLocale = sourceLocale ?? context.baseLocale;
	const sourceMessages = context.snapshot[resolvedSourceLocale] ?? {};
	const targetMessages = context.snapshot[targetLocale] ?? {};
	let remainingForLocale = 0;
	for (const [key, source] of Object.entries(sourceMessages)) {
		if (isEmptyValue(source)) continue;
		const target = key in accepted ? accepted[key] : targetMessages[key];
		if (isEmptyValue(target)) remainingForLocale++;
	}

	let saved = 0;
	for (const result of results) {
		if (result.status === "saved") saved++;
	}
	return {
		results,
		saved,
		failed: results.length - saved,
		remainingForLocale,
	};
}
