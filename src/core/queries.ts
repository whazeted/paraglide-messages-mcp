import { isEmptyValue, patternsOf, placeholdersOf } from "./format.js";
import {
	DEFAULT_TRANSLATION_BATCH_SIZE,
	DEFAULT_LIST_KEYS_PAGE_SIZE,
	DEFAULT_GET_MESSAGES_LIMIT,
	DEFAULT_SEARCH_MESSAGES_LIMIT,
} from "./constants.js";
import { MESSAGE_FORMAT_PLUGIN_KEY } from "./direct.js";
import { collectKeys, type ProjectSnapshot } from "./storage.js";
import type { MessageValue, ProjectInfo, TranslationItem } from "./types.js";

/** Pure read-only computations over a loaded project snapshot. */

export function computeProjectInfo(
	projectPath: string,
	context: ProjectSnapshot
): ProjectInfo {
	const { baseLocale, locales, snapshot } = context;
	const allKeys = new Set<string>();

	const translated: Record<string, number> = {};
	for (const locale of locales) {
		let count = 0;
		for (const [key, value] of Object.entries(snapshot[locale] ?? {})) {
			allKeys.add(key);
			if (!isEmptyValue(value)) count++;
		}
		translated[locale] = count;
	}

	const missing: Record<string, number> = {};
	for (const locale of locales) {
		missing[locale] = allKeys.size - (translated[locale] ?? 0);
	}

	return {
		projectPath,
		baseLocale,
		locales,
		pluginKey: MESSAGE_FORMAT_PLUGIN_KEY,
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

	const limit = Math.max(1, args.limit ?? DEFAULT_LIST_KEYS_PAGE_SIZE);
	const result = pageSortedKeys({
		keys: collectKeys(snapshot),
		limit,
		after: args.after,
		matches: (key) => {
			if (args.prefix && !key.startsWith(args.prefix)) return false;
			if (!locale || status === "all") return true;
			const empty = isEmptyValue(snapshot[locale]?.[key]);
			return status === "missing" ? empty : !empty;
		},
	});

	return {
		keys: result.page,
		total: result.total,
		hasMore: result.hasMore,
		nextCursor: result.hasMore
			? result.page[result.page.length - 1]
			: undefined,
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
	let allKeys: Set<string> | undefined;
	if (args.keys?.length) {
		keys = args.keys;
	} else {
		allKeys = collectKeys(snapshot);
		const result = pageSortedKeys({
			keys: allKeys,
			limit: Math.max(1, args.limit ?? DEFAULT_GET_MESSAGES_LIMIT),
			matches: (key) => key.startsWith(args.prefix!),
		});
		keys = result.page;
		return {
			messages: keys.map((key) => translationsForKey(snapshot, locales, key)),
			truncated: result.hasMore,
		};
	}

	const limit = Math.max(1, args.limit ?? DEFAULT_GET_MESSAGES_LIMIT);
	const truncated = keys.length > limit;
	keys = keys.slice(0, limit);

	const messages = keys.map((key) => {
		if (!(allKeys?.has(key) ?? keyExists(snapshot, key))) {
			return { key, translations: {} as Record<string, MessageValue | null> };
		}
		return translationsForKey(snapshot, locales, key);
	});

	return { messages, truncated };
}

function translationsForKey(
	snapshot: ProjectSnapshot["snapshot"],
	locales: string[],
	key: string
): { key: string; translations: Record<string, MessageValue | null> } {
	const translations: Record<string, MessageValue | null> = {};
	for (const locale of locales) {
		translations[locale] = snapshot[locale]?.[key] ?? null;
	}
	return { key, translations };
}

function keyExists(snapshot: ProjectSnapshot["snapshot"], key: string): boolean {
	for (const messages of Object.values(snapshot)) {
		if (key in messages) return true;
	}
	return false;
}

/** Validates and resolves the source/target locale pair of a batch call. */
function resolveSourceTarget(
	context: ProjectSnapshot,
	args: { targetLocale: string; sourceLocale?: string }
): { targetLocale: string; sourceLocale: string } {
	const { baseLocale, locales } = context;

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
	return { targetLocale, sourceLocale };
}

/** Sorted keys of one locale, optionally narrowed to a prefix. */
function sortedLocaleKeys(
	context: ProjectSnapshot,
	locale: string,
	prefix?: string
): string[] {
	let keys = Object.keys(context.snapshot[locale] ?? {}).sort();
	if (prefix) {
		keys = keys.filter((key) => key.startsWith(prefix));
	}
	return keys;
}

function pageSortedKeys(args: {
	keys: Iterable<string>;
	limit: number;
	after?: string;
	matches: (key: string) => boolean;
}): { page: string[]; total: number; hasMore: boolean } {
	const page: string[] = [];
	let total = 0;
	let hasMore = false;

	for (const key of [...args.keys].sort()) {
		if (!args.matches(key)) continue;
		total++;
		if (args.after && key <= args.after) continue;
		if (page.length < args.limit) {
			page.push(key);
		} else {
			hasMore = true;
		}
	}

	return { page, total, hasMore };
}

function toTranslationItem(
	context: ProjectSnapshot,
	sourceLocale: string,
	targetLocale: string,
	key: string
): TranslationItem {
	const source = context.snapshot[sourceLocale]![key]!;
	const existingTarget = context.snapshot[targetLocale]?.[key];
	return {
		key,
		source,
		...(existingTarget !== undefined && { existingTarget }),
		placeholders: placeholdersOf(source),
	};
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
	const { snapshot } = context;
	const { targetLocale, sourceLocale } = resolveSourceTarget(context, args);
	const batchSize = Math.max(1, args.batchSize ?? DEFAULT_TRANSLATION_BATCH_SIZE);
	const page: string[] = [];
	let remaining = 0;

	for (const key of sortedLocaleKeys(context, sourceLocale, args.prefix)) {
		const source = snapshot[sourceLocale]?.[key];
		if (isEmptyValue(source)) continue;
		if (!isEmptyValue(snapshot[targetLocale]?.[key])) continue;
		remaining++;
		if (page.length < batchSize) page.push(key);
	}

	return {
		targetLocale,
		sourceLocale,
		items: page.map((key) =>
			toTranslationItem(context, sourceLocale, targetLocale, key)
		),
		remaining,
		done: remaining === 0,
	};
}

/**
 * The retranslation counterpart of nextTranslationBatch: covers every key
 * with a non-empty source — including keys that already have a translation —
 * so a pass over the scope refreshes stale entries and fills gaps alike.
 *
 * Because saving does not shrink the scope (a retranslated key stays in it),
 * progress cannot use the remaining/done contract; the loop instead pages
 * with a key cursor: pass the previous call's `nextCursor` as `after` until
 * `hasMore` is false. This also means an agent may skip items it decides to
 * keep without stalling the loop.
 */
export function nextRetranslationBatch(
	context: ProjectSnapshot,
	args: {
		targetLocale: string;
		sourceLocale?: string;
		prefix?: string;
		batchSize?: number;
		after?: string;
	}
): {
	targetLocale: string;
	sourceLocale: string;
	items: TranslationItem[];
	total: number;
	hasMore: boolean;
	nextCursor?: string;
} {
	const { snapshot } = context;
	const { targetLocale, sourceLocale } = resolveSourceTarget(context, args);
	const batchSize = Math.max(1, args.batchSize ?? DEFAULT_TRANSLATION_BATCH_SIZE);
	const page: string[] = [];
	let total = 0;
	let hasMore = false;

	for (const key of sortedLocaleKeys(context, sourceLocale, args.prefix)) {
		if (isEmptyValue(snapshot[sourceLocale]?.[key])) continue;
		total++;
		if (args.after && key <= args.after) continue;
		if (page.length < batchSize) {
			page.push(key);
		} else {
			hasMore = true;
		}
	}

	return {
		targetLocale,
		sourceLocale,
		items: page.map((key) =>
			toTranslationItem(context, sourceLocale, targetLocale, key)
		),
		total,
		hasMore,
		nextCursor: hasMore ? page[page.length - 1] : undefined,
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
	const limit = Math.max(1, args.limit ?? DEFAULT_SEARCH_MESSAGES_LIMIT);
	let total = 0;

	for (const key of [...collectKeys(snapshot)].sort()) {
		const keyMatched = key.toLowerCase().includes(query);
		if (keyMatched && results.length >= limit) {
			total++;
			continue;
		}
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
			total++;
			if (results.length < limit) {
				results.push({ key, keyMatched, matches });
			}
		}
	}

	return {
		results,
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

