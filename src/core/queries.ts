import { isEmptyValue, placeholdersOf } from "./format.js";
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
	const limit = clamp(args.limit ?? 100, 1, 500);
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

	const locales = args.locales ?? projectLocales;
	for (const locale of locales) {
		if (!projectLocales.includes(locale)) {
			throw unknownLocaleError(locale, projectLocales);
		}
	}

	let keys: string[];
	if (args.keys?.length) {
		keys = args.keys;
	} else {
		keys = [...collectKeys(snapshot)]
			.filter((key) => key.startsWith(args.prefix!))
			.sort();
	}

	const limit = clamp(args.limit ?? 50, 1, 200);
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

	const batchSize = clamp(args.batchSize ?? 5, 1, 25);
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

export function unknownLocaleError(locale: string, locales: string[]): Error {
	return new Error(
		`unknown locale "${locale}" — project locales: ${locales.join(", ")}`
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
