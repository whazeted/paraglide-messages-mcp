import fs from "node:fs";
import path from "node:path";
import type { ComplexMessage, MessageValue } from "../../src/core/types.js";
import { generateKey, generateMessage, mulberry32 } from "./generate-messages.js";
import {
	MESSAGE_FILE_SCHEMA,
	scaffoldProject,
	type FixtureProject,
} from "./helpers.js";

/** The 10 target locales of the large fixture (base locale is "en"). */
export const LARGE_FIXTURE_TARGET_LOCALES = [
	"fr",
	"de",
	"nl",
	"es",
	"it",
	"zh-CN",
	"ja",
	"ko",
	"pt-BR",
	"ru",
] as const;

const NAMESPACES = [
	"admin",
	"auth",
	"checkout",
	"errors",
	"nav",
	"notifications",
	"profile",
	"search",
	"settings",
	"shared",
];

/**
 * Like `createFixtureProject` but at realistic scale: `messageCount`
 * (default 250) deterministic but varied English messages spread over 10
 * namespaces (see generate-messages.ts for the shapes), with all target
 * locale files starting out empty. Same `seed` + `messageCount` always
 * produces the exact same project.
 */
export function createLargeFixtureProject(
	options: { messageCount?: number; seed?: number } = {}
): FixtureProject & { messageCount: number; locales: string[] } {
	const messageCount = options.messageCount ?? 250;
	const locales = ["en", ...LARGE_FIXTURE_TARGET_LOCALES];

	const rng = mulberry32(options.seed ?? 42);
	const en: Record<string, unknown> = {};
	for (let i = 0; i < messageCount; i++) {
		const namespace = NAMESPACES[i % NAMESPACES.length]!;
		const n = String(Math.floor(i / NAMESPACES.length)).padStart(3, "0");
		en[generateKey(rng, namespace, n)] = generateMessage(rng);
	}

	const fixture = scaffoldProject({
		baseLocale: "en",
		locales,
		messages: { en },
	});
	return { ...fixture, messageCount, locales };
}

/**
 * Resets every non-base message file back to an empty `{ $schema }` document,
 * so a fixture (or a real project pointed at by `messagesDir`) can be reused
 * for another translation run.
 */
export function emptyNonBaseLocales(args: {
	messagesDir: string;
	baseLocale?: string;
}): string[] {
	const baseLocale = args.baseLocale ?? "en";
	const emptied: string[] = [];
	for (const entry of fs.readdirSync(args.messagesDir)) {
		if (!entry.endsWith(".json")) continue;
		const locale = entry.slice(0, -".json".length);
		if (locale === baseLocale) continue;
		fs.writeFileSync(
			path.join(args.messagesDir, entry),
			JSON.stringify({ $schema: MESSAGE_FILE_SCHEMA }, null, "\t")
		);
		emptied.push(locale);
	}
	return emptied;
}

const PSEUDO_TAGS: Record<string, string> = {
	fr: "FR",
	de: "DE",
	nl: "NL",
	es: "ES",
	it: "IT",
	"zh-CN": "中文",
	ja: "日本語",
	ko: "한국어",
	"pt-BR": "PT-BR",
	ru: "РУ",
};

/**
 * Deterministic pseudo-translation: prefixes strings with a locale tag while
 * preserving placeholders, and maps variant arrays match-value by match-value
 * (CJK/Cyrillic tags double as a non-ASCII round-trip check).
 */
export function pseudoTranslate(
	source: MessageValue,
	locale: string
): MessageValue {
	const tag = PSEUDO_TAGS[locale] ?? locale.toUpperCase();
	if (typeof source === "string") {
		return `${tag}:${source}`;
	}
	return source.map((variant) => ({
		...variant,
		match: Object.fromEntries(
			Object.entries(variant.match).map(([condition, value]) => [
				condition,
				`${tag}:${value}`,
			])
		),
	})) as ComplexMessage;
}
