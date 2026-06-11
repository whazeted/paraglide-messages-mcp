import { isEmptyValue, patternsOf, placeholdersOf } from "./format.js";
import {
	DEFAULT_BATCH_SIZE,
	DEFAULT_KEYS_LIMIT,
	DEFAULT_MESSAGES_LIMIT,
	DEFAULT_SEARCH_LIMIT,
	MAX_BATCH_SIZE,
	MAX_KEYS_LIMIT,
	MAX_MESSAGES_LIMIT,
	MAX_SEARCH_LIMIT,
} from "./constants.js";
import { collectKeys, type ProjectSnapshot } from "./storage.js";
import type { MessageValue, ProjectInfo, TranslationItem } from "./types.js";

/** Pure read-only computations over a loaded project snapshot. */

export function computeProjectInfo(
	projectPath: string,
	context: ProjectSnapshot
): ProjectInfo {
	const { baseLocale, locales, pluginKey, snapshot } = context;
	const allKeys = collectKeys(snapshot);

	const translated: Record<string, number> = {};
	const missing: Record<string, number> = {};
	for (const locale of locales) {
		let count = 0;
		for (const key of allKeys) {
			if (!isEmptyValue(snapshot[locale]?.[key])) count++;
		}
		translated[locale] = count;
		missing[locale] = allKeys.size - count;
	}

	return {
		projectPath,
		baseLocale,
		locales,
		pluginKey,
		totalKeys: allKeys.size,
		translated,
		missing,
	};
}

export function queryKeys(
	context: ProjectSnapshot,
	args: {
		prefix?: string;
		locale?: string;
		status?: "all" | "missing" | "translated";
		limit?: number;
		after?: string;
	}
): {
	keys: string[];
	total: number;
	hasMore: boolean;
	nextCursor?: string;
} {
	const { locales, snapshot } = context;

	const locale = args.locale;
	if (locale && !locales.includes(locale)) {
		throw unknownLocaleError(locale, locales);
	}
	const status = args.status ?? "all";
	if (status !== "all" && !locale) {
		throw new Error(`status "${status}" requires a locale`);
	}

	let keys = [...collectKeys(snapshot)].sort();
	if (args.prefix) {
		keys = keys.filter((key) => key.startsWith(args.prefix!));
	}
	if (locale && status !== "all") {
		keys = keys.filter((key) => {
			const empty = isEmptyValue(snapshot[locale]?.[key]);
			return status === "missing" ? empty : !empty;
		});
	}

	const total = keys.length;
	if (args.after) {
		keys = keys.filter((key) => key > args.after!);
	}
	const limit = clamp(args.limit ?? DEFAULT_KEYS_LIMIT, 1, MAX_KEYS_LIMIT);
	const page = keys.slice(0, limit);
	const hasMore = keys.length > limit;

	return {
		keys: page,
		total,
		hasMore,
		nextCursor: hasMore ? page[page.length - 1] : undefined,
	};
}

export function queryMessages(
	context: ProjectSnapshot,
	args: {
		keys?: string[];
		prefix?: string;
		locales?: string[];
		limit?: number;
	}
): {
	messages: Array<{
		key: string;
		translations: Record<string, MessageValue | null>;
	}>;
	truncated: boolean;
} {
	const { locales: projectLocales, snapshot } = context;
	const locales = resolveLocales(args.locales, projectLocales);

	let keys: string[];
	if (args.keys?.length) {
		keys = args.keys;
	} else {
		keys = [...collectKeys(snapshot)]
			.filter((key) => key.startsWith(args.prefix!))
			.sort();
	}

	const limit = clamp(
		args.limit ?? DEFAULT_MESSAGES_LIMIT,
		1,
		MAX_MESSAGES_LIMIT
	);
	const truncated = keys.length > limit;
	keys = keys.slice(0, limit);

	const allKeys = collectKeys(snapshot);
	const messages = keys.map((key) => {
		if (!allKeys.has(key)) {
			return { key, translations: {} as Record<string, MessageValue | null> };
		}
		const translations: Record<string, MessageValue | null> = {};
		for (const locale of locales) {
			translations[locale] = snapshot[locale]?.[key] ?? null;
		}
		return { key, translations };
	});

	return { messages, truncated };
}

export function nextTranslationBatch(
	context: ProjectSnapshot,
	args: {
		targetLocale: string;
		sourceLocale?: string;
		prefix?: string;
		batchSize?: number;
	}
): {
	targetLocale: string;
	sourceLocale: string;
	items: TranslationItem[];
	remaining: number;
	done: boolean;
} {
	const { baseLocale, locales, snapshot } = context;

	const targetLocale = args.targetLocale;
	if (!locales.includes(targetLocale)) {
		throw unknownLocaleError(targetLocale, locales);
	}
	const sourceLocale = args.sourceLocale ?? baseLocale;
	if (!locales.includes(sourceLocale)) {
		throw unknownLocaleError(sourceLocale, locales);
	}
	if (sourceLocale === targetLocale) {
		throw new Error("sourceLocale and targetLocale must differ");
	}

	let keys = [...collectKeys(snapshot)].sort();
	if (args.prefix) {
		keys = keys.filter((key) => key.startsWith(args.prefix!));
	}

	const pending = keys.filter((key) => {
		const source = snapshot[sourceLocale]?.[key];
		if (isEmptyValue(source)) return false;
		return isEmptyValue(snapshot[targetLocale]?.[key]);
	});

	const batchSize = clamp(
		args.batchSize ?? DEFAULT_BATCH_SIZE,
		1,
		MAX_BATCH_SIZE
	);
	const items: TranslationItem[] = pending.slice(0, batchSize).map((key) => {
		const source = snapshot[sourceLocale]![key]!;
		const existingTarget = snapshot[targetLocale]?.[key];
		return {
			key,
			source,
			...(existingTarget !== undefined && { existingTarget }),
			placeholders: placeholdersOf(source),
		};
	});

	return {
		targetLocale,
		sourceLocale,
		items,
		remaining: pending.length,
		done: pending.length === 0,
	};
}

export type SearchResult = {
	key: string;
	keyMatched: boolean;
	matches: Array<{ locale: string; value: MessageValue }>;
};

export function searchMessages(
	context: ProjectSnapshot,
	args: {
		query: string;
		locales?: string[];
		limit?: number;
	}
): {
	results: SearchResult[];
	total: number;
	truncated: boolean;
} {
	const { locales: projectLocales, snapshot } = context;

	const query = args.query.trim().toLowerCase();
	if (query.length === 0) {
		throw new Error("query must not be empty");
	}

	const locales = resolveLocales(args.locales, projectLocales);

	const results: SearchResult[] = [];

	for (const key of [...collectKeys(snapshot)].sort()) {
		const keyMatched = key.toLowerCase().includes(query);
		const matches: SearchResult["matches"] = [];
		for (const locale of locales) {
			const value = snapshot[locale]?.[key];
			if (value === undefined) continue;
			const textMatched = patternsOf(value).some((pattern) =>
				pattern.toLowerCase().includes(query)
			);
			if (textMatched) {
				matches.push({ locale, value });
			}
		}
		if (keyMatched || matches.length > 0) {
			results.push({ key, keyMatched, matches });
		}
	}

	const total = results.length;
	const limit = clamp(args.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
	return {
		results: results.slice(0, limit),
		total,
		truncated: total > limit,
	};
}

/**
 * Resolves a requested locale list against the project's locales: defaults
 * to all project locales and rejects unknown ones.
 */
function resolveLocales(
	requested: string[] | undefined,
	projectLocales: string[]
): string[] {
	const locales = requested ?? projectLocales;
	for (const locale of locales) {
		if (!projectLocales.includes(locale)) {
			throw unknownLocaleError(locale, projectLocales);
		}
	}
	return locales;
}

export function unknownLocaleError(locale: string, locales: string[]): Error {
	return new Error(
		`unknown locale "${locale}" — project locales: ${locales.join(", ")}`
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
